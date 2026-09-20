import { DEG, EARTH_RADIUS_KM } from './coords';
import type { Vec3 } from '../types';

/** Julianisches Datum aus einem JS-Date. */
export function julianDate(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * Sonnenrichtung als Einheitsvektor im (quasi-inertialen) TEME/ECI-Frame.
 * Low-precision-Formel des Astronomical Almanac – Genauigkeit ~0.01°,
 * mehr als ausreichend für die Erdschatten-Klassifikation.
 */
export function sunEciUnitVector(date: Date): Vec3 {
  const n = julianDate(date) - 2451545.0;
  const meanLon = (280.46 + 0.9856474 * n) * DEG;
  const meanAnom = (357.528 + 0.9856003 * n) * DEG;
  const eclipticLon =
    meanLon + 1.915 * DEG * Math.sin(meanAnom) + 0.02 * DEG * Math.sin(2 * meanAnom);
  const obliquity = (23.439 - 0.0000004 * n) * DEG;

  const sinLon = Math.sin(eclipticLon);
  return {
    x: Math.cos(eclipticLon),
    y: Math.cos(obliquity) * sinLon,
    z: Math.sin(obliquity) * sinLon,
  };
}

/**
 * Zylinderschatten-Modell: Der Satellit liegt im Erdschatten, wenn er auf der
 * sonnenabgewandten Seite steht und sein Abstand zur Erd-Sonnen-Achse kleiner
 * als der Erdradius ist.
 */
export function isEclipsed(positionEci: Vec3, sunUnit: Vec3): boolean {
  const dot = positionEci.x * sunUnit.x + positionEci.y * sunUnit.y + positionEci.z * sunUnit.z;
  if (dot > 0) return false; // sonnenzugewandte Hemisphäre -> immer beleuchtet

  const px = positionEci.x - dot * sunUnit.x;
  const py = positionEci.y - dot * sunUnit.y;
  const pz = positionEci.z - dot * sunUnit.z;
  return Math.hypot(px, py, pz) < EARTH_RADIUS_KM;
}
