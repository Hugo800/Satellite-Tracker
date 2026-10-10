/**
 * Prüft die Vorhersage „Demnächst sichtbar“ (Filter „Sichtbar“) über den
 * ganzen Weg: Scan-Mathematik (src/math/forecast.ts) gegen eine unabhängige
 * Referenz, reine Funktionen des Main-Threads (src/state/forecastView.ts),
 * Pool-Rundruf und Antworten (useSatelliteEngine), Controller in virtueller
 * Zeit (useVisibilityForecast), Szene (VisibilityForecast), Liste
 * (ForecastList), den Lang-Scan „Ausblick“ (Spezifikation 08.10.2026, §12) und
 * die Verbünde (§13).
 *
 * Abschnitte (Reihenfolge im Lauf: A, B, E, F, V, T ohne Pool, dann C, D, G, H mit Pool):
 *   A  `createScanContext` + `scanWindows` + `describeWindow` über 20 min gegen
 *      die 1-s-Referenz: jedes Referenzfenster ≥ 5 s gefunden, kein
 *      Fehlalarm, Ränder ≤ 1,25 s, im Mittel < 4 Proben je Objekt, GEO ≤ 2,
 *      das 8–12-s-Fenster gefunden; Richtung zum Sichtbeginn, Höchststand und
 *      Spitzenhelligkeit gegen die Referenz; ein schon laufendes Fenster mit
 *      seinem echten Beginn; Spurbeginn im eigenen Bogen, auch wenn das
 *      Objekt bei fromMs im vorigen über dem Horizont steht; ein Fenster im
 *      letzten Rasterschritt; ein Fenster unter 5 s in jedem Kurz- und
 *      Lang-Scan gleich (absolutes Raster).
 *   B  Konsistenz: Ränder gegen `predictPasses().nakedEyeStart/End`, jedes
 *      Fenster ab 5 s auch dort (dazu ein echtes 8,4-s-Fenster von ARIANE 40
 *      R/B), `traceStartMs` gegen den Referenz-Aufgang, `forecastPointAt`
 *      gegen die Referenzrichtung.
 *   C  Pool mit 3 Shards als Node-Threads: Rundruf, `requestId`/`shardIndex`,
 *      Übernahme erst mit allen Shards, alte Anfrage verworfen, Standortwechsel
 *      verwirft den Job; Wachhund behält einen gültigen Stand, ohne gültigen
 *      übernimmt er nach ≈ 4 s einen Teilstand.
 *   D  Controller in virtueller Zeit: Sprung +30 d, ×60, ×−60, Pause, ×600.
 *   E  Reine Funktionen: Auswahl, Abdeckung (auf dem 5-s-Raster), Gültigkeit, Zusammenführen,
 *      Spur-Treffer, Lang-Scan-Gegenstücke, Countdown-Texte gegen feste
 *      Paare, `formatForecastNext`, Label ohne Namen erst ab dem Aufgang.
 *   F  VisibilityForecast im echten Reconciler: Was `gl.render` sähe – 4 Line2
 *      mit sichtbarem Objekt und Material, nie die Platzhalter im Nadir;
 *      `showTrails` aus → Linien weg, Labels bleiben.
 *   G  ForecastList per react-dom/client auf einem Mini-DOM: Countdown aus der
 *      virtuellen Zeit, Klick wählt aus.
 *   H  Ausblick: Kandidat bei +47 min, Texte aus virtueller Zeit, Lang-Scan nur
 *      bei leerer Liste, ungültig bei Sprung und Fensterwechsel, ruht bei ×600,
 *      Vorrang des Kurz-Scans im Worker; ×−60 mit einem Fenster knapp hinter
 *      now; Anlass einer vom Wachhund aufgegebenen Anfrage bleibt.
 *   T  TapPicker und Liste im Reconciler: Labels über ihre gezeichnete Fläche
 *      antippbar, auch gezoomt; verdeckte Labels und ausgeblendete Spuren
 *      nicht; der zugängliche Name der Kandidatenzeile folgt der Zeit, Vorsatz
 *      und Name stehen in eigenen Elementen.
 *   V  Verbünde: ISS-Elemente mit um ±0,1/±0,3 s versetzter Epoche bilden mit
 *      der ISS einen Platz („+4“), ein Zugnachbar 3 s dahinter und unabhängige
 *      Objekte nicht; Anführer; 11 Kandidaten, 5 im Verbund → 7 Plätze;
 *      Deckel und Gültigkeit zählen Verbünde; eine Spur, ein Label, Antippen
 *      wählt den Anführer.
 *
 * Referenz ist satellite.js direkt (`propagate`, `gstime`, `eciToEcf`,
 * `ecfToLookAngles`, `ecfToEci`, `geodeticToEcf`) in 1-s-Schritten, Ränder
 * per Bisektion auf 10 ms; die Sonnenrichtung kommt aus astronomy-engine, der
 * Erdschatten aus einem eigenen Zylindermodell (wie `refSunlit` in
 * scripts/verify-passes.ts). NICHT src/math/forecast.ts, NICHT
 * src/math/propagation.ts und NICHT src/math/sun.ts. Aus dem Projekt
 * übernommen werden nur das Helligkeitsmodell (`apparentMagnitude`,
 * `phaseAngle`, Schwellen aus src/math/visibility.ts) und der Erdradius –
 * Modell, nicht Prüfgegenstand.
 *
 * Feste Bezugszeit statt `Date.now()`: T0 = 07.10.2026 18:00 UTC (Sonne in
 * Leipzig −13,5°). Die Testbahnen müssen beschienen sein; zu einer beliebigen
 * Uhrzeit wäre ein sichtbarer LEO nachts nicht zu entwerfen, die Prüfung hinge
 * an der Tageszeit des Laufs. Der Pool läuft deshalb von Anfang an in der
 * virtuellen Zeit (`engine.jumpTo(T0)`); die Wanduhr liegt so mindestens einen
 * Tag daneben – jede Prüfung „nicht Wanduhr“ greift.
 *
 * Testbahnen (Leipzig): ISS-Elemente hell (std −1,8) in [T0+3, T0+8 min];
 * KNAPP, ein Zenitdurchgang auf ~360 km, dessen Standardhelligkeit so
 * gewählt ist, dass das Referenzfenster 10 s lang wird und zwischen zwei
 * Punkten eines 30-s-Rasters liegt (std ≈ 5,6, Entfernungsschranke ≈ 480 km);
 * SCHATTEN, ein LEO, der den Erdschattenzylinder knapp schneidet – zwei
 * Fenster mit 2,5 min Schatten dazwischen; MEO SICHTBAR (offener Beginn,
 * offenes Ende); GEO (nie sichtbar); 400 Füllobjekte auf 390–1070 km mit
 * Standardhelligkeit 1,5 … 5,5 (zufällige echte Fenster, nur Abschnitt A);
 * 10 000 Füllobjekte oberhalb 590 km mit std 5,5 – beweisbar nie sichtbar
 * (Entfernung ≥ 590 km > 501 km), so steht im Pool nur in der Liste, was
 * entworfen ist. Dazu CSS bei T0+30 d und HST bei T0+3 d für Controller und
 * Liste.
 *
 * Aufruf: npm run verify:forecast – einzelne Abschnitte mit
 * `FORECAST_ONLY=DH npm run verify:forecast` (A läuft immer, B, E, F, T und V
 * brauchen nur A, C, D, G und H starten den Pool).
 */
import { createElement, type ReactElement } from 'react';
import { act, advance, createRoot, extend, type RootState } from '@react-three/fiber';
import { createRoot as createDomRoot } from 'react-dom/client';
import { Worker as NodeWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { PerspectiveCamera, Vector3, type Object3D, type Sprite } from 'three';
import type { LineSegments2 } from 'three-stdlib';
import type { StoreApi, UseBoundStore } from 'zustand';
import {
  ecfToEci,
  ecfToLookAngles,
  eciToEcf,
  geodeticToEcf,
  gstime,
  propagate,
  twoline2satrec,
  type SatRec,
} from 'satellite.js';
import { Body, GeoVector, RotateVector, Rotation_EQJ_EQD } from 'astronomy-engine';
import { TapPicker } from '../src/components/canvas/TapPicker';
import { VisibilityForecast } from '../src/components/canvas/VisibilityForecast';
import { ForecastList } from '../src/components/ui/ForecastList';
import { FORECAST_MAX_SLOTS } from '../src/data/forecast';
import { SKY_RADIUS } from '../src/data/groups';
import { engine, useSatelliteEngine } from '../src/hooks/useSatelliteEngine';
import { useVisibilityForecast } from '../src/hooks/useVisibilityForecast';
import { EARTH_RADIUS_KM, RAD, compassLabel, geoToObserverGd } from '../src/math/coords';
import {
  FORECAST_MAX_VISIBLE_MS,
  FORECAST_REFINE_MS,
  FORECAST_STEP_MS,
  createScanContext,
  describeWindow,
  nakedEyeAt,
  scanWindows,
  type RawWindow,
} from '../src/math/forecast';
import { buildObserverFrame, buildTickFrame, predictPasses } from '../src/math/propagation';
import { NAKED_EYE_LIMIT, NAKED_EYE_MIN_ELEVATION, apparentMagnitude, phaseAngle } from '../src/math/visibility';
import {
  FORECAST_CATALOG_DEBOUNCE_MS,
  FORECAST_FAR_HORIZON_MS,
  FORECAST_FAR_MIN_REQUEST_GAP_MS,
  FORECAST_GROUP_MAX_SEPARATION_DEG,
  FORECAST_GROUP_RISE_TOLERANCE_MS,
  coverageFor,
  deriveForecastView,
  farCoverageFor,
  forecastPointAt,
  groupForecastEntries,
  isCoverageValid,
  isFarValid,
  mergeFarParts,
  mergeForecastParts,
  needsFarRescan,
  needsRescan,
  pickForecastTrace,
  sameForecastTrack,
  selectForecastGroups,
  type ForecastLookup,
} from '../src/state/forecastView';
import {
  forecastLabels,
  forecastState,
  forecastView,
  viewState,
  type ForecastCommitted,
  type ForecastFarCommitted,
  type ForecastPart,
  type ForecastPending,
  type ForecastSlot,
  type ForecastView,
} from '../src/state/runtime';
import { useAppStore, virtualNow } from '../src/state/store';
import {
  formatForecastCountdown,
  formatForecastNext,
  formatForecastRemaining,
} from '../src/utils/format';
import type { ForecastEntry, NoradId, Vec3 } from '../src/types';

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

const ONLY = process.env.FORECAST_ONLY ?? '';
const runs = (section: string): boolean => ONLY === '' || ONLY.includes(section);

const scriptStartedAt = Date.now();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const f = (value: number, digits = 1): string =>
  Number.isFinite(value) ? value.toFixed(digits).replace('.', ',') : String(value);
const MINUTE = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const hms = (ms: number) => new Date(ms).toISOString().slice(11, 19);
/** Sekunden relativ zu einem Bezug, lesbar mit Vorzeichen. */
const rel = (ms: number, base: number) => `${ms >= base ? '+' : ''}${f((ms - base) / 1000, 2)} s`;

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

/** Leipzig, wie in scripts/verify-timetravel.ts. */
const OBSERVER = { latitudeDeg: 51.389, longitudeDeg: 12.356, altitudeKm: 0.12 };
const REF_OBSERVER = {
  latitude: (OBSERVER.latitudeDeg * Math.PI) / 180,
  longitude: (OBSERVER.longitudeDeg * Math.PI) / 180,
  height: OBSERVER.altitudeKm,
};
/** Etwa 2 km östlich – für den Standortwechsel in Abschnitt C. */
const OBSERVER_MOVED = { ...OBSERVER, longitudeDeg: OBSERVER.longitudeDeg + 0.03 };

/** Bezugszeit aller Testbahnen und Sprungziele, siehe Kopf. */
const T0 = Date.UTC(2026, 9, 7, 18, 0, 0);
const J_3D = T0 + 3 * DAY;
const J_30D = T0 + 30 * DAY;
/** Zeitraum des Scans in Abschnitt A. */
const SCAN_MS = 20 * MINUTE;

/* ------------------------------------------------------------------ */
/* TLE-Sätze                                                            */
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

/** Winkel auf [0, 360) – die Entwürfe rechnen auch mit negativen Werten. */
const deg360 = (deg: number) => ((deg % 360) + 360) % 360;

function makeTle(el: Elements, epochMs: number): Tle {
  const date = new Date(epochMs);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = 1 + (epochMs - yearStart) / 86_400_000;
  const epoch = `${String(date.getUTCFullYear() % 100).padStart(2, '0')}${day.toFixed(8).padStart(12, '0')}`;
  const body1 = `1 ${el.norad}U ${el.intl.padEnd(8)} ${epoch}  .00000000  00000+0 ${el.bstar} 0  999`;
  const ecc = Math.round(el.eccentricity * 1e7).toString().padStart(7, '0');
  const body2 =
    `2 ${el.norad} ${el.inclination.toFixed(4).padStart(8)} ${deg360(el.raan).toFixed(4).padStart(8)} ${ecc} ` +
    `${deg360(el.argPerigee).toFixed(4).padStart(8)} ${deg360(el.meanAnomaly).toFixed(4).padStart(8)} ` +
    `${el.meanMotion.toFixed(8).padStart(11)}${'1'.padStart(5)}`;
  return [el.name, `${body1}${checksum(body1)}`, `${body2}${checksum(body2)}`];
}

const block = (lines: Tle) => `${lines.join('\n')}\n`;
const satrecOf = (tle: Tle): SatRec => twoline2satrec(tle[1], tle[2]);

/* ------------------------------------------------------------------ */
/* Referenz: satellite.js, astronomy-engine, Zylinderschatten           */
/* ------------------------------------------------------------------ */

const OBSERVER_ECF = geodeticToEcf(REF_OBSERVER as never);

/** Sonnenrichtung (wahres Äquinoktium des Datums, mit Aberration) – volle Sekunden gecacht. */
const sunCache = new Map<number, Vec3>();
function refSun(ms: number): Vec3 {
  const cached = sunCache.get(ms);
  if (cached) return cached;
  const date = new Date(ms);
  const v = RotateVector(Rotation_EQJ_EQD(date), GeoVector(Body.Sun, date, true));
  const length = Math.hypot(v.x, v.y, v.z);
  const unit = { x: v.x / length, y: v.y / length, z: v.z / length };
  if (ms % 1000 === 0) sunCache.set(ms, unit);
  return unit;
}

interface RefSample {
  /** Radiant. */
  elevation: number;
  azimuth: number;
  rangeKm: number;
  sunlit: boolean;
  magnitude: number;
}

function refSample(satrec: SatRec, std: number, ms: number): RefSample | null {
  const date = new Date(ms);
  const pv = propagate(satrec, date) as unknown as { position: Vec3 | false };
  const p = pv.position;
  if (!p || !Number.isFinite(p.x)) return null;
  const gmst = gstime(date);
  const look = ecfToLookAngles(REF_OBSERVER as never, eciToEcf(p as never, gmst)) as unknown as {
    elevation: number;
    azimuth: number;
    rangeSat: number;
  };
  const sun = refSun(ms);
  // Zylinderschatten: auf der Nachtseite und näher an der Achse Erde–Sonne als der Erdradius.
  const dot = p.x * sun.x + p.y * sun.y + p.z * sun.z;
  const sunlit = dot > 0 || Math.hypot(p.x - dot * sun.x, p.y - dot * sun.y, p.z - dot * sun.z) >= EARTH_RADIUS_KM;
  const magnitude = sunlit
    ? apparentMagnitude(std, look.rangeSat, phaseAngle(p, ecfToEci(OBSERVER_ECF, gmst) as unknown as Vec3, sun), look.elevation)
    : 99;
  return { elevation: look.elevation, azimuth: look.azimuth, rangeKm: look.rangeSat, sunlit, magnitude };
}

/** Bedingung des Filters „Sichtbar“, unabhängig nachgerechnet. */
function refVisible(s: RefSample | null): boolean {
  return s !== null && s.sunlit && s.elevation >= NAKED_EYE_MIN_ELEVATION && s.magnitude <= NAKED_EYE_LIMIT;
}

/** Blickrichtung wie buildTrail: x Ost, y Zenit, −z Nord. */
function direction(azimuth: number, elevation: number): Vec3 {
  const cosEl = Math.cos(elevation);
  return { x: cosEl * Math.sin(azimuth), y: Math.sin(elevation), z: -cosEl * Math.cos(azimuth) };
}

function angleDeg(a: Vec3, b: Vec3): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  const norm = Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z);
  return Math.acos(Math.min(1, Math.max(-1, dot / norm))) * RAD;
}

/** Bisektion zwischen „gilt“ und „gilt nicht“ auf 10 ms; Ergebnis auf der Seite, an der es gilt. */
function refEdge(holds: (ms: number) => boolean, insideMs: number, outsideMs: number): number {
  let inside = insideMs;
  let outside = outsideMs;
  while (Math.abs(outside - inside) > 10) {
    const mid = Math.round((inside + outside) / 2);
    if (holds(mid)) inside = mid;
    else outside = mid;
  }
  return inside;
}

interface RefWindow {
  startMs: number;
  /** Letzter sichtbarer Moment. */
  endMs: number;
  /** Schon länger als FORECAST_MAX_VISIBLE_MS vor `fromMs` sichtbar – Beginn unbekannt, `startMs` = `fromMs`. */
  startOpen: boolean;
  /** Länger als FORECAST_MAX_VISIBLE_MS nach max(Beginn, fromMs) noch sichtbar. */
  endOpen: boolean;
}

/**
 * Sichtfenster im Sekundentakt über [fromMs, toMs], Ränder per Bisektion.
 * Ein bei `fromMs` schon laufendes Fenster wird rückwärts bis zu seinem
 * Beginn verfolgt, höchstens FORECAST_MAX_VISIBLE_MS weit; ein bei `toMs`
 * offenes vorwärts, bis es endet oder länger als FORECAST_MAX_VISIBLE_MS nach
 * max(Beginn, fromMs) ist – so weit, wie describeWindow es tut.
 */
function refWindows(satrec: SatRec, std: number, fromMs: number, toMs: number): RefWindow[] {
  const visibleAt = (ms: number) => refVisible(refSample(satrec, std, ms));
  const windows: RefWindow[] = [];
  let current: RefWindow | null = null;
  let previous = fromMs;
  for (let t = fromMs; ; t += 1000) {
    const beyond = t > toMs;
    if (beyond && (current === null || t - Math.max(current.startMs, fromMs) > FORECAST_MAX_VISIBLE_MS + 2000)) {
      if (current) {
        current.endOpen = true;
        current.endMs = previous;
        windows.push(current);
      }
      break;
    }
    const visible = visibleAt(t);
    if (visible && current === null) {
      if (t === fromMs) {
        let back = fromMs;
        while (fromMs - (back - 1000) <= FORECAST_MAX_VISIBLE_MS && visibleAt(back - 1000)) back -= 1000;
        current =
          fromMs - (back - 1000) > FORECAST_MAX_VISIBLE_MS
            ? { startMs: fromMs, endMs: NaN, startOpen: true, endOpen: false }
            : { startMs: refEdge(visibleAt, back, back - 1000), endMs: NaN, startOpen: false, endOpen: false };
      } else {
        current = { startMs: refEdge(visibleAt, t, previous), endMs: NaN, startOpen: false, endOpen: false };
      }
    } else if (!visible && current !== null) {
      current.endMs = refEdge(visibleAt, previous, t);
      windows.push(current);
      current = null;
      if (beyond) break;
    }
    previous = t;
  }
  return windows;
}

/**
 * Aufgang (Höhe 0) des Bogens, in dem `atMs` liegt: rückwärts im Sekundentakt
 * bis unter den Horizont, dann per Bisektion auf 10 ms. NaN, wenn das Objekt
 * schon bei `fromMs` über dem Horizont steht und bis `atMs` dort bleibt.
 */
function refRise(satrec: SatRec, fromMs: number, atMs: number): number {
  const above = (ms: number) => (refSample(satrec, 0, ms)?.elevation ?? -1) > 0;
  for (let t = atMs; t > fromMs; t -= 1000) {
    const earlier = Math.max(fromMs, t - 1000);
    if (!above(earlier)) return refEdge(above, t, earlier);
  }
  return NaN;
}

/* ------------------------------------------------------------------ */
/* Entwürfe                                                             */
/* ------------------------------------------------------------------ */

/**
 * Sucht Knoten und Anomalie so, dass das Objekt in [fromMs, toMs] möglichst
 * lange sichtbar ist (Referenz, 30-s-Schritte), bei Gleichstand möglichst
 * hoch; `avoid`: dort nie sichtbar (20-s-Schritte). Wie `designVisible` in
 * scripts/verify-timetravel.ts, nur mit Beleuchtung und Helligkeit.
 */
function designNakedEye(
  base: Elements,
  std: number,
  fromMs: number,
  toMs: number,
  options: { stepDeg?: number; avoid?: [number, number] } = {},
): { el: Elements; visibleSamples: number; samples: number } {
  const stepDeg = options.stepDeg ?? 4;
  const times: number[] = [];
  for (let t = fromMs; t <= toMs; t += 30_000) times.push(t);
  const avoidTimes: number[] = [];
  if (options.avoid) for (let t = options.avoid[0]; t <= options.avoid[1]; t += 20_000) avoidTimes.push(t);
  let best = { score: -1, minEl: Number.NEGATIVE_INFINITY, raan: 0, meanAnomaly: 0 };
  for (let raan = 0; raan < 360; raan += stepDeg) {
    for (let meanAnomaly = 0; meanAnomaly < 360; meanAnomaly += stepDeg) {
      const satrec = satrecOf(makeTle({ ...base, raan, meanAnomaly }, T0));
      let score = 0;
      let minEl = Number.POSITIVE_INFINITY;
      for (const t of times) {
        const s = refSample(satrec, std, t);
        if (!s || s.elevation < 0) {
          score = -1;
          break;
        }
        minEl = Math.min(minEl, s.elevation);
        if (refVisible(s)) score += 1;
      }
      if (score < best.score || (score === best.score && minEl <= best.minEl)) continue;
      if (avoidTimes.some((t) => refVisible(refSample(satrec, std, t)))) continue;
      best = { score, minEl, raan, meanAnomaly };
    }
  }
  return {
    el: { ...base, raan: best.raan, meanAnomaly: best.meanAnomaly },
    visibleSamples: best.score,
    samples: times.length,
  };
}

/** Knoten und Anomalie mit größter Höhe zur Zeit `atMs` (grob 2°, fein 0,1°). */
function designZenith(base: Elements, atMs: number): { el: Elements; elevationDeg: number } {
  let best = { elevation: Number.NEGATIVE_INFINITY, raan: 0, meanAnomaly: 0 };
  const probe = (raan: number, meanAnomaly: number) => {
    const s = refSample(satrecOf(makeTle({ ...base, raan, meanAnomaly }, T0)), 0, atMs);
    if (s && s.elevation > best.elevation) best = { elevation: s.elevation, raan, meanAnomaly };
  };
  for (let raan = 0; raan < 360; raan += 2) for (let ma = 0; ma < 360; ma += 2) probe(raan, ma);
  const coarse = { ...best };
  for (let raan = coarse.raan - 2; raan <= coarse.raan + 2; raan += 0.1) {
    for (let ma = coarse.meanAnomaly - 2; ma <= coarse.meanAnomaly + 2; ma += 0.1) probe(raan, ma);
  }
  return { el: { ...base, raan: best.raan, meanAnomaly: best.meanAnomaly }, elevationDeg: best.elevation * RAD };
}

/**
 * Standardhelligkeit, bei der das Referenzfenster um den hellsten Punkt eines
 * Durchgangs `lengthMs` lang wird: Die Magnitude ist std + f(t), eine andere
 * Standardhelligkeit verschiebt die Kurve nur. f wird im 50-ms-Takt
 * abgetastet; die Schwelle ist der Wert, unter dem genau so viele Proben
 * liegen.
 */
function stdForWindow(satrec: SatRec, fromMs: number, toMs: number, lengthMs: number): { std: number; peakMs: number } {
  let peak = { f: Number.POSITIVE_INFINITY, ms: fromMs };
  for (let t = fromMs; t <= toMs; t += 100) {
    const s = refSample(satrec, 0, t);
    if (s && s.sunlit && s.elevation >= NAKED_EYE_MIN_ELEVATION && s.magnitude < peak.f) peak = { f: s.magnitude, ms: t };
  }
  const values: number[] = [];
  for (let t = peak.ms - 3 * lengthMs; t <= peak.ms + 3 * lengthMs; t += 50) {
    const s = refSample(satrec, 0, t);
    values.push(s && s.sunlit && s.elevation >= NAKED_EYE_MIN_ELEVATION ? s.magnitude : 99);
  }
  values.sort((a, b) => a - b);
  // Mitte zwischen der letzten Probe innerhalb und der ersten außerhalb.
  const n = Math.round(lengthMs / 50);
  return { std: NAKED_EYE_LIMIT - (values[n - 1] + values[n]) / 2, peakMs: peak.ms };
}

const MU_KM3_S2 = 398600.4418;
type V3 = { x: number; y: number; z: number };
const unit = (v: V3): V3 => {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot3 = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * Kreisbahn, die den Erdschattenzylinder bei `atMs` knapp streift.
 *
 * Auf der Kugel mit Bahnradius r ist der Schatten eine Kappe um den
 * Gegenpunkt der Sonne mit Winkelradius asin(R/r). Gewählt wird der Randpunkt
 * der Kappe, der von Leipzig aus am höchsten steht, dazu eine Bahn tangential
 * zum Rand. Um `offsetDeg` nach innen versetzt, schneidet sie die Kappe in
 * einer kurzen Sehne – ein Schattenstück mitten im Bogen. Tangential wäre die
 * Schattengrenze schleifend gekreuzt und ihr Zeitpunkt empfindlich für jedes
 * Tausendstelgrad der Sonnenrichtung; die Bisektion unten zielt deshalb auf
 * 150 s Schatten (Schnittwinkel ≈ 4°).
 */
function shadowArc(
  atMs: number,
  altitudeKm: number,
  offsetDeg: number,
  template: Omit<Elements, 'inclination' | 'raan' | 'meanAnomaly' | 'meanMotion'>,
): Elements {
  const r = 6378.135 + altitudeKm;
  const sun = refSun(atMs);
  const e1 = unit(cross({ x: 0, y: 0, z: 1 }, sun));
  const e2 = cross(sun, e1);
  const alpha = Math.asin(EARTH_RADIUS_KM / r) - offsetDeg / RAD;
  const gmst = gstime(new Date(atMs));
  let best = { elevation: Number.NEGATIVE_INFINITY, p: { x: 0, y: 0, z: 0 } };
  for (let thetaDeg = 0; thetaDeg < 360; thetaDeg += 0.5) {
    const theta = thetaDeg / RAD;
    const p = {
      x: r * (-Math.cos(alpha) * sun.x + Math.sin(alpha) * (Math.cos(theta) * e1.x + Math.sin(theta) * e2.x)),
      y: r * (-Math.cos(alpha) * sun.y + Math.sin(alpha) * (Math.cos(theta) * e1.y + Math.sin(theta) * e2.y)),
      z: r * (-Math.cos(alpha) * sun.z + Math.sin(alpha) * (Math.cos(theta) * e1.z + Math.sin(theta) * e2.z)),
    };
    const look = ecfToLookAngles(REF_OBSERVER as never, eciToEcf(p as never, gmst)) as unknown as { elevation: number };
    if (look.elevation > best.elevation) best = { elevation: look.elevation, p };
  }
  const position = unit(best.p);
  const velocity = unit(cross(sun, position));
  const normal = unit(cross(position, velocity));
  const raan = Math.atan2(normal.x, -normal.y);
  const node = { x: Math.cos(raan), y: Math.sin(raan), z: 0 };
  const argumentOfLatitude = Math.atan2(dot3(cross(node, position), normal), dot3(node, position));
  const n = Math.sqrt(MU_KM3_S2 / r ** 3);
  return {
    ...template,
    inclination: Math.acos(normal.z) * RAD,
    raan: raan * RAD,
    meanAnomaly: (argumentOfLatitude - (n * (atMs - T0)) / 1000) * RAD,
    meanMotion: (n * 86400) / (2 * Math.PI),
  };
}

/** Schattenzeit in s um `atMs` (± 5 min), Referenz im Sekundentakt. */
function shadowSeconds(satrec: SatRec, atMs: number): number {
  let shadow = 0;
  for (let t = atMs - 5 * MINUTE; t <= atMs + 5 * MINUTE; t += 1000) {
    const s = refSample(satrec, 0, t);
    if (s && !s.sunlit) shadow += 1;
  }
  return shadow;
}

/* ------------------------------------------------------------------ */
/* Katalog                                                              */
/* ------------------------------------------------------------------ */

interface TestObject {
  name: string;
  id: NoradId;
  tle: Tle;
  satrec: SatRec;
  /** Standardhelligkeit in Abschnitt A und B. */
  std: number;
}

function testObject(el: Elements, std: number): TestObject {
  const tle = makeTle(el, T0);
  return { name: el.name, id: el.norad as NoradId, tle, satrec: satrecOf(tle), std };
}

const designStarted = Date.now();

/** ISS-Elemente, hell über Leipzig in [T0+3, T0+8 min]. NORAD 25544 → std −1,8 auch im Worker. */
const ISS_BASE: Elements = {
  name: 'ISS (ZARYA)',
  norad: '25544',
  intl: '98067A',
  inclination: 51.64,
  raan: 0,
  eccentricity: 0.0002571,
  argPerigee: 75.4322,
  meanAnomaly: 0,
  meanMotion: 15.50377579,
  bstar: ' 30177-3',
};
const ISS_DESIGN = designNakedEye(ISS_BASE, -1.8, T0 + 3 * MINUTE, T0 + 8 * MINUTE);
const ISS = testObject(ISS_DESIGN.el, -1.8);

/**
 * CSS (std −0,4 im Worker), sichtbar bei T0+30 d. Auf rund 720 km: Die Sonne
 * steht dann in Leipzig 24° unter dem Horizont, der Schatten reicht im Zenit
 * bis 600 km. Nie sichtbar in [T0 − 2 h, T0 + 1 h], damit Abschnitt H dort
 * nur den Kandidaten findet, den er erwartet.
 */
const CSS_DESIGN = designNakedEye(
  { ...ISS_BASE, name: 'CSS (TIANHE)', norad: '48274', intl: '21035A', inclination: 41.47, meanMotion: 14.5, bstar: ' 10000-4' },
  -0.4,
  J_30D + 2 * MINUTE,
  J_30D + 8 * MINUTE,
  { avoid: [T0 - 2 * HOUR, T0 + HOUR] },
);
const CSS = testObject(CSS_DESIGN.el, -0.4);

/** HST (std 1,4 im Worker), sichtbar bei T0+3 d, ebenfalls nie um T0. */
const HST_DESIGN = designNakedEye(
  { ...ISS_BASE, name: 'HST', norad: '20580', intl: '90037B', inclination: 51.6, meanMotion: 15.1, bstar: ' 10000-4' },
  1.4,
  J_3D + 2 * MINUTE,
  J_3D + 8 * MINUTE,
  { avoid: [T0 - 2 * HOUR, T0 + HOUR] },
);
const HST = testObject(HST_DESIGN.el, 1.4);

/** Geostationär über Leipzigs Länge. NORAD 33591 ersetzt den Offline-Fallback NOAA 19 (std 3,5). */
const GEO = testObject(
  {
    name: 'GEO STILL',
    norad: '33591',
    intl: '09005A',
    inclination: 0.05,
    raan: 0,
    eccentricity: 0.0001,
    argPerigee: 0,
    meanAnomaly: deg360(OBSERVER.longitudeDeg - gstime(new Date(T0)) * RAD),
    meanMotion: 1.00273791,
    bstar: ' 00000+0',
  },
  3.5,
);

/**
 * MEO wie BEIDOU-3 M16, die ganzen 20 min über Leipzig. Mit std −5 so hell,
 * dass das Fenster bei T0 schon läuft und länger als 20 min dauert: offener
 * Beginn, offenes Ende.
 */
const MEO_BASE: Elements = {
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
};
const MEO = testObject(designNakedEye(MEO_BASE, -5, T0, T0 + 2 * SCAN_MS, { stepDeg: 6 }).el, -5);

/** Zenitdurchgang um T0+15 min auf ~360 km; die Standardhelligkeit macht das Fenster 10 s lang. */
const KNAPP_ZENITH = designZenith(
  {
    ...ISS_BASE,
    name: 'KNAPP',
    norad: '61020',
    intl: '26050A',
    inclination: 53,
    eccentricity: 0.0003,
    argPerigee: 0,
    meanMotion: 15.7,
    bstar: ' 10000-4',
  },
  T0 + 15 * MINUTE,
);
const KNAPP_TUNE = stdForWindow(
  satrecOf(makeTle(KNAPP_ZENITH.el, T0)),
  T0 + 11 * MINUTE,
  T0 + 19 * MINUTE,
  10_000,
);
const KNAPP = testObject(KNAPP_ZENITH.el, KNAPP_TUNE.std);

/** Streift den Erdschatten bei T0+10 min; Versatz per Bisektion auf 150 s Schatten. */
const SCHATTEN_TEMPLATE = { name: 'SCHATTEN', norad: '61010', intl: '26040A', eccentricity: 0.0001, argPerigee: 0, bstar: ' 00000+0' };
const SCHATTEN_AT = T0 + 10 * MINUTE;
const SCHATTEN = (() => {
  // Mehr Versatz nach innen → längere Sehne → mehr Schatten.
  let lo = -0.3;
  let hi = 0.3;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    const seconds = shadowSeconds(satrecOf(makeTle(shadowArc(SCHATTEN_AT, 700, mid, SCHATTEN_TEMPLATE), T0)), SCHATTEN_AT);
    if (seconds < 150) lo = mid;
    else hi = mid;
  }
  return testObject(shadowArc(SCHATTEN_AT, 700, (lo + hi) / 2, SCHATTEN_TEMPLATE), 1.0);
})();

/**
 * Füllobjekte für Pool und Abschnitt A: 600–1300 km, std 5,5 (Gruppe „other“
 * im Worker). Beweisbar nie sichtbar: Die Entfernung ist mindestens die
 * Bahnhöhe, also > 501 km; std + 5·log10(590/1000) = 4,35 > 4,0, Phasen- und
 * Extinktionsterm sind ≥ 0. So hängt die Liste im Pool nur an den Entwürfen.
 */
function poolFiller(i: number): Elements {
  return {
    name: `FILL ${i}`,
    norad: String(70000 + i),
    intl: '24001A',
    inclination: 30 + ((i * 7) % 70),
    raan: (i * 37) % 360,
    eccentricity: 0.001,
    argPerigee: (i * 53) % 360,
    meanAnomaly: (i * 71) % 360,
    // 14,85 rev/d ≈ 610 km, 12,9 rev/d ≈ 1300 km.
    meanMotion: 12.9 + (i % 14) * 0.15,
    bstar: ' 10000-4',
  };
}
const POOL_FILLERS = 10_000;
const FILLER_STD = 5.5;

/**
 * Füllobjekte mit echten, zufälligen Fenstern, nur für Abschnitt A:
 * 390–1070 km, Standardhelligkeit 1,5 … 5,5 – vom langen hellen Bogen bis zum
 * Sekundenfenster an der Grenzhelligkeit.
 */
const LOW_FILLERS: TestObject[] = Array.from({ length: 400 }, (_, i) =>
  testObject(
    {
      name: `TIEF ${i}`,
      norad: String(62000 + i),
      intl: '25001A',
      inclination: 40 + ((i * 11) % 60),
      raan: (i * 43) % 360,
      eccentricity: 0.0005,
      argPerigee: (i * 29) % 360,
      meanAnomaly: (i * 97) % 360,
      meanMotion: 13.5 + (i % 12) * 0.19,
      bstar: ' 10000-4',
    },
    1.5 + (i % 9) * 0.5,
  ),
);

console.log(
  `Entwürfe in ${f((Date.now() - designStarted) / 1000, 1)} s: ISS ${ISS_DESIGN.visibleSamples}/${ISS_DESIGN.samples}, ` +
    `CSS ${CSS_DESIGN.visibleSamples}/${CSS_DESIGN.samples}, HST ${HST_DESIGN.visibleSamples}/${HST_DESIGN.samples} Proben sichtbar; ` +
    `KNAPP Zenit ${f(KNAPP_ZENITH.elevationDeg, 2)}°, std ${f(KNAPP.std, 3)}, hellster Punkt ${hms(KNAPP_TUNE.peakMs)} UTC; ` +
    `SCHATTEN i ${f(Number(SCHATTEN.tle[2].slice(8, 16)), 2)}°`,
);

/* ------------------------------------------------------------------ */
/* A: Scan gegen die 1-s-Referenz                                       */
/* ------------------------------------------------------------------ */

const OBSERVER_GD = geoToObserverGd(OBSERVER);
const OBSERVER_FRAME = buildObserverFrame(OBSERVER_GD);
/** Toleranz der Ränder: Nachschärfung auf 250 ms plus 1 s Spielraum für Sonnenmodell und Rundung. */
const EDGE_TOL_MS = 1250;

interface ScanResult {
  obj: TestObject;
  entries: ForecastEntry[];
  raw: RawWindow[];
  samples: number;
  /** null: keine Referenz gerechnet (Füllobjekt außerhalb der Stichprobe). */
  ref: RefWindow[] | null;
}

const DESIGNED = [ISS, KNAPP, SCHATTEN, MEO, GEO, CSS, HST];
const A_FILLERS = Array.from({ length: 3000 }, (_, i) => testObject(poolFiller(i), FILLER_STD));
/** Jedes 30. Füllobjekt bekommt trotzdem die Referenz – sie muss den Beweis bestätigen. */
const FILLER_REF_EVERY = 30;

console.log(`A. Scan über 20 min ab ${iso(T0)} UTC gegen die 1-s-Referenz`);
const scanStarted = performance.now();
const ctx = createScanContext(OBSERVER_GD, OBSERVER_FRAME, T0, T0 + SCAN_MS);
const scanned: ScanResult[] = [];
for (const obj of [...DESIGNED, ...LOW_FILLERS, ...A_FILLERS]) {
  const raw: RawWindow[] = [];
  const samples = scanWindows(ctx, obj.satrec, obj.std, raw);
  const copy = raw.map((w) => ({ ...w }));
  const entries = copy
    .map((w) => describeWindow(ctx, obj.satrec, obj.std, obj.id, w))
    .filter((e): e is ForecastEntry => e !== null);
  scanned.push({ obj, entries, raw: copy, samples, ref: null });
}
const scanMs = performance.now() - scanStarted;
const refStarted = performance.now();
scanned.forEach((result, i) => {
  const isFiller = i >= DESIGNED.length + LOW_FILLERS.length;
  if (isFiller && (i - DESIGNED.length - LOW_FILLERS.length) % FILLER_REF_EVERY !== 0) return;
  result.ref = refWindows(result.obj.satrec, result.obj.std, T0, T0 + SCAN_MS);
});
const refMs = performance.now() - refStarted;
const resultOf = (obj: TestObject) => scanned.find((r) => r.obj === obj) as ScanResult;
const overlaps = (e: ForecastEntry, w: RefWindow) =>
  e.startMs <= w.endMs + EDGE_TOL_MS && e.endMs >= w.startMs - EDGE_TOL_MS;
const durationS = (w: { startMs: number; endMs: number }) => (w.endMs - w.startMs) / 1000;

/**
 * Richtung zum Sichtbeginn, Höchststand und Spitzenhelligkeit eines Eintrags
 * gegen die Referenz; leer, wenn alles stimmt. Die Richtung gilt am selben
 * Zeitpunkt (≤ 0,5°). Höchststand und Helligkeit sind Maxima über Proben im
 * Abstand ≤ 5 s: nie über dem wahren Wert (+0,05° bzw. −0,05 mag für das
 * Modell) und mindestens so gut wie der schlechteste Referenzwert binnen 5 s
 * um das wahre Maximum.
 */
function describedAgainstReference(obj: TestObject, e: ForecastEntry): string[] {
  const atStart = refSample(obj.satrec, obj.std, e.startMs);
  const azOff = atStart ? Math.abs(((((e.startAzimuthDeg - atStart.azimuth * RAD) % 360) + 540) % 360) - 180) : Infinity;
  const samples: Array<{ t: number; el: number; mag: number }> = [];
  for (let t = e.startMs; ; t = Math.min(t + 1000, e.endMs)) {
    const s = refSample(obj.satrec, obj.std, t);
    if (s) samples.push({ t, el: s.elevation * RAD, mag: s.magnitude });
    if (t >= e.endMs) break;
  }
  if (samples.length === 0) return ['keine Referenzprobe im Fenster'];
  const top = samples.reduce((a, b) => (b.el > a.el ? b : a));
  const bright = samples.reduce((a, b) => (b.mag < a.mag ? b : a));
  const elFloor = Math.min(...samples.filter((x) => Math.abs(x.t - top.t) <= FORECAST_STEP_MS).map((x) => x.el)) - 0.05;
  const magCeil = Math.max(...samples.filter((x) => Math.abs(x.t - bright.t) <= FORECAST_STEP_MS).map((x) => x.mag)) + 0.05;
  return [
    azOff > 0.5 ? `aus ${f(e.startAzimuthDeg, 2)}° statt ${f((atStart?.azimuth ?? NaN) * RAD, 2)}°` : '',
    e.maxElevationDeg > top.el + 0.05 || e.maxElevationDeg < elFloor
      ? `max ${f(e.maxElevationDeg, 2)}° statt ${f(top.el, 2)}° (mindestens ${f(elFloor, 2)}°)`
      : '',
    e.peakMagnitude < bright.mag - 0.05 || e.peakMagnitude > magCeil
      ? `${f(e.peakMagnitude, 2)} mag statt ${f(bright.mag, 2)} (höchstens ${f(magCeil, 2)})`
      : '',
  ].filter(Boolean);
}

{
  let refCount = 0;
  let longRef = 0;
  const missed: string[] = [];
  const falseAlarms: string[] = [];
  const openMismatch: string[] = [];
  let worstStart = { ms: 0, name: '–' };
  let worstEnd = { ms: 0, name: '–' };
  let edges = 0;
  for (const result of scanned) {
    const { obj, entries, ref } = result;
    if (ref === null) {
      // Ohne Referenz nur Füllobjekte: beweisbar nie sichtbar, siehe `poolFiller`.
      for (const e of entries) falseAlarms.push(`${obj.name} ${hms(e.startMs)}–${hms(e.endMs)} (Füllobjekt)`);
      continue;
    }
    refCount += ref.length;
    for (const w of ref) {
      const long = w.endOpen || durationS(w) >= 5;
      if (long) longRef += 1;
      const matches = entries.filter((e) => overlaps(e, w));
      if (matches.length === 0) {
        if (long) missed.push(`${obj.name} ${hms(w.startMs)}–${hms(w.endMs)} (${f(durationS(w), 1)} s)`);
        continue;
      }
      const e = matches[0];
      if (e.startOpen !== w.startOpen) openMismatch.push(`${obj.name}: Beginn offen ${e.startOpen}, Referenz ${w.startOpen}`);
      else if (!w.startOpen) {
        edges += 1;
        const d = Math.abs(e.startMs - w.startMs);
        if (d > worstStart.ms) worstStart = { ms: d, name: `${obj.name} ${hms(w.startMs)}` };
      }
      const refLong = w.endOpen || w.endMs - Math.max(w.startMs, T0) > FORECAST_MAX_VISIBLE_MS;
      if (e.endOpen !== refLong) openMismatch.push(`${obj.name}: Ende offen ${e.endOpen}, Referenz ${refLong}`);
      else if (!refLong) {
        edges += 1;
        const d = Math.abs(e.endMs - w.endMs);
        if (d > worstEnd.ms) worstEnd = { ms: d, name: `${obj.name} ${hms(w.endMs)}` };
      }
    }
    for (const e of entries) {
      if (!ref.some((w) => overlaps(e, w))) falseAlarms.push(`${obj.name} ${hms(e.startMs)}–${hms(e.endMs)}`);
    }
  }
  const entryCount = scanned.reduce((sum, r) => sum + r.entries.length, 0);
  const withRef = scanned.filter((r) => r.ref !== null).length;
  console.log(
    `  Scan ${f(scanMs, 0)} ms für ${scanned.length} Objekte (${entryCount} Fenster beschrieben); ` +
      `Referenz ${f(refMs / 1000, 1)} s für ${withRef} Objekte, ${refCount} Fenster (${longRef} ≥ 5 s)`,
  );
  expect(
    'A jedes Referenzfenster ≥ 5 s gefunden',
    missed.length === 0 && longRef >= 8,
    `${longRef - missed.length} von ${longRef} gefunden${missed.length ? `; verpasst: ${missed.join(', ')}` : ''}`,
  );
  expect(
    'A kein Fehlalarm',
    falseAlarms.length === 0,
    `${entryCount} Fenster, ${falseAlarms.length} ohne Referenzfenster` +
      `${falseAlarms.length ? `: ${falseAlarms.slice(0, 6).join(', ')}` : ''}`,
  );
  expect(
    'A Ränder ≤ 1,25 s neben der Referenz, offene Ränder übereinstimmend',
    worstStart.ms <= EDGE_TOL_MS && worstEnd.ms <= EDGE_TOL_MS && openMismatch.length === 0 && edges > 0,
    `${edges} Ränder, Beginn höchstens ${f(worstStart.ms / 1000, 2)} s daneben (${worstStart.name}), ` +
      `Ende höchstens ${f(worstEnd.ms / 1000, 2)} s (${worstEnd.name})` +
      `${openMismatch.length ? `; offene Ränder abweichend: ${openMismatch.join(', ')}` : ''}`,
  );

  const totalSamples = scanned.reduce((sum, r) => sum + r.samples, 0);
  const meanSamples = totalSamples / scanned.length;
  const geoSamples = resultOf(GEO).samples;
  const fillerMean =
    scanned.slice(DESIGNED.length + LOW_FILLERS.length).reduce((sum, r) => sum + r.samples, 0) / A_FILLERS.length;
  expect(
    'A Entfernungsschranke: im Mittel < 4 Proben je Objekt, GEO ≤ 2',
    meanSamples < 4 && geoSamples <= 2,
    `${totalSamples} Proben für ${scanned.length} Objekte = ${f(meanSamples, 2)} je Objekt ` +
      `(Füllobjekte ${f(fillerMean, 2)}, ohne Schranke ${ctx.gridCount}); GEO ${geoSamples}`,
  );

  // KNAPP: Entwurf (Referenz 8–12 s, zwischen zwei Punkten eines 30-s-Rasters)
  // und Fund.
  const knapp = resultOf(KNAPP);
  const knappRef = knapp.ref?.[0];
  const knappEntry = knappRef ? knapp.entries.find((e) => overlaps(e, knappRef)) : undefined;
  const offGrid30 =
    knappRef !== undefined &&
    Math.floor((knappRef.startMs - T0) / 30_000) === Math.floor((knappRef.endMs - T0) / 30_000) &&
    (knappRef.startMs - T0) % 30_000 !== 0;
  expect(
    'A das 8–12-s-Fenster (KNAPP) wird gefunden',
    knappRef !== undefined && knapp.ref?.length === 1 && durationS(knappRef) >= 8 && durationS(knappRef) <= 12 &&
      offGrid30 && knappEntry !== undefined,
    knappRef
      ? `Referenz ${hms(knappRef.startMs)}–${hms(knappRef.endMs)} UTC (${f(durationS(knappRef), 2)} s, ` +
          `${offGrid30 ? 'ohne' : 'mit'} Punkt eines 30-s-Rasters), Scan ` +
          (knappEntry
            ? `${hms(knappEntry.startMs)}–${hms(knappEntry.endMs)} (${f(durationS(knappEntry), 2)} s, ` +
              `${f(knappEntry.peakMagnitude, 2)} mag, max ${f(knappEntry.maxElevationDeg, 1)}°)`
            : 'nichts') +
          `; std ${f(KNAPP.std, 3)}, Schranke ${f(1000 * Math.pow(10, (NAKED_EYE_LIMIT - KNAPP.std) / 5), 0)} km`
      : 'Entwurf ohne Referenzfenster',
  );

  const schatten = resultOf(SCHATTEN);
  const gapS =
    schatten.ref && schatten.ref.length === 2 ? (schatten.ref[1].startMs - schatten.ref[0].endMs) / 1000 : NaN;
  expect(
    'A Erdschatten mitten im Bogen: zwei Fenster eines Objekts',
    schatten.ref?.length === 2 && schatten.entries.length === 2 && gapS >= 60 &&
      schatten.entries.every((e) => !e.startOpen && !e.endOpen) &&
      schatten.entries[0].traceStartMs === schatten.entries[1].traceStartMs,
    `Referenz ${schatten.ref?.map((w) => `${hms(w.startMs)}–${hms(w.endMs)}`).join(', ')} (${f(gapS, 1)} s Schatten), ` +
      `Scan ${schatten.entries.map((e) => `${hms(e.startMs)}–${hms(e.endMs)}`).join(', ')}, ` +
      `Spurbeginn ${schatten.entries.map((e) => hms(e.traceStartMs)).join(' / ')}`,
  );

  // MEO: bei T0 schon sichtbar. Beginn wie die Referenz – rückwärts gefunden
  // oder, wenn das Fenster länger als 20 min vor T0 läuft, offen bei T0 –,
  // das Ende in jedem Fall offen 20 min nach T0, die Spur ab T0.
  const meo = resultOf(MEO).entries[0];
  const meoRef = resultOf(MEO).ref?.[0];
  const meoStartOk =
    meo !== undefined && meoRef !== undefined && meo.startOpen === meoRef.startOpen &&
    (meo.startOpen ? meo.startMs === T0 : Math.abs(meo.startMs - meoRef.startMs) <= EDGE_TOL_MS && meo.startMs < T0);
  expect(
    'A MEO: läuft bei T0, Beginn wie die Referenz, offenes Ende 20 min nach T0',
    meoStartOk && meo.endOpen && meo.endMs === T0 + FORECAST_MAX_VISIBLE_MS && meo.traceStartMs === T0,
    meo
      ? `Beginn ${rel(meo.startMs, T0)} (offen ${meo.startOpen}, Referenz ${meoRef ? `${rel(meoRef.startMs, T0)}, offen ${meoRef.startOpen}` : '–'}), ` +
          `Ende ${rel(meo.endMs, T0)} (offen ${meo.endOpen}), ` +
          `Spur ab ${rel(meo.traceStartMs, T0)}, ${meo.points.length / 3} Punkte im Abstand ${meo.stepMs / 1000} s`
      : 'kein Eintrag',
  );
  const iss = resultOf(ISS);
  expect(
    'A ISS: ein Fenster, Spur ab dem Aufgang',
    iss.ref?.length === 1 && iss.entries.length === 1 && iss.entries[0].traceStartMs > T0 && !iss.entries[0].startOpen,
    iss.entries[0]
      ? `${hms(iss.entries[0].startMs)}–${hms(iss.entries[0].endMs)} UTC, Aufgang ${hms(iss.entries[0].traceStartMs)}, ` +
          `${f(iss.entries[0].peakMagnitude, 1)} mag, max ${f(iss.entries[0].maxElevationDeg, 0)}°, aus ` +
          `${compassLabel(iss.entries[0].startAzimuthDeg)}`
      : 'kein Eintrag',
  );

  // Richtung zum Sichtbeginn, Höchststand und Spitzenhelligkeit – die
  // Unterzeile „aus NW · max 54°“ und die Rangfolge der Verbünde – gegen die
  // Referenz, nicht gegen sich selbst (`describedAgainstReference`).
  const describedWrong: string[] = [];
  let described = 0;
  for (const { obj, entries, ref } of scanned) {
    if (ref === null) continue;
    for (const e of entries) {
      if (!ref.some((w) => overlaps(e, w))) continue;
      described += 1;
      const problems = describedAgainstReference(obj, e);
      if (problems.length) describedWrong.push(`${obj.name} ${hms(e.startMs)}: ${problems.join(', ')}`);
    }
  }
  expect(
    'A Richtung zum Sichtbeginn, Höchststand und Spitzenhelligkeit wie die Referenz',
    described >= 8 && describedWrong.length === 0,
    `${described} Einträge mit Referenzfenster` +
      `${describedWrong.length ? `; FALSCH: ${describedWrong.slice(0, 6).join('; ')}` : '; Richtung ≤ 0,5°, Höchststand und Helligkeit im Rahmen'}`,
  );

  // Neuscan mitten im Überflug (Controller bei ×1 alle ≈ 90 s): Das Fenster
  // läuft bei fromMs schon und behält seinen echten Beginn, seine Richtung
  // und seinen Höchststand – sonst spränge die Unterzeile „aus … · max …“
  // während der Sichtbarkeit, und laufende Einträge sortierten sich nach
  // NORAD-ID. fromMs nach dem höchsten Punkt, damit der Rest des Fensters
  // einen kleineren Höchststand hätte.
  {
    const first = iss.entries[0];
    const ref = iss.ref?.[0];
    let topMs = first?.startMs ?? NaN;
    let topEl = -Infinity;
    for (let t = first?.startMs ?? 0; first && t <= first.endMs; t += 1000) {
      const el = refSample(ISS.satrec, ISS.std, t)?.elevation ?? -Infinity;
      if (el > topEl) {
        topEl = el;
        topMs = t;
      }
    }
    const rescanFrom = first ? Math.round(topMs + (first.endMs - topMs) / 2) : NaN;
    const rescanCtx = createScanContext(OBSERVER_GD, OBSERVER_FRAME, rescanFrom, rescanFrom + 10 * MINUTE);
    const raw: RawWindow[] = [];
    scanWindows(rescanCtx, ISS.satrec, ISS.std, raw);
    const again = raw[0] ? describeWindow(rescanCtx, ISS.satrec, ISS.std, ISS.id, raw[0]) : null;
    const problems = again ? describedAgainstReference(ISS, again) : ['kein Eintrag'];
    expect(
      'A Neuscan im laufenden Fenster: echter Beginn, Richtung und Höchststand des ganzen Fensters',
      first !== undefined && ref !== undefined && raw[0]?.startOpen === true && again !== null && !again.startOpen &&
        Math.abs(again.startMs - ref.startMs) <= EDGE_TOL_MS && problems.length === 0 &&
        Math.abs(again.endMs - first.endMs) <= 2 * FORECAST_REFINE_MS && again.traceStartMs === rescanFrom,
      again && first
        ? `Neuscan ab ${hms(rescanFrom)} (${f((rescanFrom - topMs) / 1000, 0)} s nach dem höchsten Punkt): Beginn ` +
            `${hms(again.startMs)} (offen ${again.startOpen}, erster Scan ${hms(first.startMs)}, Referenz ${ref ? hms(ref.startMs) : '–'}), ` +
            `aus ${f(again.startAzimuthDeg, 1)}° (erster Scan ${f(first.startAzimuthDeg, 1)}°), max ${f(again.maxElevationDeg, 1)}° ` +
            `(erster Scan ${f(first.maxElevationDeg, 1)}°), Ende ${rel(again.endMs, first.endMs)} neben dem ersten, ` +
            `Spur ab ${rel(again.traceStartMs, rescanFrom)}${problems.length ? `; FALSCH: ${problems.join(', ')}` : ''}`
        : 'kein Eintrag',
    );
  }

  // Spurbeginn im eigenen Bogen: Ein Lang-Scan (bis 120 min bei ×60) beginnt
  // womöglich, während das Objekt im vorigen Überflug über dem Horizont
  // steht. Die Spur des späteren Fensters beginnt trotzdem bei dessen Aufgang,
  // und vor ihm zeigt der Kopf auf den Aufgangspunkt – nicht in den vorigen
  // Bogen, wo das Antippen die Kamera sonst hinlenkte.
  if (iss.entries[0]) {
    const first = iss.entries[0];
    const spanMs = 120 * MINUTE;
    let previousArcAt = NaN;
    for (let t = first.traceStartMs - 30 * MINUTE; t >= first.endMs - spanMs + MINUTE; t -= 30_000) {
      if ((refSample(ISS.satrec, 0, t)?.elevation ?? -1) * RAD > 1) {
        previousArcAt = t;
        break;
      }
    }
    const longCtx = Number.isFinite(previousArcAt)
      ? createScanContext(OBSERVER_GD, OBSERVER_FRAME, previousArcAt, previousArcAt + spanMs)
      : null;
    const raw: RawWindow[] = [];
    if (longCtx) scanWindows(longCtx, ISS.satrec, ISS.std, raw);
    const later = longCtx
      ? raw
          .map((w) => describeWindow(longCtx, ISS.satrec, ISS.std, ISS.id, w))
          .find((e): e is ForecastEntry => e !== null && Math.abs(e.startMs - first.startMs) <= EDGE_TOL_MS)
      : undefined;
    const rise = refRise(ISS.satrec, previousArcAt, first.startMs);
    const head: Vec3 = { x: 0, y: 0, z: 0 };
    if (later) forecastPointAt(later, previousArcAt, head);
    const headElevationDeg = Math.asin(Math.max(-1, Math.min(1, head.y))) * RAD;
    expect(
      'A Spurbeginn im eigenen Bogen, auch wenn das Objekt bei fromMs im vorigen über dem Horizont steht',
      later !== undefined && Number.isFinite(rise) && Math.abs(later.traceStartMs - rise) <= EDGE_TOL_MS &&
        Math.abs(headElevationDeg) <= 0.5,
      Number.isFinite(previousArcAt)
        ? `Scan ab ${hms(previousArcAt)} (ISS dort ${f((refSample(ISS.satrec, 0, previousArcAt)?.elevation ?? NaN) * RAD, 1)}° hoch), ` +
            `Fenster ab ${later ? hms(later.startMs) : '–'}: Spur ab ${later ? hms(later.traceStartMs) : '–'}, ` +
            `Referenz-Aufgang ${Number.isFinite(rise) ? hms(rise) : '–'}; Kopf bei fromMs ${f(headElevationDeg, 2)}° hoch`
        : 'Testbahn ohne vorigen Bogen im Bereich',
    );
  }

  // Rasterende: Der letzte Rasterpunkt liegt ≤ toMs, der nächste dahinter
  // > toMs – für jede Spanne, auch 0. Und ein Fenster, das erst im letzten
  // Rasterschritt beginnt, wird gefunden: Scan ab T0 bis genau zum ersten
  // sichtbaren Rasterpunkt von KNAPP und bis 2,5 s dahinter. Ohne das „+ 1“
  // in `createScanContext` fehlte dieser Punkt; der Worker meldete den Stand
  // trotzdem als vollständig bis toMs (`completeUntilMs`), und keine andere
  // Prüfung merkte es (Review 09.10.2026: kein Entwurfsobjekt hatte einen
  // Sichtübergang im letzten Rasterschritt von Abschnitt A).
  {
    const knappRaw = resultOf(KNAPP).raw[0];
    const knappFull = resultOf(KNAPP).entries[0];
    const firstVisibleMs = knappRaw ? T0 + knappRaw.startIndex * FORECAST_STEP_MS : NaN;
    const rows: string[] = [];
    let ok = knappRaw !== undefined && knappFull !== undefined && !knappRaw.startOpen;
    for (const spanMs of [0, 1, FORECAST_STEP_MS - 1, FORECAST_STEP_MS, FORECAST_STEP_MS + 1, 10 * MINUTE + 2500]) {
      const c = createScanContext(OBSERVER_GD, OBSERVER_FRAME, T0, T0 + spanMs);
      const lastMs = c.fromMs + (c.gridCount - 1) * FORECAST_STEP_MS;
      const good = c.gridCount >= 1 && lastMs <= c.toMs && lastMs + FORECAST_STEP_MS > c.toMs;
      ok &&= good;
      if (!good) rows.push(`Spanne ${spanMs} ms: ${c.gridCount} Punkte, letzter ${rel(lastMs, c.toMs)} neben toMs`);
    }
    // Ohne KNAPP-Fenster (Abschnitt A meldet es schon) gibt es kein Rasterende zu prüfen – kein NaN-Bereich.
    for (const toMs of Number.isFinite(firstVisibleMs) ? [firstVisibleMs, firstVisibleMs + FORECAST_STEP_MS / 2] : []) {
      const endCtx = createScanContext(OBSERVER_GD, OBSERVER_FRAME, T0, toMs);
      const raw: RawWindow[] = [];
      scanWindows(endCtx, KNAPP.satrec, KNAPP.std, raw);
      const hit = raw.find((w) => endCtx.fromMs + w.startIndex * FORECAST_STEP_MS === firstVisibleMs);
      const entry = hit ? describeWindow(endCtx, KNAPP.satrec, KNAPP.std, KNAPP.id, hit) : null;
      const good =
        hit !== undefined && hit.startIndex === endCtx.gridCount - 1 && hit.endIndex === -1 && entry !== null &&
        knappFull !== undefined && entry.startMs === knappFull.startMs && entry.endMs === knappFull.endMs;
      ok &&= good;
      rows.push(
        `Ende ${rel(toMs, firstVisibleMs)} hinter dem ersten sichtbaren Punkt: ` +
          (entry ? `${hms(entry.startMs)}–${hms(entry.endMs)} (Punkt ${hit?.startIndex} von ${endCtx.gridCount})` : 'nichts'),
      );
    }
    expect(
      'A Rasterende: letzter Punkt ≤ toMs < nächster, ein Fenster im letzten Rasterschritt wird gefunden',
      ok,
      `KNAPP im vollen Scan ${knappFull ? `${hms(knappFull.startMs)}–${hms(knappFull.endMs)}` : '–'}, erster sichtbarer ` +
        `Rasterpunkt ${Number.isFinite(firstVisibleMs) ? hms(firstVisibleMs) : '–'}; ${rows.join('; ')}`,
    );
  }

  // Rasterphase: Kurz- und Lang-Scans tasten dieselben absoluten Zeitpunkte
  // ab (`coverageFor`/`farCoverageFor` legen den Beginn aufs 5-s-Raster). Ein
  // Fenster unter 5 s ist deshalb in jedem Scan drin oder in keinem, gleich,
  // wann die Anfrage gestellt wird. KNAPPs Bahn mit einer Standardhelligkeit
  // für ein ≈ 2,5-s-Fenster; je zehn Kurz- und Lang-Scans, deren now um je
  // 0,5 s versetzt ist, decken alle Phasen eines Rasterschritts ab. Hing das
  // Raster am Beginn der Anfrage, traf nur ein Teil der Phasen das Fenster:
  // In der App erschien und verschwand es bei jedem Neuscan, und „Nächster:“
  // nannte es, während die Liste leer war (ENVISAT, Frankfurt 08.10.2026).
  {
    const W = 10 * MINUTE;
    const shortStd = stdForWindow(KNAPP.satrec, T0 + 11 * MINUTE, T0 + 19 * MINUTE, 2500).std;
    const peakMs = KNAPP_TUNE.peakMs;
    // Länge im Modell des Projekts (das Raster sieht dieses, nicht die Referenz), 50-ms-Takt.
    const probe = createScanContext(OBSERVER_GD, OBSERVER_FRAME, peakMs, peakMs);
    let firstMs = NaN;
    let lastMs = NaN;
    for (let t = peakMs - 30_000; t <= peakMs + 30_000; t += 50) {
      const tick = buildTickFrame(new Date(t), OBSERVER_GD);
      if (nakedEyeAt(KNAPP.satrec, shortStd, OBSERVER_FRAME, tick, probe.scratch) !== 1) continue;
      if (Number.isNaN(firstMs)) firstMs = t;
      lastMs = t;
    }
    const lengthMs = lastMs - firstMs + 50;
    const foundIn = (range: { fromMs: number; toMs: number }): string => {
      const c = createScanContext(OBSERVER_GD, OBSERVER_FRAME, range.fromMs, range.toMs);
      const raw: RawWindow[] = [];
      scanWindows(c, KNAPP.satrec, shortStd, raw);
      return raw.some((w) => Math.abs(c.fromMs + w.startIndex * FORECAST_STEP_MS - peakMs) <= MINUTE) ? '1' : '0';
    };
    let near = '';
    let far = '';
    for (let k = 0; k < 10; k += 1) {
      near += foundIn(coverageFor(peakMs - 5 * MINUTE + k * 500, W, 1));
      far += foundIn(farCoverageFor(peakMs - 15 * MINUTE + k * 500, W, 1));
    }
    const tenth = (ms: number) => `${hms(ms)},${Math.floor((ms % 1000) / 100)}`;
    expect(
      'A Rasterphase: ein Fenster unter 5 s ist in jedem Kurz- und Lang-Scan drin oder in keinem',
      lengthMs > 0 && lengthMs < FORECAST_STEP_MS && /^(0+|1+)$/.test(near + far),
      `Fenster ${Number.isFinite(lengthMs) ? `${tenth(firstMs)}–${tenth(lastMs)} UTC (${f(lengthMs / 1000, 2)} s)` : 'keins'}, ` +
        `std ${f(shortStd, 3)}; now um je 0,5 s versetzt – Kurz-Scans ${near}, Lang-Scans ${far} (1 = gefunden)`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* B: Konsistenz mit der Überflugliste, Spurbeginn, Spurpunkte          */
/* ------------------------------------------------------------------ */

if (runs('B')) {
  console.log('B. Ränder gegen predictPasses, Spurbeginn gegen den Aufgang, Spurpunkte gegen die Referenzrichtung');
  const withEntries = scanned.filter((r) => r.entries.length > 0 && r.obj !== MEO);
  let compared = 0;
  let worst = { ms: 0, name: '–' };
  const unseen: string[] = [];
  const disagree: string[] = [];
  for (const { obj, entries } of withEntries) {
    // Gleiche Modellseite wie der Scan (src/math/propagation.ts); Aufruf wie im Worker.
    const passes = predictPasses(satrecOf(obj.tle), OBSERVER_GD, {
      fromMs: T0 - 30 * MINUTE,
      searchHours: 1.5,
      stepSec: 30,
      minElevationDeg: 1,
      standardMagnitude: obj.std,
    });
    for (const pass of passes) {
      const inPass = entries.filter((e) => e.startMs >= pass.aos && e.startMs <= pass.los);
      const start = pass.nakedEyeStart;
      const end = pass.nakedEyeEnd;
      if (start === null || end === null) {
        // Fenster ab 5 s findet der Scan sicher – dann muss das Panel es auch
        // (Abtastung ≤ 5 s). Kürzere dürfen beiden fehlen.
        for (const e of inPass) {
          const line = `${obj.name} ${hms(e.startMs)} (${f(durationS(e), 1)} s)`;
          if (e.endMs - e.startMs >= FORECAST_STEP_MS) disagree.push(`${line}: predictPasses ohne Sichtfenster`);
          else unseen.push(line);
        }
        continue;
      }
      // Nur Sichtfenster, deren Beginn der Scan beschreiben kann.
      if (start <= T0 || start > T0 + SCAN_MS) continue;
      if (inPass.length === 0) {
        disagree.push(`${obj.name}: predictPasses ${hms(start)}–${hms(end)}, Scan nichts`);
        continue;
      }
      const first = inPass[0];
      const last = inPass[inPass.length - 1];
      for (const [label, a, b] of [
        ['Beginn', first.startMs, start],
        ...(last.endOpen ? [] : [['Ende', last.endMs, end] as const]),
      ] as const) {
        compared += 1;
        const d = Math.abs(a - b);
        if (d > worst.ms) worst = { ms: d, name: `${obj.name} ${label} ${hms(b)}` };
      }
    }
  }
  expect(
    'B Ränder = predictPasses().nakedEyeStart/End (≤ 1,25 s)',
    compared >= 6 && worst.ms <= EDGE_TOL_MS && disagree.length === 0,
    `${compared} Ränder verglichen, höchstens ${f(worst.ms / 1000, 2)} s auseinander (${worst.name})` +
      `${disagree.length ? `; ${disagree.join(', ')}` : ''}` +
      `${unseen.length ? `; unter 5 s, von predictPasses nicht gesehen (hingenommen): ${unseen.join(', ')}` : ''}`,
  );

  // Echter Fall: ARIANE 40 R/B, Frankfurt, 07.10.2026. Sichtbar nur 8,4 s
  // (19:59:40,6–19:59:49,1Z), vom Austritt aus dem Erdschatten bis zum
  // Verblassen über 4,0 mag. Der Scan findet das Fenster; die Überflugliste
  // tastete den Bogen im 15-s-Takt ab und sah es bei keinem Suchbeginn – das
  // Panel nannte „nur optisch“, während die Liste „in 9:40“ zeigte. Elemente
  // vom TLE-Spiegel (CelesTrak „visual“, abgerufen 07.10.2026),
  // Standardhelligkeit 2,6 wie die Gruppe „brightest“ im Worker.
  {
    const frankfurt = geoToObserverGd({ latitudeDeg: 50.11, longitudeDeg: 8.68, altitudeKm: 0.1 });
    const ariane = twoline2satrec(
      '1 20443U 90005H   26280.12753329  .00000116  00000+0  50192-4 0  9995',
      '2 20443  98.2833 334.1923 0008926 290.3713  69.6517 14.39969882923235',
    );
    const std = 2.6;
    const from = Date.UTC(2026, 9, 7, 19, 50, 0);
    const arianeCtx = createScanContext(frankfurt, buildObserverFrame(frankfurt), from, from + 20 * MINUTE);
    const raw: RawWindow[] = [];
    scanWindows(arianeCtx, ariane, std, raw);
    const windows = raw
      .map((w) => describeWindow(arianeCtx, ariane, std, '20443' as NoradId, w))
      .filter((e): e is ForecastEntry => e !== null);
    const short = windows.find((e) => e.endMs - e.startMs < 15_000);
    // Suchbeginn wie im Worker beim Antippen: die virtuelle Zeit, hier alle
    // 37 s zwischen 19:38 und 19:59Z.
    const runs: string[] = [];
    let seen = 0;
    let worstEdge = 0;
    for (let tap = Date.UTC(2026, 9, 7, 19, 38, 0); short && tap < short.startMs; tap += 37_000) {
      const pass = predictPasses(ariane, frankfurt, {
        fromMs: tap,
        searchHours: 48,
        stepSec: 30,
        minElevationDeg: 1,
        standardMagnitude: std,
      }).find((p) => p.aos <= short.startMs && short.endMs <= p.los);
      runs.push(pass?.nakedEye ? 'ja' : 'nein');
      if (pass?.nakedEye && pass.nakedEyeStart !== null && pass.nakedEyeEnd !== null) {
        seen += 1;
        worstEdge = Math.max(worstEdge, Math.abs(pass.nakedEyeStart - short.startMs), Math.abs(pass.nakedEyeEnd - short.endMs));
      }
    }
    expect(
      'B kurzes Fenster (ARIANE 40 R/B, 8,4 s): auch die Überflugliste sieht es, Ränder ≤ 1,25 s',
      short !== undefined && durationS(short) >= 5 && runs.length >= 20 && seen === runs.length && worstEdge <= EDGE_TOL_MS,
      short
        ? `Scan ${hms(short.startMs)}–${hms(short.endMs)} (${f(durationS(short), 1)} s, ${f(short.peakMagnitude, 2)} mag); ` +
            `predictPasses mit Sichtfenster bei ${seen} von ${runs.length} Suchbeginnen, Ränder höchstens ${f(worstEdge / 1000, 2)} s daneben`
        : `kein kurzes Fenster gefunden: ${windows.map((e) => `${hms(e.startMs)}–${hms(e.endMs)}`).join(', ') || '–'}`,
    );
  }

  let rises = 0;
  let worstRise = { ms: 0, name: '–' };
  const riseProblems: string[] = [];
  for (const { obj, entries } of scanned.filter((r) => r.entries.length > 0)) {
    for (const e of entries) {
      // Aufgang des Bogens, in dem das Fenster beginnt (bei einem schon
      // laufenden: in dem es bei T0 steht).
      const rise = refRise(obj.satrec, T0, Math.max(e.startMs, T0));
      if (e.traceStartMs === T0) {
        // Spur ab fromMs nur, wenn das Objekt von dort bis zum Sichtbeginn über dem Horizont steht.
        if (Number.isFinite(rise)) riseProblems.push(`${obj.name}: Spur ab T0, Aufgang aber erst ${hms(rise)}`);
        continue;
      }
      if (!Number.isFinite(rise)) {
        riseProblems.push(`${obj.name}: kein Referenz-Aufgang vor ${hms(e.startMs)}`);
        continue;
      }
      rises += 1;
      const d = Math.abs(e.traceStartMs - rise);
      if (d > worstRise.ms) worstRise = { ms: d, name: `${obj.name} ${hms(rise)}` };
    }
  }
  expect(
    'B traceStartMs = Referenz-Aufgang (≤ 1,25 s)',
    rises >= 4 && worstRise.ms <= EDGE_TOL_MS && riseProblems.length === 0,
    `${rises} Aufgänge, höchstens ${f(worstRise.ms / 1000, 2)} s daneben (${worstRise.name})` +
      `${riseProblems.length ? `; ${riseProblems.join(', ')}` : ''}`,
  );

  let points = 0;
  let worstAngle = { deg: 0, name: '–' };
  const out: Vec3 = { x: 0, y: 0, z: 0 };
  for (const { obj, entries } of scanned.filter((r) => r.entries.length > 0)) {
    for (const e of entries) {
      for (let k = 0; k < 20; k += 1) {
        const t = Math.round(e.traceStartMs + ((e.endMs - e.traceStartMs) * k) / 19);
        forecastPointAt(e, t, out);
        const s = refSample(obj.satrec, 0, t);
        if (!s) continue;
        points += 1;
        const off = angleDeg(out, direction(s.azimuth, s.elevation));
        if (off > worstAngle.deg) worstAngle = { deg: off, name: `${obj.name} ${hms(t)} (Schritt ${e.stepMs / 1000} s)` };
      }
    }
  }
  expect(
    'B forecastPointAt = Referenzrichtung (≤ 0,3°)',
    points >= 100 && worstAngle.deg <= 0.3,
    `${points} Zeitpunkte, je Eintrag 20 zwischen Spurbeginn und Sichtende, ` +
      `höchstens ${f(worstAngle.deg, 3)}° daneben (${worstAngle.name})`,
  );
}

/* ------------------------------------------------------------------ */
/* E: reine Funktionen                                                  */
/* ------------------------------------------------------------------ */

/**
 * Richtung eines Eintrags ohne Bahn: 45° Höhe, Azimut 47° · ID. Jede NORAD-ID
 * ruht woanders – zwei Einträge im selben Zenitpunkt flögen sonst „dieselbe
 * Spur“ und bildeten einen Verbund (`sameForecastTrack`). Zwei IDs derselben
 * Prüfung liegen so mindestens 11° auseinander (nachgerechnet 08.10.2026).
 */
function synthPoints(id: string): Float32Array {
  const d = direction(((Number(id) * 47) % 360) / RAD, 45 / RAD);
  return new Float32Array([d.x, d.y, d.z, d.x, d.y, d.z]);
}

/** Eintrag ohne Bahn – für die Funktionen, die nur Zeiten und IDs lesen. */
function synthEntry(id: string, startMs: number, endMs: number, extra: Partial<ForecastEntry> = {}): ForecastEntry {
  return {
    noradId: id as NoradId,
    traceStartMs: startMs,
    startMs,
    startOpen: false,
    endMs,
    endOpen: false,
    stepMs: FORECAST_STEP_MS,
    points: synthPoints(id),
    peakMagnitude: 2,
    maxElevationDeg: 45,
    startAzimuthDeg: 270,
    ...extra,
  };
}

function part(shardIndex: number, entries: ForecastEntry[], fromMs: number, toMs: number, completeUntilMs = toMs): ForecastPart {
  return {
    type: 'forecast',
    kind: 'near',
    requestId: 7,
    shardIndex,
    fromMs,
    toMs,
    entries,
    completeUntilMs,
    scanned: 0,
    samples: 0,
    durationMs: 0,
  };
}

/** Stand aus einer Abdeckung, wie der Controller ihn nach einer Antwort aller Shards hätte. */
function committedFor(
  range: { fromMs: number; toMs: number },
  entries: ForecastEntry[] = [],
  completeUntilMs = range.toMs,
): ForecastCommitted {
  return { requestId: 1, fromMs: range.fromMs, toMs: range.toMs, completeUntilMs, entries, complete: true };
}

/** Erster Zeitpunkt (ms-Raster), ab dem `test` gilt – Suche über [fromMs, toMs] in `stepMs`, dann genau. */
function firstTrue(test: (ms: number) => boolean, fromMs: number, toMs: number, stepMs: number): number {
  const sign = toMs >= fromMs ? 1 : -1;
  let previous = fromMs;
  for (let t = fromMs; sign > 0 ? t <= toMs : t >= toMs; t += sign * stepMs) {
    if (test(t)) {
      let lo = previous;
      let hi = t;
      while (Math.abs(hi - lo) > 1) {
        const mid = Math.round((lo + hi) / 2);
        if (test(mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    previous = t;
  }
  return NaN;
}

if (runs('E')) {
  console.log('E. Reine Funktionen');
  const now = T0;
  const W = 10 * MINUTE;

  // E1 Auswahl: Filter, je ID das früheste Fenster, Sortierung (startMs, noradId),
  // Deckel. Keine zwei Einträge auf derselben Spur – Verbünde prüft Abschnitt V.
  {
    const entries = [
      synthEntry('100', now + 300_000, now + 400_000),
      synthEntry('100', now + 60_000, now + 120_000),
      synthEntry('200', now - 30_000, now + 30_000),
      synthEntry('300', now - 60_000, now),
      synthEntry('400', now + W + 1, now + W + 60_000),
      synthEntry('50', now + 60_000, now + 90_000),
      synthEntry('7', now + W, now + W + 5_000),
    ];
    const picked = selectForecastGroups(entries, now, W).map((g) => `${g.leader.noradId}@${(g.leader.startMs - now) / 1000}`);
    const many = Array.from({ length: 14 }, (_, i) => synthEntry(String(900 + i), now + (14 - i) * 10_000, now + W));
    const capped = selectForecastGroups(many, now, W).map((g) => g.leader);
    const expected = ['200@-30', '50@60', '100@60', '7@600'];
    expect(
      'E selectForecastGroups: Filter, Dedupe je ID, Sortierung, Deckel 10',
      picked.join(',') === expected.join(',') && capped.length === FORECAST_MAX_SLOTS &&
        capped[0].noradId === '913' && capped[9].noradId === '904',
      `Auswahl ${picked.join(', ')} (erwartet ${expected.join(', ')}); 14 Kandidaten → ${capped.length}, ` +
        `erster ${capped[0]?.noradId}, letzter ${capped[capped.length - 1]?.noradId}`,
    );
  }

  // E2 Gültigkeit der Kurz-Abdeckung, auch hinter `completeUntilMs`.
  {
    const range = coverageFor(now, W, 1);
    const full = committedFor(range);
    const cut = range.fromMs + 5 * MINUTE;
    const ten = Array.from({ length: 10 }, (_, i) => synthEntry(String(500 + i), now + i * 10_000, now + 9 * MINUTE));
    const nineDistinct = [...ten.slice(0, 9), synthEntry('500', now + 4 * MINUTE, now + 6 * MINUTE)];
    const rows = [
      ['jetzt', isCoverageValid(full, now, W), true],
      ['11 s davor', isCoverageValid(full, now - 11_000, W), false],
      ['Fensterende 1 ms hinter toMs', isCoverageValid(full, range.toMs - W + 1, W), false],
      ['Fensterende genau toMs', isCoverageValid(full, range.toMs - W, W), true],
      ['null', isCoverageValid(null, now, W), false],
      ['gekürzt, 10 Objekte davor', isCoverageValid(committedFor(range, ten, cut), now, W), true],
      ['gekürzt, 10 Fenster von 9 Objekten', isCoverageValid(committedFor(range, nineDistinct, cut), now, W), false],
      ['gekürzt, keine Einträge', isCoverageValid(committedFor(range, [], cut), now, W), false],
    ] as const;
    const wrong = rows.filter(([, got, want]) => got !== want);
    expect(
      'E isCoverageValid',
      wrong.length === 0,
      rows.map(([label, got]) => `${label} ${got ? 'gilt' : 'ungültig'}`).join('; ') +
        `${wrong.length ? `; FALSCH: ${wrong.map(([label]) => label).join(', ')}` : ''}`,
    );
  }

  // E3 Neuscan: Takt aus Vorlauf und Marge. Vorwärts ×1 nach 92,5 s, ×60
  // nach 240 s virtuell (4 s Wanduhr), rückwärts ×−60 nach 155 s (2,6 s).
  // Die Rücklauf-Marge wächst nur mit Rückwärtslauf (src/state/forecastView.ts:
  // mit |scale| fragte ×60 nach jeder Antwort sofort neu).
  {
    const rows: string[] = [];
    let ok = true;
    for (const [scale, wantS] of [
      [1, 92.5],
      [60, 240],
      [-60, -155],
    ] as const) {
      const committed = committedFor(coverageFor(now, W, scale));
      const fresh = needsRescan(committed, now, W, scale);
      const at = firstTrue((t) => needsRescan(committed, t, W, scale), now, now + Math.sign(wantS) * 10 * MINUTE, 500);
      const gotS = (at - now) / 1000;
      const wallS = gotS / scale;
      ok &&= !fresh && Math.abs(gotS - wantS) <= 0.002;
      rows.push(
        `×${scale}: frisch ${fresh ? 'Neuscan' : 'kein Neuscan'}, ab ${f(gotS, 3)} s virtuell ` +
          `(${f(wallS, 2)} s Wanduhr, Soll ${f(wantS, 1)} s)`,
      );
    }
    const paused = committedFor(coverageFor(now, W, 0));
    const pauseOk = !needsRescan(paused, now, W, 0);
    const incomplete = { ...committedFor(coverageFor(now, W, 1)), complete: false };
    ok &&= pauseOk && needsRescan(null, now, W, 1) && needsRescan(incomplete, now, W, 1);
    expect(
      'E needsRescan: Takt ×1 ≈ 90 s, ×60 ≈ 240 s virtuell, ×−60 ≈ 2,6 s Wanduhr',
      ok,
      `${rows.join('; ')}; Pause ${pauseOk ? 'kein Neuscan' : 'Neuscan'}; null/Teilstand → Neuscan`,
    );
  }

  // E4 Zusammenführen: alle Einträge sortiert, completeUntilMs = Minimum.
  {
    const range = coverageFor(now, W, 1);
    const parts = [
      part(0, [synthEntry('30', now + 120_000, now + 180_000)], range.fromMs, range.toMs),
      part(
        1,
        [synthEntry('20', now + 60_000, now + 90_000), synthEntry('10', now + 120_000, now + 130_000)],
        range.fromMs,
        range.toMs,
        range.toMs - 60_000,
      ),
      part(2, [], range.fromMs, range.toMs, range.toMs - 30_000),
    ];
    const merged = mergeForecastParts(parts, 3, 7, range.fromMs, range.toMs);
    const partial = mergeForecastParts(parts.slice(0, 2), 3, 7, range.fromMs, range.toMs);
    expect(
      'E mergeForecastParts: Sortierung, completeUntilMs = Minimum, complete',
      merged.entries.map((e) => e.noradId).join(',') === '20,10,30' && merged.completeUntilMs === range.toMs - 60_000 &&
        merged.complete && !partial.complete && merged.requestId === 7 && merged.fromMs === range.fromMs,
      `Reihenfolge ${merged.entries.map((e) => e.noradId).join(', ')}, completeUntilMs ${rel(merged.completeUntilMs, range.toMs)} ` +
        `gegenüber toMs, vollständig ${merged.complete}, mit 2 von 3 Teilen ${partial.complete}`,
    );
  }

  // E5 Spur-Treffer: Bogen in 30° Höhe von Ost nach Süd, Kopf bei Punkt 12.
  {
    const arc = (elevationDeg: number) => {
      const points = new Float32Array(128 * 3);
      for (let i = 0; i < 128; i += 1) {
        const d = direction((90 + (90 * i) / 127) / RAD, elevationDeg / RAD);
        points.set([d.x, d.y, d.z], i * 3);
      }
      return points;
    };
    const slot = (id: string, entry: ForecastEntry): ForecastSlot => ({
      noradId: id as NoradId,
      name: id,
      highlight: false,
      entry,
      memberIds: [],
      groupText: '',
      visibleNow: false,
      countdownText: '',
      labelText: '',
      detailText: '',
    });
    const traceStart = now - 60_000;
    const a = slot('1', synthEntry('1', now + 120_000, now + 500_000, { traceStartMs: traceStart, points: arc(30) }));
    const b = slot('2', synthEntry('2', now + 120_000, now + 500_000, { traceStartMs: traceStart, points: arc(32) }));
    const pointOf = (i: number, elevationDeg: number) => direction((90 + (90 * i) / 127) / RAD, elevationDeg / RAD);
    const maxRad = 4 / RAD;
    const onA = pickForecastTrace(pointOf(50.5, 30), [a, b], now, maxRad);
    const nearB = pickForecastTrace(pointOf(80, 31.6), [a, b], now, maxRad);
    const above = pickForecastTrace(pointOf(50, 35), [a], now, maxRad);
    const behindHead = pickForecastTrace(pointOf(5, 30), [a], now, maxRad);
    expect(
      'E pickForecastTrace: richtiges Segment und richtige Spur, 5° daneben und hinter dem Kopf kein Treffer',
      onA?.noradId === '1' && onA.angleRad * RAD < 0.05 && nearB?.noradId === '2' && above === null && behindHead === null,
      `auf Spur 1 zwischen Punkt 50 und 51: ${onA ? `${onA.noradId}, ${f(onA.angleRad * RAD, 3)}°` : 'nichts'}; ` +
        `0,4° neben Spur 2: ${nearB?.noradId ?? 'nichts'}; 5° über Spur 1: ${above?.noradId ?? 'nichts'}; ` +
        `auf Punkt 5 (Kopf bei 12): ${behindHead?.noradId ?? 'nichts'}`,
    );
  }

  // E6 Lang-Scan: Bereich, Gültigkeit, Takt, Zusammenführen.
  {
    const H90 = FORECAST_FAR_HORIZON_MS;
    const rows: string[] = [];
    let ok = true;
    // Rückwärts nie vor `now`: Der Rücklauf (30 s + 10 s je Stufe) reichte bei
    // ×−60 sonst bei W 10 30 s, bei W 5 5,5 min in die Vergangenheit, und der
    // Lang-Scan beschrieb ein schon vergangenes Fenster (Spezifikation §5
    // ohne die Grenze).
    for (const [scale, windowMin, backS, leadS] of [
      [1, 10, 30, 620],
      [60, 10, 30, 1800],
      [-60, 10, 600, 600],
      [-60, 5, 300, 600],
      [-60, 20, 630, 600],
    ] as const) {
      const w = windowMin * MINUTE;
      const c = farCoverageFor(now, w, scale);
      const good = c.fromMs === now + w - backS * 1000 && c.toMs === now + H90 + leadS * 1000 && c.fromMs >= now;
      ok &&= good;
      rows.push(`×${scale} W ${windowMin}: ${rel(c.fromMs, now + w)} vor now+W, ${rel(c.toMs, now + H90)} hinter now+90 min`);
    }
    expect('E farCoverageFor ×1/×60/×−60, rückwärts nie vor now', ok, rows.join('; '));

    // Beginn beider Bereiche auf dem absoluten 5-s-Raster, auch für ein now
    // zwischen zwei Rasterpunkten (oben liegt now = T0 auf dem Raster). Der
    // Kurz-Rücklauf ist mindestens der verlangte und < 5 s länger; der
    // Lang-Bereich beginnt nie vor now, nie hinter now + W und höchstens 5 s
    // nach dem verlangten Beginn. Hing das Raster am Beginn der Anfrage,
    // flackerten Fenster unter 5 s (Abschnitt A, Rasterphase).
    {
      const offGrid: string[] = [];
      let cases = 0;
      for (let i = 0; i < 40; i += 1) {
        const at = now + 1234.5 + i * 777.7;
        for (const scale of [1, 60, -60, 0]) {
          for (const windowMin of [5, 10, 20]) {
            cases += 1;
            const w = windowMin * MINUTE;
            const nearBack = 10_000 + Math.max(0, -scale) * 4000;
            const c = coverageFor(at, w, scale);
            const nearOk =
              c.fromMs % FORECAST_STEP_MS === 0 && c.fromMs <= at - nearBack && c.fromMs > at - nearBack - FORECAST_STEP_MS;
            const farFrom = Math.max(at, at + w - (30_000 + Math.max(0, -scale) * 10_000));
            const fc = farCoverageFor(at, w, scale);
            const farOk =
              fc.fromMs % FORECAST_STEP_MS === 0 && fc.fromMs >= at && fc.fromMs <= at + w &&
              fc.fromMs > farFrom - FORECAST_STEP_MS && fc.fromMs < farFrom + FORECAST_STEP_MS;
            if (!nearOk || !farOk) {
              offGrid.push(
                `now ${rel(at, now)} ×${scale} W ${windowMin}: Kurz ab ${rel(c.fromMs, at)}, Lang ab ${rel(fc.fromMs, at)}`,
              );
            }
          }
        }
      }
      expect(
        'E coverageFor/farCoverageFor: Beginn auf dem absoluten 5-s-Raster',
        offGrid.length === 0,
        `${cases} Fälle mit now zwischen zwei Rasterpunkten, ${offGrid.length} daneben` +
          `${offGrid.length ? `: ${offGrid.slice(0, 4).join('; ')}` : ''}`,
      );
    }

    const range = farCoverageFor(now, W, 1);
    const candidate = synthEntry('25544', now + 47 * MINUTE, now + 52 * MINUTE);
    const withEntry: ForecastFarCommitted = { requestId: 3, ...range, entry: candidate, complete: true };
    const without: ForecastFarCommitted = { requestId: 3, ...range, entry: null, complete: true };
    const validRows = [
      ['Kandidat jetzt', isFarValid(withEntry, now, W), true],
      ['Kandidat 1 ms vor Sichtbeginn', isFarValid(withEntry, candidate.startMs - 1, W), true],
      ['Kandidat bei Sichtbeginn', isFarValid(withEntry, candidate.startMs, W), false],
      ['keiner, Bereich deckt 90 min', isFarValid(without, range.toMs - H90, W), true],
      ['keiner, 1 ms zu kurz', isFarValid(without, range.toMs - H90 + 1, W), false],
      ['Beginn genau now+W', isFarValid(without, range.fromMs - W, W), true],
      ['Beginn hinter now+W (rückwärts)', isFarValid(without, range.fromMs - W - 1, W), false],
      ['null', isFarValid(null, now, W), false],
    ] as const;
    const wrongValid = validRows.filter(([, got, want]) => got !== want);
    expect(
      'E isFarValid: Kandidat bis zu seinem Sichtbeginn, „keiner“ nur mit vollen 90 min',
      wrongValid.length === 0,
      validRows.map(([label, got]) => `${label} ${got ? 'gilt' : 'ungültig'}`).join('; ') +
        `${wrongValid.length ? `; FALSCH: ${wrongValid.map(([label]) => label).join(', ')}` : ''}`,
    );

    const rescanRows: string[] = [];
    let rescanOk = true;
    for (const [scale, wantS] of [
      [1, 558],
      [60, 1620],
      [-60, -475],
    ] as const) {
      const far: ForecastFarCommitted = { requestId: 3, ...farCoverageFor(now, W, scale), entry: null, complete: true };
      const fresh = needsFarRescan(far, now, W, scale);
      const at = firstTrue((t) => needsFarRescan(far, t, W, scale), now, now + Math.sign(wantS) * HOUR, 1000);
      const gotS = (at - now) / 1000;
      rescanOk &&= !fresh && Math.abs(gotS - wantS) <= 0.002;
      rescanRows.push(`×${scale} ohne Kandidat ab ${f(gotS, 3)} s virtuell (${f(gotS / scale, 1)} s Wanduhr, Soll ${f(wantS, 0)} s)`);
    }
    const withCandidate = needsFarRescan(withEntry, now + 30 * MINUTE, W, 1);
    rescanOk &&= !withCandidate && needsFarRescan(null, now, W, 1) && needsFarRescan({ ...withEntry, complete: false }, now, W, 1);
    expect(
      'E needsFarRescan: ohne Kandidat ×1 ≈ 9 min, ×60 ≈ 27 s Wanduhr, ×−60 ≈ 7,9 s; mit Kandidat nicht',
      rescanOk,
      `${rescanRows.join('; ')}; mit Kandidat nach 30 min ${withCandidate ? 'Neuscan' : 'kein Neuscan'}`,
    );

    const farPart = (shard: number, entries: ForecastEntry[]) => ({
      ...part(shard, entries, range.fromMs, range.toMs),
      kind: 'far' as const,
    });
    const merged = mergeFarParts(
      [farPart(0, [synthEntry('300', now + 50 * MINUTE, now + 51 * MINUTE)]), farPart(1, []), farPart(2, [candidate])],
      3,
      9,
      range.fromMs,
      range.toMs,
    );
    const tie = mergeFarParts(
      [
        farPart(0, [synthEntry('1200', now + 20 * MINUTE, now + 21 * MINUTE)]),
        farPart(1, [synthEntry('999', now + 20 * MINUTE, now + 22 * MINUTE)]),
      ],
      3,
      9,
      range.fromMs,
      range.toMs,
    );
    const empty = mergeFarParts([farPart(0, []), farPart(1, []), farPart(2, [])], 3, 9, range.fromMs, range.toMs);
    expect(
      'E mergeFarParts: frühester über alle Shards, null ohne Kandidat, complete',
      merged.entry?.noradId === '25544' && merged.complete && tie.entry?.noradId === '999' && !tie.complete &&
        empty.entry === null && empty.complete && merged.requestId === 9,
      `frühester ${merged.entry?.noradId} (vollständig ${merged.complete}), Gleichstand → ${tie.entry?.noradId} ` +
        `(2 von 3: vollständig ${tie.complete}), ohne Einträge ${empty.entry === null ? 'null' : empty.entry.noradId}`,
    );
  }

  // E7 Ausblick-Zeile ohne Sekunden, aufgerundet: Hinter now + W steht nie
  // „in W min“ (darüber sagt der Zustandstext „Keine in den nächsten W min“).
  {
    const cases = [
      [47 * MINUTE, 'in 47 min'],
      [46 * MINUTE + 1000, 'in 47 min'],
      [72 * MINUTE, 'in 1 h 12 min'],
      [120 * MINUTE, 'in 2 h'],
      [20_000, 'in 1 min'],
      [59.6 * MINUTE, 'in 1 h'],
      [90 * MINUTE + 29_000, 'in 1 h 31 min'],
      [10 * MINUTE, 'in 10 min'],
      [10 * MINUTE + 20_000, 'in 11 min'],
    ] as const;
    const got = cases.map(([offset]) => formatForecastNext(now + offset, now));
    expect(
      'E formatForecastNext',
      cases.every(([, want], i) => got[i] === want),
      cases.map(([offset, want], i) => `${f(offset / MINUTE, 2)} min → „${got[i]}“${got[i] === want ? '' : ` (Soll „${want}“)`}`).join(', '),
    );
  }

  // E8 Ableitung: Zustandstexte, Ausblick nur bei leerer Liste, Zähler.
  {
    const target: ForecastView = {
      status: 'off',
      statusText: '',
      windowMs: W,
      nowMs: 0,
      scale: 1,
      slots: [],
      farStatus: 'idle',
      nextText: '',
      next: null,
      membershipVersion: 0,
      version: 0,
    };
    const lookup = (id: NoradId) => (id === '25544' ? { name: 'ISS (ZARYA)', highlight: true } : null);
    const range = coverageFor(now, W, 1);
    const candidate = synthEntry('25544', now + 47 * MINUTE, now + 52 * MINUTE, { startAzimuthDeg: 300 });
    const far: ForecastFarCommitted = { requestId: 3, ...farCoverageFor(now, W, 1), entry: candidate, complete: true };
    const texts: string[] = [];
    deriveForecastView('paused', null, 'idle', null, now, W, -600, lookup, target);
    texts.push(target.statusText);
    deriveForecastView('noObserver', null, 'idle', null, now, W, 1, lookup, target);
    texts.push(target.statusText);
    deriveForecastView('pending', null, 'idle', null, now, W, 1, lookup, target);
    texts.push(target.statusText);
    deriveForecastView('ready', committedFor(range), 'pending', null, now, W, 1, lookup, target);
    texts.push(`${target.statusText} / ${target.nextText}`);
    deriveForecastView('ready', committedFor(range), 'ready', { ...far, entry: null }, now, W, 1, lookup, target);
    texts.push(target.nextText);
    deriveForecastView('ready', committedFor(range), 'ready', far, now, W, 1, lookup, target);
    const membership = target.membershipVersion;
    const version = target.version;
    const next = target.next;
    deriveForecastView('ready', committedFor(range), 'ready', far, now + 61_000, W, 1, lookup, target);
    const minuteOnly = target.membershipVersion === membership && target.version === version + 1;
    const withSlot = committedFor(range, [synthEntry('62001', now + 60_000, now + 90_000)]);
    deriveForecastView('ready', withSlot, 'ready', far, now, W, 1, lookup, target);
    const hiddenWithSlot =
      target.next === null && target.nextText === '' && target.slots.length === 1 && target.slots[0].name === 'NORAD 62001';
    expect(
      'E deriveForecastView: Zustandstexte, Ausblick nur bei leerer Liste, Zähler',
      texts.join(' | ') ===
        'Vorhersage ruht bei ×600 | Warte auf Standort | Berechne … | ' +
          'Keine in den nächsten 10 min / Suche bis 90 min … | Auch bis 90 min keiner' &&
        next?.text === 'Nächster: ISS (ZARYA)' && next.detailText === 'in 47 min · aus WNW' && minuteOnly && hiddenWithSlot,
      `${texts.join(' | ')}; Kandidat „${next?.text}“ / „${next?.detailText}“; eine Minute später ` +
        `${minuteOnly ? 'nur version' : 'auch membershipVersion'} erhöht; mit Eintrag Ausblick ${hiddenWithSlot ? 'leer' : 'noch da'}`,
    );

    // Kandidat 20 s hinter dem Fenster: Die Liste ist noch leer, die
    // Ausblick-Zeile darf nicht „in 10 min“ sagen.
    const justBehind = synthEntry('25544', now + W + 20_000, now + W + 5 * MINUTE, { startAzimuthDeg: 300 });
    deriveForecastView(
      'ready',
      committedFor(range, [justBehind]),
      'ready',
      { ...far, entry: justBehind },
      now,
      W,
      1,
      lookup,
      target,
    );
    expect(
      'E Kandidat knapp hinter dem Fenster: „Keine in den nächsten 10 min“ und „in 11 min“',
      target.slots.length === 0 && target.statusText === 'Keine in den nächsten 10 min' &&
        target.next?.detailText === 'in 11 min · aus WNW',
      `„${target.statusText}“ / „${target.next?.text ?? '–'}“ / „${target.next?.detailText ?? '–'}“`,
    );
  }

  // E9 Countdown-Texte gegen feste Paare – unabhängig von der Ableitung, die
  // dieselben Funktionen nutzt (Abschnitt D und G vergleichen dagegen nur ±1 s).
  {
    const cases: Array<[string, string, string]> = [
      ['in 3:20 genau', formatForecastCountdown(now + 200_000, now), 'in 3:20'],
      ['0,999 s weniger', formatForecastCountdown(now + 199_001, now), 'in 3:20'],
      ['1 ms mehr', formatForecastCountdown(now + 200_001, now), 'in 3:21'],
      ['1 ms vorher', formatForecastCountdown(now + 1, now), 'in 0:01'],
      ['erreicht', formatForecastCountdown(now, now), 'jetzt'],
      ['vorbei', formatForecastCountdown(now - 5000, now), 'jetzt'],
      ['über eine Stunde', formatForecastCountdown(now + 3_725_000, now), 'in 62:05'],
      ['noch 4:10', formatForecastRemaining(now + 250_000, now, false), 'noch 4:10'],
      ['noch, 0,5 s weniger', formatForecastRemaining(now + 249_500, now, false), 'noch 4:10'],
      ['noch, 1 ms mehr', formatForecastRemaining(now + 250_001, now, false), 'noch 4:11'],
      ['Ende vorbei', formatForecastRemaining(now - 1000, now, false), 'noch 0:00'],
      ['Ende offen', formatForecastRemaining(now + 250_000, now, true), 'sichtbar'],
    ];
    const wrong = cases.filter(([, got, want]) => got !== want);
    expect(
      'E formatForecastCountdown/-Remaining: Sekunden aufgerundet, „jetzt“, „sichtbar“',
      wrong.length === 0,
      cases.map(([label, got]) => `${label} „${got}“`).join(', ') +
        `${wrong.length ? `; FALSCH: ${wrong.map(([label, got, want]) => `${label} „${got}“ statt „${want}“`).join(', ')}` : ''}`,
    );
  }

  // E10 Label eines Highlight-Objekts: Vor dem Aufgang steht noch kein
  // Namenslabel (HighlightMarkers blendet es darunter aus) – dann mit Namen,
  // ab dem Aufgang ohne.
  {
    const lookup = (id: NoradId) => (id === '25544' ? { name: 'ISS (ZARYA)', highlight: true } : null);
    const issEntry = synthEntry('25544', now + 3 * MINUTE, now + 8 * MINUTE, { traceStartMs: now + 2 * MINUTE });
    const target: ForecastView = {
      status: 'off',
      statusText: '',
      windowMs: W,
      nowMs: 0,
      scale: 1,
      slots: [],
      farStatus: 'idle',
      nextText: '',
      next: null,
      membershipVersion: 0,
      version: 0,
    };
    const range = coverageFor(now, W, 1);
    const labelAt = (t: number) => {
      deriveForecastView('ready', committedFor(range, [issEntry]), 'idle', null, t, W, 1, lookup, target);
      return target.slots[0]?.labelText ?? '–';
    };
    const before = labelAt(now);
    const atRise = labelAt(now + 2 * MINUTE);
    expect(
      'E Highlight-Label: vor dem Aufgang mit Namen, ab dem Aufgang ohne',
      before === 'ISS (ZARYA) · in 3:00' && atRise === 'in 1:00',
      `3 min vor dem Sichtbeginn (vor dem Aufgang) „${before}“, beim Aufgang „${atRise}“`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Umgebung ohne Browser: Mini-DOM, Fenster, Canvas                     */
/* ------------------------------------------------------------------ */

/*
 * Ein DOM, so klein wie react-dom/client es braucht (Rezept:
 * ~/Git/agent/docs/r3f-in-node-ohne-webgl.md, „DOM-Komponenten mit Effekten
 * und Klicks“): Knoten mit Kindern und Geschwistern, Text mit `nodeValue`,
 * Elemente mit Attributen, `style` und Listenern, ein Dokument mit
 * `activeElement` und `defaultView`. Dazu Canvas-Elemente, deren 2D-Kontext
 * jeden Aufruf schluckt und `fillText` mitschreibt – für die Labels von
 * VisibilityForecast (createReusableLabel).
 */

class MiniNode {
  parentNode: MiniNode | null = null;
  readonly childNodes: MiniNode[] = [];
  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    readonly ownerDocument: MiniDocument | null,
  ) {}
  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): MiniNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): MiniNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings ? (siblings[siblings.indexOf(this) + 1] ?? null) : null;
  }
  get previousSibling(): MiniNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings ? (siblings[siblings.indexOf(this) - 1] ?? null) : null;
  }
  get parentElement(): MiniNode | null {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null;
  }
  appendChild<T extends MiniNode>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore<T extends MiniNode>(child: T, before: MiniNode | null): T {
    if (before === null) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild<T extends MiniNode>(child: T): T {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  contains(node: MiniNode | null): boolean {
    for (let n = node; n !== null; n = n.parentNode) if (n === this) return true;
    return false;
  }
  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    if (value !== '' && value !== null && value !== undefined) {
      this.appendChild(new MiniText(String(value), this.ownerDocument));
    }
  }
}

class MiniText extends MiniNode {
  constructor(
    public nodeValue: string,
    doc: MiniDocument | null,
  ) {
    super(3, '#text', doc);
  }
  get data(): string {
    return this.nodeValue;
  }
  set data(value: string) {
    this.nodeValue = value;
  }
  get textContent(): string {
    return this.nodeValue;
  }
  set textContent(value: string) {
    this.nodeValue = String(value);
  }
}

type Listener = { type: string; fn: (event: unknown) => void; capture: boolean };
const captureOf = (options: unknown) =>
  typeof options === 'boolean' ? options : Boolean((options as { capture?: boolean } | undefined)?.capture);

class MiniElement extends MiniNode {
  readonly attributes = new Map<string, string>();
  readonly listeners: Listener[] = [];
  readonly style: Record<string, string | ((...args: string[]) => void)> = {
    setProperty: (name: string, value: string) => {
      this.style[name] = value;
    },
    removeProperty: (name: string) => {
      delete this.style[name];
    },
  };
  readonly tagName: string;
  constructor(
    readonly localName: string,
    doc: MiniDocument,
    readonly namespaceURI: string,
  ) {
    super(1, localName.toUpperCase(), doc);
    this.tagName = this.nodeName;
  }
  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  addEventListener(type: string, fn: (event: unknown) => void, options?: unknown): void {
    this.listeners.push({ type, fn, capture: captureOf(options) });
  }
  removeEventListener(type: string, fn: (event: unknown) => void, options?: unknown): void {
    const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === captureOf(options));
    if (i >= 0) this.listeners.splice(i, 1);
  }
  /** Alle Nachfahren, die `test` erfüllen, in Dokumentreihenfolge. */
  findAll(test: (el: MiniElement) => boolean): MiniElement[] {
    const found: MiniElement[] = [];
    const walk = (node: MiniNode) => {
      for (const child of node.childNodes) {
        if (child instanceof MiniElement) {
          if (test(child)) found.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return found;
  }
}

/** Texte, die in eine Canvas geschrieben wurden (Labels), je Canvas in Reihenfolge. */
const canvasTexts = new Map<MiniCanvas, string[]>();

class MiniCanvas extends MiniElement {
  width = 300;
  height = 150;
  private readonly context: unknown;
  constructor(doc: MiniDocument) {
    super('canvas', doc, 'http://www.w3.org/1999/xhtml');
    const gradient = { addColorStop() {} };
    this.context = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === 'canvas') return this;
          if (property === 'createRadialGradient' || property === 'createLinearGradient') return () => gradient;
          // 0,6 em je Zeichen bei 44 px Monospace – die Schrift der Labels.
          if (property === 'measureText') return (text: string) => ({ width: String(text).length * 26.4 });
          if (property === 'fillText') {
            return (text: string) => {
              if (!canvasTexts.has(this)) canvasTexts.set(this, []);
              canvasTexts.get(this)?.push(text);
            };
          }
          if (property === 'then') return undefined;
          return () => {};
        },
        set: () => true,
      },
    );
  }
  getContext(): unknown {
    return this.context;
  }
}

class MiniDocument extends MiniNode {
  readonly documentElement: MiniElement;
  readonly body: MiniElement;
  activeElement: MiniElement;
  defaultView: unknown = null;
  readonly listeners: Listener[] = [];
  constructor() {
    super(9, '#document', null);
    this.documentElement = new MiniElement('html', this, 'http://www.w3.org/1999/xhtml');
    this.body = new MiniElement('body', this, 'http://www.w3.org/1999/xhtml');
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string): MiniElement {
    return tag === 'canvas' ? new MiniCanvas(this) : new MiniElement(tag, this, 'http://www.w3.org/1999/xhtml');
  }
  createElementNS(namespace: string, tag: string): MiniElement {
    return new MiniElement(tag, this, namespace);
  }
  createTextNode(text: string): MiniText {
    return new MiniText(text, this);
  }
  addEventListener(type: string, fn: (event: unknown) => void, options?: unknown): void {
    this.listeners.push({ type, fn, capture: captureOf(options) });
  }
  removeEventListener(): void {}
}

const miniDocument = new MiniDocument();
const miniWindow = {
  document: miniDocument,
  // React liest `window.event` für die Priorität eines Updates.
  event: undefined,
  // getActiveElementDeep in react-dom prüft das aktive Element per instanceof.
  HTMLIFrameElement: class {},
  devicePixelRatio: 1,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {},
  removeEventListener() {},
};
miniDocument.defaultView = miniWindow;

/**
 * Klick wie im Browser: react-dom hört am Wurzelcontainer, erst in der
 * Einfang-, dann in der Bubble-Phase, und findet das Ziel über seine internen
 * Schlüssel am Knoten.
 */
function click(container: MiniElement, target: MiniElement): void {
  const event = {
    type: 'click',
    target,
    bubbles: true,
    cancelable: true,
    button: 0,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
  };
  for (const capture of [true, false]) {
    for (const listener of container.listeners.filter((l) => l.type === 'click' && l.capture === capture)) {
      listener.fn(event);
    }
  }
}

// Erst nach den Imports: React, R3F und three lesen ihre Umgebung beim Laden.
for (const [name, value] of [
  ['window', miniWindow],
  ['document', miniDocument],
] as const) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

// drei <Line> meldet beim Einhängen einen NaN-Radius, weil das esbuild-Bündel
// three zweimal enthält – harmlos, siehe scripts/verify-selection.ts.
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (first.startsWith('THREE.LineSegmentsGeometry.computeBoundingSphere')) return;
  if (first.includes('inside a test was not wrapped in act(')) return;
  consoleError(...args);
};

// Sonst erledigt das <Canvas>: <sprite>, <spriteMaterial> als R3F-Elemente.
extend(THREE as never);

type RootStore = UseBoundStore<StoreApi<RootState>>;

/** Hängt eine Komponente in eine eigene R3F-Wurzel; `onRender` läuft bei jedem `gl.render`. */
async function mountScene(component: () => ReactElement | null, onRender: (store: RootStore) => void = () => {}) {
  const root = createRoot({} as HTMLCanvasElement);
  let store: RootStore | null = null;
  const gl = {
    domElement: { style: {}, addEventListener() {}, removeEventListener() {} },
    render: () => {
      if (store) onRender(store);
    },
    setSize() {},
    setPixelRatio() {},
  };
  await act(async () => {
    await root.configure({
      gl: gl as never,
      camera: new PerspectiveCamera(70, 0.5, 0.01, 2000) as never,
      size: { width: 400, height: 800, top: 0, left: 0 },
      frameloop: 'never',
      dpr: 1,
    });
    store = root.render(createElement(component)) as unknown as RootStore;
  });
  const mounted = store as unknown as RootStore;
  let timeS = 0;
  return {
    store: mounted,
    frame(): void {
      timeS += 1 / 60;
      advance(timeS, true, mounted.getState());
    },
    unmount: () => act(async () => root.unmount()),
  };
}

function findAll(store: RootStore, test: (object: Object3D) => boolean): Object3D[] {
  const found: Object3D[] = [];
  store.getState().scene.traverse((object) => {
    if (test(object)) found.push(object);
  });
  return found;
}

/* ------------------------------------------------------------------ */
/* F: VisibilityForecast – was gl.render sähe                           */
/* ------------------------------------------------------------------ */

if (runs('F')) {
  console.log('F. VisibilityForecast im echten Reconciler: Linien und Labels beim Zeichnen');
  // Anlass wie scripts/verify-wiring.ts Abschnitt C: drei <Line> reicht ein
  // `visible`-Prop auch an das LineMaterial weiter; eine Prüfung nur von
  // `line.visible` sähe das nicht. Gelesen wird deshalb bei jedem `gl.render`:
  // Objekt UND Material sichtbar, Segmente vorhanden, kein Platzhalter im
  // Nadir. Zwei bevorstehende Einträge aus Abschnitt A – ISS und das erste
  // Fenster von SCHATTEN – ergeben je eine gestrichelte und eine kräftige Linie.
  const slotsEntries = [resultOf(ISS).entries[0], resultOf(SCHATTEN).entries[0]];
  const lookup = (id: NoradId) =>
    id === ISS.id ? { name: ISS.name, highlight: true } : id === SCHATTEN.id ? { name: SCHATTEN.name, highlight: false } : null;
  const W = 10 * MINUTE;
  await act(async () => {
    useAppStore.setState((s) => ({ filters: { ...s.filters, mode: 'nakedEye' }, showTrails: true }));
    // Ohne Pool setzt das nur die Zeitbasis im Store; die Szene liest virtualNow().
    engine.jumpTo(T0);
    engine.setTimeScale(0);
  });

  interface Drawn {
    lines: number;
    drawnLines: number;
    dim: number;
    bright: number;
    emptyDrawn: number;
    nadir: number;
    sprites: number;
  }
  let renders: Drawn[] = [];
  const nadirY = -0.5 * SKY_RADIUS;
  const scene = await mountScene(
    () => createElement(VisibilityForecast),
    (store) => {
      const lines = findAll(store, (o) => (o as { isLine2?: boolean }).isLine2 === true) as unknown as LineSegments2[];
      const drawn = lines.filter((l) => l.visible && (l.material as { visible: boolean }).visible);
      let nadir = 0;
      let emptyDrawn = 0;
      for (const line of drawn) {
        const geometry = line.geometry as unknown as {
          instanceCount: number;
          getAttribute(name: string): { data: { array: Float32Array } } | undefined;
        };
        if (!(geometry.instanceCount > 0)) emptyDrawn += 1;
        const segments = geometry.getAttribute('instanceStart')?.data.array;
        if (!segments) continue;
        for (let k = 0; k < geometry.instanceCount; k += 1) {
          if (segments[k * 6 + 1] < nadirY || segments[k * 6 + 4] < nadirY) nadir += 1;
        }
      }
      const sprites = findAll(store, (o) => (o as Sprite).isSprite === true && o.visible);
      renders.push({
        lines: lines.length,
        drawnLines: drawn.length,
        dim: drawn.filter((l) => l.renderOrder === 5).length,
        bright: drawn.filter((l) => l.renderOrder === 6).length,
        emptyDrawn,
        nadir,
        sprites: sprites.length,
      });
    },
  );
  const take = () => {
    const list = renders;
    renders = [];
    return list;
  };

  // 1. Noch kein Stand: alles versteckt, auch die Platzhalter.
  for (let i = 0; i < 3; i += 1) scene.frame();
  const before = take();
  // 2. Stand mit zwei Einträgen (neue `version`).
  const range = coverageFor(T0, W, 0);
  const versionBefore = forecastView.version;
  deriveForecastView('ready', committedFor(range, slotsEntries), 'idle', null, virtualNow(), W, 0, lookup, forecastView);
  for (let i = 0; i < 3; i += 1) scene.frame();
  const ready = take();
  const labels = [...canvasTexts.values()].map((texts) => texts[texts.length - 1]);
  const wantLabels = forecastView.slots.map((slot) => slot.labelText);
  // 3. Spuren aus: Linien weg, Labels bleiben.
  await act(async () => useAppStore.setState({ showTrails: false }));
  for (let i = 0; i < 3; i += 1) scene.frame();
  const trailsOff = take();
  await act(async () => useAppStore.setState({ showTrails: true }));
  // 4. Vorhersage aus: wieder nichts.
  deriveForecastView('off', null, 'idle', null, virtualNow(), W, 0, lookup, forecastView);
  for (let i = 0; i < 3; i += 1) scene.frame();
  const off = take();
  await scene.unmount();

  const last = ready[ready.length - 1];
  expect(
    'F nach dem Versionswechsel 4 Line2 mit sichtbarem Objekt und Material, Segmente vorhanden',
    forecastView.version > versionBefore && before.every((r) => r.drawnLines === 0 && r.sprites === 0) &&
      ready.every((r) => r.drawnLines === 4 && r.dim === 2 && r.bright === 2 && r.emptyDrawn === 0) && last.lines === 20,
    `vorher ${before.map((r) => r.drawnLines).join('/')} gezeichnet; danach je Bild ${ready.map((r) => `${r.dim}+${r.bright}`).join(', ')} ` +
      `(gestrichelt + kräftig) von ${last?.lines} Linien, ${last?.emptyDrawn} gezeichnete ohne Segment`,
  );
  expect(
    'F nie die Platzhalter im Nadir',
    [...before, ...ready, ...trailsOff, ...off].every((r) => r.nadir === 0),
    `${[...before, ...ready, ...trailsOff, ...off].reduce((sum, r) => sum + r.nadir, 0)} gezeichnete Segmente unter dem Horizont in ` +
      `${before.length + ready.length + trailsOff.length + off.length} Bildern`,
  );
  expect(
    'F Labels zeigen den abgeleiteten Text',
    last?.sprites === 2 && wantLabels.every((text) => labels.includes(text)),
    `${last?.sprites} Labels sichtbar, gezeichnet „${labels.filter(Boolean).join('“, „')}“, erwartet „${wantLabels.join('“, „')}“`,
  );
  expect(
    'F showTrails aus: Linien unsichtbar, Labels sichtbar; Vorhersage aus: nichts',
    trailsOff.every((r) => r.drawnLines === 0 && r.sprites === 2) && off.every((r) => r.drawnLines === 0 && r.sprites === 0),
    `Spuren aus: ${trailsOff.map((r) => `${r.drawnLines} Linien/${r.sprites} Labels`).join(', ')}; ` +
      `Vorhersage aus: ${off.map((r) => `${r.drawnLines}/${r.sprites}`).join(', ')}`,
  );
  await act(async () => {
    useAppStore.setState((s) => ({ filters: { ...s.filters, mode: 'all' } }));
    engine.setTimeScale(1);
  });
}

/* ------------------------------------------------------------------ */
/* V: Verbünde (Nutzerentscheidung 08.10.2026, Spezifikation §13)       */
/* ------------------------------------------------------------------ */

/**
 * Verbund aus ISS-Elementen: die ISS aus Abschnitt A (std −1,8, Highlight)
 * und vier Module mit denselben Elementen, deren Epoche um −0,3 … +0,3 s
 * versetzt ist – bis 2,3 km entlang der Bahn, wie eigenständig angepasste
 * Bahnsätze angedockter Objekte (CelesTrak gibt ihnen sogar die Elemente der
 * Station: 0,000°). Standardhelligkeit 1,0 wie die Gruppe „stations“: Ihr
 * Sichtfenster beginnt später als das der ISS – der Sichtbeginn taugt nicht
 * als Kriterium. Dazu ZUG, dieselbe Bahn 3 s dahinter (23 km, über 1°
 * daneben: ein Zugnachbar, kein Verbund), und als unabhängige Objekte
 * SCHATTEN, MEO und die Füllobjekte aus A mit Fenstern im Bereich.
 */
const MODULE_OFFSETS_MS = [-300, -100, 100, 300];
function sameOrbit(name: string, norad: string, epochOffsetMs: number, std: number): TestObject {
  const tle = makeTle({ ...ISS_DESIGN.el, name, norad, intl: '98067B' }, T0 + epochOffsetMs);
  return { name, id: norad as NoradId, tle, satrec: satrecOf(tle), std };
}
const MODULES = MODULE_OFFSETS_MS.map((offset, i) => sameOrbit(`MODUL ${i + 1}`, String(61100 + i), offset, 1.0));
const ZUG = sameOrbit('ZUG', '61110', 3000, 1.0);

if (runs('V')) {
  console.log('V. Verbünde: gleiche Spur → ein Platz, Anführer, Auswahl nach dem Zusammenfassen');
  const now = T0;
  const W = 10 * MINUTE;
  const range = coverageFor(now, W, 1);
  const vctx = createScanContext(OBSERVER_GD, OBSERVER_FRAME, range.fromMs, range.toMs);
  const scanOne = (obj: TestObject): ForecastEntry[] => {
    const raw: RawWindow[] = [];
    scanWindows(vctx, obj.satrec, obj.std, raw);
    return raw
      .map((w) => describeWindow(vctx, obj.satrec, obj.std, obj.id, w))
      .filter((e): e is ForecastEntry => e !== null);
  };
  const issEntry = scanOne(ISS)[0];
  const moduleEntries = MODULES.map((obj) => scanOne(obj)[0]);
  const zugEntry = scanOne(ZUG)[0];
  const others = [SCHATTEN, MEO, ...LOW_FILLERS].flatMap(scanOne);
  const verbundEntries = [issEntry, ...moduleEntries];
  const moduleIds: string[] = MODULES.map((obj) => obj.id);
  const names = new Map<string, string>(
    [ISS, ...MODULES, ZUG, SCHATTEN, MEO, ...LOW_FILLERS].map((obj) => [obj.id, obj.name]),
  );
  /** Wie in der App: ISS Highlight, alle anderen mit Namen. */
  const lookup: ForecastLookup = (id) => ({ name: names.get(id) ?? `S${id}`, highlight: id === ISS.id });
  const ready = verbundEntries.every((e) => e !== undefined) && zugEntry !== undefined;
  const sortedIds = (ids: readonly string[]) => [...ids].sort().join(',');

  // V1 Schwelle von beiden Seiten, unabhängig nachgerechnet (satellite.js,
  // 1-s-Schritte über das gemeinsame Stück): Module unter 0,5°, ZUG darüber.
  // `sameForecastTrack` muss genau so entscheiden – auch gegen jedes
  // unabhängige Objekt mit überlappendem Fenster.
  const refSeparation = (a: TestObject, b: TestObject, ea: ForecastEntry, eb: ForecastEntry): number => {
    let worst = 0;
    const toMs = Math.min(ea.endMs, eb.endMs);
    for (let t = Math.max(ea.traceStartMs, eb.traceStartMs); t <= toMs; t += 1000) {
      const sa = refSample(a.satrec, a.std, t);
      const sb = refSample(b.satrec, b.std, t);
      if (sa && sb) worst = Math.max(worst, angleDeg(direction(sa.azimuth, sa.elevation), direction(sb.azimuth, sb.elevation)));
    }
    return worst;
  };
  if (ready) {
    const moduleSep = MODULES.map((obj, i) => refSeparation(ISS, obj, issEntry, moduleEntries[i]));
    const zugSep = refSeparation(ISS, ZUG, issEntry, zugEntry);
    const startLag = moduleEntries.map((e) => (e.startMs - issEntry.startMs) / 1000);
    const riseLag = moduleEntries.map((e) => Math.abs(e.traceStartMs - issEntry.traceStartMs) / 1000);
    const sameModules = moduleEntries.map((e) => sameForecastTrack(issEntry, e));
    const overlapping = others.filter((e) => e.startMs <= issEntry.endMs && issEntry.startMs <= e.endMs);
    const falseMerges = others.filter((e) => sameForecastTrack(issEntry, e) || sameForecastTrack(e, issEntry));
    expect(
      'V Spurvergleich: Module (Epoche ±0,1/±0,3 s) gleich, ZUG (+3 s) und unabhängige Objekte nicht',
      moduleSep.every((sep) => sep < FORECAST_GROUP_MAX_SEPARATION_DEG) && zugSep > FORECAST_GROUP_MAX_SEPARATION_DEG &&
        sameModules.every(Boolean) && !sameForecastTrack(issEntry, zugEntry) && falseMerges.length === 0 &&
        overlapping.length > 0 && riseLag.every((s) => s * 1000 <= FORECAST_GROUP_RISE_TOLERANCE_MS),
      `Referenzabstand zur ISS: Module ${moduleSep.map((v) => f(v, 3)).join(' / ')}°, ZUG ${f(zugSep, 2)}° ` +
        `(Schwelle ${FORECAST_GROUP_MAX_SEPARATION_DEG}°); Module sichtbar ${startLag.map((v) => f(v, 1)).join(' / ')} s ` +
        `nach der ISS, Aufgang ${riseLag.map((v) => f(v, 2)).join(' / ')} s daneben; gleich: Module ` +
        `${sameModules.map((v) => (v ? 'ja' : 'nein')).join('/')}, ZUG ${sameForecastTrack(issEntry, zugEntry) ? 'ja' : 'nein'}, ` +
        `${falseMerges.length} von ${others.length} unabhängigen Fenstern (${overlapping.length} überlappen mit der ISS)`,
    );
  } else {
    expect(
      'V Testbahnen: Fenster für ISS, alle Module und ZUG',
      false,
      `ISS ${issEntry ? 'ja' : 'nein'}, Module ${moduleEntries.filter(Boolean).length}/4, ZUG ${zugEntry ? 'ja' : 'nein'}`,
    );
  }

  if (ready) {
    // V2 Ein Verbund, ISS führt (Highlight und hellste), alle anderen allein.
    const all = [...verbundEntries, zugEntry, ...others];
    const groups = groupForecastEntries(all, lookup);
    const verbund = groups.find((g) => g.memberIds.length > 0);
    const multi = groups.filter((g) => g.memberIds.length > 0).length;
    expect(
      'V groupForecastEntries: ein Verbund ISS +4, ZUG und unabhängige Fenster je eigener Verbund',
      verbund?.leader.noradId === ISS.id && sortedIds(verbund.memberIds) === sortedIds(moduleIds) && multi === 1 &&
        groups.length === all.length - MODULES.length,
      `${all.length} Fenster → ${groups.length} Verbünde, davon ${multi} mit Mitgliedern; ` +
        `Anführer ${verbund?.leader.noradId ?? '–'} mit ${verbund?.memberIds.join(', ') ?? '–'}`,
    );

    // V3 Anführer: Highlight vor Helligkeit, sonst kleinste peakMagnitude,
    // bei Gleichstand die kleinere NORAD-ID (numerisch: 9 vor 10).
    const moduleHighlight: ForecastLookup = (id) => ({ name: names.get(id) ?? id, highlight: id === MODULES[2].id });
    const byHighlight = groupForecastEntries(verbundEntries, moduleHighlight);
    const byMagnitude = groupForecastEntries(verbundEntries, () => null);
    const modulesOnly = groupForecastEntries(moduleEntries, () => null);
    const brightestModule = [...moduleEntries].sort((a, b) => a.peakMagnitude - b.peakMagnitude)[0];
    const tiePoints = synthPoints('77');
    const tie = groupForecastEntries(
      ['10', '9', '11'].map((id) => synthEntry(id, now + MINUTE, now + 3 * MINUTE, { points: tiePoints })),
      () => null,
    );
    expect(
      'V Anführer: Highlight zuerst, dann kleinste peakMagnitude, dann NORAD-ID',
      byHighlight.length === 1 && byHighlight[0].leader.noradId === MODULES[2].id && byHighlight[0].memberIds.includes(ISS.id) &&
        byMagnitude.length === 1 && byMagnitude[0].leader.noradId === ISS.id &&
        modulesOnly.length === 1 && modulesOnly[0].leader === brightestModule &&
        tie.length === 1 && tie[0].leader.noradId === '9' && tie[0].memberIds.join(',') === '10,11',
      `MODUL 3 als Highlight → Anführer ${byHighlight.map((g) => g.leader.noradId).join('/')}; ohne Highlight → ` +
        `${byMagnitude.map((g) => g.leader.noradId).join('/')} (ISS ${f(issEntry.peakMagnitude, 2)} mag); nur Module → ` +
        `${modulesOnly.map((g) => `${g.leader.noradId} (${f(g.leader.peakMagnitude, 3)} mag)`).join('/')}; ` +
        `Gleichstand 10/9/11 → ${tie.map((g) => `${g.leader.noradId} +${g.memberIds.join(',')}`).join(' | ')}`,
    );

    // V4 „11 Kandidaten, davon 5 im Verbund“ → 7 Plätze, nicht 10 Einzelobjekte.
    const target = (): ForecastView => ({
      status: 'off',
      statusText: '',
      windowMs: W,
      nowMs: 0,
      scale: 1,
      slots: [],
      farStatus: 'idle',
      nextText: '',
      next: null,
      membershipVersion: 0,
      version: 0,
    });
    const six = Array.from({ length: 6 }, (_, i) => synthEntry(String(64000 + i), now + (2 + i) * MINUTE, now + (4 + i) * MINUTE));
    const eleven = target();
    deriveForecastView('ready', committedFor(range, [...verbundEntries, ...six]), 'idle', null, now, W, 1, lookup, eleven);
    const lead = eleven.slots.find((slot) => slot.noradId === ISS.id);
    const plain = target();
    const plainLookup: ForecastLookup = (id) => ({ name: names.get(id) ?? `S${id}`, highlight: false });
    deriveForecastView('ready', committedFor(range, [...verbundEntries, ...six]), 'idle', null, now, W, 1, plainLookup, plain);
    const plainLead = plain.slots.find((slot) => slot.noradId === ISS.id);
    // Highlight ohne Namen erst ab dem Aufgang – davor steht noch kein
    // Namenslabel von HighlightMarkers am Himmel (T0 liegt vor dem Aufgang).
    const risen = target();
    deriveForecastView(
      'ready',
      committedFor(range, [...verbundEntries, ...six]),
      'idle',
      null,
      issEntry.traceStartMs + 1000,
      W,
      1,
      lookup,
      risen,
    );
    const risenLead = risen.slots.find((slot) => slot.noradId === ISS.id);
    expect(
      'V 11 Kandidaten, davon 5 im Verbund → 7 Plätze; Label „NAME +4 · in m:ss“, ab dem Aufgang „+4 · in m:ss“',
      eleven.slots.length === 7 && lead !== undefined && lead.groupText === '+4' && lead.memberIds.length === 4 &&
        now < issEntry.traceStartMs && lead.labelText === `${ISS.name} +4 · ${lead.countdownText}` && lead.name === ISS.name &&
        risenLead?.labelText === `+4 · ${risenLead?.countdownText}` &&
        !eleven.slots.some((slot) => moduleIds.includes(slot.noradId)) &&
        plainLead?.labelText === `${ISS.name} +4 · ${plainLead?.countdownText}`,
      `${eleven.slots.length} Plätze: ${eleven.slots.map((slot) => `${slot.noradId}${slot.groupText}`).join(', ')}; ` +
        `Label vor dem Aufgang „${lead?.labelText}“, danach „${risenLead?.labelText}“, ohne Highlight „${plainLead?.labelText}“`,
    );

    // V5 Gedeckelt wird nach dem Zusammenfassen: 5 im Verbund + 10 spätere
    // Einzelobjekte → 10 Plätze (Verbund + die 9 frühesten), nicht 6. Dazu
    // ein zweites, eigenes Fenster von MODUL 1 vor allen Einzelobjekten: Je
    // Objekt ein Platz – es steht schon im Verbund.
    const lastModuleStart = Math.max(...verbundEntries.map((e) => e.startMs));
    const ten = Array.from({ length: 10 }, (_, i) =>
      synthEntry(String(64100 + i), lastModuleStart + (i + 1) * 10_000, lastModuleStart + (i + 1) * 10_000 + 2 * MINUTE),
    );
    const secondWindow = synthEntry(MODULES[0].id, lastModuleStart + 5000, lastModuleStart + MINUTE);
    const fifteen = target();
    deriveForecastView(
      'ready',
      committedFor(range, [...verbundEntries, secondWindow, ...ten]),
      'idle',
      null,
      now,
      W,
      1,
      lookup,
      fifteen,
    );
    const wantIds = [ISS.id, ...ten.slice(0, 9).map((e) => e.noradId)];
    expect(
      'V Deckel zählt Verbünde: 5 im Verbund + 10 einzelne → 10 Plätze, Mitglieder verdrängen niemanden und stehen nicht doppelt',
      fifteen.slots.map((slot) => slot.noradId).join(',') === wantIds.join(','),
      `${fifteen.slots.length} Plätze: ${fifteen.slots.map((slot) => `${slot.noradId}${slot.groupText}`).join(', ')}`,
    );

    // V6 Gültigkeit hinter `completeUntilMs` zählt Verbünde: 10 Objekte vor
    // dem Schnitt, 5 davon ein Verbund → nur 6 Plätze sicher, nicht 10.
    // Alle zehn Einzelobjekte beginnen vor dem Schnitt (bis +100 s), der Schnitt vor now + W.
    const cut = lastModuleStart + 2 * MINUTE;
    const tenIds = isCoverageValid(committedFor(range, [...verbundEntries, ...ten.slice(0, 5)], cut), now, W, lookup);
    const tenGroups = isCoverageValid(committedFor(range, [...verbundEntries, ...ten.slice(0, 9)], cut), now, W, lookup);
    expect(
      'V isCoverageValid hinter dem Schnitt zählt Verbünde, nicht NORAD-IDs',
      cut < now + W && !tenIds && tenGroups,
      `Schnitt ${rel(cut, now)}: 10 IDs in 6 Verbünden ${tenIds ? 'gilt' : 'ungültig'} (Soll ungültig), ` +
        `14 IDs in 10 Verbünden ${tenGroups ? 'gilt' : 'ungültig'} (Soll gilt)`,
    );

    // V7 Szene, Liste und Antippen: eine Spur und ein Label je Verbund, Tap auf
    // die Spur eines Moduls und Klick auf die Zeile wählen den Anführer.
    const schatten = resultOf(SCHATTEN).entries[0];
    await act(async () => {
      useAppStore.setState((s) => ({ filters: { ...s.filters, mode: 'nakedEye' }, showTrails: true }));
      engine.jumpTo(now);
      engine.setTimeScale(0);
    });
    const frames: Array<{ lines: number; sprites: number }> = [];
    const scene = await mountScene(
      () => createElement(VisibilityForecast),
      (store) => {
        const lines = findAll(store, (o) => (o as { isLine2?: boolean }).isLine2 === true) as unknown as LineSegments2[];
        frames.push({
          lines: lines.filter((l) => l.visible && (l.material as { visible: boolean }).visible).length,
          sprites: findAll(store, (o) => (o as Sprite).isSprite === true && o.visible).length,
        });
      },
    );
    deriveForecastView('ready', committedFor(range, [...verbundEntries, schatten]), 'idle', null, virtualNow(), W, 0, lookup, forecastView);
    frames.length = 0;
    for (let i = 0; i < 3; i += 1) scene.frame();
    const labels = [...canvasTexts.values()].map((texts) => texts[texts.length - 1]);
    const sceneLead = forecastView.slots.find((slot) => slot.noradId === ISS.id);
    await scene.unmount();
    expect(
      'V Szene: eine Spur (gestrichelt + kräftig) und ein Label je Verbund – 4 Linien statt 12',
      forecastView.slots.length === 2 && frames.length === 3 && frames.every((r) => r.lines === 4 && r.sprites === 2) &&
        sceneLead !== undefined && labels.includes(sceneLead.labelText) && sceneLead.labelText.startsWith(`${ISS.name} +4 · `),
      `${forecastView.slots.length} Plätze; je Bild ${frames.map((r) => `${r.lines} Linien/${r.sprites} Labels`).join(', ')}; ` +
        `Label „${sceneLead?.labelText}“ ${sceneLead && labels.includes(sceneLead.labelText) ? 'gezeichnet' : 'NICHT gezeichnet'}`,
    );

    // Tap auf die Spur von MODUL 4 (+0,3 s) eine Minute nach dem Sichtbeginn
    // der ISS: Zur Wahl steht nur die Spur des Anführers.
    const lastModule = moduleEntries[moduleEntries.length - 1];
    const ray: Vec3 = { x: 0, y: 0, z: 0 };
    forecastPointAt(lastModule, issEntry.startMs + MINUTE, ray);
    const hit = pickForecastTrace(ray, forecastView.slots, virtualNow(), 3.2 / RAD);

    const container = miniDocument.createElement('div');
    miniDocument.body.appendChild(container);
    const domRoot = createDomRoot(container as unknown as HTMLElement);
    await act(async () => {
      useAppStore.getState().bumpForecastRevision();
      domRoot.render(createElement(ForecastList));
    });
    const rows = container.findAll((el) => el.localName === 'button' && (el.getAttribute('class') ?? '').includes('h-11'));
    const row = rows.find((el) => el.textContent.startsWith(ISS.name));
    const count = row?.findAll((el) => (el.getAttribute('class') ?? '').includes('flex-none'))[0]?.textContent ?? '–';
    viewState.focus = null;
    if (row) await act(async () => click(container, row));
    const selected = useAppStore.getState().selectedId;
    const focus = viewState.focus as { azimuth: number; elevation: number } | null;
    await act(async () => domRoot.unmount());
    container.parentNode?.removeChild(container);
    expect(
      'V Antippen wählt den Anführer: Tap auf die Spur eines Moduls, Klick auf die Zeile „ISS (ZARYA) +4“',
      hit?.noradId === ISS.id && rows.length === 2 && count === '+4' && selected === ISS.id && focus !== null,
      `Tap auf die Spur von MODUL 4 → ${hit ? `${hit.noradId} (${f(hit.angleRad * RAD, 3)}°)` : 'nichts'}; ` +
        `${rows.length} Zeilen, ISS-Zeile „${row?.textContent ?? '–'}“, Zahl „${count}“; Klick → selectedId ${selected}, ` +
        `Fokus ${focus ? 'gesetzt' : 'keiner'}`,
    );

    deriveForecastView('off', null, 'idle', null, virtualNow(), W, 0, lookup, forecastView);
    await act(async () => {
      useAppStore.getState().select(null);
      useAppStore.setState((s) => ({ filters: { ...s.filters, mode: 'all' } }));
      engine.setTimeScale(1);
    });
  }
}

/* ------------------------------------------------------------------ */
/* T: Antippen und Bedienhilfen                                         */
/* ------------------------------------------------------------------ */

/** Canvas für TapPicker: Listener je Ereignis, Größe wie in `mountScene`. */
class TapCanvas {
  readonly style = {};
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  addEventListener(type: string, fn: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }
  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 400, height: 800 };
  }
  dispatch(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

/** Spur ohne Bahn: 128 Punkte von (az, el) aus in `elStepDeg`-Schritten je Punkt. */
function straightTrace(azimuthDeg: number, elevationDeg: number, elStepDeg: number): Float32Array {
  const points = new Float32Array(128 * 3);
  for (let i = 0; i < 128; i += 1) {
    const d = direction(azimuthDeg / RAD, (elevationDeg + elStepDeg * i) / RAD);
    points.set([d.x, d.y, d.z], i * 3);
  }
  return points;
}

/** Klassen eines Mini-DOM-Elements; leer, wenn es fehlt oder kein Element ist. */
function classesOf(el: MiniNode | null | undefined): string[] {
  return el instanceof MiniElement ? (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean) : [];
}

/** Tailwind-Abstandsangabe (`2`, `2.5`, `px`, `[23.5px]`, `[1rem]`) in CSS-Pixel; null, wenn unbekannt. */
function spacingPx(value: string): number | null {
  if (value === 'px') return 1;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 4;
  const m = /^\[(\d+(?:\.\d+)?)(px|rem)\]$/.exec(value);
  if (m) return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
  return null;
}

type Side = 'top' | 'bottom' | 'left' | 'right';

/**
 * Wie weit das `::before` eines Knopfs nach `side` über seinen Rahmen
 * hinausreicht (`before:-top-2`, `before:-inset-2.5`, `before:-inset-x-4`), in
 * px. Eine Angabe, die sich nicht in Pixel übersetzen lässt, zählt als
 * unbegrenzt – lieber ein roter Test als ein unbemerkter Überstand.
 */
function overhangPx(classes: string[], side: Side): number {
  const axis = side === 'top' || side === 'bottom' ? 'inset-y' : 'inset-x';
  let px = 0;
  for (const c of classes) {
    const m = /^before:-(top|bottom|left|right|inset|inset-x|inset-y)-(.+)$/.exec(c);
    if (!m || (m[1] !== side && m[1] !== 'inset' && m[1] !== axis)) continue;
    px = Math.max(px, spacingPx(m[2]) ?? Infinity);
  }
  return px;
}

/** Innenabstand nach `side` aus `pt-2`, `py-1`, `px-2.5`, `p-3` (die spätere Klasse gewinnt), in px. */
function paddingPx(classes: string[], side: Side): number {
  const prefixes: Record<Side, string[]> = {
    top: ['p', 'py', 'pt'],
    bottom: ['p', 'py', 'pb'],
    left: ['p', 'px', 'pl'],
    right: ['p', 'px', 'pr'],
  };
  let px = 0;
  for (const c of classes) {
    const m = /^(p[trblxy]?)-(.+)$/.exec(c);
    if (m && prefixes[side].includes(m[1])) px = spacingPx(m[2]) ?? 0;
  }
  return px;
}

if (runs('T')) {
  console.log('T. Antippen: Label-Fläche, verdeckte Labels, ausgeblendete Spuren; Kandidatenzeile für VoiceOver; Layout-Zusagen der Karte');
  const W = 10 * MINUTE;
  await act(async () => {
    useAppStore.setState((s) => ({ filters: { ...s.filters, mode: 'nakedEye' }, showTrails: false }));
    engine.jumpTo(T0);
    engine.setTimeScale(0);
  });
  const now = virtualNow();
  // A: langes Label, Spur vom Kopf (135°/30°) senkrecht nach unten. B: Kopf
  // 1,7° daneben, später sichtbar – sein Label verdeckt die Kollisionsregel;
  // seine Spur steigt.
  const entryA = synthEntry('61201', now + 200_000, now + 500_000, { traceStartMs: now, points: straightTrace(135, 30, -0.15) });
  const entryB = synthEntry('61202', now + 260_000, now + 560_000, { traceStartMs: now, points: straightTrace(136.8, 30.6, 0.2) });
  const names = new Map([
    ['61201', 'STARLINK-31234'],
    ['61202', 'COSMOS 2219'],
  ]);
  const lookup: ForecastLookup = (id) => ({ name: names.get(id) ?? id, highlight: false });
  deriveForecastView('ready', committedFor(coverageFor(now, W, 0), [entryA, entryB]), 'idle', null, now, W, 0, lookup, forecastView);

  const canvas = new TapCanvas();
  const root = createRoot({} as HTMLCanvasElement);
  const camera = new PerspectiveCamera(70, 0.5, 0.01, 2000);
  camera.position.set(0, 0, 0);
  let tapStore: RootStore | null = null;
  await act(async () => {
    await root.configure({
      gl: { domElement: canvas, render: () => {}, setSize() {}, setPixelRatio() {} } as never,
      camera: camera as never,
      size: { width: 400, height: 800, top: 0, left: 0 },
      frameloop: 'never',
      dpr: 1,
    });
    tapStore = root.render(
      createElement(() => [createElement(VisibilityForecast, { key: 'v' }), createElement(TapPicker, { key: 't' })]),
    ) as unknown as RootStore;
  });
  const sceneStore = tapStore as unknown as RootStore;
  let frameS = 0;
  const aim = (azimuthDeg: number, elevationDeg: number, fov: number) => {
    const d = direction(azimuthDeg / RAD, elevationDeg / RAD);
    camera.fov = fov;
    camera.updateProjectionMatrix();
    camera.lookAt(new Vector3(d.x, d.y, d.z));
    camera.updateMatrixWorld();
    frameS += 1 / 60;
    advance(frameS, true, sceneStore.getState());
  };
  let tapTime = 1000;
  /** Tap auf die Bildschirmstelle eines Punkts der Szene; liefert die Auswahl danach. */
  const tapAt = async (world: Vector3): Promise<string | null> => {
    const p = world.clone().project(camera);
    const x = ((p.x + 1) / 2) * 400;
    const y = ((1 - p.y) / 2) * 800;
    await act(async () => useAppStore.getState().select('25544'));
    await act(async () => {
      canvas.dispatch('pointerdown', { pointerId: 1, clientX: x, clientY: y, timeStamp: tapTime });
      canvas.dispatch('pointerup', { pointerId: 1, clientX: x, clientY: y, timeStamp: tapTime + 50 });
    });
    tapTime += 1000;
    return useAppStore.getState().selectedId;
  };
  /** Mitte des Labels von Platz `i` plus `share` seiner halben Textbreite nach rechts (im Kamerasystem). */
  const labelPoint = (i: number, share: number) => {
    const center = new Vector3(forecastLabels.centers[i * 3], forecastLabels.centers[i * 3 + 1], forecastLabels.centers[i * 3 + 2]);
    const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    return center.addScaledVector(right, share * forecastLabels.halfWidths[i]);
  };
  const angleOf = (point: Vector3, azimuthDeg: number, elevationDeg: number) =>
    angleDeg(point.clone().normalize(), direction(azimuthDeg / RAD, elevationDeg / RAD));

  // T1 Countdown-Teil eines langen Labels bei FOV 70: rechtes Ende des Texts,
  // rund 6° neben dem Kopf – als Kreis um den Kopf (4°) nie getroffen.
  aim(138, 31, 70);
  const shownA = forecastLabels.visible[0] === 1;
  const hiddenB = forecastLabels.visible[1] === 0;
  const countdownSpot = labelPoint(0, 0.85);
  const countdownHit = await tapAt(countdownSpot);
  // T2 Gezoomt (FOV 22): die Mitte des Labels, 1,6° über dem Kopf.
  aim(135, 31.5, 22);
  const centerSpot = labelPoint(0, 0);
  const centerHit = await tapAt(centerSpot);
  // T3 Wo das verdeckte Label von B stünde: Ziel ist das sichtbare von A.
  aim(137, 31.5, 70);
  const hiddenSpot = (() => {
    const head: Vec3 = { x: 0, y: 0, z: 0 };
    forecastPointAt(entryB, now, head);
    return new Vector3(head.x * SKY_RADIUS * 0.985, head.y * SKY_RADIUS * 0.985 + 12, head.z * SKY_RADIUS * 0.985);
  })();
  const hiddenHit = await tapAt(hiddenSpot);
  // Gegenprobe: 20° daneben leerer Himmel.
  const emptyHit = await tapAt(new Vector3().copy(direction(115 / RAD, 31 / RAD) as unknown as Vector3).multiplyScalar(400));
  expect(
    'T Label über die gezeichnete Fläche antippbar: Countdown-Teil bei FOV 70, Mitte bei FOV 22, verdecktes Label kein Ziel',
    shownA && hiddenB && countdownHit === '61201' && centerHit === '61201' && hiddenHit === '61201' && emptyHit === null,
    `Label A ${shownA ? 'gezeigt' : 'NICHT gezeigt'}, B ${hiddenB ? 'verdeckt' : 'NICHT verdeckt'}; ` +
      `Countdown-Teil (${f(angleOf(countdownSpot, 135, 30), 1)}° vom Kopf) → ${countdownHit}; ` +
      `Mitte bei FOV 22 (${f(angleOf(centerSpot, 135, 30), 2)}° vom Kopf) → ${centerHit}; ` +
      `Ort des verdeckten Labels B → ${hiddenHit}; leerer Himmel → ${emptyHit}`,
  );

  // T4 Spur 1° neben A, weit unter dem Label: sichtbar ein Ziel, ausgeblendet
  // leerer Himmel – der Tap hebt die Auswahl auf.
  aim(135, 15, 70);
  const besideTrace = new Vector3().copy(direction(136.03 / RAD, 15 / RAD) as unknown as Vector3).multiplyScalar(400);
  const trailsOff = await tapAt(besideTrace);
  await act(async () => useAppStore.setState({ showTrails: true }));
  aim(135, 15, 70);
  const trailsOn = await tapAt(besideTrace);
  expect(
    'T Spur nur antippbar, solange sie zu sehen ist (showTrails)',
    trailsOff === null && trailsOn === '61201',
    `Tap 1° neben der Spur, ${f(angleOf(besideTrace, 135, 30), 0)}° vom Kopf: Spuren aus → ${trailsOff}, an → ${trailsOn}`,
  );
  await act(async () => root.unmount());

  // T5 Kandidatenzeile der Liste: Ihr zugänglicher Name folgt der Zeit wie
  // der sichtbare Text, auch ohne neues Rendern (Minutenwechsel).
  const candidate = synthEntry('22219', now + 47 * MINUTE, now + 50 * MINUTE, { startAzimuthDeg: 315 });
  const far: ForecastFarCommitted = { requestId: 5, ...farCoverageFor(now, W, 0), entry: candidate, complete: true };
  const listLookup: ForecastLookup = (id) => (id === '22219' ? { name: 'COSMOS 2219', highlight: false } : null);
  deriveForecastView('ready', committedFor(coverageFor(now, W, 0)), 'ready', far, now, W, 0, listLookup, forecastView);
  const container = miniDocument.createElement('div');
  miniDocument.body.appendChild(container);
  const domRoot = createDomRoot(container as unknown as HTMLElement);
  await act(async () => {
    useAppStore.getState().bumpForecastRevision();
    domRoot.render(createElement(ForecastList));
  });
  const button = () =>
    container.findAll((el) => el.localName === 'button' && (el.getAttribute('aria-label') ?? '').startsWith('Nächster'))[0];
  const labelBefore = button()?.getAttribute('aria-label') ?? '–';
  const revision = useAppStore.getState().forecastRevision;
  deriveForecastView('ready', committedFor(coverageFor(now, W, 0)), 'ready', far, now + 30 * MINUTE, W, 0, listLookup, forecastView);
  // Das Intervall der Liste schreibt bei stehender Zeit einmal je Sekunde.
  await sleep(1300);
  const labelAfter = button()?.getAttribute('aria-label') ?? '–';
  const shownDetail = button()?.childNodes.map((n) => n.textContent).join(' / ') ?? '–';
  // Der Name wechselt ohne neues Rendern (Katalog nachgeladen). Vorsatz und
  // Name sind eigene Elemente – nur so bricht die Zeile auf schmalen Karten
  // zwischen beiden um, statt den Namen auf „I…“ zu kürzen (320 px) –, und das
  // Intervall schreibt den neuen Namen ins Namenselement, den Vorsatz nicht
  // noch einmal.
  const renamed: ForecastLookup = (id) => (id === '22219' ? { name: 'KOSMOS 2219', highlight: false } : null);
  deriveForecastView('ready', committedFor(coverageFor(now, W, 0)), 'ready', far, now + 30 * MINUTE, W, 0, renamed, forecastView);
  await sleep(1300);
  const lineParts = button()?.childNodes[0]?.childNodes.map((n) => n.textContent ?? '') ?? [];
  const labelRenamed = button()?.getAttribute('aria-label') ?? '–';

  // T6 Layout-Zusagen der Karte, die der Mini-DOM nur an den Klassen ablesen
  // kann (gemessen werden sie in scripts/verify-forecast-layout.ts, nicht in
  // `npm test`). Ohne sie kehrten zwei Fehler der ersten Fix-Runde unbemerkt
  // zurück: Die Trefferfläche des Zeitfenster-Knopfs ragte 23,5 px über die
  // Karte in den Himmel (`before:-top-[23.5px]`, Karte ohne `overflow-hidden`)
  // und schluckte dort Satelliten-Taps; und die Ausblick-Zeile kürzte den
  // Namen bei 320 px auf „Nächster: I…“ (`truncate` statt Umbruch zwischen
  // Vorsatz und Name).
  const card = container.findAll((el) => classesOf(el).includes('material'))[0];
  const windowButton = container.findAll(
    (el) => el.localName === 'button' && (el.getAttribute('aria-label') ?? '').startsWith('Zeitfenster'),
  )[0];
  const header = classesOf(windowButton?.parentNode);
  const hit = classesOf(windowButton);
  const overhang = { top: overhangPx(hit, 'top'), bottom: overhangPx(hit, 'bottom'), right: overhangPx(hit, 'right') };
  const pad = { top: paddingPx(header, 'top'), bottom: paddingPx(header, 'bottom'), right: paddingPx(header, 'right') };
  const column = classesOf(button()?.parentNode);
  const candidateCls = classesOf(button());
  const line = classesOf(button()?.childNodes[0]);
  const nameEl = classesOf(button()?.childNodes[0]?.childNodes[1]);
  const noTruncate = (classes: string[]) => !classes.includes('truncate') && !classes.includes('whitespace-nowrap');
  await act(async () => domRoot.unmount());
  container.parentNode?.removeChild(container);
  expect(
    'T Karte beschneidet (overflow-hidden), die Trefferfläche des Zeitfenster-Knopfs endet an den Rändern der Kopfzeile',
    classesOf(card).includes('overflow-hidden') && header.length > 0 &&
      overhang.top <= pad.top && overhang.bottom <= pad.bottom && overhang.right <= pad.right,
    `Karte ${classesOf(card).includes('overflow-hidden') ? 'mit' : 'OHNE'} overflow-hidden; ::before ragt oben ${overhang.top} px ` +
      `(Kopfzeile pt ${pad.top}), unten ${overhang.bottom} px (pb ${pad.bottom}), rechts ${overhang.right} px (pr ${pad.right}) über den Knopf hinaus`,
  );
  expect(
    'T Ausblick-Zeile bricht zwischen Vorsatz und Name um (flex-wrap, kein truncate), Überlauf nur nach unten (justify-center-safe, shrink-0)',
    line.includes('flex-wrap') && !line.includes('flex-nowrap') && noTruncate(line) && nameEl.length > 0 && noTruncate(nameEl) &&
      column.includes('justify-center-safe') && candidateCls.includes('shrink-0'),
    `Zeile „${line.join(' ')}“, Name „${nameEl.join(' ')}“, Spalte „${column.join(' ')}“, Knopf „${candidateCls.join(' ')}“`,
  );
  expect(
    'T Kandidatenzeile: zugänglicher Name folgt dem Minutenwechsel ohne neues Rendern',
    labelBefore.includes('COSMOS 2219 in 47 min · aus NW') && labelAfter.includes('COSMOS 2219 in 17 min · aus NW') &&
      useAppStore.getState().forecastRevision === revision && shownDetail.includes('in 17 min'),
    `vorher „${labelBefore}“, 30 min später „${labelAfter}“ (Zeile „${shownDetail}“)`,
  );
  expect(
    'T Kandidatenzeile: Vorsatz und Name als eigene Elemente, neuer Name ohne neues Rendern',
    lineParts.length === 2 && lineParts[0] === 'Nächster:' && lineParts[1] === 'KOSMOS 2219' &&
      labelRenamed.includes('KOSMOS 2219 in 17 min') && useAppStore.getState().forecastRevision === revision,
    `Zeile aus ${lineParts.length} Elementen: ${lineParts.map((t) => `„${t}“`).join(' + ')}; zugänglicher Name „${labelRenamed}“`,
  );

  deriveForecastView('off', null, 'idle', null, virtualNow(), W, 0, lookup, forecastView);
  await act(async () => {
    useAppStore.getState().select(null);
    useAppStore.setState((s) => ({ filters: { ...s.filters, mode: 'all' }, showTrails: true }));
    engine.setTimeScale(1);
  });
}

/* ------------------------------------------------------------------ */
/* Worker-Pool als Node-Threads                                         */
/* ------------------------------------------------------------------ */

const WORKER_BUNDLE = fileURLToPath(new URL('./verify-forecast-worker.mjs', import.meta.url));

/**
 * Vorspann je Shard, wie in scripts/verify-timetravel.ts: `self`, `fetch`
 * aus dem Testkatalog, und `stall` – blockiert den Thread für `ms`
 * Millisekunden, wie ein Shard, der hängt oder gedrosselt wird.
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

function poolFeed(): { active: string } {
  let text = '';
  for (let i = 0; i < POOL_FILLERS; i += 1) text += block(makeTle(poolFiller(i), T0));
  // Ersetzen die vier Offline-Platzhalter (FALLBACK_TLE) an ihren Plätzen 0–3;
  // deren Sätze von 2025 lägen sonst irgendwo am Himmel.
  for (const obj of [ISS, CSS, HST, GEO]) text += block(obj.tle);
  return { active: text };
}

interface ShardMessage {
  type?: string;
  kind?: string;
  requestId?: number;
  shardIndex?: number;
  entries?: ForecastEntry[];
  completeUntilMs?: number;
  durationMs?: number;
}

/** Jede Nachricht des Main-Threads an einen Shard (performance.now()). */
interface SentMessage {
  type?: string;
  shardIndex?: number;
  kind?: string;
  requestId?: number;
  fromMs?: number;
  toMs?: number;
  keep?: number;
}
const sentLog: Array<Omit<SentMessage, 'type' | 'shardIndex'> & { type: string; at: number; shard: number }> = [];
/** Jede Vorhersage-Antwort eines Shards, auch zurückgehaltene. */
const received: Array<{
  shard: number;
  at: number;
  kind: string;
  requestId: number;
  shardIndex: number;
  entries: number;
  durationMs: number;
}> = [];
/** Solange gesetzt, hält die Hülle passende Antworten zurück. */
let holdFilter: ((worker: ThreadWorker, data: ShardMessage) => boolean) | null = null;
const held: Array<{ worker: ThreadWorker; data: ShardMessage }> = [];
const liveWorkers: ThreadWorker[] = [];

class ThreadWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  shard = -1;
  /** Empfangszeiten der Ticks (performance.now()). */
  readonly tickTimes: number[] = [];
  private readonly thread: NodeWorker;

  constructor(_url: URL | string, _options?: { type?: string; name?: string }) {
    this.thread = new NodeWorker(BOOTSTRAP, { eval: true, workerData: { bundle: WORKER_BUNDLE, feed: FEED } });
    this.thread.on('message', (data: ShardMessage) => {
      const at = performance.now();
      if (data?.type === 'tick') {
        this.tickTimes.push(at);
        if (this.tickTimes.length > 4000) this.tickTimes.splice(0, 2000);
      }
      if (data?.type === 'forecast') {
        received.push({
          shard: this.shard,
          at,
          kind: String(data.kind),
          requestId: data.requestId ?? -1,
          shardIndex: data.shardIndex ?? -1,
          entries: data.entries?.length ?? 0,
          durationMs: data.durationMs ?? NaN,
        });
      }
      if (holdFilter?.(this, data)) {
        held.push({ worker: this, data });
        return;
      }
      this.onmessage?.({ data });
    });
    this.thread.on('error', (err) => this.onerror?.({ message: err.message }));
    liveWorkers.push(this);
  }

  postMessage(message: SentMessage, transfer?: Transferable[]): void {
    if (message?.type === 'init') this.shard = message.shardIndex ?? -1;
    sentLog.push({
      type: String(message?.type),
      kind: message?.kind,
      requestId: message?.requestId,
      fromMs: message?.fromMs,
      toMs: message?.toMs,
      keep: message?.keep,
      at: performance.now(),
      shard: this.shard,
    });
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

const workerOfShard = (shard: number): ThreadWorker => {
  const worker = liveWorkers.find((w) => w.shard === shard);
  if (!worker) throw new Error(`Shard ${shard} läuft nicht`);
  return worker;
};

/** Anfragen einer Art, gezählt einmal je Rundruf (Shard 0). */
const requestsSince = (since: number, kind: 'near' | 'far') =>
  sentLog.filter((m) => m.type === 'forecast' && m.kind === kind && m.shard === 0 && m.at >= since);
const cancelsSince = (since: number) => sentLog.filter((m) => m.type === 'forecastCancel' && m.shard === 0 && m.at >= since);
const responsesOf = (requestId: number) => received.filter((r) => r.requestId === requestId);
/** Zeitpunkt, zu dem alle Shards zur Anfrage geantwortet haben (NaN, solange einer fehlt). */
function answeredAt(requestId: number): number {
  const list = responsesOf(requestId);
  return list.length >= engine.shardCount ? Math.max(...list.map((r) => r.at)) : NaN;
}
const sentAt = (requestId: number) => sentLog.find((m) => m.requestId === requestId && m.shard === 0)?.at ?? NaN;

/** „in 3:20“ / „noch 4:10“ → Sekunden. */
function countdownSeconds(text: string): number {
  const match = /(\d+):(\d\d)/.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
}
/** „in 47 min“ / „in 1 h 12 min“ / „in 2 h“ → Minuten. */
function nextMinutes(text: string): number {
  const match = /in (?:(\d+) h)? ?(?:(\d+) min)?/.exec(text);
  return match ? Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0) : Number.NaN;
}
/**
 * Text, den ein Slot zur virtuellen Zeit `nowMs` tragen müsste – eigene
 * Rechnung nach Spezifikation §5 (Sekunden aufgerundet, m:ss), nicht die
 * Formatierer aus src/utils/format.ts: Die erzeugen auch den angezeigten
 * Text, ein Fehler dort kürzte sich sonst heraus (mit `Math.floor` statt
 * `Math.ceil` blieben D und G grün, nachgewiesen 08.10.2026). Feste Paare für
 * die Formatierer selbst prüft E.
 */
function expectedCountdown(slot: ForecastSlot, nowMs: number): string {
  const mmss = (totalS: number) => `${Math.floor(totalS / 60)}:${String(totalS % 60).padStart(2, '0')}`;
  const { startMs, endMs, endOpen } = slot.entry;
  if (startMs <= nowMs && nowMs < endMs) {
    return endOpen ? 'sichtbar' : `noch ${mmss(Math.max(0, Math.ceil((endMs - nowMs) / 1000)))}`;
  }
  const leftS = Math.ceil((startMs - nowMs) / 1000);
  return leftS <= 0 ? 'jetzt' : `in ${mmss(leftS)}`;
}

const FEED = runs('C') || runs('D') || runs('G') || runs('H') ? poolFeed() : { active: '' };
const W10 = 10 * MINUTE;

let pool: Awaited<ReturnType<typeof mountScene>> | null = null;
if (FEED.active !== '') {
  Object.defineProperty(globalThis, 'Worker', { value: ThreadWorker, configurable: true, writable: true });
  // 4 Kerne → 3 Shards (pickShardCount: einer bleibt dem Main-Thread).
  Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', { value: 4, configurable: true });
  await act(async () => {
    useAppStore.setState((s) => ({ activeGroups: ['other'], observer: null, filters: { ...s.filters, mode: 'all' } }));
    useAppStore.getState().setForecastWindow(10);
  });
  pool = await mountScene(() => {
    // Wie App.tsx: der Controller direkt hinter dem Pool.
    useSatelliteEngine({ intervalMs: 100 });
    useVisibilityForecast();
    return null;
  });
  await act(async () => useAppStore.setState({ observer: OBSERVER }));
  await act(async () => {
    engine.jumpTo(T0);
    engine.setTimeScale(1);
  });
  const loaded = await waitFor('Katalog vollständig', () => useAppStore.getState().catalog.length >= POOL_FILLERS + 4, 30_000);
  // Der Controller markiert den Katalog 1,5 s nach seiner letzten Fassung als
  // gewachsen (Effekt B, `catalogDirty`) – das soll vor den Prüfungen
  // geschehen sein, sonst stünde eine zusätzliche Anfrage mitten in einer
  // Messung des Takts.
  await sleep(FORECAST_CATALOG_DEBOUNCE_MS + 300);
  console.log(
    `Pool: ${engine.shardCount} Shards, ${useAppStore.getState().catalog.length} Objekte ${loaded ? 'geladen' : 'NICHT vollständig'} ` +
      `nach ${f((Date.now() - scriptStartedAt) / 1000, 1)} s Laufzeit; virtuelle Zeit ${iso(virtualNow())} UTC`,
  );
}

/* ------------------------------------------------------------------ */
/* C: Pool – Rundruf, Übernahme, alte Antworten, Wachhund               */
/* ------------------------------------------------------------------ */

/**
 * Frisch gelesen: Nach `forecastState.pending = null` verengt TypeScript die
 * Eigenschaft bis zur nächsten Zuweisung auf `null` – dass der Pool sie
 * dazwischen setzt, sieht die Flussanalyse nicht.
 */
const pendingNow = (): ForecastPending | null => forecastState.pending;
const committedNow = (): ForecastCommitted | null => forecastState.committed;

if (pool && runs('C')) {
  console.log('C. Pool mit 3 Shards: Rundruf, Übernahme erst mit allen Shards, alte Antworten verworfen, Wachhund');
  // Filter „Alle“: Der Controller ruht, die Anfragen kommen von Hand.
  forecastState.committed = null;
  forecastState.pending = null;
  const range = () => coverageFor(virtualNow(), W10, 1);
  const isShard2Forecast = (worker: ThreadWorker, data: ShardMessage) => data?.type === 'forecast' && worker.shard === 2;

  // C1 + C2: Rundruf; Shard 2 zurückgehalten → kein Stand.
  holdFilter = isShard2Forecast;
  const r1 = range();
  const id1 = engine.requestForecast('near', r1.fromMs, r1.toMs);
  await waitFor('Antworten aller drei Shards zu Anfrage 1', () => responsesOf(id1).length === 3, 5000);
  const sent1 = sentLog.filter((m) => m.requestId === id1);
  const answers1 = responsesOf(id1);
  expect(
    'C Rundruf an alle Shards, Antworten tragen requestId und shardIndex',
    sent1.length === 3 && new Set(sent1.map((m) => m.shard)).size === 3 && sent1.every((m) => m.kind === 'near' && m.keep === 20) &&
      answers1.length === 3 && answers1.every((r) => r.shardIndex === r.shard && r.kind === 'near') &&
      new Set(answers1.map((r) => r.shardIndex)).size === 3,
    `Anfrage ${id1} an Shards ${sent1.map((m) => m.shard).join(', ')} (keep ${sent1[0]?.keep}); Antworten von ` +
      `${answers1.map((r) => `${r.shard}→shardIndex ${r.shardIndex} (${r.entries} Einträge, ${f(r.durationMs, 1)} ms)`).join(', ')}`,
  );
  const partsWhileHeld = pendingNow()?.parts.size ?? -1;
  expect(
    'C ohne Shard 2 kein Stand',
    committedNow() === null && partsWhileHeld === 2 && held.length === 1,
    `committed ${committedNow() === null ? 'null' : 'gesetzt'}, ${partsWhileHeld} Teile gesammelt, ${held.length} Antwort zurückgehalten`,
  );

  // C3: zweite Anfrage vor der Freigabe; dann erst die alte, dann die neue Antwort von Shard 2.
  const r2 = range();
  const id2 = engine.requestForecast('near', r2.fromMs, r2.toMs);
  await waitFor('Antworten zu Anfrage 2', () => responsesOf(id2).length === 3, 5000);
  holdFilter = null;
  await act(async () => releaseHeld((data) => data.requestId === id1));
  const afterOld = { committed: committedNow(), parts: pendingNow()?.parts.size ?? -1 };
  await act(async () => releaseHeld((data) => data.requestId === id2));
  const afterNew = committedNow();
  expect(
    'C alte Antwort (requestId) verworfen, Stand erst mit allen Teilen der neuen',
    afterOld.committed === null && afterOld.parts === 2 && afterNew?.requestId === id2 && afterNew.complete &&
      afterNew.fromMs === r2.fromMs && pendingNow() === null,
    `nach der Antwort ${id1} von Shard 2: committed ${afterOld.committed === null ? 'null' : afterOld.committed.requestId}, ` +
      `${afterOld.parts} Teile zu ${id2}; nach der Antwort ${id2}: Stand ${afterNew?.requestId ?? '–'}, vollständig ${afterNew?.complete}`,
  );

  // C4: Standortwechsel während des Jobs. Ein langer Bereich (60 min), damit
  // der Job mehrere Scheiben braucht; die `observer`-Nachricht kommt
  // spätestens nach der ersten an die Reihe.
  const now4 = virtualNow();
  const id3 = engine.requestForecast('near', now4 - 10_000, now4 + 60 * MINUTE);
  await act(async () => useAppStore.setState({ observer: OBSERVER_MOVED }));
  const observerSent = sentLog.filter((m) => m.type === 'observer' && m.at >= sentAt(id3)).length;
  await sleep(1500);
  const lateAnswers = responsesOf(id3).length;
  await act(async () => useAppStore.setState({ observer: OBSERVER }));
  forecastState.pending = null;
  const r4 = range();
  const id4 = engine.requestForecast('near', r4.fromMs, r4.toMs);
  await waitFor('Antworten zu Anfrage 4', () => committedNow()?.requestId === id4, 5000);
  expect(
    'C Standortwechsel während des Jobs: keine Antwort der alten requestId, neue Anfrage normal',
    observerSent === 3 && lateAnswers === 0 && committedNow()?.requestId === id4,
    `${observerSent} observer-Nachrichten nach Anfrage ${id3}, ${lateAnswers} Antworten darauf in 1,5 s; ` +
      `Anfrage ${id4} danach ${committedNow()?.requestId === id4 ? 'vollständig' : 'ohne Stand'}`,
  );

  // C5: Wachhund bei gültigem Stand. Controller an, die Liste nennt die ISS;
  // dann hängt der Shard der ISS für 5 s, und der Katalog gilt als gewachsen
  // (`catalogDirty`) – die nächste Kurz-Anfrage bekommt von ihm keine
  // Antwort. Der bisherige Stand ist vollständig und gilt noch: Er bleibt
  // stehen, statt durch einen Teilstand ohne die ISS ersetzt zu werden; die
  // Neuanfrage geht im selben Takt hinaus und bringt den vollständigen Stand.
  await act(async () => useAppStore.getState().setMode('nakedEye'));
  await waitFor(
    'Vorhersage bereit mit der ISS',
    () => forecastView.status === 'ready' && forecastView.slots.some((slot) => slot.noradId === ISS.id) && pendingNow() === null,
    5000,
  );
  const before = committedNow();
  const issShard = before ? (responsesOf(before.requestId).find((r) => r.entries > 0)?.shard ?? 0) : 0;
  const stallAt = performance.now();
  workerOfShard(issShard).stall(5000);
  await sleep(30);
  forecastState.catalogDirty = true;
  await waitFor('Kurz-Anfrage nach dem Hängen', () => requestsSince(stallAt, 'near').length >= 1, 1000);
  const watched = requestsSince(stallAt, 'near')[0];
  await waitFor('Neuanfrage nach dem Wachhund', () => requestsSince(stallAt, 'near').length >= 2, 6000);
  const retry = requestsSince(stallAt, 'near')[1];
  const atRetry = { committed: committedNow(), slots: forecastView.slots.map((slot) => slot.noradId), status: forecastView.status };
  await waitFor(
    'vollständiger Stand nach dem Hängen',
    () => committedNow()?.complete === true && committedNow()?.requestId === retry?.requestId,
    6000,
  );
  const retryAfterMs = (retry?.at ?? NaN) - (watched?.at ?? NaN);
  expect(
    'C Wachhund bei gültigem Stand: kein Teilstand, die Liste behält die ISS, Neuanfrage im selben Takt',
    before !== null && before.complete && atRetry.committed === before && atRetry.slots.includes(ISS.id) &&
      atRetry.status === 'ready' && retryAfterMs >= 4000 && retryAfterMs <= 4400 &&
      committedNow()?.requestId === retry?.requestId && committedNow()?.complete === true,
    `Shard ${issShard} (mit der ISS) hängt; Anfrage ${watched?.requestId} ${rel(watched?.at ?? NaN, stallAt)} nach Beginn des Hängens, ` +
      `Neuanfrage ${retry?.requestId} ${f(retryAfterMs, 0)} ms danach; dabei Stand ` +
      `${atRetry.committed === before ? `unverändert ${before?.requestId}` : `ersetzt durch ${atRetry.committed?.requestId} (vollständig ${atRetry.committed?.complete})`}, ` +
      `Liste [${atRetry.slots.join(', ')}] ${atRetry.status}; danach Stand ${committedNow()?.requestId} vollständig ${committedNow()?.complete}`,
  );

  // C6: Wachhund ohne gültigen Stand (Spezifikation §10 „Shard hängt“): Shard 2
  // hängt 5 s, dann ein Sprung um eine Stunde – der alte Stand gilt nicht
  // mehr. Nach ≈ 4 s Teilstand (`complete = false`), „Anzeige mit dem, was da
  // ist“, Neuanfrage im selben Takt, deren Stand vollständig.
  const backTo = virtualNow();
  const stall2At = performance.now();
  workerOfShard(2).stall(5000);
  await sleep(30);
  await act(async () => engine.jumpTo(backTo + HOUR));
  await waitFor('Kurz-Anfrage nach dem Sprung', () => requestsSince(stall2At, 'near').length >= 1, 1000);
  const jumped = requestsSince(stall2At, 'near')[0];
  let partialAt = Number.NaN;
  let partial: ForecastCommitted | null = null;
  await waitFor(
    'Teilstand vom Wachhund',
    () => {
      const c = committedNow();
      if (c && c.requestId === jumped?.requestId) {
        partialAt = performance.now();
        partial = c;
        return true;
      }
      return false;
    },
    6000,
  );
  await sleep(50);
  const retry2 = requestsSince(stall2At, 'near')[1];
  await waitFor(
    'vollständiger Stand nach dem Hängen',
    () => committedNow()?.complete === true && committedNow()?.requestId === retry2?.requestId,
    6000,
  );
  const partialState = partial as ForecastCommitted | null;
  // Teilstand und Neuanfrage entstehen im selben Takt des Controllers; die
  // Abfrage hier sieht den Teilstand bis zu 10 ms später.
  const retry2AfterMs = (retry2?.at ?? NaN) - (jumped?.at ?? NaN);
  expect(
    'C Wachhund ohne gültigen Stand: nach ≈ 4 s Teilstand (complete = false), Neuanfrage im selben Takt',
    partialState !== null && partialState.complete === false && retry2AfterMs >= 4000 && retry2AfterMs <= 4400 &&
      Math.abs((retry2?.at ?? NaN) - partialAt) < 50 && committedNow()?.requestId === retry2?.requestId &&
      committedNow()?.complete === true,
    `Anfrage ${jumped?.requestId} ${rel(jumped?.at ?? NaN, stall2At)} nach Beginn des Hängens; Teilstand ` +
      `(vollständig ${partialState?.complete}) und Neuanfrage ${retry2?.requestId} ${f(retry2AfterMs, 0)} ms danach, ` +
      `${f(Math.abs((retry2?.at ?? NaN) - partialAt), 0)} ms auseinander gesehen; deren Stand ` +
      `${committedNow()?.requestId === retry2?.requestId && committedNow()?.complete ? 'vollständig' : 'fehlt'}`,
  );
  // Zurück zur Zeit vor dem Sprung – D erwartet die ISS in der Liste.
  await act(async () => engine.jumpTo(backTo));
  await waitFor('Stand nach dem Rücksprung', () => forecastView.status === 'ready' && pendingNow() === null, 5000);
}

/* ------------------------------------------------------------------ */
/* D: Controller in virtueller Zeit                                     */
/* ------------------------------------------------------------------ */

/**
 * Prüft jeden Countdown gegen die virtuelle Zeit und gegen die Wanduhr.
 *
 * Abgeleitet wird alle 250 ms Wanduhr (`FORECAST_CHECK_MS`); bei ×60 liegen
 * die Texte also bis zu 15 s virtuell hinter `virtualNow()`. Verglichen wird
 * deshalb mit der Zeit der letzten Ableitung (`forecastView.nowMs`, ±1 s),
 * und die muss `virtualNow()` auf einen Takt genau folgen.
 */
function checkCountdowns(label: string, wantId: NoradId): void {
  const now = virtualNow();
  const derivedAt = forecastView.nowMs;
  const wall = Date.now();
  const scale = useAppStore.getState().timeBase.scale;
  const lagMs = Math.abs(now - derivedAt);
  const slots = forecastView.slots;
  const rows = slots.map((slot) => {
    const want = expectedCountdown(slot, derivedAt);
    const diff = Math.abs(countdownSeconds(slot.countdownText) - countdownSeconds(want));
    const wallText = expectedCountdown(slot, wall);
    return { slot, want, diff, wallText };
  });
  expect(
    `${label}: Countdowns aus der virtuellen Zeit`,
    forecastView.status === 'ready' && slots.some((s) => s.noradId === wantId) &&
      rows.every((r) => r.diff <= 1 && r.wallText !== r.slot.countdownText) &&
      lagMs <= Math.max(1, Math.abs(scale)) * 300 + 1000 && Math.abs(now - wall) > HOUR,
    rows
      .map((r) => `${r.slot.name} „${r.slot.countdownText}“ (Soll „${r.want}“, gegen die Wanduhr „${r.wallText}“)`)
      .join(', ') +
      `; abgeleitet für ${iso(derivedAt)} UTC, ${f(lagMs / 1000, 1)} s neben virtualNow() bei ×${scale}; ` +
      `Wanduhr ${f((wall - now) / DAY, 2)} d daneben`,
  );
}

if (pool && runs('D')) {
  console.log('D. Controller: Sprung, Zeitraffer, Rückwärtslauf, Pause, ×600');
  if (useAppStore.getState().filters.mode !== 'nakedEye') {
    await act(async () => useAppStore.getState().setMode('nakedEye'));
  }
  const ready = await waitFor('Vorhersage bereit', () => forecastView.status === 'ready' && forecastView.slots.length > 0, 5000);
  expect(
    'D Filter „Sichtbar“ → ready',
    ready && forecastView.slots.some((s) => s.noradId === ISS.id),
    `Status ${forecastView.status}, Einträge ${forecastView.slots.map((s) => `${s.name} ${s.countdownText}`).join(', ') || '–'}`,
  );

  // D1: Sprung +30 d – erst „Berechne …“, dann der Stand der neuen Zeit.
  const statuses: string[] = [];
  const watch = setInterval(() => {
    if (statuses[statuses.length - 1] !== forecastView.status) statuses.push(forecastView.status);
  }, 5);
  const jumpedAt = performance.now();
  await act(async () => engine.jumpTo(J_30D));
  const pendingRightAway = forecastView.status;
  await waitFor('Stand nach +30 d', () => forecastView.status === 'ready' && forecastView.slots.some((s) => s.noradId === CSS.id), 5000);
  clearInterval(watch);
  expect(
    'D Sprung +30 d: pending, dann ready',
    pendingRightAway === 'pending' && statuses.includes('pending') && forecastView.status === 'ready',
    `direkt nach dem Sprung ${pendingRightAway}, Folge ${statuses.join(' → ')}, ready nach ${f(performance.now() - jumpedAt, 0)} ms`,
  );
  checkCountdowns('D +30 d', CSS.id);

  // D2: ×60 – Neuanfrage alle ≈ 4 s Wanduhr (240 s virtuell).
  const fastAt = performance.now();
  await act(async () => engine.setTimeScale(60));
  await waitFor('zwei Kurz-Anfragen bei ×60', () => requestsSince(fastAt, 'near').length >= 2, 7000);
  const fast = requestsSince(fastAt, 'near');
  const gapS = ((fast[1]?.at ?? NaN) - (fast[0]?.at ?? NaN)) / 1000;
  const fastSpanS = ((fast[1]?.toMs ?? NaN) - (fast[1]?.fromMs ?? NaN)) / 1000;
  // Der Beginn liegt auf dem absoluten 5-s-Raster (abgerundet): Der Rücklauf
  // ist 10 s plus weniger als 5 s.
  expect(
    'D ×60: Abstand der Kurz-Anfragen 3–5 s Wanduhr',
    gapS >= 3 && gapS <= 5 && fastSpanS >= 600 + 120 + 240 + 10 && fastSpanS < 600 + 120 + 240 + 15 &&
      (fast[1]?.fromMs ?? NaN) % FORECAST_STEP_MS === 0,
    `Anfragen ${fast.map((m) => rel(m.at, fastAt)).join(', ')} nach dem Wechsel → Abstand ${f(gapS, 2)} s; ` +
      `Bereich ${f(fastSpanS, 1)} s (Fenster 600 + Vorlauf 360 + Rücklauf 10 bis < 15), Beginn ` +
      `${(fast[1]?.fromMs ?? NaN) % FORECAST_STEP_MS === 0 ? 'auf' : 'neben'} dem 5-s-Raster`,
  );

  // D3: ×−60 ab +30 d – der Eintrag steht wieder bevor, sein Countdown wächst.
  await act(async () => {
    engine.setTimeScale(-60);
    engine.jumpTo(J_30D);
  });
  await waitFor('Stand rückwärts', () => forecastView.status === 'ready' && forecastView.slots.some((s) => s.noradId === CSS.id), 5000);
  const cssText = () => forecastView.slots.find((s) => s.noradId === CSS.id)?.countdownText ?? '–';
  const first = { text: cssText(), at: performance.now(), derivedAt: forecastView.nowMs };
  await sleep(1500);
  const second = { text: cssText(), at: performance.now(), derivedAt: forecastView.nowMs };
  // Gegen die Zeiten der beiden Ableitungen; die liegen je bis zu einem Takt
  // (250 ms Wanduhr = 15 s virtuell) hinter dem Ablesen.
  const grewS = countdownSeconds(second.text) - countdownSeconds(first.text);
  const wantGrowS = (first.derivedAt - second.derivedAt) / 1000;
  const wallGrowS = ((second.at - first.at) / 1000) * 60;
  const backRequests = requestsSince(first.at - 2000, 'near');
  const lastBack = backRequests[backRequests.length - 1];
  // Rücklauf 250 s plus weniger als 5 s (Beginn aufs Raster abgerundet).
  const backSpanS = ((lastBack?.toMs ?? NaN) - (lastBack?.fromMs ?? NaN)) / 1000;
  expect(
    'D ×−60: Countdowns wachsen, Abdeckung reicht nach hinten',
    first.text.startsWith('in ') && Math.abs(grewS - wantGrowS) <= 1 && Math.abs(wantGrowS - wallGrowS) <= 32 &&
      backSpanS >= 600 + 120 + 250 && backSpanS < 600 + 120 + 255 && (lastBack?.fromMs ?? NaN) % FORECAST_STEP_MS === 0,
    `CSS „${first.text}“ → „${second.text}“ in ${f((second.at - first.at) / 1000, 2)} s Wanduhr (+${grewS} s, Soll aus den ` +
      `Ableitungen +${f(wantGrowS, 0)} s, aus der Wanduhr ×60 +${f(wallGrowS, 0)} s); ` +
      `letzte Anfrage über ${f(backSpanS, 1)} s (Fenster 600 + Vorlauf 120 + Rücklauf 250 bis < 255)`,
  );
  checkCountdowns('D ×−60', CSS.id);

  // D4: Pause – keine Anfrage, Texte stehen.
  await act(async () => engine.setTimeScale(0));
  await sleep(300);
  const pausedAt = performance.now();
  const pausedText = cssText();
  await sleep(3000);
  const pauseRequests = requestsSince(pausedAt, 'near').length + requestsSince(pausedAt, 'far').length;
  expect(
    'D Pause: keine Anfrage in 3 s, Texte stehen',
    pauseRequests === 0 && cssText() === pausedText && forecastView.status === 'ready',
    `${pauseRequests} Anfragen, CSS „${pausedText}“ → „${cssText()}“`,
  );

  // D5: ×600 ruht, ×1 läuft wieder.
  const fastestAt = performance.now();
  await act(async () => engine.setTimeScale(600));
  await sleep(1000);
  const cancels = cancelsSince(fastestAt);
  const pausedStatus = { status: forecastView.status, text: forecastView.statusText, slots: forecastView.slots.length };
  const requestsAt600 = requestsSince(fastestAt, 'near').length + requestsSince(fastestAt, 'far').length;
  expect(
    'D ×600: paused, „Vorhersage ruht bei ×600“, forecastCancel gesendet',
    pausedStatus.status === 'paused' && pausedStatus.text === 'Vorhersage ruht bei ×600' && pausedStatus.slots === 0 &&
      cancels.length >= 1 && cancels.every((m) => m.kind === undefined) && requestsAt600 === 0,
    `Status ${pausedStatus.status}, „${pausedStatus.text}“, ${pausedStatus.slots} Einträge; ${cancels.length} Abbruch ` +
      `(${cancels.map((m) => m.kind ?? 'beide Arten').join(', ')}), ${requestsAt600} Anfragen in 1 s`,
  );
  const normalAt = performance.now();
  await act(async () => engine.setTimeScale(1));
  const back = await waitFor('ready nach ×1', () => forecastView.status === 'ready', 3000);
  expect(
    'D zurück ×1 → ready',
    back && requestsSince(normalAt, 'near').length >= 1,
    `Status ${forecastView.status} nach ${f(performance.now() - normalAt, 0)} ms, ${requestsSince(normalAt, 'near').length} Kurz-Anfrage(n)`,
  );
}

/* ------------------------------------------------------------------ */
/* G: Liste auf dem Mini-DOM                                            */
/* ------------------------------------------------------------------ */

if (pool && runs('G')) {
  console.log('G. ForecastList per react-dom/client: Countdown aus der virtuellen Zeit, Klick wählt aus');
  await act(async () => {
    useAppStore.getState().setMode('nakedEye');
    engine.setTimeScale(1);
    engine.jumpTo(J_3D);
  });
  await waitFor('Stand nach +3 d', () => forecastView.status === 'ready' && forecastView.slots.some((s) => s.noradId === HST.id), 5000);
  const container = miniDocument.createElement('div');
  miniDocument.body.appendChild(container);
  const domRoot = createDomRoot(container as unknown as HTMLElement);
  await act(async () => domRoot.render(createElement(ForecastList)));
  // Das Intervall der Liste schreibt bei ×1 einmal je Sekunde.
  await sleep(1300);
  const rows = container.findAll((el) => el.localName === 'button' && (el.getAttribute('class') ?? '').includes('h-11'));
  const row = rows.find((el) => el.textContent.startsWith(HST.name));
  const cell = row?.findAll((el) => (el.getAttribute('class') ?? '').includes('shrink-0'))[0];
  const slot = forecastView.slots.find((s) => s.noradId === HST.id);
  // Name, Unterzeile und Countdown: die Blätter der Zeile, die nur Text enthalten.
  const rowTexts = (
    row?.findAll((el) => (el.localName === 'div' || el.localName === 'span') && el.childNodes.every((c) => c.nodeType === 3)) ?? []
  ).map((el) => el.textContent);
  const now = virtualNow();
  const shown = cell?.textContent ?? '–';
  const want = slot ? expectedCountdown(slot, now) : '–';
  const wall = slot ? expectedCountdown(slot, Date.now()) : '–';
  const header = container.findAll((el) => el.localName === 'button' && (el.getAttribute('aria-label') ?? '').startsWith('Zeitfenster'))[0];
  expect(
    'G Countdown-Zelle zeigt die virtuelle Zeit',
    row !== undefined && Math.abs(countdownSeconds(shown) - countdownSeconds(want)) <= 2 && shown !== wall &&
      header?.textContent === '10 min',
    `${rows.length} Zeile(n), „${rowTexts.join(' / ') || '–'}“; ` +
      `Zelle „${shown}“, Soll „${want}“, ` +
      `gegen die Wanduhr „${wall}“; Kopf „${header?.textContent}“`,
  );
  viewState.focus = null;
  if (row) await act(async () => click(container, row));
  const focus = viewState.focus as { azimuth: number; elevation: number } | null;
  expect(
    'G Klick auf die Zeile wählt aus und richtet die Kamera auf den Kopf',
    useAppStore.getState().selectedId === HST.id && focus !== null,
    `selectedId ${useAppStore.getState().selectedId}, Fokus ` +
      `${focus ? `${f(focus.azimuth * RAD, 1)}° / ${f(focus.elevation * RAD, 1)}°` : 'keiner'}`,
  );
  await act(async () => domRoot.unmount());
  container.parentNode?.removeChild(container);
  await act(async () => useAppStore.getState().select(null));
}

/* ------------------------------------------------------------------ */
/* H: Ausblick (Lang-Scan, Spezifikation §12)                           */
/* ------------------------------------------------------------------ */

/**
 * Anker von Abschnitt H: 47 min vor dem Sichtbeginn der ISS. Davor liegt im
 * Pool nichts – die Füllobjekte sind beweisbar unsichtbar, CSS und HST so
 * entworfen, dass sie um T0 nie sichtbar sind; die Referenz bestätigt es
 * unten. Die Liste ist also leer, der Lang-Scan findet die ISS „in 47 min“.
 */
const T_H = Math.round(resultOf(ISS).entries[0].startMs - 47 * MINUTE);

/** Folge der Zustände „Status/Lang-Status“, bis `done` gilt oder `untilMs` vorbei ist. */
async function watchFar(untilMs: number, done: () => boolean): Promise<string[]> {
  const seen: string[] = [];
  const end = performance.now() + untilMs;
  while (performance.now() < end) {
    const key = `${forecastView.status}/${forecastView.farStatus}`;
    if (seen[seen.length - 1] !== key) seen.push(key);
    if (done()) break;
    await sleep(5);
  }
  return seen;
}

if (pool && runs('H')) {
  console.log(`H. Ausblick: leere Liste um ${iso(T_H)} UTC, Kandidat ISS in 47 min`);
  {
    // Voraussetzung: Referenzfenster der Pool-Objekte in [T_H − 1 min, T_H + 100 min].
    const windows = [ISS, CSS, HST, GEO].flatMap((obj) =>
      refWindows(obj.satrec, obj.std, T_H - MINUTE, T_H + 100 * MINUTE).map((w) => ({ obj, w })),
    );
    windows.sort((a, b) => a.w.startMs - b.w.startMs);
    const firstWindow = windows[0];
    expect(
      'H Voraussetzung: bis T_H + 47 min kein Fenster, dann die ISS',
      firstWindow !== undefined && firstWindow.obj === ISS && Math.abs(firstWindow.w.startMs - (T_H + 47 * MINUTE)) < 1500,
      windows.map(({ obj, w }) => `${obj.name} ${rel(w.startMs, T_H)}`).join(', ') || 'keine Fenster',
    );
  }

  // H1: leere Liste → Lang-Scan pending → ready mit Kandidat.
  await act(async () => {
    useAppStore.getState().setMode('nakedEye');
    useAppStore.getState().setForecastWindow(10);
    engine.setTimeScale(1);
    engine.jumpTo(T_H);
  });
  const sequence = await watchFar(8000, () => forecastView.farStatus === 'ready' && forecastView.next !== null);
  const next = forecastView.next;
  const now1 = virtualNow();
  const wantPrefix = next ? formatForecastNext(next.entry.startMs, now1) : '–';
  const [shownPrefix, shownDirection] = (next?.detailText ?? ' · ').split(' · ');
  const wallPrefix = next ? formatForecastNext(next.entry.startMs, Date.now()) : '–';
  expect(
    'H leere Liste: farStatus pending → ready, Kandidat ISS mit Text aus der virtuellen Zeit',
    sequence.includes('ready/pending') && forecastView.status === 'ready' && forecastView.slots.length === 0 &&
      forecastView.statusText === 'Keine in den nächsten 10 min' && next?.noradId === ISS.id &&
      forecastView.nextText === `Nächster: ${ISS.name}` && next.text === forecastView.nextText &&
      Math.abs(nextMinutes(shownPrefix) - nextMinutes(wantPrefix)) <= 1 &&
      shownDirection === `aus ${compassLabel(next.entry.startAzimuthDeg)}` &&
      wallPrefix !== shownPrefix && Math.abs(now1 - Date.now()) > HOUR &&
      Math.abs(next.entry.startMs - resultOf(ISS).entries[0].startMs) < 1000,
    `Folge ${sequence.join(' → ')}; „${forecastView.statusText}“ / „${forecastView.nextText}“ / „${next?.detailText ?? '–'}“ ` +
      `(Soll „${wantPrefix} · aus ${next ? compassLabel(next.entry.startAzimuthDeg) : '–'}“, gegen die Wanduhr „${wallPrefix}“); ` +
      `Sichtbeginn ${next ? rel(next.entry.startMs, T_H) : '–'} nach T_H`,
  );

  // H2: Sprung auf T_H + 40 min – der Kandidat rückt ins Fenster, der
  // Lang-Scan ruht. Danach 10 s mit Eintrag: keine einzige Lang-Anfrage.
  const jumpAt = performance.now();
  const sentBefore = sentLog.length;
  await act(async () => engine.jumpTo(T_H + 40 * MINUTE));
  const sentOnJump = sentLog.slice(sentBefore).filter((m) => m.shard === 0).map((m) => `${m.type}${m.kind ? `:${m.kind}` : ''}`);
  const committedFarOnJump = forecastState.farCommitted;
  await waitFor('Eintrag nach dem Sprung', () => forecastView.status === 'ready' && forecastView.slots.length > 0, 5000);
  const slotIds = forecastView.slots.map((s) => s.noradId).join(', ');
  const idleAfterJump = forecastView.farStatus === 'idle' && forecastView.next === null && forecastView.nextText === '';
  const quietFrom = performance.now();
  let emptySeen = 0;
  while (performance.now() - quietFrom < 10_000) {
    if (forecastView.slots.length === 0) emptySeen += 1;
    await sleep(100);
  }
  const farInQuiet = requestsSince(quietFrom, 'far').length;
  const farAfterJump = requestsSince(jumpAt, 'far').length;
  expect(
    'H Kandidat im Fenster: Eintrag, farStatus idle, Lang-Scan abgebrochen bzw. nie gefragt',
    slotIds.includes(ISS.id) && idleAfterJump && committedFarOnJump === null &&
      (sentOnJump.includes('forecastCancel:far') || farAfterJump === 0),
    `Einträge ${slotIds}, farStatus ${forecastView.farStatus}; beim Sprung gesendet: ${sentOnJump.join(', ')}; ` +
      `farCommitted ${committedFarOnJump === null ? 'null' : 'gesetzt'}, Lang-Anfragen seit dem Sprung ${farAfterJump}`,
  );
  expect(
    'H bei ≥ 1 Eintrag in 10 s Wanduhr keine Lang-Anfrage',
    farInQuiet === 0 && emptySeen === 0,
    `${farInQuiet} Lang-Anfragen in 10 s, Liste ${emptySeen === 0 ? 'durchgehend mit Eintrag' : `${emptySeen}× leer gesehen`}`,
  );

  // H3: Fensterwechsel bei leerer Liste – der Stand des Lang-Scans ist weg,
  // danach genau eine neue Anfrage.
  await act(async () => engine.jumpTo(T_H));
  await waitFor('Kandidat bei T_H', () => forecastView.farStatus === 'ready' && forecastView.next !== null, 8000);
  const windowAt = performance.now();
  await act(async () => useAppStore.getState().setForecastWindow(20));
  const farAfterSwitch = forecastState.farCommitted;
  await waitFor(
    'Kandidat bei W = 20',
    () => forecastView.farStatus === 'ready' && forecastView.next !== null && forecastView.windowMs === 20 * MINUTE,
    8000,
  );
  await sleep(1500);
  const farAfterWindow = requestsSince(windowAt, 'far');
  expect(
    'H Fensterwechsel: farCommitted null, danach genau eine Lang-Anfrage',
    farAfterSwitch === null && farAfterWindow.length === 1 && forecastView.next?.noradId === ISS.id &&
      forecastView.statusText === 'Keine in den nächsten 20 min',
    `direkt nach dem Wechsel farCommitted ${farAfterSwitch === null ? 'null' : 'gesetzt'}; ` +
      `${farAfterWindow.length} Lang-Anfrage(n) ${farAfterWindow.map((m) => rel(m.at, windowAt)).join(', ')} danach; ` +
      `„${forecastView.statusText}“ / „${forecastView.nextText}“`,
  );
  await act(async () => useAppStore.getState().setForecastWindow(10));
  await waitFor('Kandidat bei W = 10', () => forecastView.farStatus === 'ready' && forecastView.windowMs === W10, 8000);

  // H4: ×600 – beide Arten ruhen; zurück ×1 – wieder ein Lang-Scan.
  const fastAt = performance.now();
  await act(async () => engine.setTimeScale(600));
  await sleep(1000);
  const farAt600 = requestsSince(fastAt, 'far').length;
  const cancelAt600 = cancelsSince(fastAt).map((m) => m.kind ?? 'beide');
  const statusAt600 = `${forecastView.status}/${forecastView.farStatus} „${forecastView.statusText}“ „${forecastView.nextText}“`;
  const slowAt = performance.now();
  await act(async () => engine.setTimeScale(1));
  await waitFor('Lang-Anfrage nach ×1', () => requestsSince(slowAt, 'far').length >= 1, 5000);
  expect(
    'H ×600: kein Lang-Scan, zurück ×1: wieder einer',
    farAt600 === 0 && cancelAt600.includes('beide') && statusAt600.startsWith('paused/idle') && forecastState.farCommitted === null &&
      requestsSince(slowAt, 'far').length === 1,
    `bei ×600 ${farAt600} Lang-Anfragen, Abbruch ${cancelAt600.join(', ') || '–'}, ${statusAt600}; ` +
      `nach ×1 ${requestsSince(slowAt, 'far').length} Lang-Anfrage nach ${f((requestsSince(slowAt, 'far')[0]?.at ?? NaN) - slowAt, 0)} ms`,
  );

  // H5: Vorrang des Kurz-Scans im Worker. Läuft ein Lang-Scan (10 000
  // Füllobjekte über 100 min), wartet ein Kurz-Scan höchstens eine 4-ms-
  // Scheibe; der Lang-Scan setzt danach fort und antwortet ohne neue Anfrage.
  // Die Anfragen gehen hier direkt an den Pool – genau wie der Controller sie
  // stellt (`catalogDirty`), nur ohne bis zu 250 ms auf seinen Takt zu warten.
  await act(async () => engine.jumpTo(T_H));
  await waitFor('Kandidat bei T_H', () => forecastView.farStatus === 'ready' && forecastView.next !== null, 8000);
  await sleep(300);
  const tickFrom = performance.now();
  const nearAlone: number[] = [];
  const nearWithFar: number[] = [];
  const farOrder: string[] = [];
  let farRuns = 0;
  let farWithoutSecondRequest = 0;
  for (let run = 0; run < 3; run += 1) {
    const r = coverageFor(virtualNow(), W10, 1);
    const id = engine.requestForecast('near', r.fromMs, r.toMs);
    await waitFor('Kurz-Antwort ohne Lang-Scan', () => Number.isFinite(answeredAt(id)), 5000);
    nearAlone.push(answeredAt(id) - sentAt(id));
    await sleep(150);
  }
  for (let run = 0; run < 3; run += 1) {
    const rf = farCoverageFor(virtualNow(), W10, 1);
    const farId = engine.requestForecast('far', rf.fromMs, rf.toMs);
    await sleep(30);
    const r = coverageFor(virtualNow(), W10, 1);
    const nearId = engine.requestForecast('near', r.fromMs, r.toMs);
    await waitFor('Kurz- und Lang-Antwort', () => Number.isFinite(answeredAt(nearId)) && Number.isFinite(answeredAt(farId)), 10_000);
    farRuns += 1;
    nearWithFar.push(answeredAt(nearId) - sentAt(nearId));
    const farDone = answeredAt(farId);
    farOrder.push(`${f(farDone - sentAt(farId), 0)} ms (Kurz fertig nach ${f(answeredAt(nearId) - sentAt(farId), 0)} ms)`);
    if (farDone > answeredAt(nearId) && requestsSince(sentAt(farId) + 1, 'far').length === 0) farWithoutSecondRequest += 1;
    await sleep(150);
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  let worstTickGap = 0;
  for (const worker of liveWorkers) {
    const times = worker.tickTimes.filter((t) => t >= tickFrom);
    for (let i = 1; i < times.length; i += 1) worstTickGap = Math.max(worstTickGap, times[i] - times[i - 1]);
  }
  const farCpu = received
    .filter((m) => m.kind === 'far' && m.at >= tickFrom)
    .map((m) => m.durationMs);
  expect(
    'H Vorrang: Kurz-Antwort mit laufendem Lang-Scan ≤ ohne + 10 ms, Lang-Antwort danach ohne neue Anfrage',
    median(nearWithFar) <= median(nearAlone) + 10 && farWithoutSecondRequest === farRuns && farRuns === 3,
    `Kurz-Scan allein ${nearAlone.map((v) => f(v, 0)).join(' / ')} ms (Median ${f(median(nearAlone), 0)}), ` +
      `mit Lang-Scan ${nearWithFar.map((v) => f(v, 0)).join(' / ')} ms (Median ${f(median(nearWithFar), 0)}); ` +
      `Lang-Scan fertig nach ${farOrder.join(', ')}, ${farWithoutSecondRequest} von ${farRuns} nach dem Kurz-Scan ohne zweite Anfrage; ` +
      `Rechenzeit je Shard ${farCpu.map((v) => f(v, 0)).join(' / ')} ms`,
  );
  expect(
    'H Tick-Abstand während der Scans < 150 ms',
    worstTickGap > 0 && worstTickGap < 150,
    `größter Abstand zweier Ticks eines Shards ${f(worstTickGap, 0)} ms (Takt 100 ms)`,
  );

  // H6: Rückwärtslauf ×−60, W 5, das Fenster der ISS endete vor 5 min. Der
  // Bereich des Lang-Scans reichte nach Spezifikation §5 5,5 min zurück: Der
  // Shard der ISS beschrieb ihr vergangenes Fenster (keep 1), `isFarValid`
  // verwarf es, und die Zeile blieb bei „Suche bis 90 min …“, alle 2 s neu
  // gefragt, bis der Rücklauf das Fenster erreichte (≈ 5 s Wanduhr). Jetzt
  // beginnt der Bereich nie vor now: binnen 4 s ein gültiger Ausblick.
  const issWindow = resultOf(ISS).entries[0];
  // Erst den Mindestabstand der Lang-Anfragen abwarten (H5 hat gerade
  // gefragt) – er gehört nicht zur gemessenen Zeit.
  await sleep(FORECAST_FAR_MIN_REQUEST_GAP_MS);
  const rewindAt = performance.now();
  await act(async () => {
    useAppStore.getState().setForecastWindow(5);
    engine.jumpTo(issWindow.endMs + 5 * MINUTE);
    engine.setTimeScale(-60);
  });
  let rewindReadyAt = Number.NaN;
  const rewindSeen: string[] = [];
  const pastCandidates: string[] = [];
  while (performance.now() - rewindAt < 4000) {
    const key = `${forecastView.status}/${forecastView.farStatus}/${forecastView.slots.length}`;
    if (rewindSeen[rewindSeen.length - 1] !== key) rewindSeen.push(key);
    const candidate = forecastState.farCommitted?.entry;
    if (candidate && candidate.startMs <= issWindow.endMs) pastCandidates.push(`${candidate.noradId} ${hms(candidate.startMs)}`);
    if (
      Number.isNaN(rewindReadyAt) && forecastView.status === 'ready' && forecastView.slots.length === 0 &&
      forecastView.farStatus === 'ready'
    ) {
      rewindReadyAt = performance.now();
    }
    await sleep(20);
  }
  const rewindFar = requestsSince(rewindAt, 'far');
  expect(
    'H ×−60, W 5, Fenster knapp hinter now: Ausblick binnen 4 s gültig, Lang-Bereich nie vor now',
    Number.isFinite(rewindReadyAt) && rewindFar.length >= 1 &&
      rewindFar.every((m) => (m.fromMs ?? -Infinity) > issWindow.endMs) && pastCandidates.length === 0,
    `Folge ${rewindSeen.join(' → ')}; Ausblick gültig nach ${f(rewindReadyAt - rewindAt, 0)} ms; ` +
      `${rewindFar.length} Lang-Anfragen ab ${rewindFar.map((m) => rel(m.fromMs ?? NaN, issWindow.endMs)).join(', ')} ` +
      `nach dem Ende des ISS-Fensters` +
      `${pastCandidates.length ? `; vergangene Kandidaten: ${[...new Set(pastCandidates)].join(', ')}` : ''}`,
  );
  await act(async () => {
    useAppStore.getState().setForecastWindow(10);
    engine.setTimeScale(1);
    engine.jumpTo(T_H);
  });

  // H7: Der Anlass einer aufgegebenen Anfrage bleibt. Leere Liste, gültiger
  // Ausblick; alle drei Shards hängen 10 s, und der Katalog gilt als
  // gewachsen (beide Flags). Weder Kurz- noch Lang-Anfrage bekommt eine
  // Antwort, die Wachhunde (4 s, 8 s) geben sie ohne Teilstand auf, die
  // alten Stände bleiben. Bisher war damit auch der Anlass weg – `needsRescan`
  // sah keinen Grund, neu geladene Objekte fehlten bis zur nächsten
  // Nachführung, im Ausblick bis zu 90 min. Jetzt fragt der Takt des
  // Wachhunds neu an.
  const farPendingNow = (): ForecastPending | null => forecastState.farPending;
  await waitFor(
    'Kandidat bei T_H, nichts offen',
    () => forecastView.farStatus === 'ready' && forecastView.next !== null && pendingNow() === null && farPendingNow() === null,
    8000,
  );
  // Der Mindestabstand der Lang-Anfragen (2 s) hielte die erste sonst auf –
  // ihr Wachhund fiele dann hinter das Ende des Hängens.
  await sleep(FORECAST_FAR_MIN_REQUEST_GAP_MS);
  const nearBefore = committedNow();
  const farBefore = forecastState.farCommitted;
  const hangAt = performance.now();
  for (const worker of liveWorkers) worker.stall(10_000);
  await sleep(30);
  forecastState.catalogDirty = true;
  forecastState.farDirty = true;
  await sleep(9000);
  const hungNear = requestsSince(hangAt, 'near');
  const hungFar = requestsSince(hangAt, 'far');
  const keptNear = committedNow() === nearBefore;
  const keptFar = forecastState.farCommitted === farBefore;
  const nearGap = (hungNear[1]?.at ?? NaN) - (hungNear[0]?.at ?? NaN);
  const farGap = (hungFar[1]?.at ?? NaN) - (hungFar[0]?.at ?? NaN);
  expect(
    'H Wachhund ohne jede Antwort: alte Stände bleiben, beide Anfragen werden samt Anlass wiederholt',
    keptNear && keptFar && hungNear.length >= 2 && hungFar.length >= 2 && nearGap >= 4000 && nearGap <= 4400 &&
      farGap >= 8000 && farGap <= 8400,
    `in 9 s ${hungNear.length} Kurz-Anfragen (Abstand ${f(nearGap, 0)} ms) und ${hungFar.length} Lang-Anfragen ` +
      `(Abstand ${f(farGap, 0)} ms); Stände ${keptNear ? 'unverändert' : 'ersetzt'} / ${keptFar ? 'unverändert' : 'ersetzt'}`,
  );
  await waitFor(
    'Stände nach dem Hängen',
    () => pendingNow() === null && farPendingNow() === null && committedNow() !== nearBefore && forecastState.farCommitted !== farBefore,
    10_000,
  );
}

/* ------------------------------------------------------------------ */
/* Ende                                                                 */
/* ------------------------------------------------------------------ */

console.log(`${checks} Prüfungen, ${failures} Fehlschläge (Laufzeit ${f((Date.now() - scriptStartedAt) / 1000, 1)} s)`);
if (pool) await pool.unmount();
for (const worker of [...liveWorkers]) worker.terminate();
if (failures > 0) process.exit(1);
console.log('✓ Vorhersage „Demnächst sichtbar“: Scan, Pool, Controller, Szene, Liste und Ausblick wie spezifiziert');
// Der Scheduler von React hält den Prozess sonst offen.
process.exit(0);
