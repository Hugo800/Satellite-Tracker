import { DEG, RAD } from './coords';

/**
 * Magnetische Deklination aus dem World Magnetic Model 2025, gekürzt auf Grad 9.
 *
 * Wozu: Beide Kompassquellen messen gegen magnetisch Nord – Android über
 * `deviceorientationabsolute`, iOS über `webkitCompassHeading`, das WebKit
 * immer aus `CLHeading.magneticHeading` füllt (Source/WebCore/platform/ios/
 * WebCoreMotionManager.mm, Z. 318; Apples Referenz nennt es „relative to
 * magnetic north“). Die Szene ist nach geografisch Nord ausgerichtet. Ohne
 * Korrektur steht jeder Satellit um die Deklination neben seinem Symbol – in
 * Berlin rund 5°, im Nordwesten der USA rund 15°.
 *
 * Quelle der Koeffizienten: WMM2025 von NOAA NCEI und British Geological
 * Survey, Datei WMM.COF vom 13.11.2024 (Epoche 2025,0, gültig bis 2030,0),
 * bezogen über die Kopie im Python-Paket pygeomag. Übernommen sind g, h und
 * ihre jährliche Änderung für die Grade 1 bis 9 von 12, unverändert und in der
 * Reihenfolge der Datei.
 *
 * Genauigkeit, nachgerechnet und nicht geschätzt:
 * - Die Rechenvorschrift trifft mit allen 12 Graden die 100 offiziellen
 *   WMM2025-Testwerte auf 0,005° (die Rundung der Testdatei). Einzige
 *   Näherung ist damit die Kürzung auf Grad 9.
 * - Deren Fehler gegenüber dem vollen Modell, auf einem 1°×2°-Gitter in
 *   Meereshöhe zu den Epochen 2025,0 / 2027,5 / 2030,0, außerhalb der
 *   WMM-Warnzonen (waagrechte Feldstärke H ≥ 6000 nT): höchstens 0,54°,
 *   RMS 0,11°; zwischen 60° S und 60° N höchstens 0,52°, RMS 0,09°.
 * - Wie weit das WMM selbst vom realen Feld abweicht (Krustenanomalien, Fehler
 *   der Säkularvariation), ist hier nicht nachgeprüft; lokal kann das mehrere
 *   Grad ausmachen. In den Warnzonen um die Magnetpole ist die Deklination
 *   ohnehin unbestimmt und ein Handykompass unbrauchbar.
 * - Nach 2030 wird die Säkularvariation linear fortgeschrieben; der Fehler
 *   wächst dann, ohne dass er hier geprüft ist.
 *
 * Grad 9 statt weniger: Bei Grad 8 liegt der größte Gitterfehler bei 1,6°, bei
 * Grad 6 bei 4° – in der Größenordnung dessen, was die Korrektur beseitigen soll.
 */

const EPOCH = 2025.0;
const MAX_DEGREE = 9;
/** Referenzradius des WMM. */
const REFERENCE_RADIUS_KM = 6371.2;
const WGS84_A_KM = 6378.137;
const WGS84_E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);

/** Je Zeile g, h (nT) und dg/dt, dh/dt (nT/Jahr) für n = 1 … 9, m = 0 … n. */
// prettier-ignore
const COEFFICIENTS = [
  // n = 1
  -29351.8, 0.0, 12.0, 0.0,
  -1410.8, 4545.4, 9.7, -21.5,
  // n = 2
  -2556.6, 0.0, -11.6, 0.0,
  2951.1, -3133.6, -5.2, -27.7,
  1649.3, -815.1, -8.0, -12.1,
  // n = 3
  1361.0, 0.0, -1.3, 0.0,
  -2404.1, -56.6, -4.2, 4.0,
  1243.8, 237.5, 0.4, -0.3,
  453.6, -549.5, -15.6, -4.1,
  // n = 4
  895.0, 0.0, -1.6, 0.0,
  799.5, 278.6, -2.4, -1.1,
  55.7, -133.9, -6.0, 4.1,
  -281.1, 212.0, 5.6, 1.6,
  12.1, -375.6, -7.0, -4.4,
  // n = 5
  -233.2, 0.0, 0.6, 0.0,
  368.9, 45.4, 1.4, -0.5,
  187.2, 220.2, 0.0, 2.2,
  -138.7, -122.9, 0.6, 0.4,
  -142.0, 43.0, 2.2, 1.7,
  20.9, 106.1, 0.9, 1.9,
  // n = 6
  64.4, 0.0, -0.2, 0.0,
  63.8, -18.4, -0.4, 0.3,
  76.9, 16.8, 0.9, -1.6,
  -115.7, 48.8, 1.2, -0.4,
  -40.9, -59.8, -0.9, 0.9,
  14.9, 10.9, 0.3, 0.7,
  -60.7, 72.7, 0.9, 0.9,
  // n = 7
  79.5, 0.0, -0.0, 0.0,
  -77.0, -48.9, -0.1, 0.6,
  -8.8, -14.4, -0.1, 0.5,
  59.3, -1.0, 0.5, -0.8,
  15.8, 23.4, -0.1, 0.0,
  2.5, -7.4, -0.8, -1.0,
  -11.1, -25.1, -0.8, 0.6,
  14.2, -2.3, 0.8, -0.2,
  // n = 8
  23.2, 0.0, -0.1, 0.0,
  10.8, 7.1, 0.2, -0.2,
  -17.5, -12.6, 0.0, 0.5,
  2.0, 11.4, 0.5, -0.4,
  -21.7, -9.7, -0.1, 0.4,
  16.9, 12.7, 0.3, -0.5,
  15.0, 0.7, 0.2, -0.6,
  -16.8, -5.2, -0.0, 0.3,
  0.9, 3.9, 0.2, 0.2,
  // n = 9
  4.6, 0.0, -0.0, 0.0,
  7.8, -24.8, -0.1, -0.3,
  3.0, 12.2, 0.1, 0.3,
  -0.2, 8.3, 0.3, -0.3,
  -2.5, -3.3, -0.3, 0.3,
  -13.1, -5.2, 0.0, 0.2,
  2.4, 7.2, 0.3, -0.1,
  8.6, -0.6, -0.1, -0.2,
  -8.7, 0.8, 0.1, 0.4,
  -12.9, 10.0, -0.1, 0.1,
];

const LEGENDRE_SIZE = ((MAX_DEGREE + 1) * (MAX_DEGREE + 2)) / 2;
const legendre = new Float64Array(LEGENDRE_SIZE);
const legendreDerivative = new Float64Array(LEGENDRE_SIZE);
const index = (n: number, m: number): number => (n * (n + 1)) / 2 + m;

/**
 * Deklination in Grad, Ost positiv – der Winkel, um den magnetisch Nord
 * östlich von geografisch Nord liegt.
 *
 * Gerechnet wird wie im WMM-Report: geodätische in geozentrische Koordinaten,
 * Schmidt-seminormierte Legendre-Funktionen, Feldkomponenten, Rückdrehung ins
 * geodätische System. Die Rückdrehung ist nicht vernachlässigbar: Sie mischt die
 * große Vertikalkomponente in die Nordkomponente; wo das waagrechte Feld schwach
 * ist (Südaustralien, Antarktisrand), verschiebt das die Deklination um bis zu 1,6°.
 */
export function magneticDeclinationDeg(
  latitudeDeg: number,
  longitudeDeg: number,
  altitudeKm: number,
  decimalYear: number,
): number {
  const phi = latitudeDeg * DEG;
  const lambda = longitudeDeg * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const primeVertical = WGS84_A_KM / Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  const p = (primeVertical + altitudeKm) * cosPhi;
  const z = (primeVertical * (1 - WGS84_E2) + altitudeKm) * sinPhi;
  const r = Math.hypot(p, z);
  const phiGeocentric = Math.asin(z / r);
  const c = Math.sin(phiGeocentric);
  const s = Math.cos(phiGeocentric);

  legendre.fill(0);
  legendreDerivative.fill(0);
  legendre[index(0, 0)] = 1;
  legendre[index(1, 0)] = c;
  legendre[index(1, 1)] = s;
  legendreDerivative[index(1, 0)] = -s;
  legendreDerivative[index(1, 1)] = c;
  for (let n = 2; n <= MAX_DEGREE; n += 1) {
    const diagonal = Math.sqrt((2 * n - 1) / (2 * n));
    const previous = index(n - 1, n - 1);
    legendre[index(n, n)] = diagonal * s * legendre[previous];
    legendreDerivative[index(n, n)] =
      diagonal * (s * legendreDerivative[previous] + c * legendre[previous]);
    for (let m = 0; m < n; m += 1) {
      const norm = Math.sqrt(n * n - m * m);
      const back = Math.sqrt((n - 1) * (n - 1) - m * m);
      const p2 = n - 2 >= m ? legendre[index(n - 2, m)] : 0;
      const dp2 = n - 2 >= m ? legendreDerivative[index(n - 2, m)] : 0;
      const p1 = legendre[index(n - 1, m)];
      const dp1 = legendreDerivative[index(n - 1, m)];
      legendre[index(n, m)] = ((2 * n - 1) * c * p1 - back * p2) / norm;
      legendreDerivative[index(n, m)] = ((2 * n - 1) * (c * dp1 - s * p1) - back * dp2) / norm;
    }
  }

  const years = decimalYear - EPOCH;
  let north = 0;
  let east = 0;
  let down = 0;
  for (let n = 1; n <= MAX_DEGREE; n += 1) {
    const radial = Math.pow(REFERENCE_RADIUS_KM / r, n + 2);
    for (let m = 0; m <= n; m += 1) {
      const row = (index(n, m) - 1) * 4;
      const g = COEFFICIENTS[row] + years * COEFFICIENTS[row + 2];
      const h = COEFFICIENTS[row + 1] + years * COEFFICIENTS[row + 3];
      const cosM = Math.cos(m * lambda);
      const sinM = Math.sin(m * lambda);
      const pnm = legendre[index(n, m)];
      north += radial * (g * cosM + h * sinM) * legendreDerivative[index(n, m)];
      east += radial * m * (g * sinM - h * cosM) * pnm;
      down -= (n + 1) * radial * (g * cosM + h * sinM) * pnm;
    }
  }
  // Am geografischen Pol verschwindet cos φ'; dort ist die Deklination ohnehin unbestimmt.
  east /= Math.max(s, 1e-9);

  const tilt = phiGeocentric - phi;
  const northGeodetic = north * Math.cos(tilt) - down * Math.sin(tilt);
  return Math.atan2(east, northGeodetic) * RAD;
}

/** Dezimaljahr (2026,5 = Mitte 2026), wie es die Säkularvariation erwartet. */
export function decimalYear(date: Date): number {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return year + (date.getTime() - start) / (end - start);
}
