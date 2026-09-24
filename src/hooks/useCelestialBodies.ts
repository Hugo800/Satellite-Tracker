import { useEffect } from 'react';
import { Body, Equator, Horizon, Illumination, Observer } from 'astronomy-engine';
import { useAppStore, virtualTimeAt } from '../state/store';
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

/** Virtuelle Zeit zwischen zwei Aktualisierungen: 20 s – beide Körper wandern mit rund 15°/h, also um 0,08°. */
const VIRTUAL_STEP_MS = 20_000;
/**
 * Untergrenze in Echtzeit. Jede Aktualisierung ist ein Store-Update, das
 * Kopfzeile, Himmelskugel und Sonne/Mond neu rendert; öfter als viermal je
 * Sekunde lohnt das nicht. Bei ×600 liegen dazwischen 150 s virtuelle Zeit,
 * die Sonne wandert also um rund 0,6°.
 */
const MIN_PERIOD_MS = 250;

/** Echtzeit-Abstand der Aktualisierungen bei Geschwindigkeit `scale`. */
export function celestialUpdatePeriodMs(scale: number): number {
  const speed = Math.abs(scale);
  // Angehalten: Die virtuelle Zeit steht, jeder Abstand ist gleich gut.
  if (speed === 0) return VIRTUAL_STEP_MS;
  return Math.min(VIRTUAL_STEP_MS, Math.max(MIN_PERIOD_MS, VIRTUAL_STEP_MS / speed));
}

/**
 * Sonnen- und Mondstand am Beobachterstandort (astronomy-engine) zur
 * virtuellen Zeit.
 *
 * Hängt an der ganzen Zeitbasis, nicht nur an der Epoche: Nach einem Sprung
 * stehen beide sofort an ihrem neuen Ort, statt bis zur nächsten
 * Aktualisierung in der alten Zeit zu bleiben, und bei einer neuen
 * Geschwindigkeit passt sich der Abstand der Aktualisierungen an.
 */
export function useCelestialBodies(): void {
  const observer = useAppStore((s) => s.observer);
  const timeBase = useAppStore((s) => s.timeBase);
  const setSun = useAppStore((s) => s.setSun);
  const setMoon = useAppStore((s) => s.setMoon);

  useEffect(() => {
    if (!observer) return;

    const update = () => {
      const { latitudeDeg, longitudeDeg, altitudeKm } = observer;
      const date = new Date(virtualTimeAt(timeBase, Date.now()));
      setSun(computeSunState(latitudeDeg, longitudeDeg, altitudeKm, date));
      setMoon(computeMoonState(latitudeDeg, longitudeDeg, altitudeKm, date));
    };

    update();
    const id = window.setInterval(update, celestialUpdatePeriodMs(timeBase.scale));
    return () => window.clearInterval(id);
  }, [observer, timeBase, setSun, setMoon]);
}
