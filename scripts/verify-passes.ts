/**
 * Prüft die Überflugvorhersage (`predictPasses` in src/math/propagation.ts)
 * gegen eine unabhängige Referenz.
 *
 * Anlass sind zwei Gerätebilder (iPhone 17 Pro, PWA, 24.09.2026, 08:55 MESZ,
 * Standort 51,370° N / 12,400° O): SL-16 R/B stand bei 6,62°, STARLINK-6262
 * bei 9,57° Elevation – die Überflugliste begann trotzdem erst „in 1 h 36 min“
 * bzw. „in 1 h 30 min“. `predictNextPass` erkannte einen Überflug nur an
 * seinem Aufgang und übersprang deshalb den, der gerade am Himmel stand.
 * Abschnitt A stellt beide Bilder nach.
 *
 * Referenz ist satellite.js direkt (`propagate`, `gstime`, `eciToEcf`,
 * `ecfToLookAngles`) in 1-s-Schritten, NICHT der geprüfte Code: Horizont-
 * durchgänge linear interpoliert, Höchststand per Parabel durch drei Punkte.
 * Die Sonnenrichtung kommt aus astronomy-engine statt aus src/math/sun.ts,
 * der Erdschatten aus einem eigenen Zylindermodell. Aus dem Projekt
 * übernommen werden das Helligkeitsmodell (src/math/visibility.ts) und der
 * Erdradius – beides Modell, nicht Gegenstand dieser Prüfung –, außerdem
 * `geoToObserverGd` und `RAD` (src/math/coords.ts), aus denen der Beobachter
 * für den geprüften Code UND für die Referenz entsteht, `formatCountdown`
 * (src/utils/format.ts) für den Vergleich mit dem Countdown im Gerätebild,
 * und `sunEciUnitVector` (src/math/sun.ts) nur, um die beiden Sonnenmodelle
 * gegeneinander zu vermessen.
 *
 * TLE: echte CelesTrak-Sätze (Epoche 21.–23.09.2026), so wie die App sie am
 * 24.09.2026 um 06:54 UTC geladen hatte. SL-16 R/B und STARLINK-6262 treffen
 * Elevation, Azimut und Distanz der Gerätebilder auf die Sekunde genau.
 *
 * Jeder `predictPasses`-Aufruf läuft in einem eigenen Thread mit Zeitlimit:
 * Eine Rückwärtssuche ohne Obergrenze hinge bei einem geostationären Objekt
 * für immer – das soll als Fehlschlag enden, nicht als stehender Test.
 *
 * Aufruf: npm run verify:passes
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import {
  ecfToEci,
  ecfToLookAngles,
  eciToEcf,
  geodeticToEcf,
  gstime,
  propagate,
  twoline2satrec,
} from 'satellite.js';
import type { SatRec } from 'satellite.js';
import { Body, GeoVector, RotateVector, Rotation_EQJ_EQD } from 'astronomy-engine';
import { EARTH_RADIUS_KM, RAD, geoToObserverGd } from '../src/math/coords';
import { predictPasses } from '../src/math/propagation';
import { sunEciUnitVector } from '../src/math/sun';
import {
  NAKED_EYE_LIMIT,
  NAKED_EYE_MIN_ELEVATION,
  apparentMagnitude,
  phaseAngle,
  standardMagnitudeFor,
} from '../src/math/visibility';
import { formatCountdown } from '../src/utils/format';
import type { ObserverGd, PassPrediction, SatelliteGroup, Vec3 } from '../src/types';

/* ------------------------------------------------------------------ */
/* Testdaten                                                            */
/* ------------------------------------------------------------------ */

interface Sat {
  name: string;
  norad: string;
  group: SatelliteGroup;
  l1: string;
  l2: string;
}

const SATS = {
  iss: {
    name: 'ISS (ZARYA)',
    norad: '25544',
    group: 'stations',
    l1: '1 25544U 98067A   26266.88389698  .00009434  00000+0  17760-3 0  9994',
    l2: '2 25544  51.6318 171.6234 0004723 174.4397 185.6645 15.49253495587058',
  },
  starlink: {
    name: 'STARLINK-6262',
    norad: '57091',
    group: 'starlink',
    l1: '1 57091U 23088AV  26266.75052697  .00000118  00000+0  13813-4 0  9995',
    l2: '2 57091  43.0053  57.3671 0001727 274.7304  85.3351 15.27577740180797',
  },
  sl16: {
    name: 'SL-16 R/B',
    norad: '22220',
    group: 'brightest',
    l1: '1 22220U 92076B   26266.87244883 -.00000015  00000+0  16157-4 0  9998',
    l2: '2 22220  70.9991 130.8984 0011887 162.6800 279.9676 14.16883809749909',
  },
  // Sonnensynchron, 98,6° Inklination.
  metop: {
    name: 'METOP-B',
    norad: '38771',
    group: 'weather',
    l1: '1 38771U 12049A   26266.94744253  .00000059  00000+0  46516-4 0  9991',
    l2: '2 38771  98.6402 316.4270 0003299  72.7459 287.4079 14.21460619727295',
  },
  // MEO, 773 min Umlauf – satellite.js rechnet das im Deep-Space-Zweig (SDP4).
  beidou: {
    name: 'BEIDOU-3 M16',
    norad: '43647',
    group: 'other',
    l1: '1 43647U 18078A   26264.13329856 -.00000015  00000+0  00000+0 0  9990',
    l2: '2 43647  54.0007 296.6129 0006093  30.7925 329.3056  1.86232488 53942',
  },
  // Molnija-Bahn, Exzentrizität 0,66: Überflüge von zehn Stunden.
  meridian: {
    name: 'MERIDIAN 7',
    norad: '40296',
    group: 'other',
    l1: '1 40296U 14069A   26266.38886543  .00000232  00000+0  00000+0 0  9993',
    l2: '2 40296  63.4472 205.7856 6614101 269.8886  20.2357  2.00606134 87206',
  },
  // Geostationär – steht von Mitteleuropa aus dauerhaft über dem Horizont.
  meteosat: {
    name: 'METEOSAT-11 (MSG-4)',
    norad: '40732',
    group: 'weather',
    l1: '1 40732U 15034A   26266.84311089  .00000065  00000+0  00000+0 0  9994',
    l2: '2 40732   3.4435  70.3885 0000517  86.6858 158.4640  1.00275861  8200',
  },
  // Hochexzentrisch, 14 Tage Umlauf, Apogäum in Monddistanz.
  tess: {
    name: 'TESS',
    norad: '43435',
    group: 'other',
    l1: '1 43435U 18038A   26264.61819158 -.00000879  00000+0  00000+0 0  9991',
    l2: '2 43435  56.2338  32.1610 4943752  64.1731  11.1423  0.07023037  1923',
  },
} satisfies Record<string, Sat>;

type SatKey = keyof typeof SATS;

/** Standort der Gerätebilder. */
const LEIPZIG = { latitudeDeg: 51.37, longitudeDeg: 12.4, altitudeKm: 0.1 };

/** Wie der Worker (src/workers/sgp4.worker.ts) die Suche aufruft. */
const SEARCH_HOURS = 48;
const WORKER_OPTIONS = { searchHours: SEARCH_HOURS, stepSec: 30, minElevationDeg: 1 };

/** Obergrenze der Rückwärtssuche – so in src/math/propagation.ts festgelegt. */
const LOOKBACK_MS = 24 * 3600_000;
/** So weit hinter das Suchfenster verfolgt `predictNextPass` einen Bogen bis zum Untergang. */
const TRACE_BEYOND_MS = 3600_000;

/* ------------------------------------------------------------------ */
/* Aufruf des geprüften Codes – in einem eigenen Thread mit Zeitlimit    */
/* ------------------------------------------------------------------ */

interface Job {
  sat: SatKey;
  fromMs: number;
}

function standardMagnitude(sat: Sat): number {
  return standardMagnitudeFor(sat.norad, sat.group);
}

function runJob(job: Job): PassPrediction[] {
  const sat = SATS[job.sat];
  return predictPasses(twoline2satrec(sat.l1, sat.l2), geoToObserverGd(LEIPZIG), {
    fromMs: job.fromMs,
    ...WORKER_OPTIONS,
    standardMagnitude: standardMagnitude(sat),
  });
}

/** Ein geostationäres Objekt braucht hier gemessen unter 0,2 s; 30 s heißt „hängt“. */
const JOB_TIMEOUT_MS = 30_000;

function runWithTimeout(job: Job): Promise<{ passes: PassPrediction[]; ms: number } | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: job });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve(null);
    }, JOB_TIMEOUT_MS);
    worker.once('message', (result: { passes: PassPrediction[]; ms: number }) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Referenz                                                             */
/* ------------------------------------------------------------------ */

interface RefLook {
  el: number;
  az: number;
  range: number;
  pos: Vec3;
}

function refLook(satrec: SatRec, observer: ObserverGd, ms: number): RefLook {
  const date = new Date(ms);
  const pv = propagate(satrec, date) as unknown as { position: Vec3 | false };
  if (!pv.position || !Number.isFinite(pv.position.x)) {
    throw new Error(`satellite.js liefert keine Position für ${new Date(ms).toISOString()}`);
  }
  const ecf = eciToEcf(pv.position as never, gstime(date));
  const look = ecfToLookAngles(observer as never, ecf) as unknown as {
    elevation: number;
    azimuth: number;
    rangeSat: number;
  };
  return { el: look.elevation, az: look.azimuth, range: look.rangeSat, pos: pv.position };
}

const sunCache = new Map<number, Vec3>();

/**
 * Sonnenrichtung aus astronomy-engine (wahres Äquinoktium des Datums, mit
 * Aberration), einmal je Minute – in einer Minute wandert die Sonne 0,0007°.
 */
function refSun(ms: number): Vec3 {
  const minute = Math.round(ms / 60_000);
  let unit = sunCache.get(minute);
  if (!unit) {
    const date = new Date(minute * 60_000);
    const v = RotateVector(Rotation_EQJ_EQD(date), GeoVector(Body.Sun, date, true));
    const length = Math.hypot(v.x, v.y, v.z);
    unit = { x: v.x / length, y: v.y / length, z: v.z / length };
    sunCache.set(minute, unit);
  }
  return unit;
}

function refSunlit(pos: Vec3, sun: Vec3): boolean {
  const dot = pos.x * sun.x + pos.y * sun.y + pos.z * sun.z;
  if (dot > 0) return true;
  return Math.hypot(pos.x - dot * sun.x, pos.y - dot * sun.y, pos.z - dot * sun.z) >= EARTH_RADIUS_KM;
}

interface RefArc {
  aos: number;
  los: number;
  tca: number;
  /** Radiant. */
  maxEl: number;
  /** Bogen beginnt/endet am Rand des Referenzfensters. */
  aosOpen: boolean;
  losOpen: boolean;
}

/** Alle Bögen über dem Horizont in [fromMs, toMs], abgetastet im Sekundentakt. */
function refArcs(satrec: SatRec, observer: ObserverGd, fromMs: number, toMs: number): RefArc[] {
  const arcs: RefArc[] = [];
  let prevMs = fromMs;
  let prevEl = refLook(satrec, observer, fromMs).el;
  let current: RefArc | null =
    prevEl > 0
      ? { aos: fromMs, los: Number.NaN, tca: fromMs, maxEl: prevEl, aosOpen: true, losOpen: false }
      : null;

  for (let t = fromMs + 1000; t <= toMs; t += 1000) {
    const el = refLook(satrec, observer, t).el;
    const crossing = prevMs + ((0 - prevEl) / (el - prevEl)) * 1000;
    if (prevEl <= 0 && el > 0) {
      current = { aos: crossing, los: Number.NaN, tca: t, maxEl: el, aosOpen: false, losOpen: false };
    } else if (prevEl > 0 && el <= 0 && current) {
      current.los = crossing;
      arcs.push(current);
      current = null;
    }
    if (current && el > current.maxEl) {
      current.maxEl = el;
      current.tca = t;
    }
    prevEl = el;
    prevMs = t;
  }
  if (current) {
    current.los = toMs;
    current.losOpen = true;
    arcs.push(current);
  }

  // Höchststand zwischen den Sekunden: Scheitel der Parabel durch drei Punkte.
  for (const arc of arcs) {
    if (arc.tca - 1000 < fromMs || arc.tca + 1000 > toMs) continue;
    const e0 = refLook(satrec, observer, arc.tca - 1000).el;
    const e1 = refLook(satrec, observer, arc.tca).el;
    const e2 = refLook(satrec, observer, arc.tca + 1000).el;
    const curvature = e0 - 2 * e1 + e2;
    if (curvature >= 0) continue;
    const shift = (0.5 * (e0 - e2)) / curvature;
    if (Math.abs(shift) > 1) continue;
    arc.tca += shift * 1000;
    arc.maxEl = e1 - 0.25 * (e0 - e2) * shift;
  }
  return arcs;
}

interface RefLight {
  sunlitStart: number | null;
  sunlitEnd: number | null;
  /** Summe der Sekundenschritte, die an beiden Enden beschienen sind. */
  sunlitSec: number;
  /** Wechsel zwischen Sonne und Schatten innerhalb des Bogens. */
  transitions: number;
  /** Schattenzeit zwischen erstem und letztem beschienenen Moment, s. */
  shadowInsideSec: number;
  peakMagnitude: number;
  /** Hellste Magnitude oberhalb der Mindesthöhe für „bloßes Auge“. */
  bestNakedMagnitude: number;
}

function refLight(
  satrec: SatRec,
  observer: ObserverGd,
  aos: number,
  los: number,
  standardMag: number,
): RefLight {
  const observerEcf = geodeticToEcf(observer as never);
  const light: RefLight = {
    sunlitStart: null,
    sunlitEnd: null,
    sunlitSec: 0,
    transitions: 0,
    shadowInsideSec: 0,
    peakMagnitude: 99,
    bestNakedMagnitude: 99,
  };
  let previous: boolean | null = null;
  let previousMs = aos;
  const whole = Math.floor((los - aos) / 1000);

  for (let k = 0; k <= whole + 1; k += 1) {
    const ms = k <= whole ? aos + k * 1000 : los;
    const look = refLook(satrec, observer, ms);
    const sun = refSun(ms);
    const sunlit = refSunlit(look.pos, sun);
    if (previous !== null && sunlit !== previous) light.transitions += 1;
    if (sunlit) {
      if (light.sunlitStart === null) light.sunlitStart = ms;
      light.sunlitEnd = ms;
      if (previous) light.sunlitSec += (ms - previousMs) / 1000;
      const observerEci = ecfToEci(observerEcf, gstime(new Date(ms))) as unknown as Vec3;
      const magnitude = apparentMagnitude(
        standardMag,
        look.range,
        phaseAngle(look.pos, observerEci, sun),
        look.el,
      );
      light.peakMagnitude = Math.min(light.peakMagnitude, magnitude);
      if (look.el >= NAKED_EYE_MIN_ELEVATION) {
        light.bestNakedMagnitude = Math.min(light.bestNakedMagnitude, magnitude);
      }
    }
    previous = sunlit;
    previousMs = ms;
  }
  if (light.sunlitStart !== null && light.sunlitEnd !== null) {
    light.shadowInsideSec = (light.sunlitEnd - light.sunlitStart) / 1000 - light.sunlitSec;
  }
  return light;
}

/* ------------------------------------------------------------------ */
/* Prüfrahmen                                                           */
/* ------------------------------------------------------------------ */

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

const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');
const utc = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
const f = (value: number, digits = 2): string => value.toFixed(digits);
const BERLIN = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  hour: '2-digit',
  minute: '2-digit',
});
const berlin = (ms: number): string => BERLIN.format(new Date(ms));

/** AOS/LOS: Bisektion bis 0,5 s, Referenz auf Bruchteile einer Sekunde. */
const HORIZON_TOL_MS = 1000;
/** TCA liegt im Code auf einem 10-s-Raster. */
const TCA_TOL_MS = 10_000;
/** Die Helligkeitsanalyse tastet in höchstens 15-s-Schritten ab; dazu Sonnenmodell. */
const LIGHT_STEP_TOL_MS = 15_000 + 3000;

interface Scenario {
  title: string;
  sat: SatKey;
  from: string;
  /** Vorbedingungen und zusätzliche Erwartungen dieses Falls. */
  extra?: (context: Context) => void;
}

interface Context {
  fromMs: number;
  passes: PassPrediction[];
  arcs: RefArc[];
  satrec: SatRec;
  observer: ObserverGd;
  lights: Map<PassPrediction, RefLight>;
}

/**
 * Abgleich der gelieferten Liste mit der Referenz – für jeden Fall gleich.
 */
function compareWithReference(scenario: Scenario, context: Context): void {
  const { fromMs, passes, arcs, satrec, observer } = context;
  const sat = SATS[scenario.sat];
  const endMs = fromMs + SEARCH_HOURS * 3600_000;
  const minEl = WORKER_OPTIONS.minElevationDeg / RAD;

  // Erwartet: der Bogen, der bei fromMs läuft, und alle mit Aufgang im Fenster.
  // Knapp über der Mindesthöhe oder am Fensterende entscheidet das Raster –
  // solche Bögen dürfen fehlen, aber nicht falsch sein.
  const relevant = arcs.filter(
    (arc) => (arc.aos <= fromMs && arc.los > fromMs) || (arc.aos > fromMs && arc.aos <= endMs),
  );
  const mandatory = relevant.filter(
    (arc) => arc.maxEl >= minEl + 0.3 / RAD && Math.abs(arc.aos - endMs) > 60_000,
  );
  const optional = relevant.filter((arc) => !mandatory.includes(arc) && arc.maxEl >= minEl - 0.05 / RAD);

  const unmatched: PassPrediction[] = [];
  const matchCount = new Map<RefArc, number>();
  const pairs: Array<[PassPrediction, RefArc]> = [];
  for (const pass of passes) {
    const arc = relevant.find((candidate) => pass.aos < candidate.los && pass.los > candidate.aos);
    if (!arc || !(mandatory.includes(arc) || optional.includes(arc))) {
      unmatched.push(pass);
      continue;
    }
    matchCount.set(arc, (matchCount.get(arc) ?? 0) + 1);
    pairs.push([pass, arc]);
  }
  const missing = mandatory.filter((arc) => !matchCount.has(arc));
  const doubled = [...matchCount.entries()].filter(([, count]) => count > 1);
  expect(
    'Liste deckt sich mit der Referenz',
    unmatched.length === 0 && missing.length === 0 && doubled.length === 0,
    `${passes.length} Überflüge, Referenz ${mandatory.length} sicher + ${optional.length} grenzwertig` +
      (missing.length ? `; fehlt: ${missing.map((a) => utc(a.aos)).join(', ')}` : '') +
      (unmatched.length ? `; ohne Gegenstück: ${unmatched.map((p) => iso(p.aos)).join(', ')}` : '') +
      (doubled.length ? `; doppelt: ${doubled.map(([a, n]) => `${iso(a.aos)} ×${n}`).join(', ')}` : ''),
  );

  let orderOk = true;
  for (let i = 1; i < passes.length; i += 1) {
    if (!(passes[i].aos > passes[i - 1].los)) orderOk = false;
  }
  expect('Reihenfolge ohne Überlappung', orderOk, 'jeder Aufgang liegt hinter dem vorigen Untergang');

  let horizonWorst = 0;
  let tcaWorst = 0;
  let tcaElWorst = 0;
  let cursorWorst = -Infinity;
  const horizonBad: string[] = [];
  const tcaBad: string[] = [];
  const openBad: string[] = [];
  const lightBad: string[] = [];
  let contiguousChecked = 0;

  for (const [pass, arc] of pairs) {
    const label = utc(pass.aos);

    // Offene Enden: aus der Referenz ableiten, nicht aus dem Code.
    const expectAosOpen = arc.aosOpen;
    const expectLosOpen = arc.losOpen;
    if (pass.aosOpen !== expectAosOpen || pass.losOpen !== expectLosOpen) {
      openBad.push(`${label} aosOpen=${pass.aosOpen}/${expectAosOpen} losOpen=${pass.losOpen}/${expectLosOpen}`);
    }

    if (expectAosOpen) {
      // Frühester bestätigter Punkt über dem Horizont, höchstens 24 h zurück.
      const okBound = pass.aos >= fromMs - LOOKBACK_MS && pass.aos <= fromMs - LOOKBACK_MS + 30_000;
      if (!okBound || refLook(satrec, observer, pass.aos).el <= 0) {
        openBad.push(`${label} offener Anfang bei ${iso(pass.aos)}, erwartet ${iso(fromMs - LOOKBACK_MS)}`);
      }
    } else {
      const d = Math.abs(pass.aos - arc.aos);
      horizonWorst = Math.max(horizonWorst, d);
      if (d > HORIZON_TOL_MS) horizonBad.push(`${label} AOS Δ${f(d / 1000, 1)} s`);
    }
    if (expectLosOpen) {
      if (pass.los < endMs + TRACE_BEYOND_MS - 10_000 || refLook(satrec, observer, pass.los).el <= 0) {
        openBad.push(`${label} offenes Ende bei ${iso(pass.los)}`);
      }
    } else {
      const d = Math.abs(pass.los - arc.los);
      horizonWorst = Math.max(horizonWorst, d);
      if (d > HORIZON_TOL_MS) horizonBad.push(`${label} LOS Δ${f(d / 1000, 1)} s`);
      // Der nächste Suchlauf beginnt 60 s hinter dem Untergang. Stünde der
      // Satellit dort noch über dem Horizont, suchte er rückwärts in diesen Bogen.
      cursorWorst = Math.max(cursorWorst, refLook(satrec, observer, pass.los + 60_000).el * RAD);
    }

    // Höchststand: Elevation am gemeldeten TCA gleich der gemeldeten, und
    // entweder zeitlich im Raster oder um höchstens 0,001° unter dem Maximum
    // (bei geostationären Objekten ist der Scheitel stundenlang flach).
    const elAtTca = refLook(satrec, observer, pass.tca).el * RAD;
    const dt = Math.abs(pass.tca - arc.tca);
    const dropDeg = arc.maxEl * RAD - elAtTca;
    tcaWorst = Math.max(tcaWorst, Math.min(dt, dropDeg <= 1e-3 ? 0 : dt));
    tcaElWorst = Math.max(tcaElWorst, Math.abs(elAtTca - pass.maxElevationDeg));
    if (
      Math.abs(elAtTca - pass.maxElevationDeg) > 1e-3 ||
      pass.maxElevationDeg > arc.maxEl * RAD + 1e-3 ||
      (dt > TCA_TOL_MS && dropDeg > 1e-3) ||
      pass.tca < pass.aos ||
      pass.tca > pass.los
    ) {
      tcaBad.push(
        `${label} TCA ${iso(pass.tca)} (${f(pass.maxElevationDeg)}°), Referenz ${iso(Math.round(arc.tca))} (${f(arc.maxEl * RAD)}°)`,
      );
    }
    if (Math.abs(pass.durationSec - (pass.los - pass.aos) / 1000) > 1e-6) {
      tcaBad.push(`${label} Dauer ${pass.durationSec} s passt nicht zu AOS/LOS`);
    }

    // Helligkeit über den gemeldeten Bogen, im Sekundentakt.
    const light = refLight(satrec, observer, pass.aos, pass.los, standardMagnitude(sat));
    context.lights.set(pass, light);
    const stepTol = LIGHT_STEP_TOL_MS;
    const sunlitRefSec = light.sunlitSec;
    if (light.sunlitStart === null || sunlitRefSec < 30) {
      if (sunlitRefSec === 0 && pass.sunlitStart !== null) lightBad.push(`${label} beschienen gemeldet, Referenz: nie`);
    } else {
      const startDelta = pass.sunlitStart === null ? Infinity : Math.abs(pass.sunlitStart - light.sunlitStart);
      const endDelta =
        pass.sunlitEnd === null || light.sunlitEnd === null ? Infinity : Math.abs(pass.sunlitEnd - light.sunlitEnd);
      // Jeder Wechsel kostet die 15-s-Abtastung bis zu einen Schritt.
      const secLow = sunlitRefSec - light.transitions * (stepTol / 1000) - 2;
      const secHigh = sunlitRefSec + 2;
      if (startDelta > stepTol || endDelta > stepTol || pass.sunlitSec < secLow || pass.sunlitSec > secHigh) {
        lightBad.push(
          `${label} beschienen ${pass.sunlitStart === null ? '–' : utc(pass.sunlitStart)}–` +
            `${pass.sunlitEnd === null ? '–' : utc(pass.sunlitEnd)} ${f(pass.sunlitSec, 0)} s, Referenz ` +
            `${utc(light.sunlitStart)}–${utc(light.sunlitEnd as number)} ${f(sunlitRefSec, 0)} s ` +
            `(${light.transitions} Wechsel)`,
        );
      }
      // Hängt das beschienene Stück zusammen, bleibt die Dauer wie bisher Ende minus Anfang.
      if (light.shadowInsideSec === 0 && pass.sunlitStart !== null && pass.sunlitEnd !== null) {
        contiguousChecked += 1;
        const span = (pass.sunlitEnd - pass.sunlitStart) / 1000;
        if (Math.abs(pass.sunlitSec - span) > 1e-6) {
          lightBad.push(`${label} zusammenhängend, aber ${pass.sunlitSec} s ≠ Ende − Anfang ${span} s`);
        }
      }
      if (pass.peakMagnitude < light.peakMagnitude - 0.02 || pass.peakMagnitude > light.peakMagnitude + 0.25) {
        lightBad.push(`${label} Spitzenhelligkeit ${f(pass.peakMagnitude)} mag, Referenz ${f(light.peakMagnitude)} mag`);
      }
      // Bloßes Auge nur prüfen, wo die Referenz eindeutig ist.
      if (light.bestNakedMagnitude <= NAKED_EYE_LIMIT - 0.2 && !pass.nakedEye) {
        lightBad.push(`${label} bloßes Auge fehlt (Referenz ${f(light.bestNakedMagnitude)} mag über 10°)`);
      }
      if (light.bestNakedMagnitude >= NAKED_EYE_LIMIT + 0.2 && pass.nakedEye) {
        lightBad.push(`${label} bloßes Auge gemeldet (Referenz ${f(light.bestNakedMagnitude)} mag über 10°)`);
      }
    }
  }

  expect(
    'Offene Enden',
    openBad.length === 0,
    openBad.length ? openBad.join('; ') : `${pairs.filter(([p]) => p.aosOpen || p.losOpen).length} offene Überflüge korrekt`,
  );
  expect(
    'AOS/LOS',
    horizonBad.length === 0,
    horizonBad.length ? horizonBad.join('; ') : `größte Abweichung ${f(horizonWorst / 1000, 2)} s`,
  );
  expect(
    'TCA und Höchststand',
    tcaBad.length === 0,
    tcaBad.length
      ? tcaBad.join('; ')
      : `TCA ≤ ${f(tcaWorst / 1000, 1)} s neben der Referenz, Elevation am TCA ±${tcaElWorst.toExponential(1)}°`,
  );
  if (cursorWorst > -Infinity) {
    expect(
      'Nächster Suchlauf beginnt unter dem Horizont',
      cursorWorst < 0,
      `höchste Elevation 60 s nach einem Untergang ${f(cursorWorst, 3)}°`,
    );
  }
  expect(
    'Helligkeit über den ganzen Bogen',
    lightBad.length === 0,
    lightBad.length ? lightBad.join('; ') : `${pairs.length} Bögen, davon ${contiguousChecked} zusammenhängend beschienen (Dauer = Ende − Anfang)`,
  );
}

/* ------------------------------------------------------------------ */
/* Fälle                                                                */
/* ------------------------------------------------------------------ */

function runningPass(context: Context): PassPrediction | undefined {
  return context.passes.find((p) => p.aos <= context.fromMs && p.los > context.fromMs);
}

function arcAt(context: Context, ms: number): RefArc | undefined {
  return context.arcs.find((arc) => arc.aos <= ms && arc.los > ms);
}

/** Gemeinsame Erwartung für jeden Fall, in dem bei fromMs etwas am Himmel steht. */
function expectRunningFirst(context: Context, label: string): PassPrediction | undefined {
  const arc = arcAt(context, context.fromMs);
  const first = context.passes[0];
  const running = runningPass(context);
  expect(
    `${label}: laufender Überflug steht vorn`,
    Boolean(arc) && running !== undefined && running === first,
    arc
      ? `Referenz: über dem Horizont seit ${iso(Math.round(arc.aos))}, ` +
          `erster Eintrag ${first ? `${iso(Math.round(first.aos))} – ${iso(Math.round(first.los))}` : 'fehlt'}`
      : 'Vorbedingung verletzt: Referenz sieht bei fromMs keinen Bogen',
  );
  return running;
}

function screenshotCase(
  label: string,
  context: Context,
  shot: { elevation: number; azimuth: number; range: number; countdown: string; window: string },
): void {
  const look = refLook(context.satrec, context.observer, context.fromMs);
  expect(
    `${label}: Gerätebild nachgestellt`,
    Math.abs(look.el * RAD - shot.elevation) < 0.03 &&
      Math.abs(look.az * RAD - shot.azimuth) < 0.6 &&
      Math.abs(look.range - shot.range) < 3,
    `Referenz ${f(look.el * RAD)}° / ${f(look.az * RAD, 1)}° / ${f(look.range, 1)} km, ` +
      `Bild ${shot.elevation}° / ${shot.azimuth}° / ${shot.range} km`,
  );
  const running = expectRunningFirst(context, label);
  // Der alte erste Eintrag ist jetzt der zweite – mit denselben Angaben wie im Bild.
  const second = context.passes[1];
  const secondStart = second ? (second.sunlitStart ?? second.aos) : NaN;
  const shownWindow = second
    ? `${berlin(secondStart)} – ${berlin(second.sunlitEnd ?? second.los)}`
    : '–';
  const shownCountdown = second ? formatCountdown(secondStart, context.fromMs) : '–';
  expect(
    `${label}: bisheriger erster Eintrag folgt an zweiter Stelle`,
    running !== undefined && shownWindow === shot.window && shownCountdown === shot.countdown,
    `„${shownWindow}“, „${shownCountdown}“ – Gerätebild „${shot.window}“, „${shot.countdown}“`,
  );
}

const SCENARIOS: Scenario[] = [
  {
    title: 'A1. Gerätebild SL-16 R/B, 24.09.2026 08:55 MESZ',
    sat: 'sl16',
    from: '2026-09-24T06:55:04Z',
    extra: (c) =>
      screenshotCase('SL-16 R/B', c, {
        elevation: 6.62,
        azimuth: 110,
        range: 2735.0,
        countdown: 'in 1 h 36 min',
        window: '10:31 – 10:47',
      }),
  },
  {
    title: 'A2. Gerätebild STARLINK-6262, 24.09.2026 08:55 MESZ – Höchststand schon vorbei',
    sat: 'starlink',
    from: '2026-09-24T06:55:57Z',
    extra: (c) => {
      screenshotCase('STARLINK-6262', c, {
        elevation: 9.57,
        azimuth: 121,
        range: 1692.6,
        countdown: 'in 1 h 30 min',
        window: '10:26 – 10:37',
      });
      const arc = arcAt(c, c.fromMs);
      const running = runningPass(c);
      expect(
        'STARLINK-6262: TCA liegt vor dem Suchbeginn',
        arc !== undefined && arc.tca < c.fromMs - 60_000 && running !== undefined && running.tca < c.fromMs,
        `Referenz-TCA ${arc ? iso(Math.round(arc.tca)) : '–'}, gemeldet ${running ? iso(running.tca) : '–'}`,
      );
    },
  },
  {
    title: 'B1. ISS, 21:25 MESZ: sichtbarer Teil schon vorbei, jetzt im Erdschatten',
    sat: 'iss',
    from: '2026-09-24T19:25:30Z',
    extra: (c) => {
      const running = expectRunningFirst(c, 'ISS');
      const light = running ? c.lights.get(running) : undefined;
      // Vorbedingung: Das Sichtbare liegt komplett vor fromMs. Eine Analyse nur
      // des künftigen Teils fände keinen beschienenen Moment und kein „bloßes Auge“.
      expect(
        'ISS: Vorbedingung – beschienen nur vor dem Suchbeginn, mit bloßem Auge sichtbar',
        light !== undefined &&
          light.sunlitEnd !== null &&
          light.sunlitEnd < c.fromMs - 60_000 &&
          light.bestNakedMagnitude <= NAKED_EYE_LIMIT - 1,
        light
          ? `Referenz beschienen bis ${light.sunlitEnd === null ? '–' : iso(light.sunlitEnd)}, ` +
              `hellste ${f(light.bestNakedMagnitude)} mag über 10°`
          : 'kein laufender Überflug',
      );
      expect(
        'ISS: Helligkeit des vergangenen Teils gemeldet',
        running !== undefined &&
          running.nakedEye &&
          running.sunlitStart !== null &&
          running.sunlitStart < c.fromMs &&
          running.peakMagnitude < 1,
        running
          ? `bloßes Auge ${running.nakedEye}, beschienen ab ${running.sunlitStart === null ? '–' : iso(running.sunlitStart)}, ` +
              `${f(running.peakMagnitude)} mag`
          : '–',
      );
    },
  },
  {
    title: 'B2. ISS, kurz nach dem Aufgang (Höchststand steht noch bevor)',
    sat: 'iss',
    from: '2026-09-24T17:43:30Z',
    extra: (c) => {
      const running = expectRunningFirst(c, 'ISS');
      expect(
        'ISS: TCA nach dem Suchbeginn',
        running !== undefined && running.tca > c.fromMs,
        running ? `TCA ${iso(running.tca)}` : '–',
      );
    },
  },
  {
    title: 'B3. ISS, laufender Bogen unter der Mindesthöhe von 1°',
    sat: 'iss',
    from: '2026-09-24T11:22:30Z',
    extra: (c) => {
      const arc = arcAt(c, c.fromMs);
      expect(
        'ISS: flacher laufender Bogen wird übergangen',
        arc !== undefined &&
          arc.maxEl * RAD < 0.9 &&
          c.passes.length > 0 &&
          c.passes[0].aos > arc.los,
        `Referenz ${arc ? `${f(arc.maxEl * RAD)}° bis ${iso(Math.round(arc.los))}` : '–'}, ` +
          `erster Eintrag ${c.passes[0] ? iso(Math.round(c.passes[0].aos)) : '–'}`,
      );
    },
  },
  {
    title: 'B4. ISS, Suchbeginn unter dem Horizont (bisheriges Verhalten)',
    sat: 'iss',
    from: '2026-09-24T06:55:00Z',
    extra: (c) =>
      expect(
        'ISS: kein laufender Überflug',
        arcAt(c, c.fromMs) === undefined && c.passes.length > 0 && c.passes[0].aos > c.fromMs,
        `erster Eintrag ${c.passes[0] ? iso(Math.round(c.passes[0].aos)) : '–'}`,
      ),
  },
  {
    title: 'C1. METOP-B (sonnensynchron), nach dem Höchststand',
    sat: 'metop',
    from: '2026-09-24T07:50:00Z',
    extra: (c) => {
      const running = expectRunningFirst(c, 'METOP-B');
      expect(
        'METOP-B: TCA vor dem Suchbeginn',
        running !== undefined && running.tca < c.fromMs,
        running ? `TCA ${iso(running.tca)}` : '–',
      );
    },
  },
  {
    // Gefunden per Abtastung in 60-s-Schritten ab der TLE-Epoche: Die
    // Schattensaison dieser Bahnebene beginnt am 09.12.2026; vom 19. auf den
    // 20.12. tritt der Satellit mitten im Bogen für 53 min in den Erdschatten.
    title: 'D1. BEIDOU-3 M16, Bogen 19./20.12.2026 mit Erdschatten mittendrin',
    sat: 'beidou',
    from: '2026-12-19T12:00:00Z',
    extra: (c) => shadowCase(c, Date.UTC(2026, 11, 20, 0, 30)),
  },
  {
    title: 'D2. BEIDOU-3 M16, derselbe Bogen, Suchbeginn nach dem Schatten',
    sat: 'beidou',
    from: '2026-12-20T01:30:00Z',
    extra: (c) => {
      const running = expectRunningFirst(c, 'BEIDOU-3 M16');
      shadowCase(c, Date.UTC(2026, 11, 20, 0, 30));
      expect(
        'BEIDOU-3 M16: beschienenes Fenster beginnt vor dem Schatten',
        running !== undefined && running.sunlitStart !== null && running.sunlitStart < Date.UTC(2026, 11, 20, 0, 0),
        running?.sunlitStart ? `ab ${iso(running.sunlitStart)}` : '–',
      );
    },
  },
  {
    title: 'E1. MERIDIAN 7 (Molnija), fünf Stunden nach dem Aufgang',
    sat: 'meridian',
    from: '2026-09-24T15:00:00Z',
    extra: (c) => {
      const running = expectRunningFirst(c, 'MERIDIAN 7');
      expect(
        'MERIDIAN 7: Rückwärtssuche über Stunden, TCA vor dem Suchbeginn',
        running !== undefined && running.aos < c.fromMs - 5 * 3600_000 && !running.aosOpen && running.tca < c.fromMs,
        running ? `AOS ${iso(Math.round(running.aos))}, TCA ${iso(running.tca)}, Dauer ${f(running.durationSec / 3600, 1)} h` : '–',
      );
    },
  },
  {
    title: 'F1. METEOSAT-11 (geostationär): dauerhaft über dem Horizont',
    sat: 'meteosat',
    from: '2026-09-24T06:55:00Z',
    extra: (c) => {
      const only = c.passes[0];
      expect(
        'METEOSAT-11: genau ein Eintrag, beide Enden offen',
        c.passes.length === 1 && only.aosOpen && only.losOpen && only.aos === c.fromMs - LOOKBACK_MS,
        only
          ? `${c.passes.length} Eintrag, ${iso(only.aos)} (offen ${only.aosOpen}) – ${iso(only.los)} (offen ${only.losOpen})`
          : 'kein Eintrag',
      );
      // Tag-und-Nacht-Gleiche: Schattensaison geostationärer Bahnen.
      shadowCase(c, Date.UTC(2026, 8, 24, 23, 45));
    },
  },
  {
    title: 'G1. TESS (14 Tage Umlauf), laufender Überflug',
    sat: 'tess',
    from: '2026-09-24T12:00:00Z',
    extra: (c) => void expectRunningFirst(c, 'TESS'),
  },
];

/**
 * Überflug, der den Zeitpunkt `insideMs` enthält, muss den Schatten darin
 * herausrechnen: `sunlitSec` deutlich unter `sunlitEnd − sunlitStart`.
 */
function shadowCase(context: Context, insideMs: number): void {
  const pass = context.passes.find((p) => p.aos <= insideMs && p.los > insideMs);
  const light = pass ? context.lights.get(pass) : undefined;
  if (!pass || !light || pass.sunlitStart === null || pass.sunlitEnd === null) {
    expect('Schatten im Bogen', false, 'Überflug oder Referenz fehlt');
    return;
  }
  const span = (pass.sunlitEnd - pass.sunlitStart) / 1000;
  const shadow = span - pass.sunlitSec;
  // Vorbedingung: Die Referenz sieht einen Schatten von mindestens 10 min
  // zwischen erstem und letztem beschienenen Moment.
  expect(
    'Schatten im Bogen – Vorbedingung',
    light.shadowInsideSec >= 600 && light.transitions >= 2,
    `Referenz: ${light.transitions} Wechsel, ${f(light.shadowInsideSec / 60, 1)} min Schatten im beschienenen Fenster`,
  );
  expect(
    'Schatten im Bogen – sunlitSec zählt ihn nicht mit',
    Math.abs(shadow - light.shadowInsideSec) <= (light.transitions * LIGHT_STEP_TOL_MS) / 1000 + 2,
    `Ende − Anfang ${f(span / 60, 1)} min, sunlitSec ${f(pass.sunlitSec / 60, 1)} min → ` +
      `${f(shadow / 60, 1)} min Schatten, Referenz ${f(light.shadowInsideSec / 60, 1)} min`,
  );
}

/* ------------------------------------------------------------------ */
/* Ablauf                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const observer = geoToObserverGd(LEIPZIG);

  // Vergleich der beiden Sonnenmodelle, damit die Toleranzen begründet sind.
  {
    let worst = 0;
    for (let h = 0; h < 24 * 90; h += 7) {
      const ms = Date.UTC(2026, 8, 23) + h * 3600_000;
      const a = sunEciUnitVector(new Date(ms));
      const b = refSun(ms);
      worst = Math.max(worst, Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)) * RAD);
    }
    console.log(`Sonnenrichtung src/math/sun.ts gegen astronomy-engine: höchstens ${worst.toFixed(4)}° auseinander`);
  }

  for (const scenario of SCENARIOS) {
    const sat = SATS[scenario.sat];
    const fromMs = Date.parse(scenario.from);
    console.log(`${scenario.title} – ${sat.name}, ab ${scenario.from}`);

    const result = await runWithTimeout({ sat: scenario.sat, fromMs });
    if (!result) {
      expect('Suche endet', false, `kein Ergebnis nach ${JOB_TIMEOUT_MS / 1000} s – die Suche hängt`);
      continue;
    }
    const satrec = twoline2satrec(sat.l1, sat.l2);
    const endMs = fromMs + SEARCH_HOURS * 3600_000;
    const arcs = refArcs(satrec, observer, fromMs - LOOKBACK_MS, endMs + TRACE_BEYOND_MS);
    const context: Context = { fromMs, passes: result.passes, arcs, satrec, observer, lights: new Map() };
    console.log(`  · ${result.passes.length} Überflüge in ${f(result.ms, 1)} ms (Thread, ohne Aufwärmen)`);
    compareWithReference(scenario, context);
    scenario.extra?.(context);
  }

  console.log(`${checks} Prüfungen, ${failures} Fehlschläge`);
  if (failures > 0) process.exit(1);
  console.log('✓ Überflugvorhersage stimmt mit satellite.js überein');
}

if (isMainThread) {
  await main();
} else {
  const job = workerData as Job;
  const started = performance.now();
  const passes = runJob(job);
  parentPort?.postMessage({ passes, ms: performance.now() - started });
}
