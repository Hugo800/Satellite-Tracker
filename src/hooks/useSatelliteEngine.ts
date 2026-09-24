import { useEffect, useRef } from 'react';
import { GROUP_LOAD_ORDER } from '../data/tleSources';
import { TELEMETRY_STRIDE, T_EL, T_RANGE } from '../math/telemetryLayout';
import { catalogIndex, ensureTelemetryCapacity, telemetry, trailState } from '../state/runtime';
import { isRealtime, selectTimeEpoch, useAppStore, virtualNow, virtualTimeAt } from '../state/store';
import type {
  NoradId,
  SatelliteGroup,
  SatelliteMeta,
  TimeBase,
  WorkerRequest,
  WorkerResponse,
} from '../types';

/**
 * Pool aus SGP4-Workern.
 *
 * `npm run bench:propagation` misst für 12 000 Objekte rund 25 ms je
 * Propagationsschritt auf einem Desktop-Kern. Das wäre allein noch tragbar –
 * auf einem Mobilkern, der typischerweise drei- bis fünfmal langsamer ist,
 * füllt derselbe Schritt jedoch praktisch das gesamte 100-ms-Fenster. Dann
 * bliebe keine Zeit mehr für Auswahl, Bahnspuren und Überflugsuche, die im
 * selben Thread laufen.
 *
 * Der Katalog wird deshalb per Modulo auf mehrere Worker verteilt –
 * `index % shardCount === shardIndex`. Die Zuteilung ist rein rechnerisch:
 * Wächst der Katalog, bleiben alle bisherigen Plätze unverändert gültig.
 *
 * Auswahl, Bahnspur und Überflugliste hängen trotzdem nicht am Platz, sondern
 * an der NORAD-ID: Ein neu aufgebauter Pool vergibt die Plätze nach
 * Ladereihenfolge und -erfolg neu (scripts/verify-selection.ts, Abschnitt F).
 */

function pickShardCount(): number {
  const cores = navigator.hardwareConcurrency || 4;
  if (cores <= 2) return 1;
  // Ein Kern bleibt für Main-Thread und Compositor reserviert.
  return Math.max(2, Math.min(6, cores - 1));
}

/** Tick eines Shards, der auf den Wechsel der Zeitepoche wartet. */
interface StagedTick {
  count: number;
  buffer: ArrayBuffer;
}

interface Pool {
  workers: Worker[];
  shardCount: number;
  /** Shards, die für den laufenden Tick noch fehlen. */
  pending: Set<number>;
  lastRevisionAt: number;
  /** Beginn des Messfensters für die Taktdauer. */
  windowStartedAt: number;
  windowTicks: number;
  sawTick: boolean;
  /** Virtuelle Zeit des zuletzt angenommenen Ticks – wird bei Freigabe zu `telemetry.timeMs`. */
  latestTickMs: number;
  /**
   * Ticks der neuen Epoche, solange `telemetry.epoch` noch die alte ist.
   * Übernommen werden sie in einem Zug (`commitEpoch`): sobald jeder Shard
   * einen geliefert hat oder der Wachhund den Übergang erzwingt – dann ohne
   * die Shards, die noch nichts geliefert haben; deren Plätze werden
   * ausgeblendet. Bis dahin bleibt der alte Stand in `telemetry.data` stehen.
   */
  staged: Map<number, StagedTick>;
  /** `performance.now()` des letzten Epochenwechsels – Bezug für den Wachhund im Übergang. */
  epochChangedAt: number;
}

let pool: Pool | null = null;

let catalogTotal = 0;
let catalogDirty = false;
let catalogTimer: ReturnType<typeof setTimeout> | null = null;

function broadcast(message: WorkerRequest, transfer?: Transferable[]): void {
  if (!pool) return;
  for (const worker of pool.workers) worker.postMessage(message, transfer ?? []);
}

function sendTo(shard: number, message: WorkerRequest, transfer?: Transferable[]): void {
  pool?.workers[shard]?.postMessage(message, transfer ?? []);
}

/** Shard, der den Platz besitzt. */
const shardOf = (slot: number): number => (pool ? slot % pool.shardCount : 0);

/**
 * Schickt eine Anfrage für ein Objekt an den Shard, der es rechnet.
 *
 * Aus einer NORAD-ID lässt sich der Shard nicht berechnen, nur aus dem Platz.
 * Den liefert die ID→Platz-Map des Main-Threads (`catalogIndex.slotById`) –
 * dieselbe, über die Karte, Ring und Radar die Auswahl auflösen. Ein Rundruf
 * an alle Shards ginge auch, fremde Shards verwürfen die Nachricht. Er hilft
 * aber nicht bei dem Fall, der ohnehin eine eigene Behandlung braucht: Eine
 * ID, die noch nicht im Katalog steht, bekäme auch per Rundruf keine Antwort.
 * Also gilt: Solange die Map die ID nicht kennt, geht nichts raus, und die
 * Anfrage folgt, sobald sie aufgelöst ist (Effekt unten, OrbitTrail). So
 * gibt es genau einen Moment, in dem ein Objekt als „im Katalog“ gilt, und
 * eine Überflugsuche je Auswahl und Bahnsatz.
 *
 * Die Nachricht trägt die ID, nicht den Platz; der Shard löst sie über seine
 * eigenen `knownIds` auf. Ein falsch gerouteter Auftrag bleibt deshalb ohne
 * Antwort, statt ein anderes Objekt zu liefern.
 *
 * @returns false, wenn die ID im aktuellen Katalog (noch) fehlt.
 */
function sendForId(noradId: NoradId, message: WorkerRequest): boolean {
  const slot = catalogIndex.slotById.get(noradId);
  if (slot === undefined || !pool) return false;
  sendTo(shardOf(slot), message);
  return true;
}

/**
 * Setzt eine neue Zeitbasis: an die Shards und in den Store.
 *
 * Die Effekte, die auf die neue Basis hin Anfragen verschicken (Überflugliste
 * unten, Bahnspur in OrbitTrail), laufen erst nach dem Rendern, also nach
 * diesem Aufruf – die `time`-Nachricht ist dann an jeden Shard verschickt,
 * gleich in welcher Reihenfolge `broadcast` und `setTimeBase` unten stehen. Da
 * `postMessage` an einen Worker in der Reihenfolge des Absendens ankommt,
 * rechnet der Shard ihre Anfragen mit der neuen Basis
 * (scripts/verify-timetravel.ts, Abschnitt H: während `jumpTo` gehen nur
 * `time`-Nachrichten hinaus).
 */
function applyTimeBase(next: TimeBase): void {
  const previous = useAppStore.getState().timeBase;
  if (pool && next.epoch !== previous.epoch) beginEpoch(pool);
  if (next.epoch !== previous.epoch) {
    // Die Bahnspur der alten Zeit sofort verwerfen, nicht erst, wenn die neue
    // eintrifft: OrbitTrail zeichnet nur eine Spur mit gesetzter ID.
    trailState.noradId = null;
    trailState.points = null;
    trailState.timeMs = null;
    trailState.version += 1;
  }
  broadcast({ type: 'time', base: next });
  useAppStore.getState().setTimeBase(next);
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} muss endlich sein, war ${value}`);
}

/** Imperative API des Worker-Pools – bewusst außerhalb von React. */
export const engine = {
  requestTrail(noradId: NoradId, fromMin = -25, toMin = 70, samples = 220): boolean {
    return sendForId(noradId, { type: 'trail', noradId, fromMin, toMin, samples });
  },
  requestPass(noradId: NoradId, searchHours = 48): boolean {
    return sendForId(noradId, { type: 'pass', noradId, searchHours });
  },
  /**
   * Geschwindigkeit der virtuellen Zeit: 1 = Echtzeit, 60 = eine Minute je
   * Sekunde, negativ = rückwärts, 0 = angehalten.
   *
   * Die virtuelle Zeit läuft im Moment des Wechsels stetig weiter, auch bei
   * 1 – wer nach einem Sprung in normaler Geschwindigkeit weiterlaufen will,
   * bleibt in seiner Zeit. Zurück zur Wanduhr führt `resetToRealTime`.
   *
   * Rückwärts ist erlaubt: SGP4 rechnet vor der TLE-Epoche wie danach, und
   * alle Verbraucher kommen damit zurecht – die Spuren tasten mit dem Betrag
   * des Zeitschritts ab und beginnen bei einer Richtungsumkehr neu
   * (SatelliteTrails), die Überflugliste wird neu angefordert, sobald die
   * virtuelle Zeit vor ihrem Suchbeginn liegt (unten), Sonne und Mond lesen
   * die virtuelle Zeit (useCelestialBodies). Geprüft in
   * scripts/verify-timetravel.ts, Abschnitte E, G und J.
   */
  setTimeScale(scale: number): void {
    assertFinite('scale', scale);
    const current = useAppStore.getState().timeBase;
    const now = Date.now();
    applyTimeBase({
      originRealMs: now,
      originVirtualMs: virtualTimeAt(current, now),
      scale,
      epoch: current.epoch,
    });
  },
  /** Springt auf die virtuelle Zeit `virtualMs` (ms seit 1970, UTC); die Geschwindigkeit bleibt. */
  jumpTo(virtualMs: number): void {
    assertFinite('virtualMs', virtualMs);
    const current = useAppStore.getState().timeBase;
    applyTimeBase({
      originRealMs: Date.now(),
      originVirtualMs: virtualMs,
      scale: current.scale,
      epoch: current.epoch + 1,
    });
  },
  /** Zurück auf die Wanduhr, Geschwindigkeit 1. Läuft die Szene schon in Echtzeit, passiert nichts. */
  resetToRealTime(): void {
    const current = useAppStore.getState().timeBase;
    if (isRealtime(current)) return;
    const now = Date.now();
    applyTimeBase({ originRealMs: now, originVirtualMs: now, scale: 1, epoch: current.epoch + 1 });
  },
  reload(groups: SatelliteGroup[]): void {
    sendTo(0, { type: 'load', groups });
  },
  /**
   * Meldet die Auswahl an den Pool. Subpunkt und Bahnhöhe entstehen aus einer
   * iterativen Umkehrung des Erdellipsoids und kosten rund ein Drittel des
   * Ticks; angezeigt werden sie nur für dieses eine Objekt.
   */
  setSelected(noradId: NoradId | null): void {
    broadcast({ type: 'select', noradId });
  },
  get shardCount(): number {
    return pool?.shardCount ?? 0;
  },
};

/* ------------------------------------------------------------------ */
/* Telemetrie einsammeln                                                */
/* ------------------------------------------------------------------ */

/**
 * Kopiert den Shard-Buffer an seine verstreuten Plätze im Gesamtbuffer.
 *
 * Slot `k` des Shards `s` gehört zum globalen Index `s + k * shardCount`;
 * der Schreibzeiger springt deshalb in festen Schritten – ein reiner
 * Float-Umkopierer ohne Verzweigung im Rumpf.
 */
function scatter(shard: number, count: number, src: Float32Array, shardCount: number): void {
  const dst = telemetry.data;
  const step = shardCount * TELEMETRY_STRIDE;
  const limit = dst.length;
  let d = shard * TELEMETRY_STRIDE;

  for (let s = 0; s < count * TELEMETRY_STRIDE; s += TELEMETRY_STRIDE, d += step) {
    if (d + TELEMETRY_STRIDE > limit) break;
    dst[d] = src[s];
    dst[d + 1] = src[s + 1];
    dst[d + 2] = src[s + 2];
    dst[d + 3] = src[s + 3];
    dst[d + 4] = src[s + 4];
    dst[d + 5] = src[s + 5];
    dst[d + 6] = src[s + 6];
    dst[d + 7] = src[s + 7];
    dst[d + 8] = src[s + 8];
  }
}

/**
 * Blendet alle Plätze eines Shards aus – wie ein Objekt ohne gültige
 * Propagation: `range = NaN` für alle, die danach fragen (Feld, Spuren,
 * Radar, Tap, `readSample`), dazu Höhe −90° für HighlightMarkers, das nur die
 * Höhe liest. Der Azimut bleibt der der alten Zeit; SatelliteField
 * interpoliert deshalb nie von einem ungültigen Platz aus.
 */
function invalidateShard(shard: number, shardCount: number): void {
  const dst = telemetry.data;
  for (let d = shard * TELEMETRY_STRIDE; d + TELEMETRY_STRIDE <= dst.length; d += shardCount * TELEMETRY_STRIDE) {
    dst[d + T_EL] = -Math.PI / 2;
    dst[d + T_RANGE] = Number.NaN;
  }
}

function recycle(shard: number, buffer: ArrayBuffer): void {
  sendTo(shard, { type: 'recycle', buffer }, [buffer]);
}

/** Ein Sprung beginnt: Gesammelte Ticks einer vorigen, nie freigegebenen Epoche sind wertlos. */
function beginEpoch(state: Pool): void {
  for (const [shard, staged] of state.staged) recycle(shard, staged.buffer);
  state.staged.clear();
  state.epochChangedAt = performance.now();
}

/**
 * Übernimmt die gesammelten Ticks der neuen Epoche in einem Zug.
 *
 * `force` (Wachhund): Ein Shard, der seit dem Sprung nichts geliefert hat,
 * steht noch mit Werten der alten Zeit im Buffer. Seine Plätze werden
 * ausgeblendet statt stehen gelassen – ein Himmel, in dem ein Teil fehlt,
 * ist besser als einer, in dem ein Teil Stunden oder Tage daneben liegt. Mit
 * seinem nächsten Tick kehren sie zurück (scripts/verify-timetravel.ts,
 * Abschnitt C).
 */
function commitEpoch(state: Pool, epoch: number, force: boolean): void {
  for (const [shard, staged] of state.staged) {
    scatter(shard, staged.count, new Float32Array(staged.buffer), state.shardCount);
    recycle(shard, staged.buffer);
  }
  if (force) {
    for (let shard = 0; shard < state.shardCount; shard += 1) {
      if (!state.staged.has(shard)) invalidateShard(shard, state.shardCount);
    }
  }
  state.staged.clear();
  telemetry.epoch = epoch;
  completeTickIfReady(state, true);
}

/** Über so viele vollständige Ticks wird die Taktdauer gemittelt. */
const INTERVAL_WINDOW_TICKS = 10;

/**
 * Hebt die Revision erst an, wenn jeder Shard geliefert hat – sonst sähe die
 * Renderschleife einen Himmel, in dem nur jedes n-te Objekt aktuell ist, und
 * würde zwischen zwei Teilständen interpolieren.
 *
 * Nebenbei entsteht hier die Taktdauer, über die der Shader interpoliert.
 * Sie wird über ein Fenster von mehreren Ticks gemittelt und **nicht** aus dem
 * Abstand zweier einzelner Revisionen abgeleitet: Ist der Main-Thread
 * ausgelastet, laufen mehrere Worker-Nachrichten in einem Rutsch ein, und
 * Einzelabstände unterschätzten die tatsächliche Periode deutlich – die
 * Interpolation wäre dann vor dem nächsten Tick fertig und bliebe kurz stehen.
 */
function completeTickIfReady(state: Pool, force: boolean): void {
  if (!force && state.pending.size > 0) return;

  const now = performance.now();
  state.lastRevisionAt = now;
  state.windowTicks += 1;

  if (state.windowTicks >= INTERVAL_WINDOW_TICKS) {
    const average = (now - state.windowStartedAt) / state.windowTicks;
    telemetry.intervalMs = Math.min(2000, Math.max(16, average));
    state.windowStartedAt = now;
    state.windowTicks = 0;
  }

  state.pending = new Set(Array.from({ length: state.shardCount }, (_, i) => i));
  telemetry.timeMs = state.latestTickMs;
  telemetry.revision += 1;
}

/* ------------------------------------------------------------------ */
/* Katalog zusammenführen                                               */
/* ------------------------------------------------------------------ */

/**
 * Baut die Nachschlagetabellen einer Katalogfassung – die Flags je Platz und
 * die Map ID→Platz im selben Durchlauf. Getrennt entstanden, könnten Flags
 * und Auflösung der Auswahl für einen Moment verschiedene Katalogfassungen
 * beschreiben.
 */
function rebuildCatalogIndex(catalog: SatelliteMeta[], total: number): void {
  const groupIds = new Uint8Array(total);
  const starlink = new Uint8Array(total);
  const highlight = new Uint8Array(total);
  const slotById = new Map<NoradId, number>();

  for (const meta of catalog) {
    if (meta.index >= total) continue;
    groupIds[meta.index] = GROUP_LOAD_ORDER.indexOf(meta.group);
    starlink[meta.index] = meta.group === 'starlink' ? 1 : 0;
    highlight[meta.index] = meta.highlight ? 1 : 0;
    slotById.set(meta.noradId, meta.index);
  }

  catalogIndex.groupIds = groupIds;
  catalogIndex.starlink = starlink;
  catalogIndex.highlight = highlight;
  catalogIndex.slotById = slotById;
  catalogIndex.version += 1;
}

/**
 * Die Shards melden ihre Metadaten unabhängig voneinander und mehrfach je
 * Ladevorgang. Ein Store-Update pro Nachricht würde den React-Baum bei einem
 * 12 000er Katalog dutzendfach neu aufbauen – deshalb sammeln wir und
 * schreiben gebündelt.
 */
function flushCatalog(setCatalog: (catalog: SatelliteMeta[]) => void): void {
  if (!catalogDirty) return;
  catalogDirty = false;

  const catalog: SatelliteMeta[] = [];
  for (let i = 0; i < catalogIndex.meta.length; i += 1) {
    const meta = catalogIndex.meta[i];
    if (meta) catalog.push(meta);
  }

  telemetry.count = catalogTotal;
  rebuildCatalogIndex(catalog, catalogTotal);
  // Löst die Auswahl gegen die eben gebaute Map neu auf (store.ts).
  setCatalog(catalog);
}

/**
 * Nach so viel virtueller Zeit hinter dem Suchbeginn wird die Überflugliste
 * neu gesucht. Die Suche reicht 48 h weit; in Echtzeit bleibt so rund ein Tag
 * Vorschau.
 *
 * Im Zeitraffer weniger: Geprüft wird einmal je Sekunde Wanduhr (Intervall
 * unten), neu angefragt höchstens alle `PASS_RETRY_MS`, und bis die Suche im
 * Shard beginnt, läuft die virtuelle Zeit weiter. Je Prüfabstand sind das bei
 * ×600 zehn Minuten, bei ×60 000 fast 17 h. Dort begann die neue Suche meist
 * 33,1 bis 33,4 h nach der alten, mit knapp 15 h Vorschau; in 7 von 89
 * Läufen aber eine Prüfung später, 49,8 h danach – dann war die alte Liste
 * schon 1,8 h abgelaufen (scripts/verify-timetravel.ts, G4). Bei ×60 000
 * sind das 0,1 s Wanduhr ohne gültige Liste.
 */
const PASS_REFRESH_AFTER_MS = 24 * 3600_000;
/**
 * Mindestabstand zweier Nachführungen in Echtzeit. Im schnellen Rückwärtslauf
 * läge die virtuelle Zeit fast sofort wieder vor dem Suchbeginn; ohne Sperre
 * ginge dann jede Sekunde eine 48-h-Suche an denselben Shard.
 */
const PASS_RETRY_MS = 2000;

export interface EngineOptions {
  /** Ziel-Propagationsrate in ms. 100 ms = 10 Hz, dazwischen interpoliert der Shader. */
  intervalMs?: number;
}

/**
 * Startet den Worker-Pool, hält ihn mit dem Beobachterstandort synchron und
 * schreibt eingehende Telemetrie direkt in den Modulzustand (kein React-Render).
 */
export function useSatelliteEngine({ intervalMs = 100 }: EngineOptions = {}): void {
  const observer = useAppStore((s) => s.observer);
  const activeGroups = useAppStore((s) => s.activeGroups);
  const setCatalog = useAppStore((s) => s.setCatalog);
  const setStatus = useAppStore((s) => s.setStatus);
  const pushError = useAppStore((s) => s.pushError);
  const setPasses = useAppStore((s) => s.setPasses);
  const selectedId = useAppStore((s) => s.selectedId);
  const selectedMeta = useAppStore((s) => s.selectedMeta);
  const timeEpoch = useAppStore(selectTimeEpoch);
  const started = useRef(false);

  useEffect(() => {
    const shardCount = pickShardCount();
    const workers: Worker[] = [];
    const state: Pool = {
      workers,
      shardCount,
      pending: new Set(Array.from({ length: shardCount }, (_, i) => i)),
      lastRevisionAt: 0,
      windowStartedAt: performance.now(),
      windowTicks: 0,
      sawTick: false,
      latestTickMs: telemetry.timeMs,
      staged: new Map(),
      epochChangedAt: performance.now(),
    };
    telemetry.intervalMs = intervalMs;
    pool = state;

    // Ein neuer Pool vergibt die Plätze neu. Metadaten, Map und der Platz der
    // Auswahl dürfen nicht auf dem alten Stand stehen bleiben: Bis zur ersten
    // Katalogfassung gilt die Auswahl als nicht aufgelöst (-1), danach findet
    // `setCatalog` sie über die ID wieder – auch an einem anderen Platz.
    catalogIndex.meta = [];
    catalogTotal = 0;
    catalogDirty = false;
    rebuildCatalogIndex([], 0);
    setCatalog([]);

    const scheduleFlush = () => {
      catalogDirty = true;
      if (catalogTimer !== null) return;
      catalogTimer = setTimeout(() => {
        catalogTimer = null;
        flushCatalog(setCatalog);
      }, 220);
    };

    const handle = (shard: number, msg: WorkerResponse) => {
      switch (msg.type) {
        case 'tick': {
          const epoch = useAppStore.getState().timeBase.epoch;
          if (msg.epoch !== epoch) {
            // Gerechnet mit der Basis vor dem letzten Sprung: Der Shard hatte
            // die `time`-Nachricht noch nicht verarbeitet. Übernommen stünde
            // ein Teil des Himmels in der alten Zeit
            // (scripts/verify-timetravel.ts, Abschnitt B).
            recycle(shard, msg.buffer);
            break;
          }
          state.sawTick = true;
          // Zuweisung statt Maximum: Nach einem Sprung zurück und im
          // Rückwärtslauf wird die virtuelle Zeit kleiner.
          state.latestTickMs = msg.time;

          if (telemetry.epoch !== epoch) {
            // Übergang: sammeln, bis jeder Shard die neue Epoche geliefert
            // hat. Direkt verteilt, stünden im Buffer für einen Tick alte und
            // neue Zeit nebeneinander – Radar, Liste und Karte lesen ihn
            // jederzeit, nicht nur bei einer neuen Revision.
            const previous = state.staged.get(shard);
            if (previous) recycle(shard, previous.buffer);
            state.staged.set(shard, { count: msg.count, buffer: msg.buffer });
            if (state.staged.size === state.shardCount) commitEpoch(state, epoch, false);
            break;
          }

          const src = new Float32Array(msg.buffer);
          scatter(shard, msg.count, src, state.shardCount);
          // Buffer zurückgeben – der Worker füllt ihn beim nächsten Tick erneut,
          // statt 10× pro Sekunde ein neues Megabyte zu allozieren.
          recycle(shard, msg.buffer);

          state.pending.delete(shard);
          completeTickIfReady(state, false);
          break;
        }

        case 'catalog': {
          for (const meta of msg.catalog) catalogIndex.meta[meta.index] = meta;
          if (msg.total > catalogTotal) {
            catalogTotal = msg.total;
            ensureTelemetryCapacity(catalogTotal);
          }
          scheduleFlush();
          break;
        }

        case 'tle':
          // Nur Shard 0 lädt; der Rohtext geht von hier an die Geschwister,
          // damit alle dieselbe Reihenfolge und damit dieselben Indizes sehen.
          for (let i = 1; i < workers.length; i += 1) {
            workers[i].postMessage({ type: 'tle', group: msg.group, text: msg.text });
          }
          break;

        case 'status':
          setStatus(msg.message, msg.loading);
          break;

        case 'trail': {
          const { selectedId, timeBase } = useAppStore.getState();
          // Stale-Guard: Eine Spur für ein Objekt, das nicht mehr gewählt ist,
          // wird verworfen. Sonst überschriebe eine verspätete Antwort die
          // frische Spur der neuen Auswahl, und die bliebe bis zur nächsten
          // Nachführung (OrbitTrail, 12 s virtuelle Zeit) unsichtbar.
          if (msg.noradId !== selectedId) break;
          // Dasselbe für die Zeit: eine Spur, gerechnet vor dem letzten Sprung.
          if (msg.epoch !== timeBase.epoch) break;
          trailState.noradId = msg.noradId;
          trailState.points = msg.points;
          trailState.timeMs = msg.timeMs;
          trailState.version += 1;
          break;
        }

        case 'pass':
          setPasses(msg.noradId, msg.passes, msg.epoch, msg.fromMs);
          break;

        case 'error':
          pushError(msg.message);
          break;
      }
    };

    for (let shard = 0; shard < shardCount; shard += 1) {
      const worker = new Worker(new URL('../workers/sgp4.worker.ts', import.meta.url), {
        type: 'module',
        name: `sgp4-${shard}`,
      });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => handle(shard, event.data);
      worker.onerror = (event) => pushError(`Worker ${shard}: ${event.message}`);
      worker.postMessage({ type: 'init', shardIndex: shard, shardCount });
      worker.postMessage({ type: 'time', base: useAppStore.getState().timeBase });
      workers.push(worker);
    }

    // Fällt ein Shard aus (defektes TLE, gedrosselter Thread), stünde der
    // Himmel still, weil die Revision auf ihn wartet. Der Wachhund gibt den
    // Tick nach dem Vierfachen der Zielrate trotzdem frei.
    //
    // Nach einem Zeitsprung hieße „trotzdem freigeben“: Der fehlende Shard
    // stünde mit Werten der alten Zeit neben den übrigen. `commitEpoch`
    // blendet ihn deshalb aus. Gemessen wird dann ab dem Sprung und am
    // tatsächlichen Takt, falls der langsamer ist als die Zielrate – ein
    // gesunder, nur langsamer Shard soll nicht ausgeblendet werden, weil er
    // seinen ersten Tick der neuen Epoche noch rechnet.
    const watchdog = window.setInterval(() => {
      if (!state.sawTick) return;
      const epoch = useAppStore.getState().timeBase.epoch;
      if (telemetry.epoch !== epoch) {
        if (state.staged.size === 0) return;
        const since = performance.now() - Math.max(state.lastRevisionAt, state.epochChangedAt);
        if (since < Math.max(intervalMs, telemetry.intervalMs) * 4) return;
        commitEpoch(state, epoch, true);
        return;
      }
      if (state.pending.size === 0) return;
      if (performance.now() - state.lastRevisionAt < intervalMs * 4) return;
      completeTickIfReady(state, true);
    }, Math.max(250, intervalMs * 4));

    return () => {
      window.clearInterval(watchdog);
      if (catalogTimer !== null) {
        clearTimeout(catalogTimer);
        catalogTimer = null;
      }
      for (const worker of workers) worker.terminate();
      pool = null;
      started.current = false;
      telemetry.count = 0;
      telemetry.capacity = 0;
      telemetry.data = new Float32Array(0);
    };
  }, [intervalMs, setCatalog, setStatus, pushError, setPasses]);

  useEffect(() => {
    if (!observer) return;
    broadcast({ type: 'observer', observer });
    if (!started.current) {
      broadcast({ type: 'start', intervalMs });
      started.current = true;
    }
  }, [observer, intervalMs]);

  // Strikt getrennt vom Standort-Effekt: Ein Katalog-Reload hängt nicht an
  // jedem GPS-Fix, sonst würde jeder Positionssprung neu geladen.
  useEffect(() => {
    sendTo(0, { type: 'load', groups: activeGroups });
  }, [activeGroups]);

  useEffect(() => {
    engine.setSelected(selectedId);
  }, [selectedId]);

  // Überflugliste: angefordert, sobald die gewählte ID im Katalog steht – bei
  // der Auswahl selbst oder später, wenn das Objekt erst mit einer Gruppe
  // eintrifft. `selectedMeta` wechselt außerdem, wenn ein neu aufgebauter Pool
  // dieselbe ID an anderem Platz führt (er kennt die Anfrage des alten
  // nicht) und wenn echte Bahndaten den Offline-Fallback ersetzen. Eine
  // erneute Wahl desselben Objekts ändert nichts davon und rechnet deshalb
  // nicht noch einmal (store.ts, `select`).
  //
  // `timeEpoch`: Nach einem Zeitsprung hat der Store die Liste schon geleert
  // (`setTimeBase`); ohne neue Anfrage bliebe sie leer.
  //
  // Dazu die Nachführung: Die Liste gilt ab `passFromMs`. Läuft die virtuelle
  // Zeit davor (rückwärts) oder mehr als einen Tag darüber hinaus (Zeitraffer,
  // oder die App bleibt so lange offen), fehlen vorn Überflüge bzw. hinten
  // die Vorschau. Dann wird neu gesucht; die alte Liste bleibt bis zur
  // Antwort stehen.
  useEffect(() => {
    if (selectedMeta === null) return;
    const noradId = selectedMeta.noradId;
    engine.requestPass(noradId);
    let requestedAt = performance.now();
    const id = window.setInterval(() => {
      const { passId, passFromMs } = useAppStore.getState();
      if (passId !== noradId || passFromMs === null) return;
      const now = virtualNow();
      if (now >= passFromMs && now - passFromMs <= PASS_REFRESH_AFTER_MS) return;
      if (performance.now() - requestedAt < PASS_RETRY_MS) return;
      requestedAt = performance.now();
      engine.requestPass(noradId);
    }, 1000);
    return () => window.clearInterval(id);
  }, [selectedMeta, timeEpoch]);
}
