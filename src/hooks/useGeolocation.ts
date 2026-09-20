import { useEffect } from 'react';
import { useAppStore } from '../state/store';

/** Fallback, falls der Nutzer die Ortung ablehnt (Greenwich-nahe Mitteleuropa-Referenz). */
export const DEFAULT_OBSERVER = {
  latitudeDeg: 52.5200,
  longitudeDeg: 13.4050,
  altitudeKm: 0.04,
};

/**
 * Beobachterstandort per Geolocation-API. Setzt beim ersten Fix den Store und
 * folgt danach Positionsänderungen (wichtig für mobile Nutzung im Feld).
 */
export function useGeolocation(): void {
  const setObserver = useAppStore((s) => s.setObserver);
  const setGeoError = useAppStore((s) => s.setGeoError);

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGeoError('Geolocation nicht verfügbar – Standardstandort aktiv.');
      setObserver(DEFAULT_OBSERVER);
      return;
    }

    let settled = false;
    const fallbackTimer = window.setTimeout(() => {
      if (!settled) setObserver(DEFAULT_OBSERVER);
    }, 8000);

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        settled = true;
        window.clearTimeout(fallbackTimer);
        setObserver({
          latitudeDeg: position.coords.latitude,
          longitudeDeg: position.coords.longitude,
          altitudeKm: (position.coords.altitude ?? 40) / 1000,
        });
      },
      (error) => {
        settled = true;
        window.clearTimeout(fallbackTimer);
        setGeoError(`Ortung fehlgeschlagen (${error.message}) – Standardstandort aktiv.`);
        setObserver(DEFAULT_OBSERVER);
      },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 15_000 },
    );

    return () => {
      window.clearTimeout(fallbackTimer);
      navigator.geolocation.clearWatch(watchId);
    };
  }, [setObserver, setGeoError]);
}
