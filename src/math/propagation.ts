import {
  propagate,
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
import { RAD, normalizeAngle } from './coords';
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
    if (magnitude < result.peakMagnitude) {
      result.peakMagnitude = magnitude;
      result.illumination = illuminatedFraction(phase);
      result.nakedEye =
        magnitude <= NAKED_EYE_LIMIT && found.look.elevation >= NAKED_EYE_MIN_ELEVATION;
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
    let los = aos;
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
