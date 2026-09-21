/**
 * Misst, wie viele Satelliten ein Thread je Propagationsschritt schafft.
 *
 * Daraus folgt, wie groß der Worker-Pool sein muss, damit der Gesamtkatalog
 * im 100-ms-Takt propagiert werden kann.
 *
 * Aufruf: npm run bench:propagation
 */
import { twoline2satrec } from 'satellite.js';
import type { SatRec } from 'satellite.js';
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

const COUNT = 12_000;
const TICKS = 12;

/**
 * Synthetischer Katalog mit gestreuten Bahnebenen.
 *
 * Der Mix zählt: Objekte mit einer Umlaufzeit über 225 min laufen bei
 * satellite.js über SDP4 statt SGP4 und sind spürbar teurer. Im echten
 * CelesTrak-Katalog sind das rund 8 % (GEO, Molnija, Mondtransfers) – dieser
 * Anteil wird hier nachgebildet, damit die Messung nicht zu optimistisch ist.
 */
const DEEP_SPACE_SHARE = 0.08;

function buildCatalog(count: number): { recs: SatRec[]; deepSpace: number } {
  const recs: SatRec[] = [];
  let deepSpace = 0;

  for (let i = 0; i < count; i += 1) {
    const deep = i % Math.round(1 / DEEP_SPACE_SHARE) === 0;
    const inc = (i % 180).toFixed(4).padStart(8, ' ');
    const raan = ((i * 7) % 360).toFixed(4).padStart(8, ' ');
    const ma = ((i * 13) % 360).toFixed(4).padStart(8, ' ');
    const norad = String(10000 + (i % 80000)).padStart(5, '0');
    // 1,0027 rev/Tag = geosynchron (SDP4), 15,5 = niedriger Orbit (SGP4).
    const meanMotion = deep ? ' 1.00270000' : '15.50377579';
    const ecc = deep ? '0002000' : '0002571';
    const l1 = `1 ${norad}U 98067A   25060.54791667  .00000100  00000+0  30177-3 0  9993`;
    const l2 = `2 ${norad} ${inc} ${raan} ${ecc}  75.4322 ${ma} ${meanMotion}    16`;
    try {
      const rec = twoline2satrec(l1, l2);
      if (rec && !(rec as unknown as { error?: number }).error) {
        recs.push(rec);
        if (deep) deepSpace += 1;
      }
    } catch {
      /* Unbrauchbare Kombination überspringen. */
    }
  }
  return { recs, deepSpace };
}

const observer = geoToObserverGd({ latitudeDeg: 52.52, longitudeDeg: 13.405, altitudeKm: 0.04 });
const frame = buildObserverFrame(observer);
const { recs: catalog, deepSpace } = buildCatalog(COUNT);
const buffer = new Float32Array(catalog.length * TELEMETRY_STRIDE);
const baseMs = Date.UTC(2025, 2, 3, 20, 0, 0);

function benchFast(): number {
  const started = performance.now();
  for (let t = 0; t < TICKS; t += 1) {
    const tick = buildTickFrame(new Date(baseMs + t * 100), observer);
    for (let i = 0; i < catalog.length; i += 1) {
      // Wie im Worker: Subpunkt nur für das ausgewählte Objekt.
      propagateInto(catalog[i], frame, tick, 2.6, buffer, i * TELEMETRY_STRIDE, i === 0, OFFSETS);
    }
  }
  return (performance.now() - started) / TICKS;
}

function benchSlow(): number {
  const started = performance.now();
  for (let t = 0; t < TICKS; t += 1) {
    const date = new Date(baseMs + t * 100);
    const tick = buildTickFrame(date, observer);
    for (let i = 0; i < catalog.length; i += 1) {
      propagateEphemeris(catalog[i], date, observer, tick.sunUnit, {
        observerEci: tick.observerEci,
        standardMagnitude: 2.6,
      });
    }
  }
  return (performance.now() - started) / TICKS;
}

// Aufwärmen, damit der JIT beide Pfade gleich behandelt.
benchFast();
benchSlow();

const fast = benchFast();
const slow = benchSlow();

console.log(
  `Katalog: ${catalog.length.toLocaleString('de-DE')} Objekte ` +
    `(davon ${deepSpace.toLocaleString('de-DE')} im Deep-Space-Pfad SDP4)`,
);
console.log(`  bisheriger Pfad (propagateEphemeris): ${slow.toFixed(1)} ms/Tick`);
console.log(`  schneller Pfad  (propagateInto):      ${fast.toFixed(1)} ms/Tick  (${(slow / fast).toFixed(2)}×)`);
console.log('');
// Mobile Kerne liegen erfahrungsgemäß um den Faktor 3–5 hinter einem
// Desktop-Kern; die zweite Spalte rechnet diesen Aufschlag mit ein.
const MOBILE_PENALTY = 4;

for (const shards of [1, 2, 4, 6]) {
  const perShard = fast / shards;
  const duty = perShard;
  const mobileDuty = perShard * MOBILE_PENALTY;
  console.log(
    `  ${shards} Worker → ${perShard.toFixed(1)} ms/Tick je Thread · ` +
      `${duty.toFixed(0)} % Auslastung Desktop${duty < 65 ? ' ✓' : ' ✗'} · ` +
      `${mobileDuty.toFixed(0)} % geschätzt mobil${mobileDuty < 65 ? ' ✓' : ' ✗'}`,
  );
}
