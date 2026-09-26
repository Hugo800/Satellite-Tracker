/** Bahnform aus den mittleren Elementen des TLE – für die Info-Ansicht. */

/** Gravitationsparameter der Erde (WGS84), km³/s². */
const MU_EARTH = 398_600.4418;
/** Äquatorradius (WGS84), km. */
const EARTH_RADIUS_KM = 6378.137;
/** Siderischer Tag in Minuten – Umlaufzeit einer geosynchronen Bahn. */
const SIDEREAL_DAY_MIN = 1436.07;

export type OrbitClass = 'LEO' | 'MEO' | 'GEO' | 'GSO' | 'HEO' | 'HO';

export interface OrbitSummary {
  orbitClass: OrbitClass;
  /** Klartext, z. B. „Niedrige Erdumlaufbahn (LEO)“. */
  label: string;
  semiMajorAxisKm: number;
  /** Höhe des erdfernsten Punkts über dem Äquatorradius. */
  apogeeKm: number;
  /** Höhe des erdnächsten Punkts über dem Äquatorradius. */
  perigeeKm: number;
}

const ORBIT_LABEL: Record<OrbitClass, string> = {
  LEO: 'Niedrige Erdumlaufbahn (LEO)',
  MEO: 'Mittlere Erdumlaufbahn (MEO)',
  GEO: 'Geostationär (GEO)',
  GSO: 'Geosynchron (GSO)',
  HEO: 'Stark elliptisch (HEO)',
  HO: 'Hohe Erdumlaufbahn',
};

/**
 * Große Halbachse aus der Umlaufzeit (drittes Keplersches Gesetz), Apogäum und
 * Perigäum aus der Exzentrizität.
 *
 * Die Einteilung folgt den üblichen Grenzen: LEO bis 2 000 km Apogäum, GEO/GSO
 * bei einem siderischen Tag Umlaufzeit (± 30 min) und fast kreisförmiger Bahn,
 * HEO ab Exzentrizität 0,25 (Molniya, Transferbahnen). Die Werte sind mittlere
 * Elemente des TLE, keine osculierenden – für eine Einordnung genügt das.
 *
 * @returns `null` bei unbrauchbarer Umlaufzeit.
 */
export function orbitSummary(
  periodMin: number,
  eccentricity: number,
  inclinationDeg: number,
): OrbitSummary | null {
  if (!(periodMin > 0) || !Number.isFinite(eccentricity)) return null;
  const periodSec = periodMin * 60;
  const semiMajorAxisKm = Math.cbrt(MU_EARTH * (periodSec / (2 * Math.PI)) ** 2);
  const apogeeKm = semiMajorAxisKm * (1 + eccentricity) - EARTH_RADIUS_KM;
  const perigeeKm = semiMajorAxisKm * (1 - eccentricity) - EARTH_RADIUS_KM;

  let orbitClass: OrbitClass;
  if (eccentricity >= 0.25) orbitClass = 'HEO';
  else if (apogeeKm < 2000) orbitClass = 'LEO';
  else if (Math.abs(periodMin - SIDEREAL_DAY_MIN) < 30 && eccentricity < 0.1) {
    orbitClass = inclinationDeg < 5 ? 'GEO' : 'GSO';
  } else if (apogeeKm < 35_786) orbitClass = 'MEO';
  else orbitClass = 'HO';

  return { orbitClass, label: ORBIT_LABEL[orbitClass], semiMajorAxisKm, apogeeKm, perigeeKm };
}
