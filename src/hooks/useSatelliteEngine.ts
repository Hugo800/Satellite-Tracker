import { useEffect, useRef } from 'react';
import { GROUP_LOAD_ORDER } from '../data/tleSources';
import { TELEMETRY_STRIDE } from '../math/telemetryLayout';
import { catalogIndex, ensureTelemetryCapacity, telemetry, trailState } from '../state/runtime';
import { useAppStore } from '../state/store';
import type {
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
 * Wächst der Katalog, bleiben alle bisherigen Indizes (und damit Auswahl,
 * Bahnspur und Überflugliste) unverändert gültig.
 */

function pickShardCount(): number {
  const cores = navigator.hardwareConcurrency || 4;
  if (cores <= 2) return 1;
  // Ein Kern bleibt für Main-Thread und Compositor reserviert.
  return Math.max(2, Math.min(6, cores - 1));
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
}

let pool: Pool | null = null;

let timeBase: TimeBase = {
  originRealMs: Date.now(),
  originVirtualMs: Date.now(),
  scale: 1,
};

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

/** Shard, der den globalen Index besitzt. */
const shardOf = (index: number): number => (pool ? index % pool.shardCount : 0);

/** Imperative API des Worker-Pools – bewusst außerhalb von React. */
export const engine = {
  requestTrail(index: number, fromMin = -25, toMin = 70, samples = 220): void {
    sendTo(shardOf(index), { type: 'trail', index, fromMin, toMin, samples });
  },
  requestPass(index: number, searchHours = 48): void {
    sendTo(shardOf(index), { type: 'pass', index, searchHours });
  },
  setTimeScale(value: number): void {
    // Zurück auf Echtzeit heißt: wieder auf die Wanduhr aufsetzen. Sonst
    // behielte die Szene den Vorlauf, den der Zeitraffer angesammelt hat.
    const now = Date.now();
    timeBase = {
      originRealMs: now,
      originVirtualMs: value === 1 ? now : virtualNow(now),
      scale: value,
    };
    broadcast({ type: 'time', base: timeBase });
  },
  reload(groups: SatelliteGroup[]): void {
    sendTo(0, { type: 'load', groups });
  },
  /**
   * Meldet die Auswahl an den Pool. Subpunkt und Bahnhöhe entstehen aus einer
   * iterativen Umkehrung des Erdellipsoids und kosten rund ein Drittel des
   * Ticks; angezeigt werden sie nur für dieses eine Objekt.
   */
  setSelected(index: number | null): void {
    broadcast({ type: 'select', index });
  },
  get shardCount(): number {
    return pool?.shardCount ?? 0;
  },
};

function virtualNow(now = Date.now()): number {
  return timeBase.originVirtualMs + (now - timeBase.originRealMs) * timeBase.scale;
}

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
  telemetry.revision += 1;
}

/* ------------------------------------------------------------------ */
/* Katalog zusammenführen                                               */
/* ------------------------------------------------------------------ */

function rebuildCatalogIndex(catalog: SatelliteMeta[], total: number): void {
  const groupIds = new Uint8Array(total);
  const starlink = new Uint8Array(total);
  const highlight = new Uint8Array(total);

  for (const meta of catalog) {
    if (meta.index >= total) continue;
    groupIds[meta.index] = GROUP_LOAD_ORDER.indexOf(meta.group);
    starlink[meta.index] = meta.group === 'starlink' ? 1 : 0;
    highlight[meta.index] = meta.highlight ? 1 : 0;
  }

  catalogIndex.groupIds = groupIds;
  catalogIndex.starlink = starlink;
  catalogIndex.highlight = highlight;
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
  setCatalog(catalog);
}

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
  const selectedIndex = useAppStore((s) => s.selectedIndex);
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
    };
    telemetry.intervalMs = intervalMs;
    pool = state;

    catalogIndex.meta = [];
    catalogTotal = 0;
    catalogDirty = false;

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
          const src = new Float32Array(msg.buffer);
          scatter(shard, msg.count, src, state.shardCount);
          // Buffer zurückgeben – der Worker füllt ihn beim nächsten Tick erneut,
          // statt 10× pro Sekunde ein neues Megabyte zu allozieren.
          sendTo(shard, { type: 'recycle', buffer: msg.buffer }, [msg.buffer]);

          telemetry.timeMs = Math.max(telemetry.timeMs, msg.time);
          state.pending.delete(shard);
          state.sawTick = true;
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

        case 'trail':
          trailState.index = msg.index;
          trailState.points = msg.points;
          trailState.version += 1;
          break;

        case 'pass':
          setPasses(msg.index, msg.passes);
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
      worker.postMessage({ type: 'time', base: timeBase });
      workers.push(worker);
    }

    // Fällt ein Shard aus (defektes TLE, gedrosselter Thread), stünde der
    // Himmel still, weil die Revision auf ihn wartet. Der Wachhund gibt den
    // Tick nach dem Vierfachen der Zielrate trotzdem frei.
    const watchdog = window.setInterval(() => {
      if (!state.sawTick) return;
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
    engine.setSelected(selectedIndex);
  }, [selectedIndex]);
}
