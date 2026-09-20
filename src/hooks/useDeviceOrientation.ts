import { useCallback, useEffect } from 'react';
import { Euler, Quaternion, Vector3 } from 'three';
import { orientationState } from '../state/runtime';
import { useAppStore } from '../state/store';

interface IosDeviceOrientationEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

type PermissionCapableCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
};

const ZEE = new Vector3(0, 0, 1);
const EULER = new Euler();
const Q0 = new Quaternion();
/** −90° um X: Gerätesystem (Bildschirm-normal = +Z) -> Kamerasystem (Blick = −Z). */
const Q1 = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

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
  const angle =
    (typeof screen !== 'undefined' && screen.orientation?.angle) ||
    (window as unknown as { orientation?: number }).orientation ||
    0;
  return (angle * Math.PI) / 180;
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
  const pushError = useAppStore((s) => s.pushError);
  const arEnabled = useAppStore((s) => s.arEnabled);

  useEffect(() => {
    setArSupported(typeof window !== 'undefined' && 'DeviceOrientationEvent' in window);
  }, [setArSupported]);

  useEffect(() => {
    if (!arEnabled) {
      orientationState.available = false;
      return;
    }

    const handleOrientation = (event: Event) => {
      const e = event as IosDeviceOrientationEvent;
      if (e.alpha === null && e.beta === null && e.gamma === null) return;

      const screenAngle = readScreenAngle();
      const heading =
        typeof e.webkitCompassHeading === 'number'
          ? (360 - e.webkitCompassHeading) % 360
          : (e.alpha ?? 0);

      orientationToQuaternion(
        orientationState.quaternion,
        (heading * Math.PI) / 180,
        ((e.beta ?? 0) * Math.PI) / 180,
        ((e.gamma ?? 0) * Math.PI) / 180,
        screenAngle,
      );
      orientationState.screenAngle = screenAngle;
      orientationState.headingDeg = (360 - heading) % 360;
      orientationState.available = true;
    };

    // `deviceorientationabsolute` liefert auf Android den erdfesten Kompass.
    const absoluteSupported = 'ondeviceorientationabsolute' in window;
    const eventName = absoluteSupported ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(eventName, handleOrientation, true);

    const timeout = window.setTimeout(() => {
      if (!orientationState.available) {
        pushError('Keine Sensordaten empfangen – AR-Modus benötigt HTTPS und ein Gyroskop.');
      }
    }, 2500);

    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener(eventName, handleOrientation, true);
      orientationState.available = false;
    };
  }, [arEnabled, pushError]);

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
