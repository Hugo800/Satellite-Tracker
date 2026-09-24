/**
 * Prüft, dass Bahnhöhe und Subpunkt des ausgewählten Objekts im
 * Telemetrie-Buffer ankommen – über den ganzen Weg Hook → Worker-Pool →
 * Shard → `scatter` → `readSample`, mit dem echten Code aus
 * src/hooks/useSatelliteEngine.ts und src/workers/sgp4.worker.ts.
 *
 * Anlass ist ein Gerätebild (iPhone, PWA, 24.09.2026, 06:25 MESZ): Für
 * BEIDOU-3 M16 standen „Bahnhöhe – km“ und „Subpunkt –° / –°“ in der Karte,
 * Elevation, Azimut, Distanz und Speed zeigten Werte. Abschnitt 0 belegt,
 * dass diese Werte über sechs Stunden alt waren: Der zuständige Shard hat seit
 * dem Vorabend keinen Tick mehr geliefert. Subpunkt und Bahnhöhe entstehen
 * seit c027d50 nur im Tick nach der Auswahl – ohne Tick bleiben sie NaN.
 *
 * Aufbau ohne Browser:
 *   - Die Shards laufen als echte Threads (`node:worker_threads`) mit dem
 *     gebündelten Worker (node_modules/.cache/verify-selection-worker.mjs).
 *     Ein Vorspann stellt `self` bereit, liefert statt CelesTrak feste
 *     TLE-Sätze mit Epoche „heute“ aus und kann den Thread mitten in einem
 *     Tick „einfrieren“ (Abschnitt D).
 *   - Der Hook läuft im echten Reconciler von React Three Fiber wie in
 *     scripts/verify-wiring.ts; `Worker` ist eine Hülle um den Node-Thread.
 *   - Referenz ist satellite.js über `propagateEphemeris` zum Zeitpunkt des
 *     gelieferten Ticks.
 *
 * Aufruf: npm run verify:selection
 */
import { StrictMode, createElement, type ReactElement } from 'react';
import { act, createRoot } from '@react-three/fiber';
import { Worker as NodeWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { twoline2satrec } from 'satellite.js';
import { engine, useSatelliteEngine } from '../src/hooks/useSatelliteEngine';
import { RAD, geoToObserverGd } from '../src/math/coords';
import { propagateEphemeris } from '../src/math/propagation';
import { catalogIndex, readSample, telemetry } from '../src/state/runtime';
import { useAppStore } from '../src/state/store';
import type { SatelliteGroup } from '../src/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let checks = 0;
let failures = 0;

function expect(label: string, ok: boolean, detail: string): void {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${label}: ${detail}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}: ${detail}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const f = (value: number, digits = 1): string =>
  Number.isFinite(value) ? value.toFixed(digits).replace('.', ',') : String(value);

/** Leipzig, wie in der Kopfzeile des Gerätebilds (51,389°, 12,356°). */
const OBSERVER = { latitudeDeg: 51.389, longitudeDeg: 12.356, altitudeKm: 0.12 };
const observerGd = geoToObserverGd(OBSERVER);

/* ------------------------------------------------------------------ */
/* 0. Gerätebild: Wie alt waren die angezeigten Werte?                  */
/* ------------------------------------------------------------------ */

console.log('0. Gerätebild vom 24.09.2026, 06:25 MESZ: Alter der angezeigten Telemetrie');
{
  // CelesTrak-Satz von BEIDOU-3 M16 (Epoche 21.09.2026), abgerufen am
  // 24.09.2026. Für ein MEO-Objekt ist das über wenige Tage auf Bruchteile
  // eines Grads genau.
  const satrec = twoline2satrec(
    '1 43647U 18078A   26264.13329856 -.00000015  00000+0  00000+0 0  9990',
    '2 43647  54.0007 296.6129 0006093  30.7925 329.3056  1.86232488 53942',
  );
  const shown = { elevationDeg: 82.53, azimuthDeg: 99, rangeKm: 21563.3 };
  const screenshotMs = Date.UTC(2026, 8, 24, 4, 25);
  const at = (ms: number) => propagateEphemeris(satrec, new Date(ms), observerGd);
  const now = at(screenshotMs);

  // Die letzten 24 h im 10-s-Raster: Wann stand M16 dort, wo die Karte ihn zeigte?
  let bestMs = screenshotMs;
  let bestError = Number.POSITIVE_INFINITY;
  for (let ms = screenshotMs - 86_400_000; ms <= screenshotMs; ms += 10_000) {
    const eph = at(ms);
    if (!eph) continue;
    const error =
      Math.abs(eph.elevation * RAD - shown.elevationDeg) +
      Math.abs(eph.azimuth * RAD - shown.azimuthDeg) / 5 +
      Math.abs(eph.rangeKm - shown.rangeKm) / 50;
    if (error < bestError) {
      bestError = error;
      bestMs = ms;
    }
  }
  const match = at(bestMs);
  const ageMin = (screenshotMs - bestMs) / 60_000;
  expect(
    'angezeigte Werte stammen nicht aus der Zeit des Bilds',
    now !== null && match !== null && now.elevation < 0 && ageMin > 60,
    `um 06:25 stand M16 bei ${f((now?.elevation ?? NaN) * RAD, 1)}° Elevation (unter dem Horizont); ` +
      `die angezeigten ${f(shown.elevationDeg, 2)}° / ${shown.azimuthDeg}° / ${f(shown.rangeKm)} km passen zu ` +
      `${new Date(bestMs).toISOString().slice(0, 16).replace('T', ' ')} UTC ` +
      `(${f((match?.elevation ?? NaN) * RAD, 2)}° / ${f((match?.azimuth ?? NaN) * RAD, 1)}° / ${f(match?.rangeKm ?? NaN)} km), ` +
      `also ${Math.floor(ageMin / 60)} h ${Math.round(ageMin % 60)} min alt`,
  );
}

/* ------------------------------------------------------------------ */
/* TLE-Sätze mit Epoche „jetzt“                                         */
/* ------------------------------------------------------------------ */

/** Prüfziffer nach NORAD: Ziffernsumme, Minus zählt 1. */
function checksum(line: string): number {
  let sum = 0;
  for (const ch of line) {
    if (ch >= '0' && ch <= '9') sum += Number(ch);
    else if (ch === '-') sum += 1;
  }
  return sum % 10;
}

interface Elements {
  name: string;
  norad: string;
  intl: string;
  inclination: number;
  raan: number;
  eccentricity: number;
  argPerigee: number;
  meanAnomaly: number;
  meanMotion: number;
  bstar: string;
}

/**
 * Baut einen Dreizeiler mit heutiger Epoche. Feste Sätze würden altern: Ein
 * LEO-Objekt divergiert nach einigen Monaten, und dann fehlte die ganze Zeile
 * statt nur des Subpunkts.
 */
function makeTle(el: Elements, epochMs: number): [string, string, string] {
  const date = new Date(epochMs);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = 1 + (epochMs - yearStart) / 86_400_000;
  const epoch = `${String(date.getUTCFullYear() % 100).padStart(2, '0')}${day.toFixed(8).padStart(12, '0')}`;
  const body1 = `1 ${el.norad}U ${el.intl.padEnd(8)} ${epoch}  .00000000  00000+0 ${el.bstar} 0  999`;
  const ecc = Math.round(el.eccentricity * 1e7).toString().padStart(7, '0');
  const body2 =
    `2 ${el.norad} ${el.inclination.toFixed(4).padStart(8)} ${el.raan.toFixed(4).padStart(8)} ${ecc} ` +
    `${el.argPerigee.toFixed(4).padStart(8)} ${el.meanAnomaly.toFixed(4).padStart(8)} ` +
    `${el.meanMotion.toFixed(8).padStart(11)}${'1'.padStart(5)}`;
  return [el.name, `${body1}${checksum(body1)}`, `${body2}${checksum(body2)}`];
}

const block = (lines: [string, string, string]) => `${lines.join('\n')}\n`;

const LEO: Elements = {
  name: 'ISS (ZARYA)',
  norad: '25544',
  intl: '98067A',
  inclination: 51.64,
  raan: 208.9163,
  eccentricity: 0.0002571,
  argPerigee: 75.4322,
  meanAnomaly: 284.7009,
  meanMotion: 15.50377579,
  bstar: ' 30177-3',
};

/** Bahn wie BEIDOU-3 M16 aus dem Gerätebild: 773,2 min Umlaufzeit, also SDP4 (Deep Space). */
const MEO: Elements = {
  name: 'BEIDOU-3 M16',
  norad: '43647',
  intl: '18078A',
  inclination: 54.0007,
  raan: 296.6129,
  eccentricity: 0.0006093,
  argPerigee: 30.7925,
  meanAnomaly: 329.3056,
  meanMotion: 1.86232488,
  bstar: ' 00000+0',
};

/** Füllmaterial, damit die Indizes über alle Shards streuen. */
function fillers(epochMs: number, count: number): string {
  let text = '';
  for (let i = 0; i < count; i += 1) {
    text += block(
      makeTle(
        {
          name: `FILL ${i}`,
          norad: String(60000 + i),
          intl: '24001A',
          inclination: 40 + ((i * 7) % 58),
          raan: (i * 37) % 360,
          eccentricity: 0.001,
          argPerigee: (i * 53) % 360,
          meanAnomaly: (i * 71) % 360,
          meanMotion: 14.2 + (i % 9) * 0.15,
          bstar: ' 10000-3',
        },
        epochMs,
      ),
    );
  }
  return text;
}

const epochMs = Date.now();
const LEO_TLE = makeTle(LEO, epochMs);
const MEO_TLE = makeTle(MEO, epochMs);
/** `stations` liefert die ISS; der Gesamtkatalog (`active`) bringt sie erneut mit – sie darf nur einmal zählen. */
const FEED = {
  stations: block(LEO_TLE),
  active: fillers(epochMs, 23) + block(MEO_TLE) + block(LEO_TLE),
};

/* ------------------------------------------------------------------ */
/* Worker-Pool als Node-Threads                                         */
/* ------------------------------------------------------------------ */

const WORKER_BUNDLE = fileURLToPath(new URL('./verify-selection-worker.mjs', import.meta.url));

/**
 * Vorspann je Shard (CommonJS, weil `eval: true`).
 *
 * `self` entsteht vor dem Import des Workers, denn der liest es auf oberster
 * Ebene. Nachrichten nimmt der Port erst an, wenn der Worker seinen Handler
 * gesetzt hat – wie im Browser, wo sie bis zum Ende des Skripts warten.
 *
 * `freeze` bildet nach, was iOS mit einer Seite im Hintergrund oder bei
 * gesperrtem Display tut: Der Prozess steht, die monotone Uhr hinter
 * `performance.now()` läuft weiter. Die Nachricht kommt zwischen zwei Ticks
 * an; der nächste Aufruf von `performance.now()` ist also der Beginn des
 * nächsten Ticks, und alle späteren liegen um die Pause weiter. Genau das
 * sieht ein Tick, in den das Anhalten fällt. `Date.now()` bleibt unberührt:
 * Es bestimmt nur, welche Epoche propagiert wird, nicht wann.
 */
const BOOTSTRAP = `
const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const scope = {
  onmessage: null,
  postMessage(message, transfer) { parentPort.postMessage(message, transfer || []); },
};
globalThis.self = scope;
globalThis.fetch = async (url) => {
  const group = new URL(String(url)).searchParams.get('GROUP');
  const delay = workerData.delays[group] || 0;
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  const text = workerData.feed[group];
  return text ? new Response(text, { status: 200 }) : new Response('No GP data found', { status: 404 });
};
const realNow = performance.now.bind(performance);
let offset = 0;
let pendingFreeze = 0;
Object.defineProperty(performance, 'now', {
  configurable: true,
  value: () => {
    const value = realNow() + offset;
    offset += pendingFreeze;
    pendingFreeze = 0;
    return value;
  },
});
import(pathToFileURL(workerData.bundle).href).then(() => {
  parentPort.on('message', (data) => {
    if (data && data.harness === 'freeze') {
      pendingFreeze = data.ms;
      return;
    }
    if (scope.onmessage) scope.onmessage({ data });
  });
});
`;

let poolSetup: { feed: Record<string, string>; delays: Record<string, number> } = { feed: {}, delays: {} };
const liveWorkers = new Set<ThreadWorker>();

/** `Worker` des Browsers, soweit der Hook ihn nutzt – plus Messpunkte für die Prüfung. */
class ThreadWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  shard = -1;
  /** Wanduhr beim Eintreffen des letzten Ticks. */
  lastTickAt = 0;
  /** Epoche des letzten Ticks – Referenzzeit für satellite.js. */
  lastTickTime = 0;
  lastTickDurationMs = 0;
  private readonly thread: NodeWorker;

  constructor(_url: URL | string, _options?: { type?: string; name?: string }) {
    this.thread = new NodeWorker(BOOTSTRAP, { eval: true, workerData: { bundle: WORKER_BUNDLE, ...poolSetup } });
    this.thread.on('message', (data: { type?: string; time?: number; durationMs?: number }) => {
      if (data?.type === 'tick') {
        this.lastTickAt = Date.now();
        this.lastTickTime = data.time ?? 0;
        this.lastTickDurationMs = data.durationMs ?? 0;
      }
      this.onmessage?.({ data });
    });
    this.thread.on('error', (err) => this.onerror?.({ message: err.message }));
    liveWorkers.add(this);
  }

  postMessage(message: { type?: string; shardIndex?: number }, transfer?: Transferable[]): void {
    if (message?.type === 'init') this.shard = message.shardIndex ?? -1;
    this.thread.postMessage(message, (transfer ?? []) as never);
  }

  freeze(ms: number): void {
    this.thread.postMessage({ harness: 'freeze', ms });
  }

  terminate(): void {
    liveWorkers.delete(this);
    void this.thread.terminate();
  }
}

Object.defineProperty(globalThis, 'Worker', { value: ThreadWorker, configurable: true, writable: true });
// Der Wachhund des Pools läuft über `window.setInterval`. Erst hier setzen:
// React und R3F haben ihre Umgebung beim Laden bereits gelesen.
Object.defineProperty(globalThis, 'window', {
  value: { setInterval, clearInterval, setTimeout, clearTimeout },
  configurable: true,
  writable: true,
});

/** Der Shard, der den globalen Index besitzt – dieselbe Modulo-Regel wie im Pool. */
function ownerOf(index: number): ThreadWorker {
  const shard = index % engine.shardCount;
  for (const worker of liveWorkers) if (worker.shard === shard) return worker;
  throw new Error(`Shard ${shard} läuft nicht`);
}

/* ------------------------------------------------------------------ */
/* Einhängen wie in App.tsx                                             */
/* ------------------------------------------------------------------ */

function Engine(): null {
  useSatelliteEngine({ intervalMs: 100 });
  return null;
}

async function mount(element: ReactElement) {
  const gl = { domElement: {}, render() {}, setSize() {}, setPixelRatio() {} };
  const root = createRoot({} as HTMLCanvasElement);
  await act(async () => {
    await root.configure({
      gl: gl as never,
      size: { width: 400, height: 800, top: 0, left: 0 },
      frameloop: 'never',
      dpr: 1,
    });
    root.render(element);
  });
  return { unmount: () => act(async () => root.unmount()) };
}

const setStore = (partial: Parameters<typeof useAppStore.setState>[0]) =>
  act(async () => useAppStore.setState(partial));

/** Wie TapPicker und SatelliteDrawer: Auswahl setzen und die Überflugsuche anstoßen. */
const pick = (index: number) =>
  act(async () => {
    useAppStore.getState().select(index);
    engine.requestPass(index);
  });

async function waitFor(label: string, condition: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      console.error(`    Zeitüberschreitung nach ${timeoutMs} ms: ${label}`);
      return false;
    }
    await sleep(20);
  }
  return true;
}

const indexOf = (norad: string): number => catalogIndex.meta.findIndex((meta) => meta?.noradId === norad);

/** Einige vollständige Ticks abwarten – die Auswahl muss erst im Shard ankommen. */
const settle = async () => {
  const revision = telemetry.revision;
  await waitFor('drei vollständige Ticks', () => telemetry.revision >= revision + 3);
};

/** Ab diesem Alter gilt ein Telemetriesatz als stehengeblieben (Zieltakt 100 ms). */
const STALE_MS = 2000;

/**
 * Liest den Telemetriesatz und vergleicht ihn mit satellite.js zur Epoche des
 * Ticks, aus dem er stammt. Die Toleranzen decken Float32 ab; NaN fällt in
 * jedem Fall durch.
 */
function inspect(index: number, tle: [string, string, string]) {
  const owner = ownerOf(index);
  const sample = readSample(index);
  const reference = propagateEphemeris(twoline2satrec(tle[1], tle[2]), new Date(owner.lastTickTime), observerGd);
  const ageMs = Date.now() - owner.lastTickAt;
  if (!sample || !reference) return { ok: false, text: 'kein Telemetriesatz' };
  const lonDelta = Math.abs(((sample.longitudeDeg - reference.longitudeDeg + 540) % 360) - 180);
  const ok =
    Math.abs(sample.altitudeKm - reference.altitudeKm) < 0.05 &&
    Math.abs(sample.latitudeDeg - reference.latitudeDeg) < 1e-3 &&
    lonDelta < 1e-3 &&
    Math.abs(sample.elevation - reference.elevation) * RAD < 1e-3 &&
    ageMs < STALE_MS;
  return {
    ok,
    text:
      `Bahnhöhe ${f(sample.altitudeKm)} km (satellite.js ${f(reference.altitudeKm)}), ` +
      `Subpunkt ${f(sample.latitudeDeg, 2)}° / ${f(sample.longitudeDeg, 2)}°, ` +
      `Elevation ${f(sample.elevation * RAD, 2)}°, letzter Tick des Shards vor ${f(ageMs / 1000, 1)} s`,
  };
}

async function scenario(
  title: string,
  cores: number,
  run: () => Promise<void>,
  options: { strict?: boolean; groups?: SatelliteGroup[]; delays?: Record<string, number> } = {},
): Promise<void> {
  console.log(`${title} – ${cores} Kerne`);
  Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', { value: cores, configurable: true });
  poolSetup = { feed: FEED, delays: options.delays ?? {} };
  useAppStore.setState({
    observer: null,
    selectedIndex: null,
    passes: [],
    passIndex: null,
    // Nur Gruppen, die der Vorspann ausliefert. Nach jeder Gruppe wartet der
    // Lader 1,5 s (Rate-Limit von CelesTrak); der Gesamtkatalog allein ist
    // deshalb der schnellste Weg zu LEO und MEO.
    activeGroups: options.groups ?? ['other'],
  });
  const element = createElement(Engine);
  const mounted = await mount(options.strict ? createElement(StrictMode, null, element) : element);
  try {
    await setStore({ observer: OBSERVER });
    await run();
  } finally {
    await mounted.unmount();
    await setStore({ selectedIndex: null });
  }
}

async function catalogReady(): Promise<{ leo: number; meo: number }> {
  await waitFor('Katalog mit LEO und MEO', () => {
    const leo = indexOf(LEO.norad);
    const meo = indexOf(MEO.norad);
    return leo >= 0 && meo >= 0 && telemetry.count > Math.max(leo, meo);
  });
  await settle();
  return { leo: indexOf(LEO.norad), meo: indexOf(MEO.norad) };
}

const where = (index: number) => `#${index}, Shard ${index % engine.shardCount}/${engine.shardCount}`;

async function selectAndCheck(label: string, index: number, tle: [string, string, string]): Promise<void> {
  await pick(index);
  await settle();
  const result = inspect(index, tle);
  expect(`${label} ${where(index)}`, result.ok, result.text);
}

/* ------------------------------------------------------------------ */
/* A–C: die Verdachtsfälle                                              */
/* ------------------------------------------------------------------ */

for (const cores of [2, 4, 8]) {
  await scenario('A. Auswahl im laufenden Pool (Index → Shard → Slot → scatter, SGP4 und SDP4)', cores, async () => {
    const { leo, meo } = await catalogReady();
    await selectAndCheck(`LEO ${LEO.name}`, leo, LEO_TLE);
    await selectAndCheck(`MEO ${MEO.name}`, meo, MEO_TLE);
  });
}

await scenario(
  'B. StrictMode: Pool wird beim Einhängen verworfen und neu gebaut',
  8,
  async () => {
    const { leo, meo } = await catalogReady();
    await selectAndCheck(`LEO ${LEO.name}`, leo, LEO_TLE);
    await selectAndCheck(`MEO ${MEO.name}`, meo, MEO_TLE);
  },
  { strict: true },
);

await scenario(
  'C. Katalog wächst nach der Auswahl',
  8,
  async () => {
    // Der Gesamtkatalog kommt erst 1,5 s nach `stations` – die ISS ist da
    // schon gewählt, und der Pool bekommt 24 neue Objekte dazu.
    await waitFor('ISS im Katalog', () => indexOf(LEO.norad) >= 0 && telemetry.count > indexOf(LEO.norad));
    const leo = indexOf(LEO.norad);
    await selectAndCheck(`LEO ${LEO.name} vor dem Gesamtkatalog`, leo, LEO_TLE);
    const { meo } = await catalogReady();
    const after = inspect(leo, LEO_TLE);
    expect(`LEO ${LEO.name} nach dem Gesamtkatalog ${where(leo)}`, after.ok, after.text);
    await selectAndCheck(`MEO ${MEO.name}`, meo, MEO_TLE);
  },
  { groups: ['stations', 'other'], delays: { active: 1500 } },
);

/* ------------------------------------------------------------------ */
/* D: der Fall aus dem Gerätebild                                       */
/* ------------------------------------------------------------------ */

/** Abstand zwischen angezeigten Werten und Bild, siehe Abschnitt 0. */
const FREEZE_MS = (6 * 60 + 14) * 60_000;
/** So lange darf der erste Wert nach der Auswahl höchstens brauchen. */
const FIRST_VALUE_MS = 3000;

for (const [label, tle, key] of [
  [`LEO ${LEO.name}`, LEO_TLE, 'leo'],
  [`MEO ${MEO.name}`, MEO_TLE, 'meo'],
] as const) {
  await scenario(`D. Prozess friert mitten im Tick ein (iOS: Hintergrund, Display aus), danach Auswahl – ${label}`, 8, async () => {
    const index = (await catalogReady())[key];
    const owner = ownerOf(index);

    // Nacht: iOS hält den Prozess an, während der Shard gerade rechnet.
    owner.freeze(FREEZE_MS);
    await waitFor('eingefrorener Tick', () => owner.lastTickDurationMs >= FREEZE_MS);
    const measuredMs = owner.lastTickDurationMs;
    const frozenTickAt = owner.lastTickAt;

    // Morgen: Der Nutzer tippt das Objekt an.
    const pickedAt = Date.now();
    await pick(index);
    const passesArrived = await waitFor('Überflugliste', () => useAppStore.getState().passIndex === index, 20_000);
    await waitFor(
      `Bahnhöhe innerhalb von ${FIRST_VALUE_MS} ms`,
      () => Number.isFinite(readSample(index)?.altitudeKm ?? NaN),
      FIRST_VALUE_MS,
    );
    const firstValueMs = Date.now() - pickedAt;
    const resumed = owner.lastTickAt > frozenTickAt;
    const result = inspect(index, tle);
    expect(
      `${label} ${where(index)}`,
      result.ok && passesArrived,
      `${result.text}; Überflugliste ${passesArrived ? 'geliefert' : 'fehlt'}; ` +
        `eingefrorener Tick maß ${f(measuredMs / 3_600_000, 2)} h, ` +
        (resumed
          ? `Shard danach wieder im Takt, Bahnhöhe ${firstValueMs} ms nach der Auswahl`
          : `Shard seither ohne Tick`),
    );
  });
}

console.log(`${checks} Prüfungen, ${failures} Fehlschläge`);
for (const worker of liveWorkers) worker.terminate();
if (failures > 0) process.exit(1);
console.log('✓ Bahnhöhe und Subpunkt des gewählten Objekts kommen an');
// Der Scheduler von React hält den Prozess sonst offen.
process.exit(0);
