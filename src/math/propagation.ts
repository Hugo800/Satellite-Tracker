import {
  propagate,
  gstime,
  eciToEcf,
  eciToGeodetic,
  ecfToLookAngles,
  degreesLat,
  degreesLong,
} from 'satellite.js';
import type { SatRec } from 'satellite.js';
import type { Ephemeris, ObserverGd, PassPrediction, Vec3 } from '../types';
import { RAD, normalizeAngle } from './coords';
import { isEclipsed, sunEciUnitVector } from './sun';

interface RawPv {
  position?: Vec3 | false | null;
  velocity?: Vec3 | false | null;
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

  return {
    azimuth: normalizeAngle(look.azimuth),
    elevation: look.elevation,
    rangeKm: look.rangeSat,
    positionEci,
    velocityEci: vel,
    latitudeDeg: degreesLat(geo.latitude),
    longitudeDeg: degreesLong(geo.longitude),
    altitudeKm: geo.height,
    speedKmS: Math.hypot(vel.x, vel.y, vel.z),
    eclipsed: isEclipsed(positionEci, sunUnit),
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
    const tcaLook = lookAt(satrec, tca, observer);
    const sunlitAtTca = tcaLook
      ? !isEclipsed(tcaLook.position as Vec3, sunEciUnitVector(new Date(tca)))
      : false;

    return {
      aos,
      tca,
      los,
      maxElevationDeg: maxEl * RAD,
      aosAzimuthDeg: aosLook ? normalizeAngle(aosLook.look.azimuth) * RAD : 0,
      losAzimuthDeg: losLook ? normalizeAngle(losLook.look.azimuth) * RAD : 0,
      durationSec: Math.max(0, (los - aos) / 1000),
      visible: sunlitAtTca,
    };
  }

  return null;
}
