/**
 * Prüft die virtuelle Zeit über den ganzen Weg `engine` → Worker-Pool →
 * Hook → Store → Szene: Sprünge in beide Richtungen, Zeitraffer,
 * Rückwärtslauf und die Rückkehr zur Echtzeit. Anlass ist die geplante
 * Zeitmaschine; ihre Oberfläche ist nicht Teil der Prüfung, nur die API
 * darunter (`engine.setTimeScale`, `engine.jumpTo`, `engine.resetToRealTime`).
 *
 * Abschnitte:
 *   A  Ausgangslage in Echtzeit: Feld interpoliert, Spuren entstehen.
 *   B  Sprung 6 h zurück; ein Shard bekommt die Zeitnachricht 200 ms später
 *      und liefert so lange Ticks der alten Zeit. Kein Stand mischt die
 *      Epochen, Telemetrie aller Shards stimmt, `telemetry.timeMs` folgt,
 *      keine Interpolation über den Sprung, danach interpoliert das Feld
 *      wieder, Spuren beginnen neu und tasten wieder ab, Sonne und Mond
 *      folgen.
 *   C  Wachhund: Ein Shard hängt 1,5 s, während gesprungen wird. Der Himmel
 *      läuft weiter, der Shard fehlt, statt in der alten Zeit zu stehen. Kehrt
 *      er zurück, fliegt keines seiner Objekte aus der Tiefe herauf, und keine
 *      Spur beginnt dort.
 *   D  Sprünge 6 h vor, 30 Tage vor, 30 Tage zurück.
 *   E  Rückwärtslauf ×−1 und ×−60, Zeitraffer ×60 und ×600.
 *   F  Zurück zur Echtzeit.
 *   G  Überflugliste: nach dem Sprung für die neue Zeit, verspätete Listen
 *      der alten Zeit verworfen, Nachführung im Zeitraffer und rückwärts.
 *   H  Bahnspur des gewählten Objekts, angefordert von OrbitTrail selbst:
 *      nach dem Sprung geleert und neu angefordert, verspätete Spur der alten
 *      Zeit verworfen, neue Spur zur neuen Zeit, Linie sichtbar; bei ×600
 *      nach virtueller Zeit nachgeführt; auch nach einem Sprung um Sekunden
 *      sofort neu angefordert.
 *   I  Countdown der Überflugliste in virtueller Zeit.
 *   J  Geschwindigkeit: `setTimeScale` hält die virtuelle Zeit stetig und die
 *      Epoche fest, ×1 bleibt in der virtuellen Zeit, Pause steht,
 *      `resetToRealTime` kehrt auch aus einem Sprung bei ×1 zur Wanduhr zurück.
 *
 * Referenz ist satellite.js (`propagate`, `gstime`, `ecfToLookAngles`) bzw.
 * astronomy-engine (`Equator`, `Horizon`, `Illumination`) direkt – nicht
 * src/math und nicht src/hooks.
 *
 * Aufbau wie scripts/verify-selection.ts: Shards als `node:worker_threads`
 * mit dem gebündelten Worker, Hook, SatelliteField, SatelliteTrails und
 * OrbitTrail im echten Reconciler von React Three Fiber (frameloop 'never',
 * eigene Bildpumpe). Nach jeder Worker-Nachricht, die der Hook verarbeitet hat,
 * wird der zusammengeführte Stand in `telemetry.data` klassifiziert: Jeder
 * Shard muss exakt einem seiner zuletzt gesendeten Ticks entsprechen, und
 * dessen Zeit liegt entweder auf der alten oder auf der neuen Zeitbasis.
 *
 * Aufruf: npm run verify:timetravel – einzelne Abschnitte mit
 * `TIME_ONLY=BG npm run verify:timetravel` (A läuft immer).
 */
import { Fragment, createElement, type ReactElement } from 'react';
import { act, advance, createRoot, extend, type RootState } from '@react-three/fiber';
import { Worker as NodeWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import type { BufferAttribute, BufferGeometry, Object3D } from 'three';
import type { Line2 } from 'three-stdlib';
import type { StoreApi, UseBoundStore } from 'zustand';
import { ecfToLookAngles, eciToEcf, gstime, propagate, twoline2satrec, type SatRec } from 'satellite.js';
import { Body, Equator, Horizon, Illumination, Observer } from 'astronomy-engine';
import { OrbitTrail } from '../src/components/canvas/OrbitTrail';
import { SatelliteField } from '../src/components/canvas/SatelliteField';
import { SatelliteTrails } from '../src/components/canvas/SatelliteTrails';
import { FALLBACK_TLE, normalizeNoradId } from '../src/data/tleSources';
import { useCelestialBodies } from '../src/hooks/useCelestialBodies';
import { engine, useSatelliteEngine } from '../src/hooks/useSatelliteEngine';
import { catalogIndex, readSample, telemetry, trailState } from '../src/state/runtime';
import { isRealtime, useAppStore, virtualNow, virtualTimeAt } from '../src/state/store';
import { formatCountdown, passCountdown } from '../src/utils/format';
import type { PassPrediction, TimeBase } from '../src/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let checks = 0;
let failures = 0;

function expect(label: string, ok: boolean, detail: string): void {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${label}: ${detail}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}: ${detail}`);
  }
}

const ONLY = process.env.TIME_ONLY ?? '';
const runs = (section: string): boolean => ONLY === '' || ONLY.includes(section);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const f = (value: number, digits = 1): string =>
  Number.isFinite(value) ? value.toFixed(digits).replace('.', ',') : String(value);
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
/** Abstand in Stunden, lesbar mit Vorzeichen. */
const hours = (ms: number) => `${ms >= 0 ? '+' : ''}${f(ms / HOUR, 2)} h`;

async function waitFor(label: string, condition: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      console.error(`    Zeitüberschreitung nach ${timeoutMs} ms: ${label}`);
      return false;
    }
    await sleep(10);
  }
  return true;
}

/** Leipzig, wie in scripts/verify-selection.ts. */
const OBSERVER = { latitudeDeg: 51.389, longitudeDeg: 12.356, altitudeKm: 0.12 };
const REF_OBSERVER = {
  latitude: (OBSERVER.latitudeDeg * Math.PI) / 180,
  longitude: (OBSERVER.longitudeDeg * Math.PI) / 180,
  height: OBSERVER.altitudeKm,
};

/* ------------------------------------------------------------------ */
/* TLE-Sätze und Zeitpunkte                                             */
/* ------------------------------------------------------------------ */

type Tle = [string, string, string];

function checksum(line: string): number {
  let sum = 0;
  for (const ch of line) {
    if (ch >= '0' && ch <= '9') sum += Number(ch);
    else if (ch === '-') sum += 1;
  }
  return sum % 10;
}

interface Elements {
  name: string;
  norad: string;
  intl: string;
  inclination: number;
  raan: number;
  eccentricity: number;
  argPerigee: number;
  meanAnomaly: number;
  meanMotion: number;
  bstar: string;
}

function makeTle(el: Elements, epochMs: number): Tle {
  const date = new Date(epochMs);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = 1 + (epochMs - yearStart) / 86_400_000;
  const epoch = `${String(date.getUTCFullYear() % 100).padStart(2, '0')}${day.toFixed(8).padStart(12, '0')}`;
  const body1 = `1 ${el.norad}U ${el.intl.padEnd(8)} ${epoch}  .00000000  00000+0 ${el.bstar} 0  999`;
  const ecc = Math.round(el.eccentricity * 1e7).toString().padStart(7, '0');
  const body2 =
    `2 ${el.norad} ${el.inclination.toFixed(4).padStart(8)} ${el.raan.toFixed(4).padStart(8)} ${ecc} ` +
    `${el.argPerigee.toFixed(4).padStart(8)} ${el.meanAnomaly.toFixed(4).padStart(8)} ` +
    `${el.meanMotion.toFixed(8).padStart(11)}${'1'.padStart(5)}`;
  return [el.name, `${body1}${checksum(body1)}`, `${body2}${checksum(body2)}`];
}

const block = (lines: Tle) => `${lines.join('\n')}\n`;

/** Epoche aller Sätze und Bezug aller Sprungziele. */
const T0 = Date.now();
const J_PAST = T0 - 6 * HOUR;
const J_FUT = T0 + 6 * HOUR;
const J_30F = T0 + 30 * DAY;
const J_30B = T0 - 30 * DAY;
const J_WATCHDOG = T0 + 3 * HOUR;

/* ------------------------------------------------------------------ */
/* Referenz: satellite.js und astronomy-engine direkt                   */
/* ------------------------------------------------------------------ */

type Vec = [number, number, number];

/** Blickrichtung wie in SatelliteField/SatelliteTrails: x Ost, y oben, −z Nord. */
function direction(azimuth: number, elevation: number): Vec {
  const cosEl = Math.cos(elevation);
  return [cosEl * Math.sin(azimuth), Math.sin(elevation), -cosEl * Math.cos(azimuth)];
}

function angleDeg(a: Vec, b: Vec): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = Math.hypot(...a) * Math.hypot(...b);
  return (Math.acos(Math.min(1, Math.max(-1, dot / norm))) * 180) / Math.PI;
}

interface Truth {
  azimuth: number;
  elevation: number;
  rangeKm: number;
  dir: Vec;
}

const satrecCache = new Map<string, SatRec>();

function truth(tle: Tle, ms: number): Truth | null {
  const key = `${tle[1]}\n${tle[2]}`;
  let satrec = satrecCache.get(key);
  if (!satrec) {
    satrec = twoline2satrec(tle[1], tle[2]);
    satrecCache.set(key, satrec);
  }
  const date = new Date(ms);
  const pv = propagate(satrec, date);
  const position = pv.position;
  if (!position || typeof position === 'boolean') return null;
  const look = ecfToLookAngles(REF_OBSERVER, eciToEcf(position, gstime(date)));
  return {
    azimuth: look.azimuth,
    elevation: look.elevation,
    rangeKm: look.rangeSat,
    dir: direction(look.azimuth, look.elevation),
  };
}

const refObserver = new Observer(OBSERVER.latitudeDeg, OBSERVER.longitudeDeg, OBSERVER.altitudeKm * 1000);

/** Sonne bzw. Mond als Blickrichtung zur Zeit `ms`. */
function bodyRef(body: Body, ms: number): { altitudeDeg: number; azimuthDeg: number; dir: Vec } {
  const date = new Date(ms);
  const eq = Equator(body, date, refObserver, true, true);
  const hor = Horizon(date, refObserver, eq.ra, eq.dec, 'normal');
  return {
    altitudeDeg: hor.altitude,
    azimuthDeg: hor.azimuth,
    dir: direction((hor.azimuth * Math.PI) / 180, (hor.altitude * Math.PI) / 180),
  };
}

/* ------------------------------------------------------------------ */
/* Katalog                                                              */
/* ------------------------------------------------------------------ */

/**
 * Sucht Knoten und Anomalie so, dass das Objekt zu allen `times` möglichst
 * hoch steht. Prüfungen an Spuren brauchen Objekte über dem Horizont.
 */
function designVisible(base: Elements, times: number[], stepDeg: number): { el: Elements; minElDeg: number } {
  let best = { minEl: Number.NEGATIVE_INFINITY, raan: 0, meanAnomaly: 0 };
  for (let raan = 0; raan < 360; raan += stepDeg) {
    for (let meanAnomaly = 0; meanAnomaly < 360; meanAnomaly += stepDeg) {
      const tle = makeTle({ ...base, raan, meanAnomaly }, T0);
      let minEl = Number.POSITIVE_INFINITY;
      for (const t of times) {
        const r = truth(tle, t);
        minEl = Math.min(minEl, r ? r.elevation : Number.NEGATIVE_INFINITY);
        if (minEl < best.minEl) break;
      }
      if (minEl > best.minEl) best = { minEl, raan, meanAnomaly };
    }
  }
  return { el: { ...base, raan: best.raan, meanAnomaly: best.meanAnomaly }, minElDeg: (best.minEl * 180) / Math.PI };
}

const ISS: Elements = {
  name: 'ISS (ZARYA)',
  norad: '25544',
  intl: '98067A',
  inclination: 51.64,
  raan: 208.9163,
  eccentricity: 0.0002571,
  argPerigee: 75.4322,
  meanAnomaly: 284.7009,
  meanMotion: 15.50377579,
  bstar: ' 30177-3',
};

/**
 * LEO über Leipzig im Fenster um J_PAST: Abschnitt B braucht dort ein
 * bewegtes Objekt am Himmel, Abschnitt E dasselbe im Rückwärtslauf bis
 * 3 min vor J_PAST.
 */
const LEO_VIS = designVisible(
  {
    name: 'LEO SICHTBAR',
    norad: '61001',
    intl: '26030A',
    inclination: 53,
    raan: 0,
    eccentricity: 0.0005,
    argPerigee: 0,
    meanAnomaly: 0,
    meanMotion: 15.2,
    bstar: ' 10000-4',
  },
  [J_PAST - 4 * 60_000, J_PAST - 2 * 60_000, J_PAST, J_PAST + 30_000],
  4,
);

/**
 * Langsam wandernd: äquatoriale Kreisbahn mit 23,5 h Umlaufzeit, also knapp
 * unter geostationär. In 6 h verschiebt sie sich am Himmel um gut ein Grad –
 * kürzer als `MAX_TRAIL_ARC` (4°). Verbände eine Spur ihre Stützstelle vor
 * dem Sprung mit der danach, würde das Segment gezeichnet; bei schnellen
 * Objekten schnitte es die Bogengrenze ohnehin ab.
 */
const SLOW = designVisible(
  {
    name: 'SLOW DRIFT',
    norad: '61002',
    intl: '26031A',
    inclination: 0,
    raan: 0,
    eccentricity: 0,
    argPerigee: 0,
    meanAnomaly: 0,
    meanMotion: 24 / 23.5,
    bstar: ' 00000+0',
  },
  [T0, T0 + 120_000, J_PAST],
  2,
);

/**
 * MEO wie BEIDOU-3 M16, über Leipzig bei J_PAST. Bewegt sich rund 0,01°/s:
 * langsam genug, dass eine Spur ihre ganze Historie zeigt, schnell genug, um
 * Stützstellen zeitlich zuzuordnen (Abschnitt E, Richtungsumkehr).
 */
const MEO_VIS = designVisible(
  {
    name: 'MEO SICHTBAR',
    norad: '61003',
    intl: '26032A',
    inclination: 54,
    raan: 0,
    eccentricity: 0.0006,
    argPerigee: 30,
    meanAnomaly: 0,
    meanMotion: 1.86232488,
    bstar: ' 00000+0',
  },
  [J_PAST, J_PAST + 20_000],
  5,
);

function fillers(count: number): string {
  let text = '';
  for (let i = 0; i < count; i += 1) {
    text += block(
      makeTle(
        {
          name: `FILL ${i}`,
          norad: String(60000 + i),
          intl: '24001A',
          inclination: 40 + ((i * 7) % 58),
          raan: (i * 37) % 360,
          eccentricity: 0.001,
          argPerigee: (i * 53) % 360,
          meanAnomaly: (i * 71) % 360,
          meanMotion: 14.2 + (i % 9) * 0.15,
          bstar: ' 10000-3',
        },
        T0,
      ),
    );
  }
  return text;
}

const ISS_TLE = makeTle(ISS, T0);
const FEED = {
  active:
    fillers(30) +
    block(makeTle(LEO_VIS.el, T0)) +
    block(makeTle(SLOW.el, T0)) +
    block(makeTle(MEO_VIS.el, T0)) +
    block(ISS_TLE),
};

/** Satz je normalisierter NORAD-ID: erst der Offline-Fallback, frische Daten ersetzen ihn wie im Worker. */
const tleById = new Map<string, Tle>();
for (const text of [FALLBACK_TLE, FEED.active]) {
  const lines = text.split('\n');
  for (let i = 0; i + 2 < lines.length; i += 1) {
    if (lines[i + 1].startsWith('1 ') && lines[i + 2].startsWith('2 ')) {
      tleById.set(normalizeNoradId(lines[i + 1].slice(2, 7)), [lines[i], lines[i + 1], lines[i + 2]]);
      i += 2;
    }
  }
}
const LEO_VIS_ID = LEO_VIS.el.norad;
const SLOW_ID = SLOW.el.norad;
const MEO_VIS_ID = MEO_VIS.el.norad;
const ISS_ID = ISS.norad;

/* ------------------------------------------------------------------ */
/* Worker-Pool als Node-Threads                                         */
/* ------------------------------------------------------------------ */

const WORKER_BUNDLE = fileURLToPath(new URL('./verify-timetravel-worker.mjs', import.meta.url));

/**
 * Vorspann je Shard, wie in verify-selection. Dazu `stall`: blockiert den
 * Thread für `ms` Millisekunden – kein Tick, keine Nachricht, wie ein Shard,
 * der an einer langen Suche hängt oder vom System gedrosselt wird.
 */
const BOOTSTRAP = `
const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const scope = {
  onmessage: null,
  postMessage(message, transfer) { parentPort.postMessage(message, transfer || []); },
};
globalThis.self = scope;
globalThis.fetch = async (url) => {
  const group = new URL(String(url)).searchParams.get('GROUP');
  const text = workerData.feed[group];
  return text ? new Response(text, { status: 200 }) : new Response('No GP data found', { status: 404 });
};
import(pathToFileURL(workerData.bundle).href).then(() => {
  parentPort.on('message', (data) => {
    if (data && data.harness === 'stall') {
      const end = Date.now() + data.ms;
      while (Date.now() < end) {}
      return;
    }
    if (scope.onmessage) scope.onmessage({ data });
  });
});
`;

interface ShardMessage {
  type?: string;
  time?: number;
  epoch?: number;
  noradId?: string;
}

interface TickRecord {
  time: number;
  epoch: number;
  receivedAt: number;
}

const liveWorkers: ThreadWorker[] = [];
/** Jede Nachricht des Main-Threads an einen Shard, in Sendereihenfolge (Abschnitt H). */
const sentLog: Array<{ type: string; at: number; shard: number }> = [];
/** Wird nach jeder Nachricht aufgerufen, die der Hook verarbeitet hat. */
let afterMessage: ((worker: ThreadWorker, data: ShardMessage) => void) | null = null;
/** Solange gesetzt, hält die Hülle passende Antworten zurück (Abschnitte G und H). */
let holdFilter: ((data: ShardMessage) => boolean) | null = null;
const held: Array<{ worker: ThreadWorker; data: ShardMessage }> = [];

class ThreadWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  shard = -1;
  /** Die letzten gesendeten Ticks, auch solche, die der Hook verwirft. */
  readonly ticks: TickRecord[] = [];
  /** > 0: `time`-Nachrichten kommen um so viele ms verspätet an (Abschnitt B). */
  delayTimeMs = 0;
  private readonly thread: NodeWorker;

  constructor(_url: URL | string, _options?: { type?: string; name?: string }) {
    this.thread = new NodeWorker(BOOTSTRAP, { eval: true, workerData: { bundle: WORKER_BUNDLE, feed: FEED } });
    this.thread.on('message', (data: ShardMessage) => {
      if (data?.type === 'tick') {
        this.ticks.push({ time: data.time ?? NaN, epoch: data.epoch ?? NaN, receivedAt: Date.now() });
        if (this.ticks.length > 24) this.ticks.shift();
      }
      if (holdFilter?.(data)) {
        held.push({ worker: this, data });
        return;
      }
      this.onmessage?.({ data });
      afterMessage?.(this, data);
    });
    this.thread.on('error', (err) => this.onerror?.({ message: err.message }));
    liveWorkers.push(this);
  }

  postMessage(message: { type?: string; shardIndex?: number }, transfer?: Transferable[]): void {
    if (message?.type === 'init') this.shard = message.shardIndex ?? -1;
    sentLog.push({ type: String(message?.type), at: Date.now(), shard: this.shard });
    if (message?.type === 'time' && this.delayTimeMs > 0) {
      const delay = this.delayTimeMs;
      setTimeout(() => this.thread.postMessage(message), delay);
      return;
    }
    this.thread.postMessage(message, (transfer ?? []) as never);
  }

  stall(ms: number): void {
    this.thread.postMessage({ harness: 'stall', ms });
  }

  terminate(): void {
    const i = liveWorkers.indexOf(this);
    if (i >= 0) liveWorkers.splice(i, 1);
    void this.thread.terminate();
  }
}

function releaseHeld(match: (data: ShardMessage) => boolean): number {
  let released = 0;
  for (let i = 0; i < held.length; ) {
    if (match(held[i].data)) {
      const [item] = held.splice(i, 1);
      item.worker.onmessage?.({ data: item.data });
      released += 1;
    } else {
      i += 1;
    }
  }
  return released;
}

Object.defineProperty(globalThis, 'Worker', { value: ThreadWorker, configurable: true, writable: true });
Object.defineProperty(globalThis, 'window', {
  value: { setInterval, clearInterval, setTimeout, clearTimeout },
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', { value: 8, configurable: true });

/**
 * SatelliteField zeichnet seine Symbole beim Einhängen in ein 2D-Canvas.
 * Ohne Browser genügt ein Kontext, der jeden Aufruf schluckt: Gerendert wird
 * ohnehin nicht (`gl.render` ist leer), geprüft werden nur die Attribute.
 */
function fakeCanvas(): unknown {
  const canvas: Record<string, unknown> = { width: 0, height: 0, style: {} };
  const gradient = { addColorStop() {} };
  const context = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'canvas') return canvas;
        if (property === 'createRadialGradient' || property === 'createLinearGradient') return () => gradient;
        if (property === 'measureText') return () => ({ width: 10 });
        if (property === 'then') return undefined;
        return () => {};
      },
      set() {
        return true;
      },
    },
  );
  canvas.getContext = () => context;
  return canvas;
}
Object.defineProperty(globalThis, 'document', {
  value: { createElement: () => fakeCanvas() },
  configurable: true,
  writable: true,
});

// drei <Line> (OrbitTrail) meldet beim Einhängen einen NaN-Radius, weil das
// esbuild-Bündel three zweimal enthält – harmlos, siehe
// scripts/verify-selection.ts.
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (first.startsWith('THREE.LineSegmentsGeometry.computeBoundingSphere')) return;
  if (first.includes('inside a test was not wrapped in act(')) return;
  consoleError(...args);
};

const workerOfShard = (shard: number): ThreadWorker => {
  const worker = liveWorkers.find((w) => w.shard === shard);
  if (!worker) throw new Error(`Shard ${shard} läuft nicht`);
  return worker;
};

/* ------------------------------------------------------------------ */
/* Szene                                                                */
/* ------------------------------------------------------------------ */

type RootStore = UseBoundStore<StoreApi<RootState>>;

/** Wie App.tsx und SkyScene, soweit sie an der Zeit hängen. */
function Scene(): ReactElement {
  useSatelliteEngine({ intervalMs: 100 });
  useCelestialBodies();
  return createElement(
    Fragment,
    null,
    createElement(SatelliteField),
    createElement(SatelliteTrails),
    createElement(OrbitTrail),
  );
}

// Sonst erledigt das <Canvas>: <mesh>, <lineSegments> und Materialien als R3F-Elemente.
extend(THREE as never);
const root = createRoot({} as HTMLCanvasElement);
let rootStore: RootStore | null = null;
await act(async () => {
  await root.configure({
    gl: { domElement: { style: {}, addEventListener() {}, removeEventListener() {} }, render() {}, setSize() {}, setPixelRatio() {} } as never,
    size: { width: 400, height: 800, top: 0, left: 0 },
    frameloop: 'never',
    dpr: 1,
  });
  rootStore = root.render(createElement(Scene)) as unknown as RootStore;
});
const store = rootStore as unknown as RootStore;

/* --- Bildpumpe: ein Bild alle 16 ms, wie requestAnimationFrame ---------- */

let frameTime = 0;
/** Beobachter, die nach jedem Bild laufen. */
const frameObservers = new Set<() => void>();
const pump = setInterval(() => {
  frameTime += 1 / 60;
  advance(frameTime, true, store.getState());
  for (const observer of frameObservers) observer();
}, 16);

function findObject(test: (object: Object3D) => boolean): Object3D | null {
  let found: Object3D | null = null;
  store.getState().scene.traverse((object) => {
    if (!found && test(object)) found = object;
  });
  return found;
}

/** Attribute des Feldes: Vorgänger- und Zielwinkel je Instanz, Größe (0 = nicht gezeichnet). */
function fieldAttributes(): { prev: Float32Array; cur: Float32Array; size: Float32Array } | null {
  const mesh = findObject((o) => Boolean((o as { geometry?: BufferGeometry }).geometry?.getAttribute('aPrev')));
  if (!mesh) return null;
  const geometry = (mesh as unknown as { geometry: BufferGeometry }).geometry;
  return {
    prev: (geometry.getAttribute('aPrev') as BufferAttribute).array as Float32Array,
    cur: (geometry.getAttribute('aCur') as BufferAttribute).array as Float32Array,
    size: (geometry.getAttribute('aSize') as BufferAttribute).array as Float32Array,
  };
}

/** Wie viele Instanzen interpolieren gerade (Vorgänger ≠ Ziel)? */
function interpolatingInstances(): number {
  const attributes = fieldAttributes();
  if (!attributes) return 0;
  let differ = 0;
  for (let i = 0; i < telemetry.count; i += 1) {
    if (
      Math.abs(attributes.prev[i * 2] - attributes.cur[i * 2]) > 1e-7 ||
      Math.abs(attributes.prev[i * 2 + 1] - attributes.cur[i * 2 + 1]) > 1e-7
    ) {
      differ += 1;
    }
  }
  return differ;
}

/** Die Bahnspur aus OrbitTrail (drei `Line2`), falls eingehängt. */
const orbitLine = (): Line2 | null => findObject((o) => (o as Line2).isLine2 === true) as Line2 | null;

/** Gezeichnete Spursegmente als Paare von Blickrichtungen. */
function trailSegments(): Array<[Vec, Vec]> {
  const line = findObject((o) => (o as { isLineSegments?: boolean }).isLineSegments === true);
  if (!line) return [];
  const geometry = (line as unknown as { geometry: BufferGeometry }).geometry;
  const positions = (geometry.getAttribute('position') as BufferAttribute).array as Float32Array;
  const segments: Array<[Vec, Vec]> = [];
  for (let v = 0; v + 1 < geometry.drawRange.count; v += 2) {
    const a: Vec = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
    const b: Vec = [positions[v * 3 + 3], positions[v * 3 + 4], positions[v * 3 + 5]];
    segments.push([a, b]);
  }
  return segments;
}

/* ------------------------------------------------------------------ */
/* Zusammengeführter Stand: welche Zeit zeigt jeder Shard?              */
/* ------------------------------------------------------------------ */

const indexOf = (id: string): number => catalogIndex.meta.findIndex((meta) => meta?.noradId === id);

/** Plätze mit bekanntem Satz, je Shard. */
function objectsByShard(): Map<number, Array<{ index: number; id: string; tle: Tle }>> {
  const result = new Map<number, Array<{ index: number; id: string; tle: Tle }>>();
  for (let index = 0; index < telemetry.count; index += 1) {
    const meta = catalogIndex.meta[index];
    const tle = meta ? tleById.get(meta.noradId) : undefined;
    if (!meta || !tle) continue;
    const shard = index % engine.shardCount;
    if (!result.has(shard)) result.set(shard, []);
    result.get(shard)?.push({ index, id: meta.noradId, tle });
  }
  return result;
}

/** Stimmt der Telemetriesatz mit satellite.js zur Zeit `ms` überein? NaN-Platz ↔ keine Lösung zählt als Treffer. */
function sampleMatches(index: number, tle: Tle, ms: number): { ok: boolean; offDeg: number; rangeDelta: number } {
  const sample = readSample(index);
  const ref = truth(tle, ms);
  if (!sample || !ref) return { ok: !sample && !ref, offDeg: NaN, rangeDelta: NaN };
  const offDeg = angleDeg(direction(sample.azimuth, sample.elevation), ref.dir);
  const rangeDelta = Math.abs(sample.rangeKm - ref.rangeKm);
  return { ok: offDeg < 0.01 && rangeDelta < 1, offDeg, rangeDelta };
}

type ShardClass = 'old' | 'new' | 'hidden' | 'unknown';

interface ShardView {
  shard: number;
  cls: ShardClass;
  /** Der Tick, dem der Stand des Shards entspricht. */
  tick: TickRecord | null;
}

/**
 * Ordnet jeden Shard einem seiner gesendeten Ticks zu – dem jüngsten, zu
 * dessen Zeit JEDES Objekt des Shards mit satellite.js übereinstimmt – und
 * den Tick einer der beiden Zeitbasen: der, deren Zeit zum Empfangsmoment
 * näher liegt. Die Epochen-Kennung der Nachricht wird dafür bewusst nicht
 * gelesen. Findet sich kein solcher Tick, stammen die Plätze eines Shards
 * aus verschiedenen Ticks: `unknown`.
 */
function classify(oldBase: TimeBase, newBase: TimeBase): ShardView[] {
  const views: ShardView[] = [];
  for (const [shard, objects] of objectsByShard()) {
    const worker = workerOfShard(shard);
    if (objects.every((o) => readSample(o.index) === null)) {
      views.push({ shard, cls: 'hidden', tick: null });
      continue;
    }
    let match: TickRecord | null = null;
    for (let i = worker.ticks.length - 1; i >= 0; i -= 1) {
      const time = worker.ticks[i].time;
      if (objects.every((o) => sampleMatches(o.index, o.tle, time).ok)) {
        match = worker.ticks[i];
        break;
      }
    }
    if (!match) {
      views.push({ shard, cls: 'unknown', tick: null });
      continue;
    }
    const dOld = Math.abs(match.time - virtualTimeAt(oldBase, match.receivedAt));
    const dNew = Math.abs(match.time - virtualTimeAt(newBase, match.receivedAt));
    views.push({ shard, cls: dNew < dOld ? 'new' : 'old', tick: match });
  }
  return views;
}

/** Jedes Objekt mit bekanntem Satz gegen satellite.js zur Zeit des Ticks, dem sein Shard entspricht. */
function checkAllObjects(views: ShardView[]): { ok: boolean; text: string } {
  let compared = 0;
  let worstDeg = 0;
  let worstKm = 0;
  let bad = 0;
  const badNames: string[] = [];
  const byShard = objectsByShard();
  for (const view of views) {
    if (!view.tick) {
      bad += 1;
      continue;
    }
    for (const object of byShard.get(view.shard) ?? []) {
      const m = sampleMatches(object.index, object.tle, view.tick.time);
      compared += 1;
      if (!m.ok) {
        bad += 1;
        badNames.push(`${object.tle[0].trim()} #${object.index} (${f(m.offDeg, 4)}°, ${f(m.rangeDelta, 3)} km)`);
      }
      if (Number.isFinite(m.offDeg)) worstDeg = Math.max(worstDeg, m.offDeg);
      if (Number.isFinite(m.rangeDelta)) worstKm = Math.max(worstKm, m.rangeDelta);
    }
  }
  return {
    ok: bad === 0 && compared > 0 && views.length === engine.shardCount,
    text:
      `${compared} Objekte auf ${views.length}/${engine.shardCount} Shards, größte Abweichung ` +
      `${f(worstDeg, 5)}° / ${f(worstKm, 3)} km, ${bad} daneben${badNames.length ? `: ${badNames.join(', ')}` : ''}`,
  };
}

/* ------------------------------------------------------------------ */
/* Sprung beobachten                                                    */
/* ------------------------------------------------------------------ */

interface JumpReport {
  oldBase: TimeBase;
  newBase: TimeBase;
  snapshots: number;
  mixed: string[];
  unknown: number;
  oldAfterCommit: number;
  hiddenSnapshots: number;
  /** Ms vom Sprung bis zum ersten Stand, in dem alle Shards die neue Zeit zeigen. */
  allNewAfterMs: number;
  /** Ms vom Sprung, bis `telemetry.epoch` wechselt. */
  commitAfterMs: number;
  /** Stand, in dem alle Shards die neue Zeit zeigen, frisch klassifiziert. */
  finalViews: ShardView[];
  /** Nach dem Sprung empfangene Ticks, deren Zeit auf der alten Basis liegt. */
  oldTicksAfterJump: number;
  /** Erstes Bild nach dem Epochenwechsel: Vorgänger = Ziel im Feld? */
  fieldFirstFrame: { checked: boolean; equal: number; differ: number; curMatchesTelemetry: boolean };
}

/**
 * Springt (oder setzt zurück) und beobachtet jeden Zwischenstand, bis alle
 * Shards drei Revisionen lang die neue Zeit zeigen.
 */
async function jumpAndWatch(
  action: () => void,
  options: { allowHidden?: boolean; timeoutMs?: number } = {},
): Promise<JumpReport> {
  const oldBase = useAppStore.getState().timeBase;
  const oldEpoch = telemetry.epoch;
  const report: JumpReport = {
    oldBase,
    newBase: oldBase,
    snapshots: 0,
    mixed: [],
    unknown: 0,
    oldAfterCommit: 0,
    hiddenSnapshots: 0,
    allNewAfterMs: NaN,
    commitAfterMs: NaN,
    finalViews: [],
    oldTicksAfterJump: 0,
    fieldFirstFrame: { checked: false, equal: 0, differ: 0, curMatchesTelemetry: false },
  };
  let jumpedAt = 0;
  let stableRevisions = 0;
  let lastRevision = telemetry.revision;
  let done = false;

  const observe = (worker: ThreadWorker, data: ShardMessage) => {
    if (done) return;
    // Vor dem Aufruf steht im Store noch die alte Basis; dann ist alles „alt“.
    const newBase = useAppStore.getState().timeBase;
    if (data?.type === 'tick') {
      const t = worker.ticks[worker.ticks.length - 1];
      const dOld = Math.abs(t.time - virtualTimeAt(oldBase, t.receivedAt));
      const dNew = Math.abs(t.time - virtualTimeAt(newBase, t.receivedAt));
      if (dOld < dNew) report.oldTicksAfterJump += 1;
    }
    const views = classify(oldBase, newBase);
    report.snapshots += 1;
    const classes = new Set(views.map((v) => v.cls));
    if (classes.has('unknown')) report.unknown += 1;
    if (classes.has('old') && classes.has('new')) {
      report.mixed.push(views.map((v) => `${v.shard}:${v.cls}`).join(' '));
    }
    if (classes.has('hidden')) report.hiddenSnapshots += 1;
    const committed = telemetry.epoch !== oldEpoch;
    if (committed && Number.isNaN(report.commitAfterMs)) report.commitAfterMs = Date.now() - jumpedAt;
    if (committed && classes.has('old')) report.oldAfterCommit += 1;
    const allNew = views.length === engine.shardCount && views.every((v) => v.cls === 'new');
    if (allNew && Number.isNaN(report.allNewAfterMs)) report.allNewAfterMs = Date.now() - jumpedAt;
    if (telemetry.revision !== lastRevision) {
      lastRevision = telemetry.revision;
      stableRevisions = allNew ? stableRevisions + 1 : 0;
      if (stableRevisions >= 3) {
        report.finalViews = views;
        done = true;
      }
    }
  };

  let lastFrameEpoch = telemetry.epoch;
  const fieldObserver = () => {
    if (telemetry.epoch === lastFrameEpoch || report.fieldFirstFrame.checked) return;
    lastFrameEpoch = telemetry.epoch;
    const attributes = fieldAttributes();
    if (!attributes) return;
    report.fieldFirstFrame.checked = true;
    let equal = 0;
    let differ = 0;
    let curOk = true;
    for (let i = 0; i < telemetry.count; i += 1) {
      const same =
        Math.abs(attributes.prev[i * 2] - attributes.cur[i * 2]) < 1e-6 &&
        Math.abs(attributes.prev[i * 2 + 1] - attributes.cur[i * 2 + 1]) < 1e-6;
      if (same) equal += 1;
      else differ += 1;
      const sample = readSample(i);
      if (sample && (Math.abs(sample.azimuth - attributes.cur[i * 2]) > 1e-6 || Math.abs(sample.elevation - attributes.cur[i * 2 + 1]) > 1e-6)) {
        curOk = false;
      }
    }
    report.fieldFirstFrame.equal = equal;
    report.fieldFirstFrame.differ = differ;
    report.fieldFirstFrame.curMatchesTelemetry = curOk;
  };

  afterMessage = observe;
  frameObservers.add(fieldObserver);
  jumpedAt = Date.now();
  await act(async () => action());
  const newBase = useAppStore.getState().timeBase;
  report.newBase = newBase;
  await waitFor('drei Revisionen, in denen alle Shards die neue Zeit zeigen', () => done, options.timeoutMs ?? 6000);
  afterMessage = null;
  // Das erste Bild nach dem Wechsel kann noch ausstehen, wenn die Freigabe
  // gerade eben war – die Pumpe läuft alle 16 ms.
  await waitFor('erstes Bild nach dem Epochenwechsel', () => report.fieldFirstFrame.checked, 500);
  frameObservers.delete(fieldObserver);
  if (report.finalViews.length === 0) report.finalViews = classify(oldBase, newBase);
  return report;
}

/** Zurück zur Echtzeit, falls die Szene nicht schon dort ist. */
async function ensureRealtime(): Promise<void> {
  if (!isRealtime(useAppStore.getState().timeBase)) await jumpAndWatch(() => engine.resetToRealTime());
}

/** Prüfungen, die nach jedem Sprung gelten. */
function expectJump(label: string, report: JumpReport, target: number, options: { allowHidden?: boolean } = {}): void {
  expect(
    `${label}: kein Stand mischt alte und neue Zeit`,
    report.mixed.length === 0 &&
      report.unknown === 0 &&
      report.oldAfterCommit === 0 &&
      (options.allowHidden === true || report.hiddenSnapshots === 0) &&
      Number.isFinite(report.allNewAfterMs),
    `${report.snapshots} Zwischenstände nach jeder Worker-Nachricht, ${report.mixed.length} gemischt` +
      `${report.mixed.length ? ` (erster: ${report.mixed[0]})` : ''}, ${report.unknown} ohne passenden Tick, ` +
      `${report.oldAfterCommit} mit alter Zeit nach dem Epochenwechsel, ${report.hiddenSnapshots} mit ausgeblendetem Shard; ` +
      `Epochenwechsel nach ${f(report.commitAfterMs, 0)} ms, alle Shards neu nach ${f(report.allNewAfterMs, 0)} ms`,
  );
  // Jetzt neu zuordnen: Seit dem Ende der Beobachtung sind weitere Ticks eingetroffen.
  const views = classify(report.oldBase, report.newBase);
  const all = checkAllObjects(views);
  const times = views.map((v) => v.tick?.time ?? NaN);
  const spreadMs = Math.max(...times) - Math.min(...times);
  expect(
    `${label}: Telemetrie aller Shards = satellite.js zur neuen Zeit`,
    all.ok && views.every((v) => v.cls === 'new'),
    `${all.text}; Tickzeiten ${iso(Math.min(...times))} UTC … +${f(spreadMs, 0)} ms, Ziel ${iso(target)} UTC`,
  );
  const lagMs = virtualNow() - telemetry.timeMs;
  expect(
    `${label}: telemetry.timeMs folgt`,
    Math.abs(lagMs) < 1000 * Math.max(1, Math.abs(useAppStore.getState().timeBase.scale)),
    `telemetry.timeMs ${iso(telemetry.timeMs)} UTC, virtuelle Zeit ${iso(virtualNow())} UTC (${f(lagMs, 0)} ms dahinter)`,
  );
  const ff = report.fieldFirstFrame;
  expect(
    `${label}: keine Interpolation über den Sprung`,
    ff.checked && ff.differ === 0 && ff.curMatchesTelemetry && ff.equal > 0,
    `erstes Bild nach dem Wechsel: ${ff.equal} Instanzen mit Vorgänger = Ziel, ${ff.differ} mit altem Vorgänger, ` +
      `Ziel ${ff.curMatchesTelemetry ? '=' : '≠'} Telemetrie`,
  );
}

/** Sonne und Mond im Store gegen astronomy-engine zur virtuellen Zeit (Fenster: seit der letzten Aktualisierung). */
function checkBodies(label: string, windowMs: number): void {
  const { sun, moon } = useAppStore.getState();
  const now = virtualNow();
  const sunDir = direction((sun.azimuthDeg * Math.PI) / 180, (sun.altitudeDeg * Math.PI) / 180);
  const moonDir = direction((moon.azimuthDeg * Math.PI) / 180, (moon.altitudeDeg * Math.PI) / 180);
  let bestSun = { off: Number.POSITIVE_INFINITY, t: now };
  let bestMoon = Number.POSITIVE_INFINITY;
  const step = Math.max(500, windowMs / 400);
  for (let t = now - windowMs; t <= now + 1; t += step) {
    const off = angleDeg(sunDir, bodyRef(Body.Sun, t).dir);
    if (off < bestSun.off) bestSun = { off, t };
    bestMoon = Math.min(bestMoon, angleDeg(moonDir, bodyRef(Body.Moon, t).dir));
  }
  const phase = Illumination(Body.Moon, new Date(bestSun.t)).phase_fraction;
  const wall = angleDeg(sunDir, bodyRef(Body.Sun, Date.now()).dir);
  expect(
    `${label}: Sonne und Mond zur virtuellen Zeit`,
    bestSun.off < 0.02 && bestMoon < 0.02 && Math.abs(phase - moon.illumination) < 0.001,
    `Sonne ${f(sun.altitudeDeg, 2)}° / ${f(sun.azimuthDeg, 2)}° (astronomy-engine ${f(bestSun.off, 4)}° daneben, ` +
      `zur Wanduhr ${f(wall, 1)}° daneben), Mond ${f(bestMoon, 4)}° daneben, beleuchtet ${f(moon.illumination, 3)} (${f(phase, 3)})`,
  );
}

/**
 * Ordnet jede Stützstelle der Spuren einem Objekt und einer Zeit zu: die
 * nächstgelegene Stelle auf den Bahnen aller Objekte im Fenster [t0, t1].
 */
function matchVertices(t0: number, t1: number, stepMs: number) {
  const tracks: Array<{ id: string; times: number[]; dirs: Vec[] }> = [];
  for (let index = 0; index < telemetry.count; index += 1) {
    const meta = catalogIndex.meta[index];
    const tle = meta ? tleById.get(meta.noradId) : undefined;
    if (!meta || !tle) continue;
    const mid = truth(tle, (t0 + t1) / 2);
    if (!mid || mid.elevation < -0.1) continue;
    const times: number[] = [];
    const dirs: Vec[] = [];
    for (let t = t0; t <= t1; t += stepMs) {
      const r = truth(tle, t);
      if (!r) continue;
      times.push(t);
      dirs.push(r.dir);
    }
    tracks.push({ id: meta.noradId, times, dirs });
  }
  return trailSegments().map(([a, b]) => {
    const best = (v: Vec) => {
      let result = { id: '', t: NaN, off: Number.POSITIVE_INFINITY };
      for (const track of tracks) {
        for (let k = 0; k < track.dirs.length; k += 1) {
          const off = angleDeg(v, track.dirs[k]);
          if (off < result.off) result = { id: track.id, t: track.times[k], off };
        }
      }
      return result;
    };
    return { a: best(a), b: best(b), lengthDeg: angleDeg(a, b) };
  });
}

/* ------------------------------------------------------------------ */
/* A: Ausgangslage                                                      */
/* ------------------------------------------------------------------ */

console.log(
  `Katalog: LEO SICHTBAR mind. ${f(LEO_VIS.minElDeg, 1)}° um ${iso(J_PAST)} UTC, SLOW DRIFT mind. ${f(SLOW.minElDeg, 1)}°, ` +
    `MEO SICHTBAR mind. ${f(MEO_VIS.minElDeg, 1)}°`,
);
console.log('A. Ausgangslage in Echtzeit – 8 Kerne');
useAppStore.setState({ activeGroups: ['other'] });
await act(async () => useAppStore.setState({ observer: OBSERVER }));
await waitFor('Katalog vollständig', () => [ISS_ID, LEO_VIS_ID, SLOW_ID, MEO_VIS_ID].every((id) => {
  const index = indexOf(id);
  return index >= 0 && telemetry.count > index;
}));
{
  const revision = telemetry.revision;
  await waitFor('drei vollständige Ticks', () => telemetry.revision >= revision + 3);
}
{
  const base = useAppStore.getState().timeBase;
  const views = classify(base, base);
  const all = checkAllObjects(views);
  expect(
    'A Echtzeit: Telemetrie = satellite.js',
    isRealtime(base) && all.ok,
    `${engine.shardCount} Shards, ${telemetry.count} Plätze; ${all.text}`,
  );

  // Das Feld interpoliert: Bei einer neuen Revision unterscheiden sich
  // Vorgänger und Ziel bewegter Objekte. Ohne das wäre die Prüfung nach dem
  // Sprung (Vorgänger = Ziel) nichtssagend.
  let moving = 0;
  const observer = () => {
    const attributes = fieldAttributes();
    if (!attributes) return;
    let differ = 0;
    for (let i = 0; i < telemetry.count; i += 1) {
      if (Math.abs(attributes.prev[i * 2 + 1] - attributes.cur[i * 2 + 1]) > 1e-7) differ += 1;
    }
    moving = Math.max(moving, differ);
  };
  frameObservers.add(observer);
  await sleep(2600);
  frameObservers.delete(observer);
  const segments = trailSegments();
  expect(
    'A Feld interpoliert, Spuren entstehen',
    moving > 0 && segments.length > 0,
    `bis zu ${moving} Instanzen mit Vorgänger ≠ Ziel, ${segments.length} Spursegmente nach 2,6 s`,
  );
  checkBodies('A Echtzeit', 21_000);
}

/* ------------------------------------------------------------------ */
/* B: Sprung 6 h zurück                                                  */
/* ------------------------------------------------------------------ */

const DELAYED_SHARD = 3;
const DELAY_MS = 200;

if (runs('B')) {
  console.log(`B. Sprung 6 h zurück auf ${iso(J_PAST)} UTC; Shard ${DELAYED_SHARD} erhält die Zeitnachricht ${DELAY_MS} ms später`);
  const slowIndex = indexOf(SLOW_ID);
  const slowBefore = readSample(slowIndex);
  workerOfShard(DELAYED_SHARD).delayTimeMs = DELAY_MS;
  const report = await jumpAndWatch(() => engine.jumpTo(J_PAST));
  workerOfShard(DELAYED_SHARD).delayTimeMs = 0;
  expect(
    'B Voraussetzung: Ticks der alten Zeit kamen nach dem Sprung noch an',
    report.oldTicksAfterJump > 0,
    `${report.oldTicksAfterJump} Ticks mit Zeit auf der alten Basis nach dem Sprung empfangen`,
  );
  expectJump('B −6 h', report, J_PAST);

  // Nur das erste Bild nach dem Wechsel übernimmt Vorgänger = Ziel; danach
  // muss das Feld wieder interpolieren, sonst sprängen die Objekte nach
  // jedem Sprung für immer von Tick zu Tick.
  let movingAfter = 0;
  const interpolation = () => {
    movingAfter = Math.max(movingAfter, interpolatingInstances());
  };
  frameObservers.add(interpolation);
  // Spuren: neu begonnen und wieder abgetastet.
  const jumpedAt = virtualNow();
  await sleep(3000);
  frameObservers.delete(interpolation);
  expect(
    'B Feld interpoliert nach dem Sprung wieder',
    movingAfter > 0,
    `bis zu ${movingAfter} von ${telemetry.count} Instanzen mit Vorgänger ≠ Ziel in den 3 s nach dem Wechsel`,
  );
  const matched = matchVertices(J_PAST - 1000, virtualNow() + 500, 50);
  const off = matched.filter((m) => m.a.off > 0.05 || m.b.off > 0.05);
  const leoSegments = matched.filter((m) => m.a.id === LEO_VIS_ID && m.b.id === LEO_VIS_ID && m.lengthDeg > 0.02);
  const slowAfter = readSample(slowIndex);
  const slowShift =
    slowBefore && slowAfter
      ? angleDeg(direction(slowBefore.azimuth, slowBefore.elevation), direction(slowAfter.azimuth, slowAfter.elevation))
      : NaN;
  expect(
    'B Spuren beginnen nach dem Sprung neu',
    matched.length > 0 && off.length === 0,
    `${matched.length} Segmente, ${off.length} mit einer Stützstelle abseits der Bahnen seit ${iso(J_PAST)} UTC ` +
      `(SLOW DRIFT hat sich durch den Sprung um ${f(slowShift, 2)}° verschoben)`,
  );
  expect(
    'B Spuren tasten nach dem Sprung zurück wieder ab',
    leoSegments.length >= 1,
    `${leoSegments.length} Segmente von LEO SICHTBAR mit Länge > 0,02° in ${f((virtualNow() - jumpedAt) / 1000, 1)} s`,
  );
  checkBodies('B −6 h', 2000);
}

/* ------------------------------------------------------------------ */
/* C: Wachhund mit hängendem Shard                                      */
/* ------------------------------------------------------------------ */

const STALL_MS = 1500;

if (runs('C')) {
  // Der Shard von SLOW DRIFT: Das Objekt steht vor und nach dem Sprung über
  // dem Horizont, seine Rückkehr ist also im Feld und in den Spuren zu sehen.
  const STALLED_SHARD = indexOf(SLOW_ID) % engine.shardCount;
  console.log(`C. Shard ${STALLED_SHARD} (mit SLOW DRIFT) hängt ${STALL_MS} ms, während auf ${iso(J_WATCHDOG)} UTC gesprungen wird`);
  const stalled = workerOfShard(STALLED_SHARD);
  const revisionBefore = telemetry.revision;
  stalled.stall(STALL_MS);
  await sleep(30);
  const stallEndsAt = Date.now() + STALL_MS - 30;
  let hiddenWhileStalled = 0;
  let revisionsWhileStalled = 0;
  let lastRevision = telemetry.revision;
  const watch = setInterval(() => {
    if (Date.now() > stallEndsAt - 50) return;
    if (telemetry.revision !== lastRevision) {
      lastRevision = telemetry.revision;
      revisionsWhileStalled += 1;
    }
    const objects = objectsByShard().get(STALLED_SHARD) ?? [];
    if (objects.length > 0 && objects.every((o) => readSample(o.index) === null)) hiddenWhileStalled += 1;
  }, 20);
  // Rückkehr im Feld: erst ausgeblendet (alle Plätze ungültig), dann das
  // erste Bild, in dem Objekte des Shards wieder gezeichnet werden. Deren
  // Weg von Vorgänger zu Ziel ist der Flug, den sie im nächsten Tickintervall
  // zurücklegen. Übernähme das Feld den ausgeblendeten Stand als Vorgänger,
  // begänne er bei Höhe −90° mit dem Azimut der alten Zeit.
  const shardObjects = objectsByShard().get(STALLED_SHARD) ?? [];
  // `phase` als Feld, nicht als Variable: Geschrieben wird sie im Bildbeobachter.
  const returned = {
    phase: 'wait-hidden' as 'wait-hidden' | 'wait-back' | 'done',
    visible: 0,
    sweeping: 0,
    worstDeg: 0,
    worstName: '–',
    worstPrevElDeg: Number.NaN,
    differ: 0,
    valid: 0,
  };
  const returnObserver = () => {
    if (returned.phase === 'done') return;
    if (returned.phase === 'wait-hidden') {
      const hidden = shardObjects.length > 0 && shardObjects.every((o) => readSample(o.index) === null);
      if (hidden) returned.phase = 'wait-back';
      return;
    }
    const attributes = fieldAttributes();
    if (!attributes || !shardObjects.some((o) => attributes.size[o.index] > 0)) return;
    for (const o of shardObjects) {
      const i = o.index;
      if (readSample(i) === null) continue;
      returned.valid += 1;
      const prevDir = direction(attributes.prev[i * 2], attributes.prev[i * 2 + 1]);
      const curDir = direction(attributes.cur[i * 2], attributes.cur[i * 2 + 1]);
      const sweep = angleDeg(prevDir, curDir);
      if (attributes.prev[i * 2] !== attributes.cur[i * 2] || attributes.prev[i * 2 + 1] !== attributes.cur[i * 2 + 1]) {
        returned.differ += 1;
      }
      if (attributes.size[i] <= 0) continue;
      returned.visible += 1;
      if (sweep > 1) returned.sweeping += 1;
      if (sweep >= returned.worstDeg) {
        returned.worstDeg = sweep;
        returned.worstName = o.tle[0].trim();
        returned.worstPrevElDeg = (attributes.prev[i * 2 + 1] * 180) / Math.PI;
      }
    }
    returned.phase = 'done';
  };
  frameObservers.add(returnObserver);
  const report = await jumpAndWatch(() => engine.jumpTo(J_WATCHDOG), { allowHidden: true, timeoutMs: 6000 });
  clearInterval(watch);
  await waitFor('Objekte des Shards wieder gezeichnet', () => returned.phase === 'done', 2000);
  frameObservers.delete(returnObserver);
  expect(
    'C Wachhund: Himmel läuft weiter, hängender Shard fehlt statt alter Zeit',
    report.commitAfterMs < STALL_MS && hiddenWhileStalled > 0 && revisionsWhileStalled > 0,
    `Epochenwechsel ${f(report.commitAfterMs, 0)} ms nach dem Sprung, Shard hing bis ${STALL_MS} ms; ` +
      `${revisionsWhileStalled} Revisionen während des Hängens (vorher ${revisionBefore}), ` +
      `${hiddenWhileStalled}× alle Objekte des Shards ausgeblendet`,
  );
  expectJump('C Wachhund', report, J_WATCHDOG, { allowHidden: true });
  expect(
    'C Rückkehr des Shards: kein Flug aus der Tiefe',
    returned.phase === 'done' && returned.visible > 0 && returned.sweeping === 0,
    returned.phase === 'done'
      ? `erstes Bild mit Objekten des Shards: ${returned.visible} gezeichnet, ${returned.sweeping} davon mit mehr als 1° ` +
          `bis zum nächsten Tick (größter Weg ${f(returned.worstDeg, 3)}°, ${returned.worstName}, Vorgänger auf ` +
          `${f(returned.worstPrevElDeg, 1)}° Höhe); ${returned.differ} von ${returned.valid} gültigen Plätzen mit Vorgänger ≠ Ziel`
      : `nicht beobachtet (Phase ${returned.phase})`,
  );

  // Spuren nach der Rückkehr: Stützstellen des ausgeblendeten Stands (Höhe
  // −90°) dürfen mit keinem Segment verbunden sein.
  await sleep(1500);
  const segments = trailSegments();
  const below = segments.filter(([a, b]) => a[1] <= 0 || b[1] <= 0).length;
  const matched = matchVertices(J_WATCHDOG - 1000, virtualNow() + 500, 50);
  const off = matched.filter((m) => m.a.off > 0.05 || m.b.off > 0.05);
  const slow = matched.filter((m) => m.a.id === SLOW_ID && m.b.id === SLOW_ID).length;
  expect(
    'C Rückkehr: Spuren beginnen am neuen Ort, nicht in der Tiefe',
    segments.length > 0 && below === 0 && off.length === 0 && slow > 0,
    `${segments.length} Segmente, ${below} mit einem Ende unter dem Horizont, ${off.length} mit einer Stützstelle ` +
      `abseits der Bahnen seit dem Sprung, ${slow} von SLOW DRIFT`,
  );
}

/* ------------------------------------------------------------------ */
/* D: weitere Sprünge                                                    */
/* ------------------------------------------------------------------ */

if (runs('D')) {
  for (const [label, target] of [
    ['D +6 h', J_FUT],
    ['D +30 Tage', J_30F],
    ['D −30 Tage', J_30B],
  ] as const) {
    console.log(`${label}: Sprung auf ${iso(target)} UTC`);
    const report = await jumpAndWatch(() => engine.jumpTo(target));
    expectJump(label, report, target);
    // Zwei Stützstellen (900 ms virtuell) braucht ein Segment. SLOW DRIFT
    // steht bei +6 h über dem Horizont und hat sich seit dem Stand vor dem
    // Sprung (C, +3 h) nur um knapp ein Grad bewegt – ein Segment über den
    // Sprung würde gezeichnet. Bei ±30 Tagen steht es woanders; dort kann
    // die Liste leer sein.
    await sleep(1500);
    const segments = matchVertices(target - 1000, virtualNow() + 500, 50);
    const off = segments.filter((m) => m.a.off > 0.05 || m.b.off > 0.05);
    const slow = segments.filter((m) => m.a.id === SLOW_ID).length;
    expect(
      `${label}: keine Spur aus der alten Zeit`,
      off.length === 0 && (target !== J_FUT || slow > 0),
      `${segments.length} Segmente (${slow} von SLOW DRIFT), ${off.length} mit einer Stützstelle abseits der Bahnen seit dem Sprung`,
    );
    checkBodies(label, 2000);
  }
}

/* ------------------------------------------------------------------ */
/* E: Rückwärtslauf und Zeitraffer                                      */
/* ------------------------------------------------------------------ */

/** Zeitrate je Shard aus den Ticks der letzten `spanMs`: virtuelle ms je Wanduhr-ms. */
function measuredRates(spanMs: number): number[] {
  const rates: number[] = [];
  for (let shard = 0; shard < engine.shardCount; shard += 1) {
    const ticks = workerOfShard(shard).ticks.filter((t) => t.receivedAt >= Date.now() - spanMs);
    if (ticks.length < 2) continue;
    const first = ticks[0];
    const last = ticks[ticks.length - 1];
    rates.push((last.time - first.time) / (last.receivedAt - first.receivedAt));
  }
  return rates;
}

async function checkScale(label: string, scale: number): Promise<void> {
  await act(async () => engine.setTimeScale(scale));
  const base = useAppStore.getState().timeBase;
  await sleep(2500);
  const rates = measuredRates(2000);
  const worstRate = Math.max(...rates.map((r) => Math.abs(r / scale - 1)));
  // Der Tick rechnet zu seinem Anfang; empfangen wird er danach. Seine Zeit
  // liegt also zwischen der Basis 250 ms vor dem Empfang und der beim Empfang.
  const views = classify(base, base);
  let worstLagMs = 0;
  let outside = 0;
  for (const view of views) {
    if (!view.tick) continue;
    const atReceipt = virtualTimeAt(base, view.tick.receivedAt);
    const lag = (atReceipt - view.tick.time) / scale;
    worstLagMs = Math.max(worstLagMs, lag);
    if (lag < -1 || lag > 250) outside += 1;
  }
  const all = checkAllObjects(views);
  const times = views.map((v) => v.tick?.time ?? NaN);
  expect(
    `${label}: Positionen stimmen zur virtuellen Zeit`,
    all.ok && rates.length === engine.shardCount && worstRate < 0.05 && outside === 0,
    `${all.text}; gemessene Rate je Shard ${rates.map((r) => f(r, 1)).join(' / ')} (Soll ${scale}), ` +
      `Tickzeit höchstens ${f(worstLagMs, 0)} ms Wanduhr vor dem Empfang; ` +
      `Shards eines Stands bis ${f((Math.max(...times) - Math.min(...times)) / 1000, 1)} s virtuelle Zeit auseinander`,
  );
}

if (runs('E')) {
  console.log(`E. Rückwärtslauf ab ${iso(J_PAST)} UTC, danach Zeitraffer`);
  const report = await jumpAndWatch(() => engine.jumpTo(J_PAST));
  expectJump('E Sprung auf J_PAST', report, J_PAST);
  await sleep(6000);

  // E1: ×−1. Die Spur von MEO SICHTBAR darf nur zeigen, wo das Objekt im
  // Rückwärtslauf schon war – Zeiten zwischen jetzt und dem Umkehrpunkt.
  const reversedAt = virtualNow();
  await act(async () => engine.setTimeScale(-1));
  await sleep(3200);
  const now1 = virtualNow();
  const meoIndex = indexOf(MEO_VIS_ID);
  const meoTle = tleById.get(MEO_VIS_ID) as Tle;
  const meoNow = truth(meoTle, now1);
  const meoTimes: number[] = [];
  const meoDirs: Vec[] = [];
  for (let t = J_PAST - 2000; t <= reversedAt + 2000; t += 20) {
    const r = truth(meoTle, t);
    if (r) {
      meoTimes.push(t);
      meoDirs.push(r.dir);
    }
  }
  let ahead = 0;
  let meoVertices = 0;
  let earliest = Number.POSITIVE_INFINITY;
  for (const [a, b] of trailSegments()) {
    for (const v of [a, b]) {
      if (!meoNow || angleDeg(v, meoNow.dir) > 0.3) continue;
      let best = { off: Number.POSITIVE_INFINITY, t: NaN };
      for (let k = 0; k < meoDirs.length; k += 1) {
        const off = angleDeg(v, meoDirs[k]);
        if (off < best.off) best = { off, t: meoTimes[k] };
      }
      if (best.off > 0.002) continue;
      meoVertices += 1;
      earliest = Math.min(earliest, best.t);
      if (best.t < now1 - 1000) ahead += 1;
    }
  }
  expect(
    'E ×−1: Spur beginnt am Umkehrpunkt neu, nichts liegt vor dem Objekt',
    meoIndex >= 0 && meoVertices > 0 && ahead === 0 && telemetry.timeMs < reversedAt,
    `${meoVertices} Stützstellen von MEO SICHTBAR, ${ahead} davon vor dem Objekt ` +
      `(früheste ${f((earliest - now1) / 1000, 1)} s relativ zu jetzt), telemetry.timeMs ${hours(telemetry.timeMs - reversedAt)} ` +
      `gegenüber dem Umkehrpunkt`,
  );

  // E2: ×−60 – 3 s Wanduhr sind 3 min Bahn zurück.
  //
  // Gezählt werden Segmente, deren beide Stützstellen mehr als 10 s virtueller
  // Zeit vor dem Beginn von ×−60 liegen: Sie sind erst im Rückwärtslauf
  // entstanden. Ohne Abtastung rückwärts gäbe es keine – alle Stützstellen
  // stammten aus der Zeit davor. Gezählt über alle Objekte außer SLOW DRIFT
  // (zu langsam, um einer Stützstelle eine Zeit zuzuordnen), nicht über ein
  // einzelnes: Wie viel von einer Spur übrig bleibt, hängt an `MAX_TRAIL_ARC`
  // und `MAX_SEGMENT_STEP`, die beide im Azimut messen – nahe am Zenit dreht
  // der Azimut schnell –, und wo ein Objekt steht, hängt vom Startzeitpunkt
  // ab, weil die Bahnen zu `Date.now()` entworfen werden. Einzeln gezählt,
  // fiel LEO SICHTBAR unter Last auf 0 Segmente (Abnahme) und MEO SICHTBAR in
  // einem Kontrolllauf auf 1.
  const reversed60At = virtualNow();
  const timeBefore = telemetry.timeMs;
  await act(async () => engine.setTimeScale(-60));
  await sleep(3000);
  const now60 = virtualNow();
  const matched = matchVertices(now60 - 8000, reversed60At + 8000, 20);
  const off = matched.filter((m) => m.a.off > 0.1 || m.b.off > 0.1);
  const backward = matched.filter(
    (m) =>
      m.a.id === m.b.id &&
      m.a.id !== SLOW_ID &&
      m.a.off < 0.01 &&
      m.b.off < 0.01 &&
      m.lengthDeg > 0.01 &&
      Math.max(m.a.t, m.b.t) < reversed60At - 10_000,
  );
  const backwardIds = new Set(backward.map((m) => m.a.id));
  const count = (id: string) => backward.filter((m) => m.a.id === id).length;
  expect(
    'E ×−60: Spuren tasten rückwärts ab, telemetry.timeMs folgt',
    backward.length >= 3 && off.length === 0 && telemetry.timeMs < timeBefore - 150_000,
    `${backward.length} Segmente aus dem Rückwärtslauf von ${backwardIds.size} Objekten (LEO SICHTBAR ` +
      `${count(LEO_VIS_ID)}, MEO SICHTBAR ${count(MEO_VIS_ID)}), ${off.length} von ${matched.length} Segmenten ` +
      `abseits der Bahnen; telemetry.timeMs ${f((telemetry.timeMs - timeBefore) / 1000, 0)} s gegenüber vor dem Rückwärtslauf`,
  );
  await checkScale('E ×−60', -60);

  // E3: Zeitraffer aus der Echtzeit.
  await ensureRealtime();
  await checkScale('E ×60', 60);
  await checkScale('E ×600', 600);
  const segments = trailSegments();
  expect('E ×600: Spuren bleiben', segments.length > 0, `${segments.length} Spursegmente`);
  // Aktualisierung alle 250 ms Wanduhr = 150 s virtuelle Zeit.
  checkBodies('E ×600', 200_000);
}

/* ------------------------------------------------------------------ */
/* F: zurück zur Echtzeit                                               */
/* ------------------------------------------------------------------ */

if (runs('F')) {
  console.log('F. Zurück zur Echtzeit');
  if (isRealtime(useAppStore.getState().timeBase)) {
    await jumpAndWatch(() => engine.jumpTo(J_FUT));
  }
  let worstAgeMs = 0;
  let revisions = 0;
  const report = await jumpAndWatch(() => engine.resetToRealTime());
  expectJump('F Echtzeit', report, Date.now());
  // Nach jeder Revision: Abstand von telemetry.timeMs zur Wanduhr.
  let last = telemetry.revision;
  const watch = setInterval(() => {
    if (telemetry.revision === last) return;
    last = telemetry.revision;
    revisions += 1;
    worstAgeMs = Math.max(worstAgeMs, Math.abs(Date.now() - telemetry.timeMs));
  }, 2);
  await sleep(1500);
  clearInterval(watch);
  const tickAges = report.finalViews.map((v) => (v.tick ? v.tick.receivedAt - v.tick.time : NaN));
  const base = useAppStore.getState().timeBase;
  expect(
    'F Abweichung zur Wanduhr unter einem Tick (100 ms)',
    isRealtime(base) && virtualNow(123_456) === 123_456 && worstAgeMs < 100 && tickAges.every((a) => a >= 0 && a < 100),
    `Basis ${isRealtime(base) ? 'Echtzeit' : 'nicht Echtzeit'} (Epoche ${base.epoch}); Tickzeit je Shard ` +
      `${tickAges.map((a) => f(a, 0)).join(' / ')} ms vor dem Empfang; telemetry.timeMs bei ${revisions} Revisionen ` +
      `höchstens ${f(worstAgeMs, 0)} ms neben Date.now()`,
  );
  checkBodies('F Echtzeit', 21_000);
}

/* ------------------------------------------------------------------ */
/* G: Überflugliste                                                     */
/* ------------------------------------------------------------------ */

/** Jeder Überflug gegen satellite.js; dazu: gilt die Liste ab `fromMs`? */
function checkPasses(passes: PassPrediction[], fromMs: number | null): { ok: boolean; text: string } {
  const elevationDeg = (ms: number) => ((truth(ISS_TLE, ms)?.elevation ?? Number.NaN) * 180) / Math.PI;
  let worstPeak = 0;
  let worstEdge = 0;
  let outside = 0;
  for (const pass of passes) {
    worstPeak = Math.max(worstPeak, Math.abs(elevationDeg(pass.tca) - pass.maxElevationDeg));
    if (!pass.aosOpen) worstEdge = Math.max(worstEdge, Math.abs(elevationDeg(pass.aos)));
    if (!pass.losOpen) worstEdge = Math.max(worstEdge, Math.abs(elevationDeg(pass.los)));
    if (fromMs === null || pass.los < fromMs || pass.aos > fromMs + 49 * HOUR) outside += 1;
  }
  return {
    ok: passes.length > 0 && worstPeak < 0.1 && worstEdge < 0.1 && outside === 0,
    text:
      `${passes.length} Überflüge ab ${fromMs === null ? '–' : iso(fromMs)} UTC, erster ${passes[0] ? iso(passes[0].aos) : '–'}, ` +
      `Höchststand bis ${f(worstPeak, 3)}° neben satellite.js, Auf-/Untergang bis ${f(worstEdge, 3)}°, ${outside} außerhalb des Fensters`,
  };
}

const isPassFor = (data: ShardMessage) => data?.type === 'pass' && data.noradId === ISS_ID;
const heldPasses = () => held.filter((item) => isPassFor(item.data));

if (runs('G') || runs('H') || runs('I')) {
  await ensureRealtime();
  await act(async () => useAppStore.getState().select(ISS_ID));
  await waitFor('Überflugliste der ISS', () => useAppStore.getState().passId === ISS_ID);
}

if (runs('G')) {
  console.log('G. Überflugliste der ISS');
  {
    const state = useAppStore.getState();
    const result = checkPasses(state.passes, state.passFromMs);
    expect(
      'G0 Echtzeit: Liste gilt ab jetzt',
      result.ok && state.passFromMs !== null && Math.abs(state.passFromMs - Date.now()) < 10_000,
      result.text,
    );
  }

  // G1: einfacher Sprung – die Liste wird im selben Schritt geleert und für
  // die neue Zeit neu gesucht.
  let cleared = useAppStore.getState();
  await act(async () => {
    engine.jumpTo(J_FUT);
    // Unmittelbar nach dem Aufruf, bevor eine Antwort eintreffen kann.
    cleared = useAppStore.getState();
  });
  await waitFor('Liste für +6 h', () => useAppStore.getState().passId === ISS_ID);
  {
    const state = useAppStore.getState();
    const result = checkPasses(state.passes, state.passFromMs);
    expect(
      'G1 Sprung +6 h: alte Liste sofort weg, neue gilt ab der neuen Zeit',
      cleared.passes.length === 0 && cleared.passId === null && cleared.passPending &&
        result.ok && state.passFromMs !== null && state.passFromMs >= J_FUT && state.passFromMs - J_FUT < 10_000,
      `direkt nach dem Sprung ${cleared.passes.length} Überflüge, ausstehend ${cleared.passPending}; danach ${result.text}`,
    );
  }

  // G2: Die Antwort der alten Zeit kommt nach dem Sprung, aber vor der neuen –
  // die Reihenfolge, in der ein Shard sie tatsächlich liefert.
  holdFilter = isPassFor;
  engine.requestPass(ISS_ID as never);
  await waitFor('Liste der alten Zeit zurückgehalten', () => heldPasses().length >= 1);
  await act(async () => engine.jumpTo(J_30F));
  await waitFor('Liste der neuen Zeit zurückgehalten', () => heldPasses().length >= 2);
  holdFilter = null;
  const [oldResponse, newResponse] = heldPasses();
  if (!oldResponse || !newResponse) {
    // Ohne neue Anfrage nach dem Sprung kommt nur eine Antwort an.
    expect('G2 verspätete Liste der alten Zeit wird verworfen', false, `nur ${heldPasses().length} Antwort(en) zurückgehalten`);
    await act(async () => releaseHeld(isPassFor));
  } else {
    await act(async () => releaseHeld((data) => data === oldResponse.data));
    const afterOld = useAppStore.getState();
    await act(async () => releaseHeld((data) => data === newResponse.data));
    const afterNew = useAppStore.getState();
    const resultG2 = checkPasses(afterNew.passes, afterNew.passFromMs);
    expect(
      'G2 verspätete Liste der alten Zeit wird verworfen',
      afterOld.passId === null && afterOld.passes.length === 0 && afterOld.passPending &&
        afterNew.passId === ISS_ID && resultG2.ok && (afterNew.passFromMs ?? 0) >= J_30F,
      `nach der alten Antwort (ab ${iso((oldResponse.data as { fromMs?: number }).fromMs ?? NaN)} UTC): ` +
        `${afterOld.passes.length} Überflüge, ausstehend ${afterOld.passPending}; nach der neuen: ${resultG2.text}`,
    );
  }

  // G3: umgekehrt – die neue Liste ist schon da, die alte kommt hinterher.
  holdFilter = isPassFor;
  engine.requestPass(ISS_ID as never);
  await waitFor('Liste der alten Zeit zurückgehalten', () => heldPasses().length >= 1);
  await act(async () => engine.jumpTo(J_30B));
  await waitFor('Liste der neuen Zeit zurückgehalten', () => heldPasses().length >= 2);
  holdFilter = null;
  const [oldLate, newFirst] = heldPasses();
  if (!oldLate || !newFirst) {
    expect('G3 alte Liste überschreibt die neue nicht', false, `nur ${heldPasses().length} Antwort(en) zurückgehalten`);
    await act(async () => releaseHeld(isPassFor));
  } else {
    await act(async () => releaseHeld((data) => data === newFirst.data));
    const withNew = useAppStore.getState();
    await act(async () => releaseHeld((data) => data === oldLate.data));
    const afterLate = useAppStore.getState();
    expect(
      'G3 alte Liste überschreibt die neue nicht',
      withNew.passId === ISS_ID && afterLate.passes === withNew.passes && afterLate.passFromMs === withNew.passFromMs &&
        (withNew.passFromMs ?? NaN) >= J_30B && (withNew.passFromMs ?? NaN) - J_30B < 10_000,
      `Liste ab ${iso(withNew.passFromMs ?? NaN)} UTC, nach der verspäteten Antwort ` +
        `${afterLate.passes === withNew.passes ? 'dieselbe' : 'eine andere'} Liste ab ${iso(afterLate.passFromMs ?? NaN)} UTC`,
    );
  }

  // G4: Nachführung. ×60 000 – ein Tag vergeht in 1,4 s.
  const fromBefore = useAppStore.getState().passFromMs ?? NaN;
  await act(async () => engine.setTimeScale(60_000));
  const forward = await waitFor('Liste nachgeführt (vorwärts)', () => (useAppStore.getState().passFromMs ?? 0) > fromBefore + 24 * HOUR);
  const fwd = useAppStore.getState();
  const fwdResult = checkPasses(fwd.passes, fwd.passFromMs);
  const fwdFrom = fwd.passFromMs ?? NaN;
  await act(async () => engine.setTimeScale(-60_000));
  const backward = await waitFor(
    'Liste nachgeführt (rückwärts)',
    () => (useAppStore.getState().passFromMs ?? Number.POSITIVE_INFINITY) < fwdFrom - HOUR,
  );
  const back = useAppStore.getState();
  const backResult = checkPasses(back.passes, back.passFromMs);
  await act(async () => engine.setTimeScale(1));
  expect(
    'G4 Liste folgt dem Zeitraffer in beide Richtungen',
    forward && backward && fwdResult.ok && backResult.ok,
    `vorwärts: ${fwdResult.text} (${hours(fwdFrom - fromBefore)}); rückwärts: ${backResult.text} ` +
      `(${hours((back.passFromMs ?? NaN) - fwdFrom)})`,
  );
  await ensureRealtime();
  await waitFor('Liste in Echtzeit', () => useAppStore.getState().passId === ISS_ID);
}

/* ------------------------------------------------------------------ */
/* H: Bahnspur des gewählten Objekts                                    */
/* ------------------------------------------------------------------ */

const isTrailFor = (data: ShardMessage) => data?.type === 'trail' && data.noradId === ISS_ID;

/** Spur in `trailState` gegen satellite.js zur Zeit, die der Shard gemeldet hat (−25 … +70 min, 220 Punkte). */
function checkTrail(): { ok: boolean; text: string } {
  const points = trailState.points;
  const t0 = trailState.timeMs;
  if (trailState.noradId !== ISS_ID || !points || t0 === null) {
    return { ok: false, text: `trailState gehört zu ${trailState.noradId ?? 'niemandem'}` };
  }
  const samples = points.length / 3;
  let worst = 0;
  for (let i = 0; i < samples; i += 1) {
    const t = t0 + (-25 + (95 * i) / (samples - 1)) * 60_000;
    const ref = truth(ISS_TLE, t);
    if (!ref) return { ok: false, text: `satellite.js ohne Lösung bei Punkt ${i}` };
    worst = Math.max(worst, angleDeg([points[i * 3], points[i * 3 + 1], points[i * 3 + 2]], ref.dir));
  }
  return { ok: worst < 0.01, text: `${samples} Punkte ab ${iso(t0)} UTC, größte Abweichung ${f(worst, 4)}°` };
}

if (runs('H')) {
  console.log('H. Bahnspur der ISS, angefordert von OrbitTrail');
  // Gewählt seit dem Vorspann; OrbitTrail hat die Spur selbst angefordert.
  await waitFor('Spur in Echtzeit', () => trailState.noradId === ISS_ID);
  const before = checkTrail();

  // Eine Antwort, gerechnet vor dem Sprung, kommt erst danach an.
  holdFilter = isTrailFor;
  engine.requestTrail(ISS_ID as never);
  await waitFor('Spur der alten Zeit zurückgehalten', () => held.some((item) => isTrailFor(item.data)));
  const sentBefore = sentLog.length;
  let sentDuringJump: string[] = [];
  let clearedOnJump = false;
  let jumpedAt = 0;
  await act(async () => {
    jumpedAt = Date.now();
    engine.jumpTo(J_PAST);
    // Unmittelbar nach dem Aufruf, bevor React Effekte ausführt.
    sentDuringJump = sentLog.slice(sentBefore).map((m) => m.type);
    clearedOnJump = trailState.noradId === null && trailState.points === null;
  });
  const newEpoch = useAppStore.getState().timeBase.epoch;
  // Neu angefordert wird nur, weil OrbitTrail an der Epoche hängt.
  const firstSent = (type: string) => sentLog.slice(sentBefore).find((m) => m.type === type);
  await waitFor('Spur-Anfrage von OrbitTrail', () => firstSent('trail') !== undefined, 2000);
  const trailAfterMs = (firstSent('trail')?.at ?? Number.NaN) - jumpedAt;
  const passAfterMs = (firstSent('pass')?.at ?? Number.NaN) - jumpedAt;
  await waitFor(
    'Spur der neuen Zeit zurückgehalten',
    () => held.some((item) => isTrailFor(item.data) && item.data.epoch === newEpoch),
    3000,
  );
  holdFilter = null;
  // Erst die alte Antwort, dann die neue – die Reihenfolge, in der der Shard sie liefert.
  const releasedOld = await act(async () => releaseHeld((data) => isTrailFor(data) && data.epoch !== newEpoch));
  const afterLate = trailState.noradId;
  const releasedNew = await act(async () => releaseHeld(isTrailFor));
  await waitFor('Linie sichtbar', () => orbitLine()?.visible === true, 1000);
  const after = checkTrail();
  const line = orbitLine();
  const drawn = line !== null && line.visible && (line.material as { visible: boolean }).visible;
  expect(
    'H Bahnspur: beim Sprung geleert, von OrbitTrail neu angefordert, alte verworfen, neue zur neuen Zeit',
    before.ok && clearedOnJump && trailAfterMs >= 0 && trailAfterMs < 1000 && releasedOld >= 1 &&
      afterLate === null && releasedNew >= 1 && after.ok && Math.abs((trailState.timeMs ?? NaN) - J_PAST) < 10_000 && drawn,
    `vorher ${before.text}; beim Sprung ${clearedOnJump ? 'geleert' : 'stehen geblieben'}; Anfrage von OrbitTrail ` +
      `${f(trailAfterMs, 0)} ms nach dem Sprung; ${releasedOld} verspätete Spur(en) der alten Zeit ` +
      `${afterLate === null ? 'verworfen' : 'übernommen'}; danach ${after.text}; Linie und Material ` +
      `${drawn ? 'sichtbar' : 'nicht sichtbar'}`,
  );
  expect(
    'H Während jumpTo gehen nur time-Nachrichten hinaus, Anfragen der Effekte danach',
    sentDuringJump.length === engine.shardCount && sentDuringJump.every((type) => type === 'time') && trailAfterMs >= 0,
    `im Aufruf: ${sentDuringJump.join(', ') || 'nichts'}; danach Spur-Anfrage nach ${f(trailAfterMs, 0)} ms, ` +
      `Überflug-Anfrage nach ${f(passAfterMs, 0)} ms`,
  );

  // H2: Im Zeitraffer führt OrbitTrail nach virtueller Zeit nach. Nach der
  // Wanduhr (alle 12 s) liefe das Objekt bei ×600 schon nach 7 s aus der
  // Spur, die 70 min vorausreicht.
  const sentBeforeFast = sentLog.length;
  await act(async () => engine.setTimeScale(600));
  await sleep(2000);
  const fastRequests = sentLog.slice(sentBeforeFast).filter((m) => m.type === 'trail').length;
  const lagS = (virtualNow() - (trailState.timeMs ?? Number.NaN)) / 1000;
  const fastTrail = checkTrail();
  await act(async () => engine.setTimeScale(1));
  expect(
    'H2 ×600: Bahnspur folgt der virtuellen Zeit',
    fastRequests >= 4 && fastTrail.ok && lagS >= 0 && lagS < 400,
    `${fastRequests} Spur-Anfragen in 2 s, jüngste Spur ${f(lagS, 0)} s virtuelle Zeit alt; ${fastTrail.text}`,
  );

  // H3: Ein Sprung um wenige Sekunden. Die Nachführung nach virtueller Zeit
  // (alle 12 s) fängt einen großen Sprung auch ohne die Epoche im Effekt
  // binnen 250 ms auf; einen kleinen nicht – dann bliebe die vom Pool
  // geleerte Spur bis zu 12 s weg. Vorher ein großer Sprung, damit jede
  // Fassung von OrbitTrail gerade frisch angefordert hat.
  await act(async () => engine.jumpTo(J_FUT));
  await sleep(600);
  const sentBeforeSmall = sentLog.length;
  const smallTarget = virtualNow() + 4000;
  const smallAt = Date.now();
  await act(async () => engine.jumpTo(smallTarget));
  await waitFor('Spur nach dem kleinen Sprung', () => trailState.noradId === ISS_ID, 1500);
  const smallRequest = sentLog.slice(sentBeforeSmall).find((m) => m.type === 'trail');
  const smallTrail = checkTrail();
  expect(
    'H3 Sprung um 4 s: Bahnspur sofort neu angefordert',
    smallRequest !== undefined && smallRequest.at - smallAt < 500 && smallTrail.ok &&
      Math.abs((trailState.timeMs ?? Number.NaN) - smallTarget) < 5000,
    `Spur-Anfrage ${smallRequest ? `${f(smallRequest.at - smallAt, 0)} ms` : 'keine binnen 1,5 s'} nach dem Sprung; ${smallTrail.text}`,
  );
}

/* ------------------------------------------------------------------ */
/* I: Countdown                                                         */
/* ------------------------------------------------------------------ */

if (runs('I')) {
  console.log('I. Countdown der Überflugliste in virtueller Zeit');
  await jumpAndWatch(() => engine.jumpTo(J_30F));
  await waitFor('Liste für +30 Tage', () => useAppStore.getState().passId === ISS_ID);
  const { passes } = useAppStore.getState();
  const now = virtualNow();
  const shown = passCountdown(passes, now);
  const next = passes.find((p) => p.los > now);
  const expected = next ? (next.aos <= now ? null : formatCountdown(next.sunlitStart ?? next.aos, now)) : '–';
  const wall = passCountdown(passes, Date.now());
  expect(
    'I Countdown rechnet gegen die virtuelle Zeit',
    next !== undefined && (expected === null ? shown.text.startsWith('läuft') : shown.text === expected) && wall.text !== shown.text,
    `„${shown.text}“ (erster Überflug ${next ? iso(next.aos) : '–'} UTC, virtuelle Zeit ${iso(now)} UTC); ` +
      `gegen die Wanduhr stünde „${wall.text}“`,
  );
}

/* ------------------------------------------------------------------ */
/* J: Geschwindigkeit und Rückkehr zur Echtzeit                         */
/* ------------------------------------------------------------------ */

if (runs('J')) {
  console.log('J. Geschwindigkeit: stetig, ohne Epochenwechsel; Rückkehr zur Echtzeit aus einem Sprung bei ×1');
  await act(async () => useAppStore.getState().select(null));
  await ensureRealtime();
  {
    const revision = telemetry.revision;
    await waitFor('drei vollständige Ticks', () => telemetry.revision >= revision + 3);
  }

  // J1: Eine Geschwindigkeitsänderung setzt die virtuelle Zeit dort fort, wo
  // sie gerade steht, und lässt die Epoche stehen. Erlaubt ist nur, was
  // zwischen den beiden Messungen vergeht: (t1 − t0) × die größere der beiden
  // Geschwindigkeiten. Beide Messungen liegen im selben synchronen Schritt
  // wie der Aufruf, t1 − t0 ist also 0 oder 1 ms.
  const rows: string[] = [];
  let steady = true;
  for (const scale of [60, -60, 0, 600, 1]) {
    const base0 = useAppStore.getState().timeBase;
    const telemetryEpoch0 = telemetry.epoch;
    let t0 = 0;
    let t1 = 0;
    let v0 = 0;
    let v1 = 0;
    await act(async () => {
      t0 = Date.now();
      v0 = virtualTimeAt(useAppStore.getState().timeBase, t0);
      engine.setTimeScale(scale);
      t1 = Date.now();
      v1 = virtualTimeAt(useAppStore.getState().timeBase, t1);
    });
    const base1 = useAppStore.getState().timeBase;
    const revision = telemetry.revision;
    await sleep(500);
    const revisions = telemetry.revision - revision;
    const tolerance = (t1 - t0) * Math.max(Math.abs(base0.scale), Math.abs(scale));
    const jump = v1 - v0;
    const ok =
      Math.abs(jump) <= tolerance &&
      base1.scale === scale &&
      base1.epoch === base0.epoch &&
      telemetry.epoch === telemetryEpoch0 &&
      revisions >= 2;
    steady &&= ok;
    rows.push(
      `×${base0.scale} → ×${scale}: Sprung ${f(jump, 0)} ms (erlaubt ${f(tolerance, 0)}), Epoche ${base0.epoch} → ${base1.epoch}, ` +
        `telemetry.epoch ${telemetryEpoch0} → ${telemetry.epoch}, ${revisions} Revisionen in 500 ms`,
    );
  }
  expect('J1 setTimeScale: virtuelle Zeit stetig, Epoche bleibt, Telemetrie läuft weiter', steady, rows.join('; '));

  // J2: ×1 nach dem Zeitraffer bleibt in der virtuellen Zeit.
  {
    const base = useAppStore.getState().timeBase;
    const offsetMs = virtualNow() - Date.now();
    expect(
      'J2 setTimeScale(1) bleibt in der virtuellen Zeit',
      base.scale === 1 && !isRealtime(base) && Math.abs(offsetMs) > 60_000,
      `Geschwindigkeit ${base.scale}, isRealtime ${isRealtime(base)}, Vorlauf ${f(offsetMs / 1000, 1)} s gegenüber der Wanduhr`,
    );
  }

  // J3: Pause – virtuelle Zeit und freigegebene Telemetrie stehen, die Ticks laufen weiter.
  {
    await act(async () => engine.setTimeScale(0));
    await sleep(300);
    const v1 = virtualNow();
    const tm1 = telemetry.timeMs;
    const revision = telemetry.revision;
    await sleep(700);
    const v2 = virtualNow();
    const tm2 = telemetry.timeMs;
    expect(
      'J3 Pause: virtuelle Zeit und telemetry.timeMs stehen',
      v1 === v2 && tm1 === tm2 && telemetry.revision - revision >= 2,
      `virtuell Δ ${v2 - v1} ms, telemetry.timeMs Δ ${tm2 - tm1} ms, ${telemetry.revision - revision} Revisionen in 700 ms`,
    );
    await act(async () => engine.setTimeScale(1));
  }

  // J4: Nicht endliche Werte werden abgewiesen, statt die Zeitbasis zu zerstören.
  {
    const results: string[] = [];
    const before = useAppStore.getState().timeBase;
    for (const [label, call] of [
      ['setTimeScale(NaN)', () => engine.setTimeScale(Number.NaN)],
      ['setTimeScale(Infinity)', () => engine.setTimeScale(Number.POSITIVE_INFINITY)],
      ['jumpTo(NaN)', () => engine.jumpTo(Number.NaN)],
    ] as const) {
      try {
        call();
        results.push(`${label}: kein Fehler`);
      } catch (error) {
        results.push(`${label}: ${(error as Error).name}`);
      }
    }
    expect(
      'J4 nicht endliche Werte werfen RangeError, Zeitbasis bleibt',
      results.every((r) => r.endsWith('RangeError')) && useAppStore.getState().timeBase === before,
      results.join(', '),
    );
  }

  // J5: Der Hauptfall eines „Jetzt“-Knopfs – nach einem Sprung bei ×1 zurück
  // zur Wanduhr. Bei ×1 unterscheidet nur der Versatz die Basis von Echtzeit.
  {
    await jumpAndWatch(() => engine.jumpTo(J_FUT));
    const jumped = useAppStore.getState().timeBase;
    const report = await jumpAndWatch(() => engine.resetToRealTime());
    const base = useAppStore.getState().timeBase;
    const offsetMs = virtualNow() - Date.now();
    expect(
      'J5 resetToRealTime nach einem Sprung bei ×1',
      jumped.scale === 1 && !isRealtime(jumped) && isRealtime(base) && base.epoch === jumped.epoch + 1 && Math.abs(offsetMs) <= 1,
      `vorher ×${jumped.scale}, ${hours(virtualTimeAt(jumped, Date.now()) - Date.now())} gegenüber der Wanduhr, ` +
        `Epoche ${jumped.epoch}; danach isRealtime ${isRealtime(base)}, Epoche ${base.epoch}, Versatz ${offsetMs} ms`,
    );
    expectJump('J5 Echtzeit', report, Date.now());

    // J6: In Echtzeit ist `resetToRealTime` wirkungslos – kein Epochenwechsel,
    // der Telemetrie und Überflugliste grundlos anhielte.
    const epochBefore = useAppStore.getState().timeBase.epoch;
    await act(async () => engine.resetToRealTime());
    expect(
      'J6 resetToRealTime in Echtzeit ändert nichts',
      useAppStore.getState().timeBase.epoch === epochBefore && isRealtime(useAppStore.getState().timeBase),
      `Epoche ${epochBefore} → ${useAppStore.getState().timeBase.epoch}`,
    );
  }
}

console.log(`${checks} Prüfungen, ${failures} Fehlschläge`);
clearInterval(pump);
for (const worker of [...liveWorkers]) worker.terminate();
if (failures > 0) process.exit(1);
console.log('✓ Sprung, Zeitraffer, Rückwärtslauf und Echtzeit: Telemetrie, Spuren, Sonne/Mond und Überflüge folgen der virtuellen Zeit');
process.exit(0);
