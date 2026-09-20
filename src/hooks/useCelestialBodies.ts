import { useEffect } from 'react';
import { Body, Equator, Horizon, Illumination, Observer } from 'astronomy-engine';
import { useAppStore } from '../state/store';
import type { MoonState, SunState } from '../types';

/** Topozentrische Position eines Körpers (Azimut/Höhe) am Beobachterstandort. */
function horizontalPosition(
  body: Body,
  observer: Observer,
  date: Date,
): { altitudeDeg: number; azimuthDeg: number } {
  const equatorial = Equator(body, date, observer, true, true);
  const horizontal = Horizon(date, observer, equatorial.ra, equatorial.dec, 'normal');
  return { altitudeDeg: horizontal.altitude, azimuthDeg: horizontal.azimuth };
}

export function computeSunState(
  latitudeDeg: number,
  longitudeDeg: number,
  altitudeKm: number,
  date: Date,
): SunState {
  const observer = new Observer(latitudeDeg, longitudeDeg, altitudeKm * 1000);
  return horizontalPosition(Body.Sun, observer, date);
}

export function computeMoonState(
  latitudeDeg: number,
  longitudeDeg: number,
  altitudeKm: number,
  date: Date,
): MoonState {
  const observer = new Observer(latitudeDeg, longitudeDeg, altitudeKm * 1000);
  return {
    ...horizontalPosition(Body.Moon, observer, date),
    illumination: Illumination(Body.Moon, date).phase_fraction,
  };
}

/**
 * Sonnen- und Mondstand am Beobachterstandort (astronomy-engine). Aktualisiert
 * sich alle 20 s – beide Körper wandern mit rund 15°/h.
 */
export function useCelestialBodies(): void {
  const observer = useAppStore((s) => s.observer);
  const setSun = useAppStore((s) => s.setSun);
  const setMoon = useAppStore((s) => s.setMoon);

  useEffect(() => {
    if (!observer) return;

    const update = () => {
      const { latitudeDeg, longitudeDeg, altitudeKm } = observer;
      const now = new Date();
      setSun(computeSunState(latitudeDeg, longitudeDeg, altitudeKm, now));
      setMoon(computeMoonState(latitudeDeg, longitudeDeg, altitudeKm, now));
    };

    update();
    const id = window.setInterval(update, 20_000);
    return () => window.clearInterval(id);
  }, [observer, setSun, setMoon]);
}
