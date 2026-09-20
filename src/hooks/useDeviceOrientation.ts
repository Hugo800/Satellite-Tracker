import { useCallback, useEffect, useRef } from 'react';
import { Euler, Quaternion, Vector3 } from 'three';
import { DEG, RAD, angleDelta, clamp, normalizeAngle } from '../math/coords';
import { orientationState } from '../state/runtime';
import { useAppStore } from '../state/store';
import type { CompassStatus } from '../types';

interface IosDeviceOrientationEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

type PermissionCapableCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
};

/** Tiefster Blickwinkel im AR-Modus – darunter rastet die Ansicht ein. */
const AR_MIN_ELEVATION = -6 * DEG;
/** Ab hier zeigt das Gerät nahezu senkrecht; der Azimut ist dort entartet. */
const NEAR_VERTICAL = 0.97;
/** iOS meldet die Kompassgüte in Grad; darüber gilt er als unkalibriert. */
const MAX_COMPASS_ACCURACY_DEG = 25;
/**
 * Grunddämpfung und Fehlerabhängigkeit des Kursfilters (bezogen auf 60 Hz).
 * Simuliert: dämpft ±4° Magnetometerrauschen auf ~0,6° bei ~4,6° Nachlauf
 * während einer 90°/s-Drehung.
 */
const HEADING_GAIN_MIN = 0.06;
const HEADING_GAIN_SLOPE = 1.6;

const ZEE = new Vector3(0, 0, 1);
const EULER = new Euler();
const Q0 = new Quaternion();
/** −90° um X: Gerätesystem (Bildschirm-normal = +Z) -> Kamerasystem (Blick = −Z). */
const Q1 = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

const forward = new Vector3();
const upVector = new Vector3();
const pitchAxis = new Vector3();
const pitchFix = new Quaternion();
const candidate = new Quaternion();

/**
 * Wandelt die Euler-Winkel des `deviceorientation`-Events in ein Quaternion,
 * das direkt auf die R3F-Kamera gelegt werden kann.
 *
 * Bewusst über Quaternionen statt Euler-Zuweisung: Beim Blick in den Zenit
 * (beta ≈ 90°) läuft eine naive Euler-Kette in den Gimbal Lock.
 *
 * Resultierendes Weltsystem: +Y = Zenit, −Z = Nord, +X = Ost.
 */
function orientationToQuaternion(
  target: Quaternion,
  alphaRad: number,
  betaRad: number,
  gammaRad: number,
  screenAngleRad: number,
): Quaternion {
  EULER.set(betaRad, alphaRad, -gammaRad, 'YXZ');
  target.setFromEuler(EULER);
  target.multiply(Q1);
  target.multiply(Q0.setFromAxisAngle(ZEE, -screenAngleRad));
  return target;
}

function readScreenAngle(): number {
  const screenAngle = typeof screen !== 'undefined' ? screen.orientation?.angle : undefined;
  const legacyAngle = (window as unknown as { orientation?: number }).orientation;
  return (screenAngle ?? legacyAngle ?? 0) * DEG;
}

/**
 * Begrenzt die Blickrichtung nach unten, ohne Kurs und Rollwinkel zu verfälschen.
 *
 * Gedreht wird um die Normale der Vertikalebene der Blickrichtung – *nicht* um
 * die lokale X-Achse der Kamera, die im Querformat schräg steht und dabei den
 * Azimut mitziehen würde. Unterhalb der Grenze steht das Bild still, statt in
 * die Bodenebene zu kippen.
 */
function clampPitch(q: Quaternion, minElevation: number): void {
  forward.set(0, 0, -1).applyQuaternion(q);
  const horizontal = Math.hypot(forward.x, forward.z);
  const elevation = Math.atan2(forward.y, horizontal);
  if (elevation >= minElevation) return;

  if (horizontal > 1e-4) {
    pitchAxis.set(-forward.z, 0, forward.x);
  } else {
    // Exakt senkrechter Blick: Kurs aus der Bildschirm-Oben-Richtung ableiten.
    upVector.set(0, 1, 0).applyQuaternion(q);
    pitchAxis.set(-upVector.z, 0, upVector.x);
  }
  if (pitchAxis.lengthSq() < 1e-8) return;

  pitchFix.setFromAxisAngle(pitchAxis.normalize(), minElevation - elevation);
  q.premultiply(pitchFix);
}

export interface DeviceOrientationApi {
  /** Fordert (iOS 13+) die Sensor-Berechtigung an und startet das Tracking. */
  enable: () => Promise<boolean>;
  disable: () => void;
}

/**
 * Kompass-/Gyroskop-Anbindung. Schreibt ausschließlich in `orientationState`
 * (Ref-artiger Modulzustand) – kein React-Render pro Sensor-Sample (~60 Hz).
 */
export function useDeviceOrientation(): DeviceOrientationApi {
  const setAr = useAppStore((s) => s.setAr);
  const setArSupported = useAppStore((s) => s.setArSupported);
  const setCompassStatus = useAppStore((s) => s.setCompassStatus);
  const pushError = useAppStore((s) => s.pushError);
  const arEnabled = useAppStore((s) => s.arEnabled);
  const statusRef = useRef<CompassStatus>('unknown');

  useEffect(() => {
    setArSupported(typeof window !== 'undefined' && 'DeviceOrientationEvent' in window);
  }, [setArSupported]);

  useEffect(() => {
    if (!arEnabled) {
      orientationState.available = false;
      statusRef.current = 'unknown';
      setCompassStatus('unknown');
      return;
    }

    // Zirkulärer Tiefpass auf den Kurs: gemittelt wird über sin/cos, damit der
    // Sprung zwischen 359° und 0° keinen Ausreißer erzeugt.
    let headingSin = 0;
    let headingCos = 0;
    let headingReady = false;
    let sawAbsolute = false;
    let lastSampleMs = 0;

    const publishStatus = (status: CompassStatus) => {
      if (statusRef.current === status) return;
      statusRef.current = status;
      setCompassStatus(status);
    };

    const handleOrientation = (event: Event) => {
      const e = event as IosDeviceOrientationEvent;
      if (e.alpha === null && e.beta === null && e.gamma === null) return;

      const isAbsolute = event.type === 'deviceorientationabsolute' || e.absolute === true;
      const iosHeading = typeof e.webkitCompassHeading === 'number' ? e.webkitCompassHeading : null;

      if (isAbsolute) sawAbsolute = true;
      // Relative Events verwerfen, sobald eine erdfeste Quelle liefert – sonst
      // überschreibt der driftende Kreiselkurs den kalibrierten Kompasskurs.
      else if (sawAbsolute && iosHeading === null) return;

      const accuracy = e.webkitCompassAccuracy;
      if (iosHeading !== null) {
        const poor =
          typeof accuracy === 'number' && (accuracy < 0 || accuracy > MAX_COMPASS_ACCURACY_DEG);
        orientationState.accuracyDeg = typeof accuracy === 'number' ? accuracy : null;
        publishStatus(poor ? 'calibrating' : 'ok');
      } else {
        orientationState.accuracyDeg = null;
        publishStatus(isAbsolute ? 'ok' : 'relative');
      }

      // iOS zählt den Kurs im Uhrzeigersinn, `alpha` läuft entgegengesetzt.
      const headingRad =
        iosHeading !== null ? ((360 - iosHeading) % 360) * DEG : (e.alpha ?? 0) * DEG;
      const betaRad = (e.beta ?? 0) * DEG;
      const gammaRad = (e.gamma ?? 0) * DEG;
      const screenAngle = readScreenAngle();
      const previousHeading = headingReady ? Math.atan2(headingSin, headingCos) : headingRad;

      const now = performance.now();
      const dt = lastSampleMs > 0 ? Math.min(0.2, (now - lastSampleMs) / 1000) : 1 / 60;
      lastSampleMs = now;

      // Liegt das Gerät flach, ist der Azimut mathematisch entartet und springt
      // wild – in diesem Bereich wird der zuletzt stabile Kurs gehalten.
      orientationToQuaternion(candidate, previousHeading, betaRad, gammaRad, screenAngle);
      forward.set(0, 0, -1).applyQuaternion(candidate);
      const nearVertical = Math.abs(forward.y) > NEAR_VERTICAL;

      if (!headingReady) {
        headingSin = Math.sin(headingRad);
        headingCos = Math.cos(headingRad);
        headingReady = true;
      } else if (!nearVertical) {
        // Adaptiv über den Regelfehler: Rauschen wird stark gedämpft, bewusste
        // Drehungen öffnen den Filter. Auf die reale Ereignisrate normiert,
        // da Android häufig nur 15–30 Hz liefert.
        const step = Math.abs(angleDelta(headingRad, previousHeading));
        const gain60 = clamp(HEADING_GAIN_MIN + step * HEADING_GAIN_SLOPE, HEADING_GAIN_MIN, 0.6);
        const k = 1 - Math.pow(1 - gain60, dt * 60);

        headingSin += (Math.sin(headingRad) - headingSin) * k;
        headingCos += (Math.cos(headingRad) - headingCos) * k;
      }

      const smoothedHeading = Math.atan2(headingSin, headingCos);
      orientationToQuaternion(candidate, smoothedHeading, betaRad, gammaRad, screenAngle);
      clampPitch(candidate, AR_MIN_ELEVATION);

      orientationState.quaternion.copy(candidate);
      orientationState.screenAngle = screenAngle;
      orientationState.headingDeg = normalizeAngle(-smoothedHeading) * RAD;
      orientationState.available = true;
    };

    // Android liefert den erdfesten Kompass über `deviceorientationabsolute`,
    // iOS ausschließlich über `deviceorientation` + `webkitCompassHeading`.
    window.addEventListener('deviceorientationabsolute', handleOrientation, true);
    window.addEventListener('deviceorientation', handleOrientation, true);

    const timeout = window.setTimeout(() => {
      if (!orientationState.available) {
        pushError('Keine Sensordaten empfangen – AR-Modus benötigt HTTPS und ein Gyroskop.');
      }
    }, 2500);

    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('deviceorientationabsolute', handleOrientation, true);
      window.removeEventListener('deviceorientation', handleOrientation, true);
      orientationState.available = false;
    };
  }, [arEnabled, pushError, setCompassStatus]);

  const enable = useCallback(async (): Promise<boolean> => {
    const Ctor = DeviceOrientationEvent as PermissionCapableCtor;
    if (typeof Ctor?.requestPermission === 'function') {
      try {
        const result = await Ctor.requestPermission();
        if (result !== 'granted') {
          pushError('Sensor-Zugriff abgelehnt. AR-Modus nicht möglich.');
          return false;
        }
      } catch {
        pushError('Sensor-Dialog konnte nicht geöffnet werden (Nutzergeste erforderlich).');
        return false;
      }
    }
    setAr(true);
    return true;
  }, [pushError, setAr]);

  const disable = useCallback(() => setAr(false), [setAr]);

  return { enable, disable };
}
