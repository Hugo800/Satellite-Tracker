import { Vector3 } from 'three';
import type { GeoCoord, ObserverGd, Vec3 } from '../types';

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const EARTH_RADIUS_KM = 6378.137;

export const toDeg = (rad: number): number => rad * RAD;
export const toRad = (deg: number): number => deg * DEG;

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

/**
 * Szenen-Konvention (ENU -> Three.js):
 *   +Y = Zenit, -Z = Nord, +X = Ost.
 * Damit entspricht die Default-Blickrichtung der Kamera (-Z) exakt Azimut 0°.
 */
export function azElToVector(
  azimuthRad: number,
  elevationRad: number,
  radius: number,
  target?: Vector3,
): Vector3 {
  const cosEl = Math.cos(elevationRad);
  const out = target ?? new Vector3();
  return out.set(
    radius * cosEl * Math.sin(azimuthRad),
    radius * Math.sin(elevationRad),
    -radius * cosEl * Math.cos(azimuthRad),
  );
}

/** Umkehrung von {@link azElToVector} – erwartet einen beliebig langen Vektor. */
export function vectorToAzEl(v: Vector3): { azimuth: number; elevation: number } {
  const horizontal = Math.hypot(v.x, v.z);
  const azimuth = normalizeAngle(Math.atan2(v.x, -v.z));
  const elevation = Math.atan2(v.y, horizontal);
  return { azimuth, elevation };
}

/** Normalisiert einen Winkel auf [0, 2π). */
export function normalizeAngle(rad: number): number {
  const twoPi = Math.PI * 2;
  return ((rad % twoPi) + twoPi) % twoPi;
}

/** Kürzeste Differenz zweier Winkel im Bereich (-π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function geoToObserverGd(geo: GeoCoord): ObserverGd {
  return {
    latitude: geo.latitudeDeg * DEG,
    longitude: geo.longitudeDeg * DEG,
    height: geo.altitudeKm,
  };
}

export function vecLength(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/** Kompass-Kürzel (N, NO, O …) für einen Azimut in Grad. */
const COMPASS_16 = [
  'N',
  'NNO',
  'NO',
  'ONO',
  'O',
  'OSO',
  'SO',
  'SSO',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const;

export function compassLabel(azimuthDeg: number): string {
  const idx = Math.round((((azimuthDeg % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS_16[idx];
}
