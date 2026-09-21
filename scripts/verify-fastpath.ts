/**
 * Prüft, dass `propagateInto()` exakt dieselben Werte liefert wie der
 * ausführliche Pfad `propagateEphemeris()`, der satellite.js direkt nutzt.
 *
 * Der schnelle Pfad zieht `gstime()`/`jday()` aus der Schleife und rechnet
 * ECI→ECF, Blickwinkel und Subpunkt selbst. Genau diese Inlining-Schritte
 * werden hier gegen die Bibliothek gegengerechnet.
 *
 * Aufruf: npm run verify:fastpath
 */
import { twoline2satrec } from 'satellite.js';
import { decodeAlpha5 } from '../src/data/tleSources';
import { geoToObserverGd } from '../src/math/coords';
import {
  buildObserverFrame,
  buildTickFrame,
  propagateEphemeris,
  propagateInto,
} from '../src/math/propagation';
import {
  TELEMETRY_STRIDE,
  T_ALT,
  T_AZ,
  T_ECLIPSED,
  T_EL,
  T_LAT,
  T_LON,
  T_MAG,
  T_RANGE,
  T_SPEED,
} from '../src/math/telemetryLayout';
import { standardMagnitudeFor } from '../src/math/visibility';

const OFFSETS = {
  az: T_AZ,
  el: T_EL,
  range: T_RANGE,
  alt: T_ALT,
  speed: T_SPEED,
  eclipsed: T_ECLIPSED,
  lat: T_LAT,
  lon: T_LON,
  mag: T_MAG,
};

/** Bewusst gemischt: LEO polar, LEO äquatornah, HEO/Molnija, GEO. */
const TLES: Array<[string, string, string]> = [
  [
    'ISS (ZARYA)',
    '1 25544U 98067A   25060.54791667  .00016717  00000+0  30177-3 0  9993',
    '2 25544  51.6400 208.9163 0002571  75.4322 284.7009 15.50377579    16',
  ],
  [
    'NOAA 19',
    '1 33591U 09005A   25060.45000000  .00000155  00000+0  10312-3 0  9990',
    '2 33591  99.0500  50.2000 0013500 220.0000 140.0000 14.12800000    15',
  ],
  [
    'HST',
    '1 20580U 90037B   25060.38472222  .00001876  00000+0  10083-3 0  9991',
    '2 20580  28.4696 288.1456 0002534 174.7539 185.3345 15.11049889    19',
  ],
  [
    'MOLNIYA-TYPE',
    '1 25485U 98054A   25060.20000000  .00000100  00000+0  00000+0 0  9995',
    '2 25485  62.8000 120.0000 7200000 270.0000  10.0000  2.00600000    18',
  ],
  [
    'GEO-TYPE',
    '1 28884U 05041A   25060.10000000 -.00000200  00000+0  00000+0 0  9990',
    '2 28884   0.0300  85.0000 0002000 180.0000 180.0000  1.00270000    15',
  ],
];

const OBSERVERS = [
  { latitudeDeg: 52.52, longitudeDeg: 13.405, altitudeKm: 0.04 }, // Berlin
  { latitudeDeg: -33.87, longitudeDeg: 151.21, altitudeKm: 0.02 }, // Sydney
  { latitudeDeg: 78.22, longitudeDeg: 15.65, altitudeKm: 0.01 }, // Longyearbyen
  { latitudeDeg: 0.0, longitudeDeg: -78.5, altitudeKm: 2.85 }, // Quito, Höhenlage
];

/** Zulässige Abweichung je Feld – ausschließlich Float32-Rundung. */
const TOLERANCE: Record<string, number> = {
  azimuth: 1e-5, // rad
  elevation: 1e-5, // rad
  rangeKm: 5e-2, // km bei bis zu 4e4 km Distanz -> ~1e-6 relativ
  altitudeKm: 5e-2,
  speedKmS: 1e-4,
  latitudeDeg: 1e-4,
  longitudeDeg: 1e-4,
  magnitude: 1e-3,
};

let checks = 0;
let failures = 0;

function compare(label: string, field: string, slow: number, fast: number): void {
  checks += 1;
  const limit = TOLERANCE[field];
  const delta = Math.abs(slow - fast);
  if (Number.isFinite(slow) !== Number.isFinite(fast) || delta > limit) {
    failures += 1;
    console.error(
      `  ✗ ${label} ${field}: langsam=${slow} schnell=${fast} Δ=${delta.toExponential(3)} > ${limit}`,
    );
  }
}

const buffer = new Float32Array(TELEMETRY_STRIDE);
const baseMs = Date.UTC(2025, 2, 3, 18, 42, 17, 350);

for (const geo of OBSERVERS) {
  const observer = geoToObserverGd(geo);
  const frame = buildObserverFrame(observer);

  for (const [name, l1, l2] of TLES) {
    const satrec = twoline2satrec(l1, l2);
    const standardMagnitude = standardMagnitudeFor('00000', 'brightest');

    // 24 Zeitpunkte über zwei Tage – deckt Auf-/Untergang und Schattendurchgang ab.
    for (let step = 0; step < 24; step += 1) {
      const date = new Date(baseMs + step * 97 * 60_000);
      const tick = buildTickFrame(date, observer);

      const slow = propagateEphemeris(satrec, date, observer, tick.sunUnit, {
        observerEci: tick.observerEci,
        standardMagnitude,
      });

      buffer.fill(Number.NaN);
      const ok = propagateInto(satrec, frame, tick, standardMagnitude, buffer, 0, true, OFFSETS);

      if (!slow || !ok) {
        if (Boolean(slow) !== ok) {
          failures += 1;
          console.error(`  ✗ ${name}: Gültigkeit weicht ab (langsam=${Boolean(slow)} schnell=${ok})`);
        }
        continue;
      }

      const label = `${name} @ ${geo.latitudeDeg}/${geo.longitudeDeg} +${step}`;
      compare(label, 'azimuth', slow.azimuth, buffer[T_AZ]);
      compare(label, 'elevation', slow.elevation, buffer[T_EL]);
      compare(label, 'rangeKm', slow.rangeKm, buffer[T_RANGE]);
      compare(label, 'altitudeKm', slow.altitudeKm, buffer[T_ALT]);
      compare(label, 'speedKmS', slow.speedKmS, buffer[T_SPEED]);
      compare(label, 'latitudeDeg', slow.latitudeDeg, buffer[T_LAT]);
      // Der Längengrad springt bei ±180° – dort ist die Differenz 360°, nicht 0.
      const lonDelta = Math.abs(((slow.longitudeDeg - buffer[T_LON] + 540) % 360) - 180);
      compare(label, 'longitudeDeg', 0, lonDelta);
      compare(label, 'magnitude', slow.magnitude, buffer[T_MAG]);

      checks += 1;
      if (slow.eclipsed !== buffer[T_ECLIPSED] > 0.5) {
        failures += 1;
        console.error(`  ✗ ${label} eclipsed: langsam=${slow.eclipsed} schnell=${buffer[T_ECLIPSED]}`);
      }
    }
  }
}

/* --- Gegenprobe: `withSubPoint = false` lässt nur Subpunkt/Bahnhöhe weg --- */
{
  const observer = geoToObserverGd(OBSERVERS[0]);
  const frame = buildObserverFrame(observer);
  const satrec = twoline2satrec(TLES[0][1], TLES[0][2]);
  const tick = buildTickFrame(new Date(baseMs), observer);
  const full = new Float32Array(TELEMETRY_STRIDE);
  const lean = new Float32Array(TELEMETRY_STRIDE);
  propagateInto(satrec, frame, tick, 2.6, full, 0, true, OFFSETS);
  propagateInto(satrec, frame, tick, 2.6, lean, 0, false, OFFSETS);

  const dropped = new Set([T_ALT, T_LAT, T_LON]);
  for (let i = 0; i < TELEMETRY_STRIDE; i += 1) {
    checks += 1;
    if (dropped.has(i)) {
      if (!Number.isNaN(lean[i])) {
        failures += 1;
        console.error(`  ✗ ohne Subpunkt: Feld ${i} sollte NaN sein, ist ${lean[i]}`);
      }
    } else if (full[i] !== lean[i] && !(Number.isNaN(full[i]) && Number.isNaN(lean[i]))) {
      failures += 1;
      console.error(`  ✗ ohne Subpunkt: Feld ${i} weicht ab (${full[i]} vs ${lean[i]})`);
    }
  }
}

/* --- Alpha-5-Katalognummern --- */
const ALPHA5_CASES: Array<[string, string]> = [
  ['25544', '25544'],
  ['00005', '5'],
  ['  900', '900'],
  ['A0001', '100001'], // erste Nummer jenseits von 99999
  ['B0000', '110000'],
  ['H0001', '170001'],
  ['J0001', '180001'], // I wird übersprungen
  ['P0000', '230000'], // O wird übersprungen
  ['Z9999', '339999'], // letzte darstellbare Nummer
];

for (const [input, expected] of ALPHA5_CASES) {
  checks += 1;
  const got = decodeAlpha5(input);
  if (got !== expected) {
    failures += 1;
    console.error(`  ✗ decodeAlpha5('${input}'): erwartet ${expected}, erhalten ${got}`);
  }
}

console.log(`${checks} Vergleiche, ${failures} Abweichungen`);
if (failures > 0) process.exit(1);
console.log('✓ Schneller Pfad stimmt mit satellite.js überein');
