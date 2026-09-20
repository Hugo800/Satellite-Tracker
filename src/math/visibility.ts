import type { SatelliteGroup, SkyFilterMode, Vec3 } from '../types';
import { DEG } from './coords';

/**
 * Standardhelligkeit einzelner Objekte: scheinbare Helligkeit bei 1000 km
 * Entfernung und voller Beleuchtung (Phasenwinkel 0°). Werte aus den gängigen
 * Beobachterkatalogen (McCants/Molczan).
 */
const STANDARD_MAGNITUDE_BY_NORAD: Record<string, number> = {
  '25544': -1.8, // ISS (ZARYA)
  '48274': -0.4, // CSS (TIANHE)
  '20580': 1.4, // Hubble Space Telescope
  '25338': 3.5, // NOAA 15
  '33591': 3.5, // NOAA 19
};

/** Gruppenweise Näherung, wenn kein Einzelwert vorliegt. */
const STANDARD_MAGNITUDE_BY_GROUP: Record<SatelliteGroup, number> = {
  stations: 1.0,
  brightest: 2.6,
  weather: 4.2,
  starlink: 5.5,
};

export function standardMagnitudeFor(noradId: string, group: SatelliteGroup): number {
  return STANDARD_MAGNITUDE_BY_NORAD[noradId] ?? STANDARD_MAGNITUDE_BY_GROUP[group];
}

/** Grenzhelligkeit, ab der ein Objekt unter realen Bedingungen noch auffällt. */
export const NAKED_EYE_LIMIT = 4.0;
/** Unter dieser Elevation stören Dunst, Bebauung und Extinktion zu stark. */
export const NAKED_EYE_MIN_ELEVATION = 10 * DEG;

/** Für Objekte im Erdschatten – bequem sortierbar statt `Infinity`. */
export const INVISIBLE_MAGNITUDE = 99;

/**
 * Phasenwinkel am Satelliten zwischen Sonnenrichtung und Beobachterrichtung.
 * 0° = voll beleuchtet („Vollmond“), 180° = Rückseite.
 */
export function phaseAngle(satelliteEci: Vec3, observerEci: Vec3, sunUnit: Vec3): number {
  const ox = observerEci.x - satelliteEci.x;
  const oy = observerEci.y - satelliteEci.y;
  const oz = observerEci.z - satelliteEci.z;
  const length = Math.hypot(ox, oy, oz) || 1;
  const cosPhase = (ox * sunUnit.x + oy * sunUnit.y + oz * sunUnit.z) / length;
  return Math.acos(Math.max(-1, Math.min(1, cosPhase)));
}

/** Luftmasse nach Kasten & Young – bleibt auch am Horizont endlich. */
function airmass(elevationRad: number): number {
  const elevationDeg = elevationRad / DEG;
  if (elevationDeg < -1) return 40;
  const h = Math.max(elevationDeg, -1);
  return 1 / (Math.sin(h * DEG) + 0.50572 * Math.pow(h + 6.07995, -1.6364));
}

/**
 * Beleuchteter Anteil der dem Beobachter zugewandten Fläche.
 * 1 = voll angestrahlt („Vollmond“), 0 = der Satellit zeigt uns seine Nachtseite.
 */
export function illuminatedFraction(phaseAngleRad: number): number {
  return ((Math.PI - phaseAngleRad) * Math.cos(phaseAngleRad) + Math.sin(phaseAngleRad)) / Math.PI;
}

/**
 * Scheinbare visuelle Helligkeit eines sonnenbeschienenen Satelliten.
 *
 * Diffus streuende Kugel als Phasenfunktion plus atmosphärische Extinktion –
 * für die Unterscheidung „mit bloßem Auge sichtbar“ ausreichend genau.
 */
export function apparentMagnitude(
  standardMagnitude: number,
  rangeKm: number,
  phaseAngleRad: number,
  elevationRad: number,
): number {
  const phaseFactor = illuminatedFraction(phaseAngleRad);
  if (phaseFactor <= 1e-4) return INVISIBLE_MAGNITUDE;

  const distanceTerm = 5 * Math.log10(rangeKm / 1000);
  const phaseTerm = -2.5 * Math.log10(phaseFactor);
  const extinction = 0.23 * (airmass(elevationRad) - 1);

  return standardMagnitude + distanceTerm + phaseTerm + extinction;
}

export interface NakedEyeInput {
  magnitude: number;
  elevationRad: number;
  eclipsed: boolean;
}

/**
 * „Realistisch mit bloßem Auge sichtbar“: sonnenbeschienenes Objekt,
 * ausreichende Höhe über dem Horizont und Helligkeit über der
 * Wahrnehmungsschwelle.
 *
 * Der Sonnenstand am Beobachterort geht bewusst *nicht* ein: Die App trennt
 * nicht zwischen Tag und Nacht, es sind immer alle aktuellen Objekte am
 * Himmel darstellbar.
 */
export function isNakedEyeVisible(input: NakedEyeInput): boolean {
  if (input.eclipsed) return false;
  if (input.elevationRad < NAKED_EYE_MIN_ELEVATION) return false;
  return input.magnitude <= NAKED_EYE_LIMIT;
}

/**
 * Gemeinsames Filterkriterium für 3D-Szene, Radar, Auswahl und Liste.
 *
 * Positionale Parameter statt Options-Objekt: Die Funktion läuft pro Frame
 * über den gesamten Katalog und darf dabei nichts allozieren.
 */
export function passesSkyFilter(
  mode: SkyFilterMode,
  isStarlink: boolean,
  elevationRad: number,
  eclipsed: boolean,
  magnitude: number,
): boolean {
  if (elevationRad <= 0) return false;
  if (mode === 'starlink') return isStarlink;
  if (mode === 'all') return true;
  if (eclipsed) return false;
  if (elevationRad < NAKED_EYE_MIN_ELEVATION) return false;
  return magnitude <= NAKED_EYE_LIMIT;
}
