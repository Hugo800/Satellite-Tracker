import { useEffect } from 'react';
import { Body, Equator, Horizon, Observer } from 'astronomy-engine';
import { clamp } from '../math/coords';
import { useAppStore } from '../state/store';
import type { SkyPhase, SunState } from '../types';

function phaseFor(altitudeDeg: number): SkyPhase {
  if (altitudeDeg > -0.833) return 'day';
  if (altitudeDeg > -6) return 'civil';
  if (altitudeDeg > -12) return 'nautical';
  if (altitudeDeg > -18) return 'astronomical';
  return 'night';
}

export function computeSunState(
  latitudeDeg: number,
  longitudeDeg: number,
  altitudeKm: number,
  date: Date,
): SunState {
  const observer = new Observer(latitudeDeg, longitudeDeg, altitudeKm * 1000);
  const equatorial = Equator(Body.Sun, date, observer, true, true);
  const horizontal = Horizon(date, observer, equatorial.ra, equatorial.dec, 'normal');

  return {
    altitudeDeg: horizontal.altitude,
    azimuthDeg: horizontal.azimuth,
    phase: phaseFor(horizontal.altitude),
    daylight: clamp((horizontal.altitude + 8) / 14, 0, 1),
  };
}

/**
 * Sonnenstand am Beobachterstandort (astronomy-engine). Aktualisiert sich alle
 * 20 s – langsam genug für React-State, schnell genug für weiche Dämmerung.
 */
export function useSunState(): void {
  const observer = useAppStore((s) => s.observer);
  const setSun = useAppStore((s) => s.setSun);

  useEffect(() => {
    if (!observer) return;

    const update = () => {
      setSun(
        computeSunState(
          observer.latitudeDeg,
          observer.longitudeDeg,
          observer.altitudeKm,
          new Date(),
        ),
      );
    };

    update();
    const id = window.setInterval(update, 20_000);
    return () => window.clearInterval(id);
  }, [observer, setSun]);
}
