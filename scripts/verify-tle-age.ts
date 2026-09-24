/**
 * Prüft TEIL 1 (Alter der Bahndaten) und TEIL 2 (Dauer mit Stunden) aus der
 * TLE-Alter-Aufgabe, soweit das ohne Browser ehrlich geht:
 *
 *   A. `epochMs` in `SatelliteMeta` (sgp4.worker.ts, `makeMeta` /
 *      `epochMsFromSatrec`) stimmt für vier echte TLEs (`FALLBACK_TLE`,
 *      src/data/tleSources.ts) mit einer davon UNABHÄNGIGEN Handrechnung
 *      überein: Jahr/Tag-des-Jahres direkt aus den TLE-Spalten gelesen und
 *      über `Date.UTC` umgerechnet – der Worker geht stattdessen über
 *      satellite.js' julianisches Datum (`jday`, node_modules/satellite.js/
 *      lib/ext.js). Zwei unabhängige Rechenwege, ein Ergebnis. Der echte
 *      Worker läuft dafür als Node-Thread (node:worker_threads, per esbuild
 *      gebündelt) – kein Mock von `makeMeta`.
 *
 *      Genutzt wird der eingebaute Offline-Fallback-Zweig von `loadGroups`
 *      (`nextIndex === 0` → sofort `ingest(FALLBACK_TLE, …)`, VOR jedem
 *      Netzabruf): Der läuft durch exakt denselben `ingest` → `parseTle` →
 *      `makeMeta` → `epochMsFromSatrec`-Pfad wie ein echter Gruppenabruf,
 *      nur ohne Netz und ohne Fetch-Stub. Die `catalog`-Antwort daraus trägt
 *      schon alle vier Objekte.
 *
 *   B. `formatDurationSec` (src/utils/format.ts) für die in der Abnahme
 *      genannten Fälle: 45 s, 59 min 59 s, 1 h, 16 h 12 min, 69 h 53 min 30 s
 *      (letzterer > 1 Tag: 2 d 21 h 53 min).
 *
 *   C. `tleAgeSeverity` schaltet exakt an `TLE_AGE_WARN_HOURS` /
 *      `TLE_AGE_CRITICAL_HOURS` (knapp darunter „ok“/„warn“, knapp darüber
 *      „warn“/„critical“) und symmetrisch für negatives Alter (Betrag zählt).
 *
 * Was diese Datei NICHT prüft: dass TelemetryPanel.tsx im rAF-Callback
 * wirklich `virtualNow()` liest (nicht `Date.now()`), dass die „Bahndaten“-
 * Kachel tatsächlich im DOM erscheint, und dass „≥“ vorm Höchststand in der
 * echten JSX korrekt bedingt ist. Das hängt an einem gemounteten DOM mit
 * echtem rAF/Store und ist nur im echten Browser ehrlich zu prüfen – dafür
 * ist der headless-Chrome-Teil der Abnahme da (inkl. Zeitsprung über
 * `engine.jumpTo`).
 *
 * Aufruf (package.json bewusst unverändert, s. Auftrag – direkt über esbuild
 * nach dem Muster der vorhandenen `verify:*`-Einträge):
 *
 *   esbuild src/workers/sgp4.worker.ts --bundle --platform=node --format=esm \
 *     --outfile=node_modules/.cache/verify-tle-age-worker.mjs --log-level=warning
 *   esbuild scripts/verify-tle-age.ts --bundle --platform=node --format=esm \
 *     --outfile=node_modules/.cache/verify-tle-age.mjs --log-level=warning
 *   node node_modules/.cache/verify-tle-age.mjs
 *
 * Vorschlag für package.json (trägt der Hauptagent ein):
 *   "verify:tle-age": "esbuild src/workers/sgp4.worker.ts --bundle --platform=node --format=esm --outfile=node_modules/.cache/verify-tle-age-worker.mjs --log-level=warning && esbuild scripts/verify-tle-age.ts --bundle --platform=node --format=esm --outfile=node_modules/.cache/verify-tle-age.mjs --log-level=warning && node node_modules/.cache/verify-tle-age.mjs"
 *   und in "test" aufgenommen: " && npm run verify:tle-age"
 */
import { fileURLToPath } from 'node:url';
import { Worker as NodeWorker } from 'node:worker_threads';
import { FALLBACK_TLE, normalizeNoradId } from '../src/data/tleSources';
import {
  formatDurationSec,
  TLE_AGE_CRITICAL_HOURS,
  TLE_AGE_WARN_HOURS,
  tleAgeSeverity,
} from '../src/utils/format';
import type { SatelliteMeta } from '../src/types';

let checks = 0;
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${label}${detail ? `: ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
  }
}

/* ------------------------------------------------------------------ */
/* A. epochMs gegen eine unabhängige Handrechnung                       */
/* ------------------------------------------------------------------ */

/**
 * Epoche einer TLE-Zeile 1 „von Hand“ – bewusst OHNE julianisches Datum,
 * damit ein Fehler in `jday`/`epochMsFromSatrec` sich nicht selbst bestätigt.
 * Spalten nach Spacetrack Report #3: Jahr Zeichen 19–20 (zweistellig, < 57 →
 * 20xx, sonst 19xx), Tag des Jahres Zeichen 21–32 (Bruch; Tag 1,0 = 1. Januar
 * 00:00:00 UTC).
 */
function epochMsByHand(line1: string): number {
  const yy = parseInt(line1.slice(18, 20), 10);
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const dayOfYear = parseFloat(line1.slice(20, 32));
  return Date.UTC(year, 0, 1) + (dayOfYear - 1) * 86_400_000;
}

const WORKER_BUNDLE = fileURLToPath(new URL('./verify-tle-age-worker.mjs', import.meta.url));

/**
 * Minimaler Vorspann – wie in scripts/verify-selection.ts, aber ohne
 * Fetch-Stub: Wir brauchen ihn nicht, weil die Prüfung schon vor dem
 * Netzabruf beantwortet ist (s. Dateikopf).
 */
const BOOTSTRAP = `
const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const scope = {
  onmessage: null,
  postMessage(message, transfer) { parentPort.postMessage(message, transfer || []); },
};
globalThis.self = scope;
import(pathToFileURL(workerData.bundle).href).then(() => {
  parentPort.on('message', (data) => { if (scope.onmessage) scope.onmessage({ data }); });
});
`;

interface CatalogMessage {
  type: 'catalog';
  catalog: SatelliteMeta[];
}

async function checkEpochMs(): Promise<void> {
  console.log('A. epochMs gegen unabhängige Handrechnung (vier echte TLEs, echter Worker als Node-Thread)');

  const thread = new NodeWorker(BOOTSTRAP, { eval: true, workerData: { bundle: WORKER_BUNDLE } });
  thread.postMessage({ type: 'init', shardIndex: 0, shardCount: 1 });
  thread.postMessage({ type: 'load', groups: ['stations'] });

  let catalog: SatelliteMeta[];
  try {
    catalog = await new Promise<SatelliteMeta[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout: keine catalog-Antwort')), 5000);
      thread.on('message', (data: CatalogMessage) => {
        if (data?.type === 'catalog') {
          clearTimeout(timeout);
          resolve(data.catalog);
        }
      });
      thread.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  } finally {
    await thread.terminate();
  }

  const lines = FALLBACK_TLE.split('\n');
  let found = 0;
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i]?.trim();
    const line1 = lines[i + 1];
    if (!name || !line1?.startsWith('1 ')) continue;
    const noradId = normalizeNoradId(line1.slice(2, 7));
    const meta = catalog.find((m) => m.noradId === noradId);
    const expected = epochMsByHand(line1);
    found += 1;
    const deltaMs = meta ? meta.epochMs - expected : Number.NaN;
    check(
      `${name} (NORAD ${noradId})`,
      meta !== undefined && Math.abs(deltaMs) < 2,
      meta
        ? `Worker ${new Date(meta.epochMs).toISOString()}, Handrechnung ${new Date(expected).toISOString()}, Δ ${deltaMs.toFixed(3)} ms`
        : 'Objekt nicht im Katalog angekommen',
    );
  }
  check('mindestens drei TLEs geprüft', found >= 3, `${found} geprüft`);
}

/* ------------------------------------------------------------------ */
/* B. formatDurationSec                                                 */
/* ------------------------------------------------------------------ */

function checkFormatDurationSec(): void {
  console.log('B. formatDurationSec – Stunden- und Tagesumbruch');

  const cases: Array<[label: string, seconds: number, expected: string]> = [
    ['45 s', 45, '45 s'],
    ['59 min 59 s', 59 * 60 + 59, '59 min 59 s'],
    ['1 h', 3600, '1 h'],
    ['16 h 12 min', 16 * 3600 + 12 * 60, '16 h 12 min'],
    // 69 h 53 min 30 s = 2 volle Tage (48 h) + 21 h 53 min 30 s. Ab einem Tag
    // fallen die Sekunden weg (s. JSDoc formatDurationSec) – erwartet also
    // „2 d 21 h 53 min“, nicht „69 h …“.
    ['69 h 53 min 30 s', 69 * 3600 + 53 * 60 + 30, '2 d 21 h 53 min'],
    // Zusätzliche Randfälle, nicht in der Abnahme genannt, aber offensichtlich
    // dieselbe Regel prüfend: 0 s, eine glatte Minute, ein glatter Tag.
    ['0 s', 0, '0 s'],
    ['1 min 0 s', 60, '1 min 0 s'],
    ['1 d (glatt)', 86_400, '1 d'],
  ];

  for (const [label, seconds, expected] of cases) {
    const actual = formatDurationSec(seconds);
    check(`${label} (${seconds} s)`, actual === expected, `„${actual}“ (erwartet „${expected}“)`);
  }
}

/* ------------------------------------------------------------------ */
/* C. Warnstufen-Schwellen                                              */
/* ------------------------------------------------------------------ */

function checkSeverityThresholds(): void {
  console.log('C. tleAgeSeverity – Schaltpunkte bei TLE_AGE_WARN_HOURS/TLE_AGE_CRITICAL_HOURS');

  const EPS = 0.01;
  const cases: Array<[label: string, hours: number, expected: 'ok' | 'warn' | 'critical']> = [
    ['knapp unter WARN', TLE_AGE_WARN_HOURS - EPS, 'ok'],
    ['genau WARN', TLE_AGE_WARN_HOURS, 'warn'],
    ['knapp über WARN', TLE_AGE_WARN_HOURS + EPS, 'warn'],
    ['knapp unter CRITICAL', TLE_AGE_CRITICAL_HOURS - EPS, 'warn'],
    ['genau CRITICAL', TLE_AGE_CRITICAL_HOURS, 'critical'],
    ['knapp über CRITICAL', TLE_AGE_CRITICAL_HOURS + EPS, 'critical'],
    // Negatives Alter (Rechenzeit vor der Epoche): derselbe Betrag, dieselbe Stufe.
    ['negativ, genau WARN', -TLE_AGE_WARN_HOURS, 'warn'],
    ['negativ, genau CRITICAL', -TLE_AGE_CRITICAL_HOURS, 'critical'],
    ['0 h', 0, 'ok'],
  ];

  for (const [label, hours, expected] of cases) {
    const actual = tleAgeSeverity(hours);
    check(`${label} (${hours.toFixed(2)} h)`, actual === expected, `„${actual}“ (erwartet „${expected}“)`);
  }
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await checkEpochMs();
  checkFormatDurationSec();
  checkSeverityThresholds();

  console.log(`${checks} Prüfungen, ${failures} Fehlschläge`);
  if (failures > 0) {
    console.error('✗ TLE-Alter/Dauerformatierung: mindestens eine Prüfung fehlgeschlagen');
    process.exitCode = 1;
  } else {
    console.log('✓ epochMs, formatDurationSec und die Warnstufen-Schwellen stimmen');
  }
}

void main();
