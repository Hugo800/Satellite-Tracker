import { useCallback, useEffect, useRef } from 'react';
import { Quaternion, Vector3 } from 'three';
import { DEG, RAD, normalizeAngle } from '../math/coords';
import { decimalYear, magneticDeclinationDeg } from '../math/declination';
import {
  AR_MIN_ELEVATION,
  HeadingFusion,
  MAX_COMPASS_ACCURACY_DEG,
  attitudeToCamera,
  clampPitch,
  type OrientationSample,
} from '../math/orientation';
import { orientationState, type OrientationState } from '../state/runtime';
import { useAppStore } from '../state/store';
import type { CompassStatus, GeoCoord } from '../types';

interface IosDeviceOrientationEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

type PermissionCapableCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
};

const camera = new Quaternion();
const forward = new Vector3();

/**
 * Eventtypen des AR-Modus. Android liefert den erdfesten Kompass über
 * `deviceorientationabsolute` und den relativen Kreiselstrom über
 * `deviceorientation`; iOS liefert alles über `deviceorientation` +
 * `webkitCompassHeading`.
 */
export const ORIENTATION_EVENT_TYPES = ['deviceorientationabsolute', 'deviceorientation'] as const;

/**
 * Hängt `handler` an beide Eventtypen (Capture-Phase); gibt die Abmeldung zurück.
 * Die Option als Objekt statt `true`: Node (Prüfskript) wertet beim Abmelden nur
 * `{ capture }` aus, Browser beides gleich.
 */
export function listenForOrientation(target: EventTarget, handler: (event: Event) => void): () => void {
  const options = { capture: true };
  for (const type of ORIENTATION_EVENT_TYPES) target.addEventListener(type, handler, options);
  return () => {
    for (const type of ORIENTATION_EVENT_TYPES) target.removeEventListener(type, handler, options);
  };
}

/**
 * Wandelt ein Orientierungs-Event in ein Sample der Kursfusion; `null`, wenn es
 * keine Lage trägt (alle drei Winkel `null`: Gerät ohne Sensor).
 *
 * Rein und ohne Browser-Objekte, damit scripts/verify-orientation.ts die
 * Umwandlung mit echten Event-Objekten prüfen kann. Zwei Fehler, die hier schon
 * einmal steckten und die Fusion nicht bemerken kann: die Deklination nur auf
 * erdfesten Events (iOS lag damit um die volle Deklination daneben) und eine
 * verschluckte Genauigkeit (der WebKit-Platzhalter Kurs 0 bei Genauigkeit −1
 * wurde dann zum Nordbezug).
 */
export function orientationSample(
  event: Event,
  timeMs: number,
  declinationRad: number,
): OrientationSample | null {
  const e = event as IosDeviceOrientationEvent;
  if (e.alpha === null && e.beta === null && e.gamma === null) return null;

  const absolute = event.type === 'deviceorientationabsolute' || e.absolute === true;
  const heading = e.webkitCompassHeading;
  // Negativ heißt laut Apple „ungültige Richtung“.
  const compass =
    !absolute && typeof heading === 'number' && Number.isFinite(heading) && heading >= 0
      ? heading
      : null;
  const accuracy =
    typeof e.webkitCompassAccuracy === 'number' && Number.isFinite(e.webkitCompassAccuracy)
      ? e.webkitCompassAccuracy
      : null;

  return {
    timeMs,
    stream: event.type,
    alphaRad: (e.alpha ?? 0) * DEG,
    betaRad: (e.beta ?? 0) * DEG,
    gammaRad: (e.gamma ?? 0) * DEG,
    absolute,
    // iOS zählt den Kurs im Uhrzeigersinn; die Umrechnung auf alpha macht die Fusion.
    compassHeadingRad: compass === null ? null : compass * DEG,
    // Ungefiltert weitergereicht: Den WebKit-Platzhalter (Kurs 0 bei
    // Genauigkeit −1) verwirft erst die Fusion.
    compassAccuracyDeg: compass === null ? null : accuracy,
    // Beide Quellen sind magnetisch: Android `deviceorientationabsolute` und
    // iOS `webkitCompassHeading` = `CLHeading.magneticHeading`
    // (WebKit, Source/WebCore/platform/ios/WebCoreMotionManager.mm, Z. 318;
    // `trueHeading` kommt dort nicht vor). Also auf jedem Event.
    declinationRad,
  };
}

/**
 * Deklination am Standort in Radiant, Ost positiv. Rechnet nur neu, wenn sich
 * das Standortobjekt ändert – `observer` im Store wechselt erst ab 200 m.
 */
export function createDeclinationReader(
  observer: () => GeoCoord | null,
  now: () => Date = () => new Date(),
): () => number {
  let cachedObserver: GeoCoord | null = null;
  let declinationRad = 0;
  return () => {
    const current = observer();
    if (current !== cachedObserver) {
      cachedObserver = current;
      // Ohne Standort bleibt der magnetische Kurs unkorrigiert; das ist kein
      // Fehlerzustand, nur einige Grad ungenauer.
      declinationRad = current
        ? magneticDeclinationDeg(
            current.latitudeDeg,
            current.longitudeDeg,
            current.altitudeKm,
            decimalYear(now()),
          ) * DEG
        : 0;
    }
    return declinationRad;
  };
}

export interface OrientationHandlerOptions {
  /** Ziel der Kameralage; im Betrieb `orientationState`. */
  state: OrientationState;
  /** Monotone Zeit in ms. */
  now: () => number;
  declinationRad: () => number;
  screenAngleRad: () => number;
  publishStatus: (status: CompassStatus) => void;
}

/**
 * Verarbeitet die Orientierungs-Events des AR-Modus: Sample bilden,
 * fusionieren, Kompassstatus melden, Kameralage in `state` schreiben. Ohne
 * React und ohne globale Browser-Objekte (alles über `options`), damit die
 * Kette Event → Kamera ohne Browser prüfbar ist.
 */
export function createOrientationHandler(options: OrientationHandlerOptions): (event: Event) => void {
  const { state } = options;
  const fusion = new HeadingFusion();
  state.accuracyDeg = null;

  return (event: Event) => {
    const sample = orientationSample(event, options.now(), options.declinationRad());
    if (sample === null) return;
    if (sample.compassHeadingRad !== null) state.accuracyDeg = sample.compassAccuracyDeg ?? null;
    if (!fusion.push(sample)) return;

    // Der Status hängt am Nordbezug der Fusion, nicht am einzelnen Event:
    // Fehlt iOS in einem Event der Kompasswert, gilt der letzte weiter.
    const lastAccuracy = state.accuracyDeg;
    const poor =
      lastAccuracy !== null && (lastAccuracy < 0 || lastAccuracy > MAX_COMPASS_ACCURACY_DEG);
    options.publishStatus(!fusion.referenced ? 'relative' : poor ? 'calibrating' : 'ok');

    const screenAngle = options.screenAngleRad();
    attitudeToCamera(camera, fusion.attitude, screenAngle);
    clampPitch(camera, AR_MIN_ELEVATION);
    forward.set(0, 0, -1).applyQuaternion(camera);

    state.quaternion.copy(camera);
    state.screenAngle = screenAngle;
    state.headingDeg = normalizeAngle(Math.atan2(forward.x, -forward.z)) * RAD;
    state.available = true;
  };
}

function readScreenAngle(): number {
  const screenAngle = typeof screen !== 'undefined' ? screen.orientation?.angle : undefined;
  const legacyAngle = (window as unknown as { orientation?: number }).orientation;
  return (screenAngle ?? legacyAngle ?? 0) * DEG;
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

    const handleOrientation = createOrientationHandler({
      state: orientationState,
      now: () => performance.now(),
      declinationRad: createDeclinationReader(() => useAppStore.getState().observer),
      screenAngleRad: readScreenAngle,
      publishStatus: (status) => {
        if (statusRef.current === status) return;
        statusRef.current = status;
        setCompassStatus(status);
      },
    });
    const stopListening = listenForOrientation(window, handleOrientation);

    const timeout = window.setTimeout(() => {
      if (!orientationState.available) {
        pushError('Keine Sensordaten empfangen – AR-Modus benötigt HTTPS und ein Gyroskop.');
      }
    }, 2500);

    return () => {
      window.clearTimeout(timeout);
      stopListening();
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
