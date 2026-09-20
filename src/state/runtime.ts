import { Quaternion, Vector3 } from 'three';
import {
  TELEMETRY_STRIDE,
  T_ALT,
  T_AZ,
  T_ECLIPSED,
  T_EL,
  T_LAT,
  T_LON,
  T_RANGE,
  T_SPEED,
} from '../math/telemetryLayout';

/**
 * Bewusst *außerhalb* von React gehaltener Laufzeit-Zustand.
 *
 * Positionen, Winkel und Quaternionen ändern sich pro Frame. Lägen sie im
 * React-State, würde jeder Tick einen Re-Render des gesamten Baums auslösen.
 * Stattdessen mutieren wir diese Objekte direkt und lesen sie in `useFrame`
 * bzw. in rAF-Schleifen der 2D-Overlays.
 */

export interface TelemetryStore {
  count: number;
  data: Float32Array;
  timeMs: number;
  /** Monoton steigend – Overlays erkennen daran neue Daten. */
  revision: number;
}

export const telemetry: TelemetryStore = {
  count: 0,
  data: new Float32Array(0),
  timeMs: Date.now(),
  revision: 0,
};

export interface SatelliteSample {
  azimuth: number;
  elevation: number;
  rangeKm: number;
  altitudeKm: number;
  speedKmS: number;
  eclipsed: boolean;
  latitudeDeg: number;
  longitudeDeg: number;
}

/** Liest einen Telemetrie-Datensatz. Gibt `null` zurück, wenn der Index leer ist. */
export function readSample(index: number, out?: SatelliteSample): SatelliteSample | null {
  if (index < 0 || index >= telemetry.count) return null;
  const d = telemetry.data;
  const base = index * TELEMETRY_STRIDE;
  const range = d[base + T_RANGE];
  if (!Number.isFinite(range)) return null;

  const target = out ?? ({} as SatelliteSample);
  target.azimuth = d[base + T_AZ];
  target.elevation = d[base + T_EL];
  target.rangeKm = range;
  target.altitudeKm = d[base + T_ALT];
  target.speedKmS = d[base + T_SPEED];
  target.eclipsed = d[base + T_ECLIPSED] > 0.5;
  target.latitudeDeg = d[base + T_LAT];
  target.longitudeDeg = d[base + T_LON];
  return target;
}

export interface ViewState {
  /** Aktuelle Kamera-Orientierung (wird vom CameraRig jeden Frame gespiegelt). */
  quaternion: Quaternion;
  forward: Vector3;
  azimuthDeg: number;
  elevationDeg: number;
  fovDeg: number;
  aspect: number;
  /** Ziel für die weiche Kamera-Anfahrt; wird vom Rig konsumiert. */
  focus: { azimuth: number; elevation: number; startedAt: number } | null;
}

export const viewState: ViewState = {
  quaternion: new Quaternion(),
  forward: new Vector3(0, 0, -1),
  azimuthDeg: 0,
  elevationDeg: 0,
  fovDeg: 70,
  aspect: 1,
  focus: null,
};

export interface OrientationState {
  quaternion: Quaternion;
  available: boolean;
  headingDeg: number;
  /** Bildschirmrotation in Radiant. */
  screenAngle: number;
  /** Kompassgenauigkeit in Grad, sofern die Plattform sie meldet (iOS). */
  accuracyDeg: number | null;
}

export const orientationState: OrientationState = {
  quaternion: new Quaternion(),
  available: false,
  headingDeg: 0,
  screenAngle: 0,
  accuracyDeg: null,
};

/** Bahnspur des aktuell selektierten Objekts (Einheitsvektoren, xyz-interleaved). */
export const trailState: { index: number; points: Float32Array | null; version: number } = {
  index: -1,
  points: null,
  version: 0,
};

export function requestFocus(azimuth: number, elevation: number): void {
  viewState.focus = { azimuth, elevation, startedAt: performance.now() };
}
