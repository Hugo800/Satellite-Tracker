/// <reference lib="webworker" />
/**
 * SGP4-Worker – eine Kachel („Shard“) des Propagations-Pools.
 *
 * Jede Instanz sieht denselben, in identischer Reihenfolge aufgebauten Katalog
 * und ist für die globalen Indizes mit `index % shardCount === shardIndex`
 * zuständig. Weil die Zuteilung rein über den Modulo läuft, bleiben alle
 * Indizes stabil, während der Katalog wächst.
 *
 * Nach außen spricht der Shard trotzdem NORAD-IDs: Auswahl, Bahnspur und
 * Überflug kommen als ID herein und gehen als ID hinaus. Welcher Platz dazu
 * gehört, weiß nur dieser Katalog (`knownIds`) – ein neu aufgebauter Pool
 * vergibt die Plätze anders.
 *
 * Shard 0 ist zusätzlich der Lader: Nur er ruft CelesTrak ab (sonst liefen N
 * parallele Abrufe derselben URL ins Rate-Limit) und reicht den Rohtext über
 * den Main-Thread an die übrigen Shards weiter.
 *
 * Der Main-Thread erhält ausschließlich flache, transferierbare
 * Float32Array-Buffer – und gibt sie zum Wiederverwenden zurück.
 */
import { twoline2satrec } from 'satellite.js';
import type { SatRec } from 'satellite.js';
import {
  FALLBACK_TLE,
  GROUP_LOAD_ORDER,
  HIGHLIGHT_NORAD_IDS,
  TLE_SOURCES,
  normalizeNoradId,
} from '../data/tleSources';
import { geoToObserverGd, normalizeAngle } from '../math/coords';
import {
  buildObserverFrame,
  buildTickFrame,
  predictPasses,
  propagateEphemeris,
  propagateInto,
} from '../math/propagation';
import type { ObserverFrame } from '../math/propagation';
import { sunEciUnitVector } from '../math/sun';
import { standardMagnitudeFor } from '../math/visibility';
import {
  TELEMETRY_STRIDE,
  T_ALT,
  T_AZ,
  T_ECLIPSED,
  T_EL,
  T_LAT,
  T_LON,
  T_MAG,
  T_RANGE,
  T_SPEED,
} from '../math/telemetryLayout';
import type {
  GeoCoord,
  NoradId,
  ObserverGd,
  SatelliteGroup,
  SatelliteMeta,
  TimeBase,
  WorkerRequest,
  WorkerResponse,
} from '../types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const OFFSETS = {
  az: T_AZ,
  el: T_EL,
  range: T_RANGE,
  alt: T_ALT,
  speed: T_SPEED,
  eclipsed: T_ECLIPSED,
  lat: T_LAT,
  lon: T_LON,
  mag: T_MAG,
} as const;

interface Entry {
  meta: SatelliteMeta;
  satrec: SatRec;
}

/* ------------------------------------------------------------------ */
/* Shard-Zustand                                                        */
/* ------------------------------------------------------------------ */

let shardIndex = 0;
let shardCount = 1;
/** Ist dieser Shard der Lader? Nur er darf CelesTrak abrufen. */
let isLoader = true;

/**
 * Eigene Einträge, dicht gepackt: Slot `k` entspricht dem globalen Index
 * `shardIndex + k * shardCount`. Lücken (defektes TLE) bleiben `null`, damit
 * die Zuordnung rechnerisch bleibt und ohne Map auskommt.
 */
const own: Array<Entry | null> = [];
/** Globaler Index je NORAD-ID – in *jedem* Shard identisch aufgebaut. */
const knownIds = new Map<NoradId, number>();
/** Aus dem Offline-Fallback erzeugte IDs, die echte Daten überschreiben dürfen. */
const provisionalIds = new Set<NoradId>();
let nextIndex = 0;

let observer: ObserverGd | null = null;
let observerFrame: ObserverFrame | null = null;
/** Ausgewähltes Objekt, oder null. */
let selectedId: NoradId | null = null;
/**
 * Eigener Slot des ausgewählten Objekts, oder -1 (nichts gewählt, anderer
 * Shard, ID noch unbekannt). Aufgelöst bei der Auswahl und nach jedem
 * Einlesen, nicht je Tick – `tick()` vergleicht damit nur Zahlen.
 */
let selectedSlot = -1;

let timer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let baseIntervalMs = 100;
let running = false;

/** Bis zur ersten `time`-Nachricht, die der Pool gleich nach `init` schickt: Echtzeit. */
const startedAtMs = Date.now();
let timeBase: TimeBase = { originRealMs: startedAtMs, originVirtualMs: startedAtMs, scale: 1, epoch: 0 };

/** Freigegebene Buffer des Main-Threads – vermeidet eine Allokation je Tick. */
const bufferPool: ArrayBuffer[] = [];

/** Gestaffelte Wartezeiten, bis gedrosselte CelesTrak-Gruppen erneut versucht werden. */
const RETRY_DELAYS_MS = [45_000, 3 * 60_000, 10 * 60_000];
let retryStep = 0;
/** Abstand zwischen zwei Gruppenabrufen – hält uns unter dem Rate-Limit. */
const GROUP_GAP_MS = 1500;

function post(message: WorkerResponse, transfer?: Transferable[]): void {
  ctx.postMessage(message, transfer ?? []);
}

/** Virtuelle Zeit als reine Funktion – dadurch rechnen alle Shards dieselbe Epoche. */
function virtualNow(): number {
  return timeBase.originVirtualMs + (Date.now() - timeBase.originRealMs) * timeBase.scale;
}

const ownSlotFor = (globalIndex: number): number => (globalIndex - shardIndex) / shardCount;
const isMine = (globalIndex: number): boolean => globalIndex % shardCount === shardIndex;

/** Eigener Slot einer NORAD-ID, oder -1, wenn ein anderer Shard sie führt oder sie unbekannt ist. */
function ownSlotOf(noradId: NoradId): number {
  const index = knownIds.get(noradId);
  return index !== undefined && isMine(index) ? ownSlotFor(index) : -1;
}

/**
 * Die Auswahl kann eine ID nennen, die erst mit einer späteren Gruppe
 * eintrifft. Deshalb auch nach jedem Einlesen neu auflösen – sonst blieben
 * Subpunkt und Bahnhöhe des Objekts NaN, bis jemand neu wählt.
 */
function resolveSelectedSlot(): void {
  selectedSlot = selectedId === null ? -1 : ownSlotOf(selectedId);
}

/* ------------------------------------------------------------------ */
/* Katalog                                                              */
/* ------------------------------------------------------------------ */

function makeMeta(
  index: number,
  name: string,
  noradId: NoradId,
  group: SatelliteGroup,
  satrec: SatRec,
): SatelliteMeta {
  const meanMotionRadMin = satrec.no;
  return {
    index,
    name: name.trim(),
    noradId,
    group,
    highlight: HIGHLIGHT_NORAD_IDS.has(noradId),
    periodMin: meanMotionRadMin > 0 ? (2 * Math.PI) / meanMotionRadMin : 0,
    inclinationDeg: (satrec.inclo * 180) / Math.PI,
    standardMagnitude: standardMagnitudeFor(noradId, group),
  };
}

/**
 * Nimmt einen TLE-Block in den Katalog auf.
 *
 * Bewusst **ohne** Mengenbegrenzung – im Modus „Alle“ soll ausnahmslos jedes
 * Objekt propagiert werden. Jede NORAD-ID bekommt genau einen, dauerhaft
 * gültigen Index; die Gruppe des ersten Auftretens gewinnt, weil die
 * spezifischen Gruppen vor dem Gesamtkatalog geladen werden.
 *
 * @returns Metadaten der in diesem Shard neu entstandenen Objekte.
 */
function parseTle(text: string, group: SatelliteGroup): SatelliteMeta[] {
  const lines = text.split(/\r?\n/);
  const added: SatelliteMeta[] = [];

  for (let i = 0; i + 2 < lines.length; i += 1) {
    const name = lines[i].trim();
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!l1 || !l2 || !l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;

    const noradId = normalizeNoradId(l1.slice(2, 7));
    if (!noradId) continue;
    // Der Dreierblock ist verbraucht – die beiden Elementzeilen nicht erneut prüfen.
    i += 2;

    const existing = knownIds.get(noradId);
    let index: number;

    if (existing !== undefined) {
      // Frische Daten dürfen einen Offline-Platzhalter an *derselben* Stelle
      // ersetzen; alles andere bleibt, wie es ist.
      if (!provisionalIds.has(noradId)) continue;
      provisionalIds.delete(noradId);
      index = existing;
    } else {
      index = nextIndex;
      nextIndex += 1;
      knownIds.set(noradId, index);
    }

    if (!isMine(index)) continue;

    const slot = ownSlotFor(index);
    let satrec: SatRec;
    try {
      satrec = twoline2satrec(l1, l2);
    } catch {
      own[slot] = null;
      continue;
    }
    if (!satrec || (satrec as unknown as { error?: number }).error) {
      own[slot] = null;
      continue;
    }

    const meta = makeMeta(index, name || `NORAD ${noradId}`, noradId, group, satrec);
    own[slot] = { satrec, meta };
    added.push(meta);
  }

  // Lücken auffüllen, damit `own.length` der Slot-Zahl entspricht.
  const slots = Math.ceil(Math.max(0, nextIndex - shardIndex) / shardCount);
  while (own.length < slots) own.push(null);

  return added;
}

function ingest(text: string, group: SatelliteGroup): void {
  const added = parseTle(text, group);
  resolveSelectedSlot();
  post({
    type: 'catalog',
    shardIndex,
    offset: shardIndex,
    total: nextIndex,
    catalog: added,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isTleBody = (text: string) => text.includes('\n1 ') && text.includes('\n2 ');

const TLE_CACHE = 'tle-raw-v1';

async function readCachedTle(url: string): Promise<string> {
  try {
    const cache = await caches.open(TLE_CACHE);
    const hit = await cache.match(url);
    return hit ? await hit.text() : '';
  } catch {
    return '';
  }
}

async function writeCachedTle(url: string, text: string): Promise<void> {
  try {
    const cache = await caches.open(TLE_CACHE);
    await cache.put(url, new Response(text, { headers: { 'content-type': 'text/plain' } }));
  } catch {
    /* CacheStorage nicht verfügbar (z. B. unsicherer Kontext) – kein Problem. */
  }
}

/**
 * CelesTrak beantwortet einen erneuten Abruf innerhalb des 2-Stunden-Update-
 * Intervalls mit HTTP 403 („GP data has not updated…“). Das ist kein Fehler,
 * sondern die Aufforderung, die zuletzt geladene Fassung weiterzuverwenden –
 * deshalb halten wir jede erfolgreiche Antwort selbst in der CacheStorage.
 */
async function fetchTle(source: (typeof TLE_SOURCES)[SatelliteGroup]): Promise<string> {
  let lastError = 'unbekannt';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(1500 * attempt);
    try {
      const res = await fetch(source.url, {
        mode: 'cors',
        cache: 'default',
        signal: AbortSignal.timeout(source.timeoutMs),
      });

      if (res.status === 403 || res.status === 429) {
        const cached = await readCachedTle(source.url);
        if (isTleBody(cached)) return cached;
        lastError = 'Update-Intervall aktiv, keine zwischengespeicherte Fassung';
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!isTleBody(text)) throw new Error('Unerwartetes Format');
      await writeCachedTle(source.url, text);
      return text;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  const cached = await readCachedTle(source.url);
  if (isTleBody(cached)) return cached;
  throw new Error(lastError);
}

/**
 * Lädt Gruppen nach. Der Katalog wächst dabei ausschließlich an – bestehende
 * Indizes bleiben gültig, ein Reset findet nicht statt.
 */
async function loadGroups(groups: SatelliteGroup[]): Promise<void> {
  if (!isLoader) return;

  if (nextIndex === 0) {
    // Sofort etwas Sichtbares: Kernobjekte aus dem eingebauten Katalog. Sie
    // werden an Ort und Stelle durch echte Daten ersetzt, sobald sie eintreffen.
    for (const line of FALLBACK_TLE.split(/\r?\n/)) {
      if (line.startsWith('1 ')) provisionalIds.add(normalizeNoradId(line.slice(2, 7)));
    }
    post({ type: 'tle', group: 'stations', text: FALLBACK_TLE });
    ingest(FALLBACK_TLE, 'stations');
  }

  post({ type: 'status', message: 'Lade TLE-Kataloge …', loading: true });

  const failed: SatelliteGroup[] = [];

  for (const group of groups) {
    const source = TLE_SOURCES[group];
    try {
      const text = await fetchTle(source);
      // Erst an die Geschwister verteilen, dann selbst einlesen: So sehen alle
      // Shards die Gruppen in derselben Reihenfolge und vergeben dieselben Indizes.
      post({ type: 'tle', group, text });
      ingest(text, group);
      post({
        type: 'status',
        message: `${source.label}: ${nextIndex.toLocaleString('de-DE')} Objekte im Katalog`,
        loading: true,
      });
    } catch (err) {
      failed.push(group);
      post({
        type: 'error',
        message: `${source.label} noch nicht verfügbar – ${(err as Error).message}. Wird automatisch nachgeladen.`,
      });
    }
    // Abstand zwischen den Gruppen hält uns unter dem Rate-Limit.
    await sleep(GROUP_GAP_MS);
  }

  if (nextIndex === 0) {
    post({ type: 'tle', group: 'stations', text: FALLBACK_TLE });
    ingest(FALLBACK_TLE, 'stations');
    post({ type: 'error', message: 'Offline-Fallback aktiv – nur Kernobjekte verfügbar.' });
  }

  post({
    type: 'status',
    message: `${nextIndex.toLocaleString('de-DE')} Objekte im Katalog`,
    loading: false,
  });

  // CelesTrak gibt Gruppen erst nach Ablauf des Update-Intervalls wieder frei;
  // ein späterer Versuch holt sie nach, ohne den Nutzer zu behelligen.
  if (failed.length > 0) {
    if (retryTimer === null) {
      const delay = RETRY_DELAYS_MS[Math.min(retryStep, RETRY_DELAYS_MS.length - 1)];
      retryStep += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void loadGroups(failed);
      }, delay);
    }
  } else {
    retryStep = 0;
  }
}

function loadCatalog(groups: SatelliteGroup[]): Promise<void> {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryStep = 0;
  const ordered = GROUP_LOAD_ORDER.filter((g) => groups.includes(g));
  return loadGroups(ordered.length > 0 ? ordered : groups);
}

/* ------------------------------------------------------------------ */
/* Propagations-Schleife                                                */
/* ------------------------------------------------------------------ */

function takeBuffer(byteLength: number): Float32Array {
  for (let i = bufferPool.length - 1; i >= 0; i -= 1) {
    if (bufferPool[i].byteLength === byteLength) {
      const [buffer] = bufferPool.splice(i, 1);
      return new Float32Array(buffer);
    }
  }
  // Der Katalog ist gewachsen: alte Größen fliegen raus statt sich anzusammeln.
  bufferPool.length = 0;
  return new Float32Array(byteLength / 4);
}

function tick(): number {
  const frame = observerFrame;
  if (!frame || own.length === 0) return 0;

  const startedAt = performance.now();
  const timeMs = virtualNow();
  // Epoche zusammen mit der Zeit festhalten: Der Main-Thread erkennt daran
  // einen Tick, der noch mit der Basis vor einem Sprung gerechnet wurde.
  const epoch = timeBase.epoch;
  const date = new Date(timeMs);
  const tickFrame = buildTickFrame(date, observer as ObserverGd);

  const count = own.length;
  const buffer = takeBuffer(count * TELEMETRY_STRIDE * 4);

  // Nur der eigene Slot des ausgewählten Objekts braucht den Subpunkt. Als
  // lokale Konstante, wie vor der Umstellung auf IDs: Die Schleife liest ihn
  // je Objekt.
  const selected = selectedSlot;

  for (let k = 0; k < count; k += 1) {
    const base = k * TELEMETRY_STRIDE;
    const entry = own[k];
    if (
      !entry ||
      !propagateInto(
        entry.satrec,
        frame,
        tickFrame,
        entry.meta.standardMagnitude,
        buffer,
        base,
        k === selected,
        OFFSETS,
      )
    ) {
      // Der Buffer ist recycelt – ohne Löschen stünden hier die Werte des
      // vorigen Takts. `range = NaN` genügt zwar allen Verbrauchern als
      // Ausschlusskriterium, aber Altdaten in einem Buffer sind eine Falle.
      buffer.fill(0, base, base + TELEMETRY_STRIDE);
      buffer[base + T_EL] = -Math.PI / 2;
      buffer[base + T_RANGE] = Number.NaN;
    }
  }

  const durationMs = performance.now() - startedAt;

  post(
    {
      type: 'tick',
      shardIndex,
      offset: shardIndex,
      count,
      time: timeMs,
      epoch,
      durationMs,
      buffer: buffer.buffer as ArrayBuffer,
    },
    [buffer.buffer as ArrayBuffer],
  );

  return durationMs;
}

/**
 * Selbsttaktende Schleife statt `setInterval`.
 *
 * Auf schwacher Hardware oder bei einem sehr großen Shard kann ein Tick länger
 * dauern als das Zielintervall. `setInterval` würde die Aufrufe dann stapeln,
 * bis der Worker nur noch propagiert und auf Nachrichten (Auswahl, Bahnspur,
 * Überflugsuche) nicht mehr reagiert. Hier wächst stattdessen der Abstand mit,
 * sodass höchstens der unten gesetzte Anteil des Threads verbraucht wird.
 */
const MAX_DUTY_CYCLE = 0.65;

/**
 * Obergrenze der Pause nach einem Tick.
 *
 * Die Taktdauer misst `performance.now()`, eine monotone Uhr. Sie läuft
 * weiter, während iOS den Prozess der Seite anhält (App im Hintergrund,
 * Display aus). Fällt das Anhalten in einen laufenden Tick, zählt die ganze
 * Pause als Rechenzeit, und die Formel oben verlangt danach noch gut die
 * Hälfte davon als Wartezeit – nach einer Nacht also Stunden. So lange liefert
 * der Shard keinen Tick, beantwortet aber weiter Nachrichten. Genau das zeigte
 * ein iPhone am 24.09.2026: Die Überflugliste kam, die Telemetrie des
 * gewählten Objekts war 6 h 14 min alt, und Bahnhöhe und Subpunkt blieben
 * NaN, weil der Pool sie erst im Tick nach der Auswahl rechnet
 * (scripts/verify-selection.ts, Abschnitte 0 und D).
 *
 * Eine Sekunde lässt echte Taktdauern bis gut 1,8 s unberührt. Längere sind
 * nicht zu erwarten: `npm run bench:propagation` misst für 12 000 Objekte
 * rund 20 ms auf einem Desktop-Kern, und der Main-Thread kappt die
 * Interpolationsdauer ohnehin bei 2 s.
 */
const MAX_PAUSE_MS = 1000;

function schedule(): void {
  if (!running) return;
  const durationMs = tick();
  const wait = Math.max(baseIntervalMs, durationMs / MAX_DUTY_CYCLE) - durationMs;
  timer = setTimeout(schedule, Math.min(MAX_PAUSE_MS, Math.max(8, wait)));
}

/* ------------------------------------------------------------------ */
/* Bahnspur                                                             */
/* ------------------------------------------------------------------ */

function buildTrail(noradId: NoradId, fromMin: number, toMin: number, samples: number): void {
  const slot = ownSlotOf(noradId);
  if (slot < 0) return;
  const entry = own[slot];
  if (!entry || !observer || samples < 2) return;

  const points = new Float32Array(samples * 3);
  const spanMs = (toMin - fromMin) * 60_000;
  const timeMs = virtualNow();
  const epoch = timeBase.epoch;
  const sunUnit = sunEciUnitVector(new Date(timeMs));

  for (let i = 0; i < samples; i += 1) {
    const t = timeMs + fromMin * 60_000 + (spanMs * i) / (samples - 1);
    const eph = propagateEphemeris(entry.satrec, new Date(t), observer, sunUnit);
    if (!eph) continue;
    const az = normalizeAngle(eph.azimuth);
    const cosEl = Math.cos(eph.elevation);
    points[i * 3 + 0] = cosEl * Math.sin(az);
    points[i * 3 + 1] = Math.sin(eph.elevation);
    points[i * 3 + 2] = -cosEl * Math.cos(az);
  }

  post({ type: 'trail', noradId, points, timeMs, epoch }, [points.buffer]);
}

/* ------------------------------------------------------------------ */
/* Nachrichten                                                          */
/* ------------------------------------------------------------------ */

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'init':
      shardIndex = msg.shardIndex;
      shardCount = msg.shardCount;
      isLoader = msg.shardIndex === 0;
      break;

    case 'load':
      void loadCatalog(msg.groups);
      break;

    case 'tle':
      // Weitergereichter Rohtext des Laders – nur die Nicht-Lader lesen ihn ein.
      if (!isLoader) {
        if (msg.group === 'stations' && nextIndex === 0) {
          for (const line of msg.text.split(/\r?\n/)) {
            if (line.startsWith('1 ')) provisionalIds.add(normalizeNoradId(line.slice(2, 7)));
          }
        }
        ingest(msg.text, msg.group);
      }
      break;

    case 'observer':
      observer = geoToObserverGd(msg.observer as GeoCoord);
      observerFrame = buildObserverFrame(observer);
      break;

    case 'start':
      baseIntervalMs = msg.intervalMs;
      if (running) break;
      running = true;
      schedule();
      break;

    case 'stop':
      running = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      break;

    case 'time':
      // Gilt ab dem nächsten Tick. Die Nachricht wartet, bis ein laufender
      // Tick fertig ist; dieser und jeder davor meldet noch die alte Epoche.
      timeBase = msg.base;
      break;

    case 'select':
      selectedId = msg.noradId;
      resolveSelectedSlot();
      break;

    case 'recycle':
      // Höchstens zwei Buffer vorhalten – mehr bringt nichts und bindet Speicher.
      if (bufferPool.length < 2) bufferPool.push(msg.buffer);
      break;

    case 'trail':
      buildTrail(msg.noradId, msg.fromMin, msg.toMin, msg.samples);
      break;

    case 'pass': {
      const slot = ownSlotOf(msg.noradId);
      if (slot < 0) break;
      const entry = own[slot];
      const fromMs = virtualNow();
      const { epoch } = timeBase;
      if (!entry || !observer) {
        post({ type: 'pass', noradId: msg.noradId, passes: [], fromMs, epoch });
        break;
      }
      const passes = predictPasses(entry.satrec, observer, {
        fromMs,
        searchHours: msg.searchHours,
        stepSec: 30,
        minElevationDeg: 1,
        standardMagnitude: entry.meta.standardMagnitude,
      });
      post({ type: 'pass', noradId: msg.noradId, passes, fromMs, epoch });
      break;
    }
  }
};
