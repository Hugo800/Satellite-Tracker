/**
 * Prüft die Auswahl über den ganzen Weg Hook → Worker-Pool → Shard →
 * `scatter` → `readSample`, mit dem echten Code aus
 * src/hooks/useSatelliteEngine.ts und src/workers/sgp4.worker.ts.
 *
 * Abschnitte 0 und A–D: Bahnhöhe und Subpunkt des ausgewählten Objekts kommen
 * im Telemetrie-Buffer an. Anlass ist ein Gerätebild (iPhone, PWA,
 * 24.09.2026, 06:25 MESZ): Für BEIDOU-3 M16 standen „Bahnhöhe – km“ und
 * „Subpunkt –° / –°“ in der Karte, Elevation, Azimut, Distanz und Speed
 * zeigten Werte. Abschnitt 0 belegt, dass diese Werte über sechs Stunden alt
 * waren: Der zuständige Shard hat seit dem Vorabend keinen Tick mehr
 * geliefert. Subpunkt und Bahnhöhe entstehen seit c027d50 nur im Tick nach der
 * Auswahl – ohne Tick bleiben sie NaN.
 *
 * Abschnitte E–I: Die Auswahl hängt an der NORAD-ID, nicht am Platz im
 * Telemetrie-Buffer.
 *   E  Auswahl per ID: Karte, Telemetrie, Bahnspur und Überflüge gehören zu
 *      genau diesem Objekt.
 *   F  Plätze verschieben sich: F1 Fallback-Ersatz beim Start (gleicher
 *      Platz, neue Bahndaten), F2 neu aufgebauter Pool, in dem Starlink diesmal
 *      lädt und der Gesamtkatalog deshalb sieben Plätze weiter hinten steht.
 *   G  Verspätete Antworten für ein vorher gewähltes Objekt werden verworfen.
 *   H  Eine ID, die nicht im Katalog steht, bleibt gewählt und löst sich auf,
 *      sobald ihre (zuvor fehlgeschlagene) Gruppe nachgeladen ist.
 *   I  Alpha-5: `A0001` über Liste, Tap und rohe Kennung.
 * Referenz ist dort satellite.js direkt (`propagate`, `gstime`,
 * `ecfToLookAngles`, `eciToGeodetic`) mit demselben TLE – nicht src/math.
 *
 * Gegenprobe gegen den Stand vor der Umstellung (3c5dc67): src per
 * `git show HEAD:…` nach node_modules/.cache/, die mit GEGENPROBE markierte
 * Zeile auf `select(index)` + `engine.requestPass(index)` umgestellt, die
 * alten Feldnamen (`passIndex`, `trailState.index`) auf die neuen abgebildet,
 * Abschnitt F allein (`SELECTION_ONLY=F`). Ergebnis siehe Abschnitt F.
 *
 * Aufbau ohne Browser:
 *   - Die Shards laufen als echte Threads (`node:worker_threads`) mit dem
 *     gebündelten Worker (node_modules/.cache/verify-selection-worker.mjs).
 *     Ein Vorspann stellt `self` bereit, liefert statt CelesTrak feste
 *     TLE-Sätze mit Epoche „heute“ aus, kann Abrufe scheitern lassen, die
 *     langen Wartezeiten des Laders stauchen und den Thread mitten in einem
 *     Tick „einfrieren“ (Abschnitt D).
 *   - Hook, OrbitTrail und TapPicker laufen im echten Reconciler von React
 *     Three Fiber wie in scripts/verify-wiring.ts; `Worker` ist eine Hülle um
 *     den Node-Thread, die Antworten auch zurückhalten kann (Abschnitt G).
 *   - Karte, Liste und HUD rendert react-dom/server aus dem aktuellen Store.
 *
 * Aufruf: npm run verify:selection – einzelne Abschnitte mit
 * `SELECTION_ONLY=EG npm run verify:selection`.
 */
import { Fragment, StrictMode, createElement, type FunctionComponent, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.browser';
import { act, advance, createRoot, type RootState } from '@react-three/fiber';
import { Worker as NodeWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { PerspectiveCamera } from 'three';
import type { Line2 } from 'three-stdlib';
import type { StoreApi, UseBoundStore } from 'zustand';
import {
  ecfToLookAngles,
  eciToEcf,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
  type SatRec,
} from 'satellite.js';
import { OrbitTrail } from '../src/components/canvas/OrbitTrail';
import { TapPicker } from '../src/components/canvas/TapPicker';
import { Hud } from '../src/components/ui/Hud';
import { SatelliteDrawer } from '../src/components/ui/SatelliteDrawer';
import { TelemetryPanel } from '../src/components/ui/TelemetryPanel';
// Als Namensraum: Die Gegenprobe bündelt diese Datei gegen den alten Stand,
// dem `normalizeNoradId` fehlt – ein benannter Import bräche dort den Build.
import * as tleSources from '../src/data/tleSources';
import { engine, useSatelliteEngine } from '../src/hooks/useSatelliteEngine';
import { RAD, geoToObserverGd } from '../src/math/coords';
import { propagateEphemeris } from '../src/math/propagation';
import { catalogIndex, readSample, telemetry, trailState } from '../src/state/runtime';
import { useAppStore } from '../src/state/store';
import type { PassPrediction, SatelliteGroup } from '../src/types';

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

const ONLY = process.env.SELECTION_ONLY ?? '';
/** Läuft dieser Abschnitt? Ohne `SELECTION_ONLY` alle. */
const runs = (section: string): boolean => ONLY === '' || ONLY.includes(section);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const f = (value: number, digits = 1): string =>
  Number.isFinite(value) ? value.toFixed(digits).replace('.', ',') : String(value);

/** Leipzig, wie in der Kopfzeile des Gerätebilds (51,389°, 12,356°). */
const OBSERVER = { latitudeDeg: 51.389, longitudeDeg: 12.356, altitudeKm: 0.12 };
const observerGd = geoToObserverGd(OBSERVER);

/* ------------------------------------------------------------------ */
/* 0. Gerätebild: Wie alt waren die angezeigten Werte?                  */
/* ------------------------------------------------------------------ */

console.log('0. Gerätebild vom 24.09.2026, 06:25 MESZ: Alter der angezeigten Telemetrie');
{
  // CelesTrak-Satz von BEIDOU-3 M16 (Epoche 21.09.2026), abgerufen am
  // 24.09.2026. Für ein MEO-Objekt ist das über wenige Tage auf Bruchteile
  // eines Grads genau.
  const satrec = twoline2satrec(
    '1 43647U 18078A   26264.13329856 -.00000015  00000+0  00000+0 0  9990',
    '2 43647  54.0007 296.6129 0006093  30.7925 329.3056  1.86232488 53942',
  );
  const shown = { elevationDeg: 82.53, azimuthDeg: 99, rangeKm: 21563.3 };
  const screenshotMs = Date.UTC(2026, 8, 24, 4, 25);
  const at = (ms: number) => propagateEphemeris(satrec, new Date(ms), observerGd);
  const now = at(screenshotMs);

  // Die letzten 24 h im 10-s-Raster: Wann stand M16 dort, wo die Karte ihn zeigte?
  let bestMs = screenshotMs;
  let bestError = Number.POSITIVE_INFINITY;
  for (let ms = screenshotMs - 86_400_000; ms <= screenshotMs; ms += 10_000) {
    const eph = at(ms);
    if (!eph) continue;
    const error =
      Math.abs(eph.elevation * RAD - shown.elevationDeg) +
      Math.abs(eph.azimuth * RAD - shown.azimuthDeg) / 5 +
      Math.abs(eph.rangeKm - shown.rangeKm) / 50;
    if (error < bestError) {
      bestError = error;
      bestMs = ms;
    }
  }
  const match = at(bestMs);
  const ageMin = (screenshotMs - bestMs) / 60_000;
  expect(
    'angezeigte Werte stammen nicht aus der Zeit des Bilds',
    now !== null && match !== null && now.elevation < 0 && ageMin > 60,
    `um 06:25 stand M16 bei ${f((now?.elevation ?? NaN) * RAD, 1)}° Elevation (unter dem Horizont); ` +
      `die angezeigten ${f(shown.elevationDeg, 2)}° / ${shown.azimuthDeg}° / ${f(shown.rangeKm)} km passen zu ` +
      `${new Date(bestMs).toISOString().slice(0, 16).replace('T', ' ')} UTC ` +
      `(${f((match?.elevation ?? NaN) * RAD, 2)}° / ${f((match?.azimuth ?? NaN) * RAD, 1)}° / ${f(match?.rangeKm ?? NaN)} km), ` +
      `also ${Math.floor(ageMin / 60)} h ${Math.round(ageMin % 60)} min alt`,
  );
}

/* ------------------------------------------------------------------ */
/* TLE-Sätze mit Epoche „jetzt“                                         */
/* ------------------------------------------------------------------ */

type Tle = [string, string, string];

/** Prüfziffer nach NORAD: Ziffernsumme, Minus zählt 1. */
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
  /** Katalogfeld der TLE-Zeile, wie CelesTrak es liefert – auch Alpha-5. */
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

/**
 * Baut einen Dreizeiler mit heutiger Epoche. Feste Sätze würden altern: Ein
 * LEO-Objekt divergiert nach einigen Monaten, und dann fehlte die ganze Zeile
 * statt nur des Subpunkts.
 */
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

const LEO: Elements = {
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

/** Bahn wie BEIDOU-3 M16 aus dem Gerätebild: 773,2 min Umlaufzeit, also SDP4 (Deep Space). */
const MEO: Elements = {
  name: 'BEIDOU-3 M16',
  norad: '43647',
  intl: '18078A',
  inclination: 54.0007,
  raan: 296.6129,
  eccentricity: 0.0006093,
  argPerigee: 30.7925,
  meanAnomaly: 329.3056,
  meanMotion: 1.86232488,
  bstar: ' 00000+0',
};

/** Füllmaterial, damit die Indizes über alle Shards streuen. */
function fillers(epochMs: number, count: number): string {
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
        epochMs,
      ),
    );
  }
  return text;
}

const epochMs = Date.now();
const LEO_TLE = makeTle(LEO, epochMs);
const MEO_TLE = makeTle(MEO, epochMs);
/** `stations` liefert die ISS; der Gesamtkatalog (`active`) bringt sie erneut mit – sie darf nur einmal zählen. */
const FEED = {
  stations: block(LEO_TLE),
  active: fillers(epochMs, 23) + block(MEO_TLE) + block(LEO_TLE),
};

/* ------------------------------------------------------------------ */
/* Referenz: satellite.js direkt                                        */
/* ------------------------------------------------------------------ */

/** Beobachter im Format von satellite.js, unabhängig von src/math berechnet. */
const REF_OBSERVER = {
  latitude: (OBSERVER.latitudeDeg * Math.PI) / 180,
  longitude: (OBSERVER.longitudeDeg * Math.PI) / 180,
  height: OBSERVER.altitudeKm,
};

interface Truth {
  azimuth: number;
  elevation: number;
  rangeKm: number;
  altitudeKm: number;
  latitudeDeg: number;
  longitudeDeg: number;
}

const satrecCache = new Map<string, SatRec>();

/** Wo steht das Objekt aus `tle` zur Zeit `ms`? Nur satellite.js, kein Code aus src/. */
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
  const gmst = gstime(date);
  const look = ecfToLookAngles(REF_OBSERVER, eciToEcf(position, gmst));
  const geo = eciToGeodetic(position, gmst);
  return {
    azimuth: look.azimuth,
    elevation: look.elevation,
    rangeKm: look.rangeSat,
    altitudeKm: geo.height,
    latitudeDeg: (geo.latitude * 180) / Math.PI,
    longitudeDeg: (geo.longitude * 180) / Math.PI,
  };
}

/** Blickrichtung wie in TapPicker und OrbitTrail: x Ost, y oben, −z Nord. */
function direction(azimuth: number, elevation: number): [number, number, number] {
  const cosEl = Math.cos(elevation);
  return [cosEl * Math.sin(azimuth), Math.sin(elevation), -cosEl * Math.cos(azimuth)];
}

function angleDeg(a: [number, number, number], b: [number, number, number]): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = Math.hypot(...a) * Math.hypot(...b);
  return (Math.acos(Math.min(1, Math.max(-1, dot / norm))) * 180) / Math.PI;
}

/* ------------------------------------------------------------------ */
/* Katalog für die Abschnitte E–I                                       */
/* ------------------------------------------------------------------ */

/** Sieben Starlink-Objekte: so viele Plätze rückt der Gesamtkatalog nach hinten, wenn Starlink lädt. */
const STARLINKS: Elements[] = Array.from({ length: 7 }, (_, i) => ({
  name: `STARLINK-T${i}`,
  norad: String(70000 + i),
  intl: '26010A',
  inclination: 53.05,
  raan: (i * 47) % 360,
  eccentricity: 0.0001,
  argPerigee: 90,
  meanAnomaly: (i * 61) % 360,
  meanMotion: 15.06,
  bstar: ' 20000-3',
}));
const STARLINK_TLES = STARLINKS.map((el) => makeTle(el, epochMs));

/**
 * Ein Objekt mit Alpha-5-Kennung. Bahn wie ein Galileo-Satellit, Knoten und
 * Anomalie so gewählt, dass es über Leipzig hoch am Himmel steht: Der Tap in
 * Abschnitt I braucht ein Objekt über dem Horizont.
 */
function alpha5Elements(): Elements {
  const base: Elements = {
    name: 'ALPHA5 TESTOBJEKT',
    norad: 'A0001',
    intl: '26020A',
    inclination: 56,
    raan: 0,
    eccentricity: 0.0003,
    argPerigee: 0,
    meanAnomaly: 0,
    meanMotion: 1.7,
    bstar: ' 00000+0',
  };
  let best = { minEl: Number.NEGATIVE_INFINITY, raan: 0, meanAnomaly: 0 };
  for (let raan = 0; raan < 360; raan += 10) {
    for (let meanAnomaly = 0; meanAnomaly < 360; meanAnomaly += 10) {
      const tle = makeTle({ ...base, raan, meanAnomaly }, epochMs);
      const a = truth(tle, epochMs);
      const b = truth(tle, epochMs + 30 * 60_000);
      if (!a || !b) continue;
      const minEl = Math.min(a.elevation, b.elevation);
      if (minEl > best.minEl) best = { minEl, raan, meanAnomaly };
    }
  }
  return { ...base, raan: best.raan, meanAnomaly: best.meanAnomaly };
}
const ALPHA5 = alpha5Elements();
const ALPHA5_TLE = makeTle(ALPHA5, epochMs);

/** Katalog mit Starlink und Alpha-5: stations = ISS, starlink = 7 Objekte, active = Gesamtkatalog. */
const FEED_FULL = {
  stations: block(LEO_TLE),
  starlink: STARLINK_TLES.map(block).join(''),
  active: fillers(epochMs, 23) + block(MEO_TLE) + block(ALPHA5_TLE) + block(LEO_TLE),
};

/** Was die Prüfung von einem Objekt erwartet: Name, normalisierte ID, TLE. */
interface Target {
  name: string;
  id: string;
  tle: Tle;
}
const LEO_T: Target = { name: LEO.name, id: LEO.norad, tle: LEO_TLE };
const MEO_T: Target = { name: MEO.name, id: MEO.norad, tle: MEO_TLE };
const STARLINK_T3: Target = { name: STARLINKS[3].name, id: STARLINKS[3].norad, tle: STARLINK_TLES[3] };
/** Normalisiert von Hand: A = 10, also 10·10000 + 1. */
const ALPHA5_T: Target = { name: ALPHA5.name, id: '100001', tle: ALPHA5_TLE };

/* ------------------------------------------------------------------ */
/* Worker-Pool als Node-Threads                                         */
/* ------------------------------------------------------------------ */

const WORKER_BUNDLE = fileURLToPath(new URL('./verify-selection-worker.mjs', import.meta.url));

/**
 * Vorspann je Shard (CommonJS, weil `eval: true`).
 *
 * `self` entsteht vor dem Import des Workers, denn der liest es auf oberster
 * Ebene. Nachrichten nimmt der Port erst an, wenn der Worker seinen Handler
 * gesetzt hat – wie im Browser, wo sie bis zum Ende des Skripts warten.
 *
 * `failCalls` lässt die ersten n Abrufe einer Gruppe mit HTTP 404 scheitern,
 * wie ein gedrosseltes CelesTrak. `shortWaits` staucht die langen Wartezeiten
 * des Laders – Gruppenabstand 1,5 s und Wiederholungen auf ein Zwanzigstel,
 * das Nachladen nach 45 s auf `retryMs` –, damit Abschnitte F und H nicht
 * minutenlang laufen. Takt und Tick bleiben unberührt (alles unter 1,5 s).
 *
 * `freeze` bildet nach, was iOS mit einer Seite im Hintergrund oder bei
 * gesperrtem Display tut: Der Prozess steht, die monotone Uhr hinter
 * `performance.now()` läuft weiter. Die Nachricht kommt zwischen zwei Ticks
 * an; der nächste Aufruf von `performance.now()` ist also der Beginn des
 * nächsten Ticks, und alle späteren liegen um die Pause weiter. Genau das
 * sieht ein Tick, in den das Anhalten fällt. `Date.now()` bleibt unberührt:
 * Es bestimmt nur, welche Epoche propagiert wird, nicht wann.
 */
const BOOTSTRAP = `
const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const scope = {
  onmessage: null,
  postMessage(message, transfer) { parentPort.postMessage(message, transfer || []); },
};
globalThis.self = scope;
const realSetTimeout = globalThis.setTimeout;
const calls = {};
globalThis.fetch = async (url) => {
  const group = new URL(String(url)).searchParams.get('GROUP');
  calls[group] = (calls[group] || 0) + 1;
  const delay = workerData.delays[group] || 0;
  if (delay) await new Promise((resolve) => realSetTimeout(resolve, delay));
  const failing = calls[group] <= (workerData.failCalls[group] || 0);
  const text = failing ? '' : workerData.feed[group];
  return text ? new Response(text, { status: 200 }) : new Response('No GP data found', { status: 404 });
};
if (workerData.shortWaits) {
  globalThis.setTimeout = (fn, ms, ...args) =>
    realSetTimeout(fn, ms >= 40000 ? workerData.retryMs : ms >= 1500 ? ms / 20 : ms, ...args);
}
const realNow = performance.now.bind(performance);
let offset = 0;
let pendingFreeze = 0;
Object.defineProperty(performance, 'now', {
  configurable: true,
  value: () => {
    const value = realNow() + offset;
    offset += pendingFreeze;
    pendingFreeze = 0;
    return value;
  },
});
import(pathToFileURL(workerData.bundle).href).then(() => {
  parentPort.on('message', (data) => {
    if (data && data.harness === 'freeze') {
      pendingFreeze = data.ms;
      return;
    }
    if (scope.onmessage) scope.onmessage({ data });
  });
});
`;

interface PoolSetup {
  feed: Record<string, string>;
  delays: Record<string, number>;
  failCalls: Record<string, number>;
  shortWaits: boolean;
  retryMs: number;
}

const DEFAULT_SETUP: PoolSetup = { feed: FEED, delays: {}, failCalls: {}, shortWaits: false, retryMs: 0 };
let poolSetup: PoolSetup = DEFAULT_SETUP;
const liveWorkers = new Set<ThreadWorker>();

/** Nachricht eines Shards, soweit die Prüfung sie liest. */
interface ShardMessage {
  type?: string;
  time?: number;
  durationMs?: number;
  noradId?: string;
  points?: Float32Array;
}

/** Letzte Bahnspur-Anfrage je ID – das Zeitfenster, in dem der Shard sie gerechnet hat. */
interface TrailRequest {
  at: number;
  fromMin: number;
  toMin: number;
  samples: number;
}
const trailRequests = new Map<string, TrailRequest>();
/** Jede eingetroffene Bahnspur, mit Anfrage- und Empfangszeit. */
const trailLog: Array<{ noradId: string | undefined; points: Float32Array; request?: TrailRequest; receivedAt: number }> =
  [];
/** Jede Auswahl-, Spur- und Überflug-Anfrage an einen Shard. */
const requestLog: Array<{ type: string; noradId: unknown; shard: number }> = [];

/** Solange gesetzt, hält die Hülle passende Antworten zurück, statt sie dem Hook zu geben (Abschnitt G). */
let holdFilter: ((data: ShardMessage) => boolean) | null = null;
const held: Array<{ worker: ThreadWorker; data: ShardMessage }> = [];

/** `Worker` des Browsers, soweit der Hook ihn nutzt – plus Messpunkte für die Prüfung. */
class ThreadWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  shard = -1;
  /** Wanduhr beim Eintreffen des letzten Ticks. */
  lastTickAt = 0;
  /** Epoche des letzten Ticks – Referenzzeit für satellite.js. */
  lastTickTime = 0;
  lastTickDurationMs = 0;
  private readonly thread: NodeWorker;

  constructor(_url: URL | string, _options?: { type?: string; name?: string }) {
    this.thread = new NodeWorker(BOOTSTRAP, { eval: true, workerData: { bundle: WORKER_BUNDLE, ...poolSetup } });
    this.thread.on('message', (data: ShardMessage) => {
      if (data?.type === 'tick') {
        this.lastTickAt = Date.now();
        this.lastTickTime = data.time ?? 0;
        this.lastTickDurationMs = data.durationMs ?? 0;
      }
      if (data?.type === 'trail' && data.points) {
        trailLog.push({
          noradId: data.noradId,
          points: data.points,
          request: data.noradId === undefined ? undefined : trailRequests.get(data.noradId),
          receivedAt: Date.now(),
        });
      }
      if (holdFilter?.(data)) {
        held.push({ worker: this, data });
        return;
      }
      this.onmessage?.({ data });
    });
    this.thread.on('error', (err) => this.onerror?.({ message: err.message }));
    liveWorkers.add(this);
  }

  postMessage(
    message: { type?: string; shardIndex?: number; noradId?: string; fromMin?: number; toMin?: number; samples?: number },
    transfer?: Transferable[],
  ): void {
    if (message?.type === 'init') this.shard = message.shardIndex ?? -1;
    if (message?.type === 'select' || message?.type === 'trail' || message?.type === 'pass') {
      requestLog.push({ type: message.type, noradId: message.noradId, shard: this.shard });
    }
    if (message?.type === 'trail' && message.noradId !== undefined) {
      trailRequests.set(message.noradId, {
        at: Date.now(),
        fromMin: message.fromMin ?? 0,
        toMin: message.toMin ?? 0,
        samples: message.samples ?? 0,
      });
    }
    this.thread.postMessage(message, (transfer ?? []) as never);
  }

  freeze(ms: number): void {
    this.thread.postMessage({ harness: 'freeze', ms });
  }

  terminate(): void {
    liveWorkers.delete(this);
    void this.thread.terminate();
  }
}

/** Gibt zurückgehaltene Antworten in ihrer Reihenfolge an den Hook weiter. */
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
// Der Wachhund des Pools läuft über `window.setInterval`. Erst hier setzen:
// React und R3F haben ihre Umgebung beim Laden bereits gelesen.
Object.defineProperty(globalThis, 'window', {
  value: { setInterval, clearInterval, setTimeout, clearTimeout },
  configurable: true,
  writable: true,
});

// Zwei erwartete Meldungen, die sonst jede echte Ausgabe verschütten:
//  - drei <Line> legt seine Anfangsgeometrie aus `Vector3`-Punkten an und
//    prüft sie per `instanceof`. Das esbuild-Bündel enthält three zweimal
//    (build/three.cjs und build/three.module.js), die Prüfung schlägt fehl,
//    und three meldet beim Einhängen einen NaN-Radius. OrbitTrail überschreibt
//    die Geometrie ohnehin mit der ersten Spur; im Vite-Build gibt es nur ein
//    three.
//  - Katalogfassung und Worker-Antworten ändern den Store aus Timern und
//    Nachrichten heraus, also außerhalb von act() – wie in der App. Seit
//    OrbitTrail und der Hook an `selectedMeta` hängen, rendern sie dabei neu,
//    und React warnt. Die Prüfungen warten ohnehin auf das Ergebnis.
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (first.startsWith('THREE.LineSegmentsGeometry.computeBoundingSphere')) return;
  if (first.includes('inside a test was not wrapped in act(')) return;
  consoleError(...args);
};

/** Der Shard, der den Platz besitzt – dieselbe Modulo-Regel wie im Pool. */
function ownerOf(index: number): ThreadWorker {
  const shard = index % engine.shardCount;
  for (const worker of liveWorkers) if (worker.shard === shard) return worker;
  throw new Error(`Shard ${shard} läuft nicht`);
}

/* ------------------------------------------------------------------ */
/* Einhängen wie in App.tsx                                             */
/* ------------------------------------------------------------------ */

/** Zeigerziel für TapPicker: sammelt Listener, liefert ein festes Rechteck. */
class FakeCanvas {
  readonly style = {};
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 400, height: 800 };
  }
  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

type RootStore = UseBoundStore<StoreApi<RootState>>;

function Engine(): null {
  useSatelliteEngine({ intervalMs: 100 });
  return null;
}

/** Wie App.tsx plus die beiden Canvas-Teile, die an der Auswahl hängen. */
function Scene(): ReactElement {
  useSatelliteEngine({ intervalMs: 100 });
  return createElement(Fragment, null, createElement(OrbitTrail), createElement(TapPicker));
}

interface Mounted {
  canvas: FakeCanvas;
  store: RootStore;
  unmount: () => Promise<void>;
}

async function mount(element: ReactElement): Promise<Mounted> {
  const canvas = new FakeCanvas();
  const gl = { domElement: canvas, render() {}, setSize() {}, setPixelRatio() {} };
  const root = createRoot({} as HTMLCanvasElement);
  let store: RootStore | null = null;
  await act(async () => {
    await root.configure({
      gl: gl as never,
      size: { width: 400, height: 800, top: 0, left: 0 },
      frameloop: 'never',
      dpr: 1,
    });
    store = root.render(element) as RootStore;
  });
  return { canvas, store: store as unknown as RootStore, unmount: () => act(async () => root.unmount()) };
}

const setStore = (partial: Parameters<typeof useAppStore.setState>[0]) =>
  act(async () => useAppStore.setState(partial));

/**
 * Wählt ein Objekt über seine NORAD-ID – wie Liste und Tap: `select` mit der
 * Kennung. Die Überflugliste fordert der Hook selbst an.
 */
const chooseByNorad = (norad: string) => act(async () => useAppStore.getState().select(norad)); // GEGENPROBE
const clearSelection = () => act(async () => useAppStore.getState().select(null));

const CLEAR_SELECTION = {
  selectedId: null,
  selectedIndex: null,
  selectedMeta: null,
  passes: [] as PassPrediction[],
  passId: null,
  passPending: false,
};

async function waitFor(label: string, condition: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      console.error(`    Zeitüberschreitung nach ${timeoutMs} ms: ${label}`);
      return false;
    }
    await sleep(20);
  }
  return true;
}

const indexOf = (norad: string): number => catalogIndex.meta.findIndex((meta) => meta?.noradId === norad);
/** Steht die ID in der zuletzt veröffentlichten Katalogfassung? `telemetry.count` setzt erst `flushCatalog`. */
const inCatalog = (norad: string): boolean => {
  const index = indexOf(norad);
  return index >= 0 && telemetry.count > index;
};

/** Einige vollständige Ticks abwarten – die Auswahl muss erst im Shard ankommen. */
const settle = async () => {
  const revision = telemetry.revision;
  await waitFor('drei vollständige Ticks', () => telemetry.revision >= revision + 3);
};

/** Ab diesem Alter gilt ein Telemetriesatz als stehengeblieben (Zieltakt 100 ms). */
const STALE_MS = 2000;

/**
 * Liest den Telemetriesatz und vergleicht ihn mit satellite.js zur Epoche des
 * Ticks, aus dem er stammt. Die Toleranzen decken Float32 ab; NaN fällt in
 * jedem Fall durch.
 */
function inspect(index: number, tle: Tle) {
  const owner = ownerOf(index);
  const sample = readSample(index);
  const reference = propagateEphemeris(twoline2satrec(tle[1], tle[2]), new Date(owner.lastTickTime), observerGd);
  const ageMs = Date.now() - owner.lastTickAt;
  if (!sample || !reference) return { ok: false, text: 'kein Telemetriesatz' };
  const lonDelta = Math.abs(((sample.longitudeDeg - reference.longitudeDeg + 540) % 360) - 180);
  const ok =
    Math.abs(sample.altitudeKm - reference.altitudeKm) < 0.05 &&
    Math.abs(sample.latitudeDeg - reference.latitudeDeg) < 1e-3 &&
    lonDelta < 1e-3 &&
    Math.abs(sample.elevation - reference.elevation) * RAD < 1e-3 &&
    ageMs < STALE_MS;
  return {
    ok,
    text:
      `Bahnhöhe ${f(sample.altitudeKm)} km (satellite.js ${f(reference.altitudeKm)}), ` +
      `Subpunkt ${f(sample.latitudeDeg, 2)}° / ${f(sample.longitudeDeg, 2)}°, ` +
      `Elevation ${f(sample.elevation * RAD, 2)}°, letzter Tick des Shards vor ${f(ageMs / 1000, 1)} s`,
  };
}

function setCores(cores: number): void {
  Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', { value: cores, configurable: true });
}

async function scenario(
  title: string,
  cores: number,
  run: (mounted: Mounted) => Promise<void>,
  options: {
    strict?: boolean;
    scene?: boolean;
    groups?: SatelliteGroup[];
    setup?: Partial<PoolSetup>;
  } = {},
): Promise<void> {
  console.log(`${title} – ${cores} Kerne`);
  setCores(cores);
  poolSetup = { ...DEFAULT_SETUP, ...options.setup };
  useAppStore.setState({
    observer: null,
    ...CLEAR_SELECTION,
    errors: [],
    // Nur Gruppen, die der Vorspann ausliefert. Nach jeder Gruppe wartet der
    // Lader 1,5 s (Rate-Limit von CelesTrak); der Gesamtkatalog allein ist
    // deshalb der schnellste Weg zu LEO und MEO.
    activeGroups: options.groups ?? ['other'],
  });
  const element = createElement(options.scene ? Scene : Engine);
  const mounted = await mount(options.strict ? createElement(StrictMode, null, element) : element);
  try {
    await setStore({ observer: OBSERVER });
    await run(mounted);
  } finally {
    await mounted.unmount();
    await setStore({ ...CLEAR_SELECTION });
  }
}

async function catalogReady(): Promise<{ leo: number; meo: number }> {
  await waitFor('Katalog mit LEO und MEO', () => inCatalog(LEO.norad) && inCatalog(MEO.norad));
  await settle();
  return { leo: indexOf(LEO.norad), meo: indexOf(MEO.norad) };
}

const where = (index: number) => `#${index}, Shard ${index % engine.shardCount}/${engine.shardCount}`;

async function selectAndCheck(label: string, norad: string, tle: Tle): Promise<void> {
  await chooseByNorad(norad);
  await settle();
  const index = useAppStore.getState().selectedIndex ?? -1;
  const result = inspect(index, tle);
  expect(`${label} ${where(index)}`, result.ok, result.text);
}

/* ------------------------------------------------------------------ */
/* A–C: die Verdachtsfälle                                              */
/* ------------------------------------------------------------------ */

if (runs('A')) {
  for (const cores of [2, 4, 8]) {
    await scenario('A. Auswahl im laufenden Pool (ID → Platz → Shard → scatter, SGP4 und SDP4)', cores, async () => {
      await catalogReady();
      await selectAndCheck(`LEO ${LEO.name}`, LEO.norad, LEO_TLE);
      await selectAndCheck(`MEO ${MEO.name}`, MEO.norad, MEO_TLE);
    });
  }
}

if (runs('B')) {
  await scenario(
    'B. StrictMode: Pool wird beim Einhängen verworfen und neu gebaut',
    8,
    async () => {
      await catalogReady();
      await selectAndCheck(`LEO ${LEO.name}`, LEO.norad, LEO_TLE);
      await selectAndCheck(`MEO ${MEO.name}`, MEO.norad, MEO_TLE);
    },
    { strict: true },
  );
}

if (runs('C')) {
  await scenario(
    'C. Katalog wächst nach der Auswahl',
    8,
    async () => {
      // Der Gesamtkatalog kommt erst 1,5 s nach `stations` – die ISS ist da
      // schon gewählt, und der Pool bekommt 24 neue Objekte dazu.
      await waitFor('ISS im Katalog', () => inCatalog(LEO.norad));
      await selectAndCheck(`LEO ${LEO.name} vor dem Gesamtkatalog`, LEO.norad, LEO_TLE);
      const leo = useAppStore.getState().selectedIndex ?? -1;
      await catalogReady();
      const after = inspect(leo, LEO_TLE);
      expect(`LEO ${LEO.name} nach dem Gesamtkatalog ${where(leo)}`, after.ok, after.text);
      await selectAndCheck(`MEO ${MEO.name}`, MEO.norad, MEO_TLE);
    },
    { groups: ['stations', 'other'], setup: { delays: { active: 1500 } } },
  );
}

/* ------------------------------------------------------------------ */
/* D: der Fall aus dem Gerätebild                                       */
/* ------------------------------------------------------------------ */

/** Abstand zwischen angezeigten Werten und Bild, siehe Abschnitt 0. */
const FREEZE_MS = (6 * 60 + 14) * 60_000;
/** So lange darf der erste Wert nach der Auswahl höchstens brauchen. */
const FIRST_VALUE_MS = 3000;

if (runs('D')) {
  for (const [label, tle, key, norad] of [
    [`LEO ${LEO.name}`, LEO_TLE, 'leo', LEO.norad],
    [`MEO ${MEO.name}`, MEO_TLE, 'meo', MEO.norad],
  ] as const) {
    await scenario(`D. Prozess friert mitten im Tick ein (iOS: Hintergrund, Display aus), danach Auswahl – ${label}`, 8, async () => {
      const index = (await catalogReady())[key];
      const owner = ownerOf(index);

      // Nacht: iOS hält den Prozess an, während der Shard gerade rechnet.
      owner.freeze(FREEZE_MS);
      await waitFor('eingefrorener Tick', () => owner.lastTickDurationMs >= FREEZE_MS);
      const measuredMs = owner.lastTickDurationMs;
      const frozenTickAt = owner.lastTickAt;

      // Morgen: Der Nutzer tippt das Objekt an.
      const pickedAt = Date.now();
      await chooseByNorad(norad);
      const passesArrived = await waitFor('Überflugliste', () => useAppStore.getState().passId === norad, 20_000);
      await waitFor(
        `Bahnhöhe innerhalb von ${FIRST_VALUE_MS} ms`,
        () => Number.isFinite(readSample(index)?.altitudeKm ?? NaN),
        FIRST_VALUE_MS,
      );
      const firstValueMs = Date.now() - pickedAt;
      const resumed = owner.lastTickAt > frozenTickAt;
      const result = inspect(index, tle);
      expect(
        `${label} ${where(index)}`,
        result.ok && passesArrived,
        `${result.text}; Überflugliste ${passesArrived ? 'geliefert' : 'fehlt'}; ` +
          `eingefrorener Tick maß ${f(measuredMs / 3_600_000, 2)} h, ` +
          (resumed
            ? `Shard danach wieder im Takt, Bahnhöhe ${firstValueMs} ms nach der Auswahl`
            : `Shard seither ohne Tick`),
      );
    });
  }
}

/* ------------------------------------------------------------------ */
/* Werkzeuge für E–I: was Karte, Spur und Liste zeigen                  */
/* ------------------------------------------------------------------ */

/**
 * Rendert eine DOM-Komponente mit dem aktuellen Store. react-dom/server liest
 * zustand über den Server-Schnappschuss, und das ist der Anfangszustand des
 * Stores; der wird hier vorher auf den aktuellen Stand gebracht. Effekte
 * laufen nicht – die rAF-Felder der Karte bleiben „–“, Name, NORAD-ID und
 * Überflugbereich stehen im Markup.
 */
function serverRender(component: FunctionComponent): string {
  Object.assign(useAppStore.getInitialState(), useAppStore.getState());
  return renderToStaticMarkup(createElement(component));
}

const textOf = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** Kopfzeile der Telemetriekarte, wie sie gerendert wird. */
const panelText = (): string => textOf(serverRender(TelemetryPanel));

function findLine(store: RootStore): Line2 | null {
  let line: Line2 | null = null;
  store.getState().scene.traverse((object) => {
    if ((object as Line2).isLine2) line = object as Line2;
  });
  return line;
}

let frameTime = 0;
/** Ein Bild der R3F-Wurzel – OrbitTrail aktualisiert die Linie nur in `useFrame`. */
function frame(store: RootStore): void {
  frameTime += 1 / 60;
  advance(frameTime, true, store.getState());
}

/** Telemetrie des Platzes gegen satellite.js zur Epoche des letzten Ticks seines Shards. */
function checkTelemetry(slot: number, tle: Tle): { ok: boolean; text: string } {
  if (slot < 0) return { ok: false, text: 'kein Platz' };
  const owner = ownerOf(slot);
  const sample = readSample(slot);
  const ref = truth(tle, owner.lastTickTime);
  const ageMs = Date.now() - owner.lastTickAt;
  if (!sample || !ref) return { ok: false, text: 'kein Telemetriesatz' };
  const offDeg = angleDeg(direction(sample.azimuth, sample.elevation), direction(ref.azimuth, ref.elevation));
  const lonDelta = Math.abs(((sample.longitudeDeg - ref.longitudeDeg + 540) % 360) - 180);
  const ok =
    offDeg < 0.01 &&
    Math.abs(sample.rangeKm - ref.rangeKm) < 0.5 &&
    Math.abs(sample.altitudeKm - ref.altitudeKm) < 0.1 &&
    Math.abs(sample.latitudeDeg - ref.latitudeDeg) < 0.01 &&
    lonDelta < 0.01 &&
    ageMs < STALE_MS;
  return {
    ok,
    text:
      `Blickrichtung ${f(offDeg, 4)}° neben satellite.js, Distanz ${f(sample.rangeKm)} km (${f(ref.rangeKm)}), ` +
      `Bahnhöhe ${f(sample.altitudeKm)} km (${f(ref.altitudeKm)}), Subpunkt ${f(sample.latitudeDeg, 2)}° / ` +
      `${f(sample.longitudeDeg, 2)}° (${f(ref.latitudeDeg, 2)}° / ${f(ref.longitudeDeg, 2)}°), Tick vor ${f(ageMs / 1000, 1)} s`,
  };
}

/**
 * Bahnspur in `trailState` gegen satellite.js. Der Shard rechnet sie zu seiner
 * Zeit beim Empfang der Anfrage; die liegt zwischen Absenden und Eintreffen.
 * Geprüft wird zur Mitte dieses Fensters, mit einer Toleranz aus dessen Breite
 * und 1,2°/s – schneller zieht auch die ISS im Zenit nicht über den Himmel.
 */
function checkTrail(tle: Tle, id: string): { ok: boolean; text: string } {
  const points = trailState.points;
  const entry = trailLog.findLast((item) => item.points === points);
  if (trailState.noradId !== id || !points || !entry?.request) {
    return { ok: false, text: `trailState gehört zu ${trailState.noradId ?? 'niemandem'}` };
  }
  const { request } = entry;
  const windowMs = entry.receivedAt - request.at;
  const t0 = (entry.receivedAt + request.at) / 2;
  const tolerance = 0.05 + (1.2 * windowMs) / 2000;
  const samples = points.length / 3;
  let worst = 0;
  for (let i = 0; i < samples; i += 1) {
    const t = t0 + (request.fromMin + ((request.toMin - request.fromMin) * i) / (samples - 1)) * 60_000;
    const ref = truth(tle, t);
    if (!ref) return { ok: false, text: `satellite.js ohne Lösung bei Punkt ${i}` };
    const point: [number, number, number] = [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
    worst = Math.max(worst, angleDeg(point, direction(ref.azimuth, ref.elevation)));
  }
  return {
    ok: worst < tolerance,
    text: `${samples} Punkte, größte Abweichung ${f(worst, 3)}° (Toleranz ${f(tolerance, 3)}°, Anfragefenster ${windowMs} ms)`,
  };
}

/** Jeder Überflug gegen satellite.js: Elevation im Höchststand und an geschlossenen Enden am Horizont. */
function checkPasses(passes: PassPrediction[], tle: Tle): { ok: boolean; text: string } {
  const elevationDeg = (ms: number) => ((truth(tle, ms)?.elevation ?? Number.NaN) * 180) / Math.PI;
  let worstPeak = 0;
  let worstEdge = 0;
  for (const pass of passes) {
    worstPeak = Math.max(worstPeak, Math.abs(elevationDeg(pass.tca) - pass.maxElevationDeg));
    if (!pass.aosOpen) worstEdge = Math.max(worstEdge, Math.abs(elevationDeg(pass.aos)));
    if (!pass.losOpen) worstEdge = Math.max(worstEdge, Math.abs(elevationDeg(pass.los)));
  }
  const ok = passes.length > 0 && worstPeak < 0.1 && worstEdge < 0.1;
  return {
    ok,
    text:
      `${passes.length} Überflüge, Höchststand bis ${f(worstPeak, 3)}° neben satellite.js, ` +
      `Auf-/Untergang bis ${f(worstEdge, 3)}° vom Horizont`,
  };
}

/**
 * Das Kernstück von E–I: Zeigt alles, was an der Auswahl hängt, genau dieses
 * Objekt? Gewartet wird, bis alle Kanäle stimmen (höchstens 20 s); danach
 * meldet jede Prüfung ihren Befund – auch den falschen.
 */
async function verifyShown(label: string, target: Target): Promise<void> {
  const channels = () => {
    const state = useAppStore.getState();
    const slot = state.selectedIndex ?? -1;
    return {
      state,
      slot,
      meta: catalogIndex.meta[slot],
      telemetry: checkTelemetry(slot, target.tle),
      trail: checkTrail(target.tle, target.id),
      passes: checkPasses(state.passId === target.id ? state.passes : [], target.tle),
    };
  };
  await waitFor(
    `${label}: alle Kanäle`,
    () => {
      const c = channels();
      return c.meta?.noradId === target.id && c.telemetry.ok && c.trail.ok && c.passes.ok && !c.state.passPending;
    },
    20_000,
  );
  const c = channels();
  expect(
    `${label}: Identität ${where(c.slot)}`,
    c.state.selectedId === target.id &&
      c.meta?.noradId === target.id &&
      c.meta?.name === target.name &&
      c.state.selectedMeta === c.meta,
    `gewählt ${c.state.selectedId}; Platz #${c.slot} trägt ${c.meta ? `${c.meta.name} (NORAD ${c.meta.noradId})` : 'nichts'}`,
  );
  const text = panelText();
  expect(
    `${label}: Karte`,
    text.includes(target.name) && text.includes(`NORAD ${target.id}`) && !text.includes('nicht im geladenen Katalog'),
    `„${text.slice(0, 70)} …“`,
  );
  expect(`${label}: Telemetrie`, c.telemetry.ok, c.telemetry.text);
  expect(`${label}: Bahnspur`, c.trail.ok, c.trail.text);
  expect(`${label}: Überflüge`, c.state.passId === target.id && c.passes.ok, c.passes.text);
}

/* ------------------------------------------------------------------ */
/* E: Auswahl per NORAD-ID                                              */
/* ------------------------------------------------------------------ */

if (runs('E')) {
  // 3 Kerne → 2 Shards, 8 Kerne → 6 Shards: BEIDOU-3 M16 liegt je auf einem
  // anderen Shard als die ISS, das Routing muss also wirklich auflösen.
  for (const cores of [3, 8]) {
    await scenario(
      'E. Auswahl per NORAD-ID: Karte, Telemetrie, Bahnspur und Überflüge gehören zu genau diesem Objekt',
      cores,
      async () => {
        await waitFor('Katalog mit LEO und MEO', () => inCatalog(LEO.norad) && inCatalog(MEO.norad));
        await chooseByNorad(LEO.norad);
        await verifyShown(`LEO ${LEO.name}`, LEO_T);
        await chooseByNorad(MEO.norad);
        await verifyShown(`MEO ${MEO.name}`, MEO_T);

        // Noch einmal dasselbe Objekt (Liste, Tap): Die Überflugliste bleibt.
        // Der Hook fordert nur bei neuer ID oder neuen Bahndaten an – eine hier
        // geleerte Liste käme nie wieder.
        const before = useAppStore.getState();
        await chooseByNorad(MEO.norad);
        await settle();
        const after = useAppStore.getState();
        expect(
          'erneute Wahl desselben Objekts',
          after.passId === MEO.norad && after.passes === before.passes && !after.passPending,
          `Liste gehört zu ${after.passId}, ${after.passes === before.passes ? 'dieselbe' : 'eine andere'} Liste, ` +
            `ausstehend ${after.passPending}`,
        );
      },
      { scene: true, setup: { feed: FEED_FULL } },
    );
  }
}

/* ------------------------------------------------------------------ */
/* F: Plätze verschieben sich                                           */
/* ------------------------------------------------------------------ */

/*
 * Innerhalb eines Pools verschiebt sich kein Platz: Der Fallback-Ersatz
 * bleibt an Ort und Stelle (F1), eine nachgeladene Gruppe wird angehängt (H2).
 * Neu vergeben werden Plätze erst von einem neuen Pool – beim Neustart, in dem
 * eine gemerkte Auswahl wieder aufgelöst werden muss (F2).
 *
 * Gegenprobe gegen den alten Stand, 24.09.2026: In F2 zeigt er vor dem
 * Neuaufbau auf allen fünf Kanälen BEIDOU-3 M16, danach die Karte „FILL 16
 * NORAD 60016“, Telemetrie 79,6° neben BEIDOU-3 M16 (Bahnhöhe 491 statt
 * 21 513 km) und die Spur von 60016. In F1 bleibt seine Überflugliste die aus
 * dem Fallback-Satz von 2025 – Höchststände bis 170,7° neben dem frischen
 * Satz, eine einzige Anfrage.
 */

if (runs('F')) {
  await scenario(
    'F1. Fallback-Ersatz beim Start: gleicher Platz, neue Bahndaten',
    8,
    async () => {
      // Die vier Kernobjekte des Offline-Fallbacks (Epoche 2025) stehen sofort
      // im Katalog; die ISS wird gewählt, bevor `stations` sie durch den
      // frischen Satz ersetzt. Danach müssen Telemetrie, Spur und Überflüge
      // aus dem frischen Satz stammen – auch die Überflugliste, die zunächst
      // aus dem Fallback gerechnet wurde.
      await waitFor('Fallback-ISS im Katalog', () => inCatalog(LEO.norad));
      const fallbackSlot = indexOf(LEO.norad);
      const fallbackMeta = catalogIndex.meta[fallbackSlot];
      await chooseByNorad(LEO.norad);
      await verifyShown(`LEO ${LEO.name} nach dem Ersatz`, LEO_T);
      const passRequests = requestLog.filter((entry) => entry.type === 'pass' && entry.noradId === LEO.norad).length;
      expect(
        'Platz bleibt, Bahndaten und Überflugsuche wechseln',
        indexOf(LEO.norad) === fallbackSlot && catalogIndex.meta[fallbackSlot] !== fallbackMeta && passRequests >= 2,
        `Fallback-ISS #${fallbackSlot}, frische ISS #${indexOf(LEO.norad)}, Metadaten ` +
          `${catalogIndex.meta[fallbackSlot] !== fallbackMeta ? 'ersetzt' : 'unverändert'}, ${passRequests} Überflug-Anfragen`,
      );
    },
    { scene: true, groups: ['stations', 'other'], setup: { feed: FEED_FULL, delays: { stations: 1500 } } },
  );

  console.log('F2. Neu aufgebauter Pool legt dieselben Objekte auf andere Plätze – 8 Kerne');
  setCores(8);
  // Erster Pool: CelesTrak drosselt Starlink, das Nachladen käme erst nach
  // 60 s. Der Gesamtkatalog rückt direkt hinter Fallback und Raumstationen.
  poolSetup = { ...DEFAULT_SETUP, feed: FEED_FULL, failCalls: { starlink: 1_000 }, shortWaits: true, retryMs: 60_000 };
  useAppStore.setState({ observer: null, ...CLEAR_SELECTION, errors: [], activeGroups: ['stations', 'starlink', 'other'] });
  let mounted = await mount(createElement(Scene));
  await setStore({ observer: OBSERVER });
  await waitFor('BEIDOU-3 M16 im ersten Katalog', () => inCatalog(MEO.norad));
  const starlinkFailed = useAppStore.getState().errors.some((message) => message.startsWith('Starlink'));
  const slotBefore = indexOf(MEO.norad);
  await chooseByNorad(MEO.norad);
  await verifyShown(`MEO ${MEO.name} im ersten Pool`, MEO_T);
  await mounted.unmount();

  // Zweiter Pool – wie ein Neustart mit gemerkter Auswahl: Der Store behält
  // sie, die Worker fangen von vorn an, und diesmal lädt Starlink sofort.
  poolSetup = { ...poolSetup, failCalls: {} };
  mounted = await mount(createElement(Scene));
  await setStore({ observer: OBSERVER });
  await waitFor('BEIDOU-3 M16 im zweiten Katalog', () => inCatalog(MEO.norad));
  const slotAfter = indexOf(MEO.norad);
  const occupant = catalogIndex.meta[slotBefore];
  expect(
    'Voraussetzung: der Platz hat sich verschoben',
    starlinkFailed && slotAfter !== slotBefore && occupant !== undefined && occupant.noradId !== MEO.norad,
    `Starlink im ersten Pool ${starlinkFailed ? 'fehlgeschlagen' : 'geladen'}; BEIDOU-3 M16 erst ${where(slotBefore)}, ` +
      `jetzt ${where(slotAfter)}; auf #${slotBefore} steht jetzt ${occupant?.name ?? 'nichts'}`,
  );
  await verifyShown(`MEO ${MEO.name} nach dem Neuaufbau`, MEO_T);
  await mounted.unmount();
  await setStore({ ...CLEAR_SELECTION });
}

/* ------------------------------------------------------------------ */
/* G: verspätete Antworten                                              */
/* ------------------------------------------------------------------ */

if (runs('G')) {
  await scenario(
    'G. Verspätete Bahnspur- und Überflug-Antworten für das vorige Objekt werden verworfen',
    8,
    async ({ store }) => {
      await waitFor('Katalog mit LEO und MEO', () => inCatalog(LEO.norad) && inCatalog(MEO.norad));
      const isFor = (id: string) => (data: ShardMessage) =>
        (data?.type === 'trail' || data?.type === 'pass') && data.noradId === id;
      const heldFor = (id: string) => held.filter((item) => isFor(id)(item.data)).length;

      // G1: A antwortet erst, nachdem B schon geantwortet hat.
      holdFilter = isFor(LEO.norad);
      await chooseByNorad(LEO.norad);
      await waitFor('Spur und Überflüge der ISS zurückgehalten', () => heldFor(LEO.norad) >= 2);
      await chooseByNorad(MEO.norad);
      await verifyShown(`G1 MEO ${MEO.name}`, MEO_T);
      const passesB = useAppStore.getState().passes;
      const pointsB = trailState.points;
      const releasedA = await act(async () => releaseHeld(isFor(LEO.norad)));
      holdFilter = null;
      frame(store);
      const afterA = useAppStore.getState();
      const line = findLine(store);
      expect(
        'G1 Überflugliste bleibt die von B',
        releasedA === 2 && afterA.passId === MEO.norad && afterA.passes === passesB && !afterA.passPending,
        `${releasedA} Antworten der ISS nachgereicht; Liste gehört zu ${afterA.passId}, ${afterA.passes === passesB ? 'dieselbe' : 'eine andere'} Liste`,
      );
      expect(
        'G1 Bahnspur bleibt die von B',
        trailState.noradId === MEO.norad && trailState.points === pointsB && line?.visible === true,
        `trailState gehört zu ${trailState.noradId}, ${trailState.points === pointsB ? 'dieselben' : 'andere'} Punkte, Linie ${line?.visible ? 'sichtbar' : 'verborgen'}`,
      );

      // G2: A antwortet nach der Auswahl von B, aber bevor B antwortet.
      await clearSelection();
      holdFilter = (data) => isFor(LEO.norad)(data) || isFor(MEO.norad)(data);
      await chooseByNorad(LEO.norad);
      await waitFor('Antworten zur ISS zurückgehalten', () => heldFor(LEO.norad) >= 2);
      await chooseByNorad(MEO.norad);
      await waitFor('Antworten zu BEIDOU-3 M16 zurückgehalten', () => heldFor(MEO.norad) >= 2);
      const releasedEarly = await act(async () => releaseHeld(isFor(LEO.norad)));
      frame(store);
      const early = useAppStore.getState();
      expect(
        'G2 Antworten zur ISS landen nicht bei BEIDOU-3 M16',
        releasedEarly === 2 &&
          early.passId === null &&
          early.passes.length === 0 &&
          early.passPending &&
          trailState.noradId === null &&
          findLine(store)?.visible === false,
        `${releasedEarly} Antworten nachgereicht; Überflüge von ${early.passId ?? 'niemandem'} (${early.passes.length}), ` +
          `ausstehend ${early.passPending}, Spur von ${trailState.noradId ?? 'niemandem'}, Linie ${findLine(store)?.visible ? 'sichtbar' : 'verborgen'}`,
      );
      await act(async () => releaseHeld(isFor(MEO.norad)));
      holdFilter = null;
      await verifyShown(`G2 MEO ${MEO.name}, danach`, MEO_T);

      // G3: OrbitTrail selbst zeichnet nur die Spur der gewählten ID – auch
      // wenn trailState (von Hand) die eines anderen Objekts trägt.
      frame(store);
      const shownBefore = findLine(store)?.visible === true;
      const saved = { noradId: trailState.noradId, points: trailState.points };
      trailState.noradId = LEO.norad as typeof trailState.noradId;
      trailState.points = new Float32Array(saved.points ?? new Float32Array(0));
      trailState.version += 1;
      frame(store);
      const hiddenForeign = findLine(store)?.visible === false;
      trailState.noradId = saved.noradId;
      trailState.points = saved.points;
      trailState.version += 1;
      frame(store);
      expect(
        'G3 OrbitTrail verbirgt eine Spur, die nicht zur Auswahl gehört',
        shownBefore && hiddenForeign && findLine(store)?.visible === true,
        `vorher ${shownBefore ? 'sichtbar' : 'verborgen'}, mit Spur der ISS ${hiddenForeign ? 'verborgen' : 'sichtbar'}, ` +
          `danach wieder ${findLine(store)?.visible ? 'sichtbar' : 'verborgen'}`,
      );
    },
    { scene: true, setup: { feed: FEED_FULL } },
  );
}

/* ------------------------------------------------------------------ */
/* H: nicht auflösbare ID                                               */
/* ------------------------------------------------------------------ */

/** HUD im Server-Rendering: Ist das Radar auf Telefonbreite ausgeblendet (`hidden sm:flex`)? */
const radarHiddenOnPhone = (): boolean => /class="[^"]*\bhidden sm:flex/.test(serverRender(Hud));

/** Befund für eine gewählte, aber nicht aufgelöste ID. */
function checkUnresolved(label: string, id: string): void {
  const state = useAppStore.getState();
  const text = panelText();
  const requests = requestLog.filter((entry) => entry.noradId === id && entry.type !== 'select').length;
  expect(
    `${label}: Auswahl bleibt stehen`,
    state.selectedId === id && state.selectedIndex === -1 && state.selectedMeta === null,
    `gewählt ${state.selectedId}, Platz ${state.selectedIndex}`,
  );
  expect(
    `${label}: Karte sagt, dass das Objekt fehlt`,
    text.includes(`NORAD ${id}`) &&
      text.includes('nicht im geladenen Katalog') &&
      text.includes('Folgt, sobald das Objekt im Katalog steht') &&
      radarHiddenOnPhone(),
    `„${text.slice(0, 110)} …“; Radar auf Telefonbreite ${radarHiddenOnPhone() ? 'ausgeblendet' : 'sichtbar'}`,
  );
  expect(
    `${label}: nichts von einem anderen Objekt`,
    readSample(state.selectedIndex ?? -1) === null &&
      state.passes.length === 0 &&
      trailState.noradId === null &&
      requests === 0,
    `Telemetrie ${readSample(state.selectedIndex ?? -1) ? 'vorhanden' : 'keine'}, ${state.passes.length} Überflüge, ` +
      `Spur von ${trailState.noradId ?? 'niemandem'}, ${requests} Spur-/Überflug-Anfragen an Shards`,
  );
}

if (runs('H')) {
  await scenario(
    'H. Nicht auflösbare ID: bleibt gewählt, löst sich auf, sobald die fehlgeschlagene Gruppe nachgeladen ist',
    8,
    async () => {
      await waitFor('BEIDOU-3 M16 im Katalog', () => inCatalog(MEO.norad));
      const starlinkFailed = useAppStore.getState().errors.some((message) => message.startsWith('Starlink'));

      // H1: eine ID, die es in keiner Gruppe gibt.
      await chooseByNorad('88888');
      await settle();
      checkUnresolved('H1 NORAD 88888', '88888');

      // H2: ein Starlink-Objekt, dessen Gruppe beim ersten Abruf scheiterte.
      await chooseByNorad(MEO.norad);
      const meoSlot = useAppStore.getState().selectedIndex;
      await chooseByNorad(STARLINK_T3.id);
      await settle();
      expect(
        'H2 Voraussetzung: Starlink fehlt noch',
        starlinkFailed && !inCatalog(STARLINK_T3.id),
        `Starlink ${starlinkFailed ? 'fehlgeschlagen' : 'geladen'}, ${STARLINK_T3.name} ${inCatalog(STARLINK_T3.id) ? 'schon' : 'nicht'} im Katalog`,
      );
      checkUnresolved(`H2 ${STARLINK_T3.name}`, STARLINK_T3.id);
      // Das Nachladen nach 45 s ist auf 2,5 s gestaucht.
      await verifyShown(`H2 ${STARLINK_T3.name} nach dem Nachladen`, STARLINK_T3);
      expect(
        'H2 nachgeladene Gruppe verschiebt keinen bestehenden Platz',
        indexOf(MEO.norad) === meoSlot,
        `BEIDOU-3 M16 vorher #${meoSlot}, nachher #${indexOf(MEO.norad)}; Starlink angehängt ab #${indexOf(STARLINKS[0].norad)}`,
      );
    },
    {
      scene: true,
      groups: ['stations', 'starlink', 'other'],
      setup: { feed: FEED_FULL, failCalls: { starlink: 3 }, shortWaits: true, retryMs: 2500 },
    },
  );
}

/* ------------------------------------------------------------------ */
/* I: Alpha-5                                                           */
/* ------------------------------------------------------------------ */

if (runs('I')) {
  console.log('I. Alpha-5-Kennung A0001 = NORAD 100001');
  const normalize = (tleSources as { normalizeNoradId?: (field: string) => string }).normalizeNoradId;
  const samples = ['A0001', 'a0001', '00005', '  900', '25544', 'Z9999', '100001'];
  const once = samples.map((value) => normalize?.(value));
  const twice = once.map((value) => (value === undefined ? undefined : normalize?.(value)));
  expect(
    'normalizeNoradId ist idempotent',
    normalize !== undefined && once[0] === '100001' && once.every((value, i) => value === twice[i]),
    samples.map((value, i) => `${value.trim()} → ${once[i]} → ${twice[i]}`).join(', '),
  );

  await scenario(
    'I. Alpha-5 über Liste, Tap und rohe Kennung',
    8,
    async ({ canvas, store }) => {
      await waitFor('Alpha-5-Objekt im Katalog', () =>
        useAppStore.getState().catalog.some((meta) => meta.name === ALPHA5.name),
      );
      await settle();

      // Liste: SatelliteDrawer wählt `row.meta.noradId` aus dem Store-Katalog.
      const row = useAppStore.getState().catalog.find((meta) => meta.name === ALPHA5.name);
      expect('I1 Katalog führt die normalisierte Kennung', row?.noradId === ALPHA5_T.id, `Liste zeigt NORAD ${row?.noradId}`);
      await chooseByNorad(row?.noradId ?? '');
      await verifyShown('I1 aus der Liste', ALPHA5_T);
      await setStore({ drawerOpen: true, filters: { mode: 'all', includeBelowHorizon: true, query: ALPHA5_T.id } });
      const drawer = serverRender(SatelliteDrawer);
      await setStore({ drawerOpen: false, filters: { mode: 'all', includeBelowHorizon: false, query: '' } });
      const rowStyle = new RegExp(`<button[^>]*style="([^"]*)"[^>]*>(?:(?!</button>).)*${ALPHA5.name}`).exec(drawer)?.[1] ?? '';
      expect(
        'I1 Liste markiert die Zeile als gewählt',
        rowStyle.includes('var(--accent) 14%'),
        `Suche „${ALPHA5_T.id}“, Zeilenstil „${rowStyle}“`,
      );

      // Tap: Kamera auf das Objekt, Tipp in die Bildmitte.
      await clearSelection();
      const slot = indexOf(ALPHA5_T.id);
      const sample = readSample(slot);
      const camera = store.getState().camera as PerspectiveCamera;
      if (sample) {
        camera.position.set(0, 0, 0);
        camera.up.set(0, 1, 0);
        camera.lookAt(...direction(sample.azimuth, sample.elevation));
        camera.updateMatrixWorld(true);
        camera.updateProjectionMatrix();
      }
      await act(async () => {
        canvas.dispatch('pointerdown', { clientX: 200, clientY: 400 });
        canvas.dispatch('pointerup', { clientX: 200, clientY: 400 });
      });
      expect(
        'I2 Tap trifft das Alpha-5-Objekt',
        useAppStore.getState().selectedId === ALPHA5_T.id,
        `Objekt bei ${f((sample?.elevation ?? NaN) * RAD, 1)}° Elevation, gewählt ${useAppStore.getState().selectedId}`,
      );
      await verifyShown('I2 per Tap', ALPHA5_T);

      // Roh: die Kennung, wie sie in der TLE-Zeile steht.
      await clearSelection();
      await chooseByNorad('A0001');
      await verifyShown('I3 als „A0001“', ALPHA5_T);
    },
    { scene: true, setup: { feed: FEED_FULL } },
  );
}

console.log(`${checks} Prüfungen, ${failures} Fehlschläge`);
for (const worker of liveWorkers) worker.terminate();
if (failures > 0) process.exit(1);
console.log('✓ Auswahl hängt an der NORAD-ID; Bahnhöhe, Subpunkt, Spur und Überflüge gehören zum gewählten Objekt');
// Der Scheduler von React hält den Prozess sonst offen.
process.exit(0);
