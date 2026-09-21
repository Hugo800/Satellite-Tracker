import { useEffect, useRef } from 'react';
import { useAppStore } from '../state/store';
import type { GeoCoord } from '../types';

/** Fallback, falls der Nutzer die Ortung ablehnt (Greenwich-nahe Mitteleuropa-Referenz). */
export const DEFAULT_OBSERVER: GeoCoord = {
  latitudeDeg: 52.52,
  longitudeDeg: 13.405,
  altitudeKm: 0.04,
};

/**
 * Ab dieser Verschiebung wird der Standort übernommen.
 *
 * Für Objekte in 500–40 000 km Höhe ändert sich die Blickrichtung unterhalb
 * dieser Schwelle um deutlich weniger als ein Grad. Jedes übernommene Update
 * stößt dagegen Effekte in der gesamten App an – `watchPosition` feuert auf
 * Mobilgeräten sekündlich.
 */
const MIN_MOVE_METERS = 200;

function distanceMeters(a: GeoCoord, b: GeoCoord): number {
  const latMeters = (a.latitudeDeg - b.latitudeDeg) * 111_320;
  const lonMeters =
    (a.longitudeDeg - b.longitudeDeg) * 111_320 * Math.cos((a.latitudeDeg * Math.PI) / 180);
  return Math.hypot(latMeters, lonMeters);
}

/**
 * Beobachterstandort per Geolocation-API. Setzt beim ersten Fix den Store und
 * folgt danach nur noch nennenswerten Positionsänderungen.
 */
export function useGeolocation(): void {
  const setObserver = useAppStore((s) => s.setObserver);
  const setGeoError = useAppStore((s) => s.setGeoError);
  const lastAccepted = useRef<GeoCoord | null>(null);

  useEffect(() => {
    const accept = (next: GeoCoord) => {
      const previous = lastAccepted.current;
      if (previous && distanceMeters(previous, next) < MIN_MOVE_METERS) return;
      lastAccepted.current = next;
      setObserver(next);
    };

    // Reihenfolge zählt: `setObserver` löscht `geoError` – ein echter Fix soll
    // den Hinweis verschwinden lassen, der Fallback ihn aber stehen lassen.
    if (!('geolocation' in navigator)) {
      accept(DEFAULT_OBSERVER);
      setGeoError('Geolocation nicht verfügbar – Standardstandort aktiv.');
      return;
    }

    let settled = false;
    const fallbackTimer = window.setTimeout(() => {
      if (settled) return;
      accept(DEFAULT_OBSERVER);
      setGeoError('Ortung dauert zu lange – Standardstandort aktiv.');
    }, 8000);

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        settled = true;
        window.clearTimeout(fallbackTimer);
        accept({
          latitudeDeg: position.coords.latitude,
          longitudeDeg: position.coords.longitude,
          altitudeKm: (position.coords.altitude ?? 40) / 1000,
        });
      },
      (error) => {
        settled = true;
        window.clearTimeout(fallbackTimer);
        accept(DEFAULT_OBSERVER);
        setGeoError(`Ortung fehlgeschlagen (${error.message}) – Standardstandort aktiv.`);
      },
      // Meterpräzision bringt hier nichts, kostet aber Akku und erzeugt Update-Sturm.
      { enableHighAccuracy: false, maximumAge: 120_000, timeout: 15_000 },
    );

    return () => {
      window.clearTimeout(fallbackTimer);
      navigator.geolocation.clearWatch(watchId);
    };
  }, [setObserver, setGeoError]);
}
