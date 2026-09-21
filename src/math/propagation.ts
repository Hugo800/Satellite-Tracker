import {
  propagate,
  sgp4,
  gstime,
  eciToEcf,
  ecfToEci,
  eciToGeodetic,
  geodeticToEcf,
  ecfToLookAngles,
  degreesLat,
  degreesLong,
} from 'satellite.js';
import type { SatRec } from 'satellite.js';
import type { Ephemeris, ObserverGd, PassPrediction, Vec3 } from '../types';
import { EARTH_RADIUS_KM, RAD, normalizeAngle } from './coords';
import { isEclipsed, sunEciUnitVector } from './sun';
import {
  INVISIBLE_MAGNITUDE,
  NAKED_EYE_LIMIT,
  NAKED_EYE_MIN_ELEVATION,
  apparentMagnitude,
  illuminatedFraction,
  phaseAngle,
} from './visibility';

interface RawPv {
  position?: Vec3 | false | null;
  velocity?: Vec3 | false | null;
}

/** Beobachterposition im inertialen Frame – Basis für den Phasenwinkel. */
export function observerEciPosition(observer: ObserverGd, date: Date): Vec3 {
  const ecf = geodeticToEcf(observer as never) as unknown as Vec3;
  return ecfToEci(ecf as never, gstime(date)) as unknown as Vec3;
}

export interface MagnitudeContext {
  observerEci: Vec3;
  standardMagnitude: number;
}

/**
 * SGP4-Propagation eines TLE-Satzes auf einen Zeitpunkt.
 * Gibt `null` zurück, wenn der Propagator divergiert (veraltetes/defektes TLE).
 */
export function propagateEphemeris(
  satrec: SatRec,
  date: Date,
  observer: ObserverGd,
  sunUnit: Vec3 = sunEciUnitVector(date),
  magnitudeContext?: MagnitudeContext,
): Ephemeris | null {
  let pv: RawPv;
  try {
    pv = propagate(satrec, date) as unknown as RawPv;
  } catch {
    return null;
  }

  const positionEci = pv.position;
  const velocityEci = pv.velocity;
  if (!positionEci || typeof positionEci !== 'object') return null;
  if (!Number.isFinite(positionEci.x)) return null;

  const gmst = gstime(date);
  const ecf = eciToEcf(positionEci as never, gmst) as unknown as Vec3;
  const look = ecfToLookAngles(observer as never, ecf as never) as unknown as {
    azimuth: number;
    elevation: number;
    rangeSat: number;
  };
  const geo = eciToGeodetic(positionEci as never, gmst) as unknown as {
    latitude: number;
    longitude: number;
    height: number;
  };

  const vel: Vec3 =
    velocityEci && typeof velocityEci === 'object' ? velocityEci : { x: 0, y: 0, z: 0 };

  const eclipsed = isEclipsed(positionEci, sunUnit);
  const elevation = look.elevation;

  let magnitude = INVISIBLE_MAGNITUDE;
  if (!eclipsed && magnitudeContext) {
    magnitude = apparentMagnitude(
      magnitudeContext.standardMagnitude,
      look.rangeSat,
      phaseAngle(positionEci, magnitudeContext.observerEci, sunUnit),
      elevation,
    );
  }

  return {
    azimuth: normalizeAngle(look.azimuth),
    elevation,
    rangeKm: look.rangeSat,
    positionEci,
    velocityEci: vel,
    latitudeDeg: degreesLat(geo.latitude),
    longitudeDeg: degreesLong(geo.longitude),
    altitudeKm: geo.height,
    speedKmS: Math.hypot(vel.x, vel.y, vel.z),
    eclipsed,
    magnitude,
  };
}

/** Nur die Elevation – schnelle Variante für die Pass-Suche. */
function elevationAt(satrec: SatRec, date: Date, observer: ObserverGd): number {
  let pv: RawPv;
  try {
    pv = propagate(satrec, date) as unknown as RawPv;
  } catch {
    return Number.NaN;
  }
  const position = pv.position;
  if (!position || typeof position !== 'object' || !Number.isFinite(position.x)) return Number.NaN;
  const ecf = eciToEcf(position as never, gstime(date)) as never;
  const look = ecfToLookAngles(observer as never, ecf) as unknown as { elevation: number };
  return look.elevation;
}

function lookAt(satrec: SatRec, ms: number, observer: ObserverGd) {
  const date = new Date(ms);
  let pv: RawPv;
  try {
    pv = propagate(satrec, date) as unknown as RawPv;
  } catch {
    return null;
  }
  const position = pv.position;
  if (!position || typeof position !== 'object' || !Number.isFinite(position.x)) return null;
  const ecf = eciToEcf(position as never, gstime(date)) as never;
  const look = ecfToLookAngles(observer as never, ecf) as unknown as {
    azimuth: number;
    elevation: number;
    rangeSat: number;
  };
  return { look, position };
}

/** Bisektion auf den Zeitpunkt, an dem die Elevation 0° kreuzt. */
function refineHorizonCrossing(
  satrec: SatRec,
  observer: ObserverGd,
  belowMs: number,
  aboveMs: number,
): number {
  let lo = belowMs;
  let hi = aboveMs;
  for (let i = 0; i < 24 && Math.abs(hi - lo) > 500; i += 1) {
    const mid = (lo + hi) / 2;
    const el = elevationAt(satrec, new Date(mid), observer);
    if (Number.isNaN(el)) break;
    if (el > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export interface PassOptions {
  /** Startzeit der Suche (ms seit Epoch). */
  fromMs: number;
  /** Suchfenster in Stunden. */
  searchHours: number;
  /** Grobschritt in Sekunden. */
  stepSec?: number;
  /** Mindest-Elevation in Grad, ab der ein Überflug zählt. */
  minElevationDeg?: number;
  /** Helligkeit bei 1000 km und vollem Phasenwinkel – Basis der Helligkeitsschätzung. */
  standardMagnitude?: number;
}

/** Abtastschritt innerhalb eines gefundenen Überflugs für die Helligkeitsanalyse. */
const BRIGHTNESS_STEP_MS = 15_000;

interface Brightness {
  sunlitStart: number | null;
  sunlitEnd: number | null;
  sunlitSec: number;
  peakMagnitude: number;
  illumination: number;
  nakedEye: boolean;
}

/**
 * Tastet einen Überflug ab und bestimmt, wann der Satellit sonnenbeschienen ist
 * und wie hell er dabei maximal wird.
 */
function analyseBrightness(
  satrec: SatRec,
  observer: ObserverGd,
  aos: number,
  los: number,
  standardMagnitude: number | undefined,
): Brightness {
  const empty: Brightness = {
    sunlitStart: null,
    sunlitEnd: null,
    sunlitSec: 0,
    peakMagnitude: INVISIBLE_MAGNITUDE,
    illumination: 0,
    nakedEye: false,
  };
  if (standardMagnitude === undefined) return empty;

  const result = { ...empty };
  const steps = Math.max(2, Math.ceil((los - aos) / BRIGHTNESS_STEP_MS));

  for (let i = 0; i <= steps; i += 1) {
    const ms = aos + ((los - aos) * i) / steps;
    const found = lookAt(satrec, ms, observer);
    if (!found) continue;

    const date = new Date(ms);
    const sunUnit = sunEciUnitVector(date);
    const position = found.position as Vec3;
    if (isEclipsed(position, sunUnit)) continue;

    if (result.sunlitStart === null) result.sunlitStart = ms;
    result.sunlitEnd = ms;

    const phase = phaseAngle(position, observerEciPosition(observer, date), sunUnit);
    const magnitude = apparentMagnitude(
      standardMagnitude,
      found.look.rangeSat,
      phase,
      found.look.elevation,
    );

    // Bloßes Auge gilt für den gesamten Bogen, nicht nur für das
    // Helligkeitsmaximum: Der hellste Moment kann horizontnah liegen und dort
    // an der Mindesthöhe scheitern, während das Objekt kurz darauf hoch am
    // Himmel steht – minimal schwächer, aber klar zu sehen.
    if (magnitude <= NAKED_EYE_LIMIT && found.look.elevation >= NAKED_EYE_MIN_ELEVATION) {
      result.nakedEye = true;
    }

    if (magnitude < result.peakMagnitude) {
      result.peakMagnitude = magnitude;
      result.illumination = illuminatedFraction(phase);
    }
  }

  if (result.sunlitStart !== null && result.sunlitEnd !== null) {
    result.sunlitSec = Math.max(0, (result.sunlitEnd - result.sunlitStart) / 1000);
  }
  return result;
}

/**
 * Sucht den nächsten Überflug (AOS / TCA / LOS) eines Satelliten über dem Beobachter.
 * Grobraster + Bisektion; für sonnensynchrone LEO-Objekte typisch < 15 ms Rechenzeit.
 */
export function predictNextPass(
  satrec: SatRec,
  observer: ObserverGd,
  options: PassOptions,
): PassPrediction | null {
  const stepMs = (options.stepSec ?? 30) * 1000;
  const endMs = options.fromMs + options.searchHours * 3600_000;
  const minEl = (options.minElevationDeg ?? 5) * (1 / RAD);

  let prevMs = options.fromMs;
  let prevEl = elevationAt(satrec, new Date(prevMs), observer);
  if (Number.isNaN(prevEl)) return null;

  for (let t = prevMs + stepMs; t <= endMs; t += stepMs) {
    const el = elevationAt(satrec, new Date(t), observer);
    if (Number.isNaN(el)) return null;

    const rising = prevEl <= 0 && el > 0;
    if (!rising) {
      prevEl = el;
      prevMs = t;
      continue;
    }

    const aos = refineHorizonCrossing(satrec, observer, prevMs, t);

    // Höchststand + Untergang verfolgen.
    let maxEl = -Math.PI;
    let tca = aos;
    let los = -1;
    let lastAbove = aos;
    let scanEl = el;
    let scanMs = t;
    const fineStep = 10_000;

    while (scanMs <= endMs + 3600_000) {
      if (scanEl > maxEl) {
        maxEl = scanEl;
        tca = scanMs;
      }
      if (scanEl <= 0) {
        los = refineHorizonCrossing(satrec, observer, scanMs, lastAbove);
        break;
      }
      lastAbove = scanMs;
      scanMs += fineStep;
      scanEl = elevationAt(satrec, new Date(scanMs), observer);
      if (Number.isNaN(scanEl)) return null;
    }

    // Stark exzentrische Bahnen bleiben länger über dem Horizont, als das
    // Suchfenster reicht. Dann begrenzt der letzte bestätigte Punkt oberhalb
    // des Horizonts den Überflug – sonst meldete die Vorhersage 0 s Dauer.
    if (los < 0) los = lastAbove;

    if (maxEl < minEl) {
      prevEl = scanEl;
      prevMs = scanMs;
      t = scanMs;
      continue;
    }

    const aosLook = lookAt(satrec, aos, observer);
    const losLook = lookAt(satrec, los, observer);
    const brightness = analyseBrightness(satrec, observer, aos, los, options.standardMagnitude);

    return {
      aos,
      tca,
      los,
      maxElevationDeg: maxEl * RAD,
      aosAzimuthDeg: aosLook ? normalizeAngle(aosLook.look.azimuth) * RAD : 0,
      losAzimuthDeg: losLook ? normalizeAngle(losLook.look.azimuth) * RAD : 0,
      durationSec: Math.max(0, (los - aos) / 1000),
      ...brightness,
    };
  }

  return null;
}

/**
 * Alle Überflüge im Suchfenster. Setzt die Suche jeweils kurz nach dem letzten
 * Untergang fort, sodass das Fenster insgesamt nur einmal abgetastet wird.
 */
export function predictPasses(
  satrec: SatRec,
  observer: ObserverGd,
  options: PassOptions,
  maxPasses = 60,
): PassPrediction[] {
  const endMs = options.fromMs + options.searchHours * 3600_000;
  const passes: PassPrediction[] = [];
  let cursor = options.fromMs;

  while (passes.length < maxPasses && cursor < endMs) {
    const pass = predictNextPass(satrec, observer, {
      ...options,
      fromMs: cursor,
      searchHours: (endMs - cursor) / 3600_000,
    });
    if (!pass) break;
    passes.push(pass);
    // Etwas Abstand hinter den Untergang, damit derselbe Überflug nicht erneut anschlägt.
    cursor = pass.los + 60_000;
  }

  return passes;
}

/* ------------------------------------------------------------------ */
/* Schneller Pfad für die Renderschleife                                */
/* ------------------------------------------------------------------ */

/**
 * Der Massen-Tick propagiert je Frame den gesamten Katalog. `propagateEphemeris`
 * wäre dafür zu teuer: Es ruft `gstime()` pro Satellit auf (identisch für alle),
 * lässt satellite.js das Julianische Datum pro Satellit neu bestimmen und legt
 * pro Aufruf vier Zwischenobjekte an.
 *
 * Die Funktionen unten ziehen alles Zeit- und Ortsabhängige aus der Schleife
 * heraus und schreiben direkt in den Telemetrie-Buffer – kein einziges
 * Objekt pro Satellit. Die Formeln sind identisch zu `eciToEcf`,
 * `ecfToLookAngles` und `eciToGeodetic` aus satellite.js; `scripts/verify-fastpath.mjs`
 * prüft die Gleichheit numerisch gegen die Bibliothek.
 */

const WGS84_A = 6378.137;
const WGS84_B = 6356.7523142;
const WGS84_F = (WGS84_A - WGS84_B) / WGS84_A;
const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F;
const MINUTES_PER_DAY = 1440;
const TAU = Math.PI * 2;

/** Vorberechnete, nur vom Standort abhängige Größen. */
export interface ObserverFrame {
  ecfX: number;
  ecfY: number;
  ecfZ: number;
  sinLat: number;
  cosLat: number;
  sinLon: number;
  cosLon: number;
}

export function buildObserverFrame(observer: ObserverGd): ObserverFrame {
  const sinLat = Math.sin(observer.latitude);
  const cosLat = Math.cos(observer.latitude);
  const sinLon = Math.sin(observer.longitude);
  const cosLon = Math.cos(observer.longitude);
  const normal = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    ecfX: (normal + observer.height) * cosLat * cosLon,
    ecfY: (normal + observer.height) * cosLat * sinLon,
    ecfZ: (normal * (1 - WGS84_E2) + observer.height) * sinLat,
    sinLat,
    cosLat,
    sinLon,
    cosLon,
  };
}

/** Julianisches Datum (UTC) – identisch zu `jday()` aus satellite.js. */
export function julianDayFor(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

/** Nur vom Zeitpunkt abhängige Größen eines Ticks. */
export interface TickFrame {
  julianDay: number;
  sinGmst: number;
  cosGmst: number;
  gmst: number;
  sunUnit: Vec3;
  observerEci: Vec3;
}

export function buildTickFrame(date: Date, observer: ObserverGd): TickFrame {
  const gmst = gstime(date);
  return {
    julianDay: julianDayFor(date),
    sinGmst: Math.sin(gmst),
    cosGmst: Math.cos(gmst),
    gmst,
    sunUnit: sunEciUnitVector(date),
    observerEci: observerEciPosition(observer, date),
  };
}

/**
 * Propagiert einen Satelliten und schreibt Azimut, Elevation, Distanz, Bahnhöhe,
 * Geschwindigkeit, Schattenflag, Subpunkt und Helligkeit ab `base` in `out`.
 * Gibt `false` zurück, wenn der Propagator divergiert.
 *
 * Die Feldreihenfolge entspricht `math/telemetryLayout.ts`; sie wird hier
 * bewusst über Offsets adressiert, damit der Aufrufer keinen Umweg über ein
 * Zwischenobjekt nehmen muss.
 */
export function propagateInto(
  satrec: SatRec,
  frame: ObserverFrame,
  tick: TickFrame,
  standardMagnitude: number,
  out: Float32Array,
  base: number,
  offsets: {
    az: number;
    el: number;
    range: number;
    alt: number;
    speed: number;
    eclipsed: number;
    lat: number;
    lon: number;
    mag: number;
  },
): boolean {
  let pv: RawPv;
  try {
    pv = sgp4(satrec, (tick.julianDay - satrec.jdsatepoch) * MINUTES_PER_DAY) as unknown as RawPv;
  } catch {
    return false;
  }

  const p = pv.position;
  if (!p || typeof p !== 'object' || !Number.isFinite(p.x)) return false;
  const v = pv.velocity;

  /* --- ECI -> ECF (Rotation um die Polachse) --- */
  const ecfX = p.x * tick.cosGmst + p.y * tick.sinGmst;
  const ecfY = -p.x * tick.sinGmst + p.y * tick.cosGmst;
  const ecfZ = p.z;

  /* --- topozentrische Blickwinkel --- */
  const rx = ecfX - frame.ecfX;
  const ry = ecfY - frame.ecfY;
  const rz = ecfZ - frame.ecfZ;

  const topS = frame.sinLat * frame.cosLon * rx + frame.sinLat * frame.sinLon * ry - frame.cosLat * rz;
  const topE = -frame.sinLon * rx + frame.cosLon * ry;
  const topZ = frame.cosLat * frame.cosLon * rx + frame.cosLat * frame.sinLon * ry + frame.sinLat * rz;

  const rangeKm = Math.sqrt(topS * topS + topE * topE + topZ * topZ);
  if (!(rangeKm > 0)) return false;

  const elevation = Math.asin(topZ / rangeKm);
  let azimuth = Math.atan2(-topE, topS) + Math.PI;
  azimuth = ((azimuth % TAU) + TAU) % TAU;

  /* --- Subpunkt (iterativ, bricht ab sobald konvergiert) --- */
  const R = Math.hypot(p.x, p.y);
  let longitude = Math.atan2(p.y, p.x) - tick.gmst;
  longitude = ((((longitude + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

  let latitude = Math.atan2(p.z, R);
  let C = 1;
  for (let i = 0; i < 20; i += 1) {
    const sinLat = Math.sin(latitude);
    C = 1 / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    const next = Math.atan2(p.z + WGS84_A * C * WGS84_E2 * sinLat, R);
    const converged = Math.abs(next - latitude) < 1e-13;
    latitude = next;
    if (converged) break;
  }
  const heightKm = R / Math.cos(latitude) - WGS84_A * C;

  /* --- Beleuchtung --- */
  const sun = tick.sunUnit;
  const dot = p.x * sun.x + p.y * sun.y + p.z * sun.z;
  let eclipsed = false;
  if (dot <= 0) {
    const ax = p.x - dot * sun.x;
    const ay = p.y - dot * sun.y;
    const az = p.z - dot * sun.z;
    eclipsed = Math.hypot(ax, ay, az) < EARTH_RADIUS_KM;
  }

  let magnitude = INVISIBLE_MAGNITUDE;
  if (!eclipsed) {
    const ox = tick.observerEci.x - p.x;
    const oy = tick.observerEci.y - p.y;
    const oz = tick.observerEci.z - p.z;
    const length = Math.hypot(ox, oy, oz) || 1;
    let cosPhase = (ox * sun.x + oy * sun.y + oz * sun.z) / length;
    cosPhase = cosPhase > 1 ? 1 : cosPhase < -1 ? -1 : cosPhase;
    magnitude = apparentMagnitude(standardMagnitude, rangeKm, Math.acos(cosPhase), elevation);
  }

  out[base + offsets.az] = azimuth;
  out[base + offsets.el] = elevation;
  out[base + offsets.range] = rangeKm;
  out[base + offsets.alt] = heightKm;
  out[base + offsets.speed] =
    v && typeof v === 'object' ? Math.hypot(v.x, v.y, v.z) : 0;
  out[base + offsets.eclipsed] = eclipsed ? 1 : 0;
  out[base + offsets.lat] = latitude * RAD;
  out[base + offsets.lon] = longitude * RAD;
  out[base + offsets.mag] = magnitude;
  return true;
}
