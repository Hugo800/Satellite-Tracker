/**
 * Prüft die Orientierungspipeline des AR-Modus ohne Browser: Kursfusion,
 * Pitch-Klammer, Kameraglättung, AR-Übergabe und magnetische Deklination.
 *
 * Sensormodell – bewusst unabhängig vom geprüften Code:
 * - Die Wahrheit ist eine physische Lage als 3×3-Matrix (Gerät → Welt, x Ost,
 *   y Nord, z oben), gebaut aus Kamerakurs, Blickhöhe und Bildrollwinkel.
 * - Euler-Winkel entstehen mit der Zerlegung aus WebKit
 *   (Source/WebCore/platform/ios/WebCoreMotionManager.mm), nicht mit three.js.
 * - iOS: alpha relativ zu einem Kreiselnullpunkt; `webkitCompassHeading` ist
 *   magnetisch (Wahrheit minus Deklination) und wird aus der physischen Lage
 *   berechnet – je nach Deutung als −alpha oder als Kamerakurs (siehe
 *   MAX_HEADING_SPREAD_RAD in src/math/orientation.ts; offen, beide werden
 *   geprüft). Solange kein Kurs vorliegt, sendet WebKit 0 mit Genauigkeit −1.
 * - Android: `deviceorientation` relativ, `deviceorientationabsolute` gegen
 *   magnetisch Nord.
 * - Bewertet wird die ausgegebene Lage gegen die Wahrheit; die Umrechnung
 *   Wahrheit → Szene prüft Abschnitt 0 gegen die Matrix.
 *
 * Die bisherige Kursglättung (adaptiver Gain direkt auf alpha) ist als
 * Vergleichsgröße Zeile für Zeile nachgebaut.
 *
 * Abschnitt 14 prüft zusätzlich den Weg vom Browser-Event bis zur Kameralage
 * mit echten Event-Objekten durch den Code aus src/hooks/useDeviceOrientation.ts
 * (Umwandlung, beide Listener, Status); die Kameraführung prüft
 * scripts/verify-rig.ts. Den Effekt-Rumpf des Hooks (Deklination aus dem
 * Standort, Bildschirmwinkel, Abmelden, Zurücksetzen) prüft
 * scripts/verify-wiring.ts im echten React-Renderer.
 *
 * Aufruf: npm run verify:orientation
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  createDeclinationReader,
  createOrientationHandler,
  listenForOrientation,
  orientationSample,
} from '../src/hooks/useDeviceOrientation';
import { DEG, RAD, angleDelta, clamp } from '../src/math/coords';
import { magneticDeclinationDeg } from '../src/math/declination';
import {
  AR_SMOOTHING_RATE,
  HeadingFusion,
  RollHandover,
  arSmoothingFactor,
  attitudeToCamera,
  clampPitch,
  eulerToAttitude,
  type OrientationSample,
} from '../src/math/orientation';
import type { OrientationState } from '../src/state/runtime';
import type { CompassStatus } from '../src/types';

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

const f = (value: number, digits = 2): string => value.toFixed(digits).replace('.', ',');

/* --- Zufall --- */

/** Deterministischer Zufall (mulberry32), damit jede Ausführung dieselben Zahlen liefert. */
function createRandom(seed: number): { uniform: () => number; gauss: (sigma: number) => number } {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = (sigma: number) =>
    sigma * Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());
  return { uniform, gauss };
}

const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360;
const wrap180 = (deg: number): number => angleDelta(deg * DEG, 0) * RAD;
const PERIOD_MS = 1000 / 60;

/* --- Physisches Modell (Matrizen, ohne three.js) --- */

type Matrix = number[];
const multiply = (a: Matrix, b: Matrix): Matrix => {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r += 1)
    for (let c = 0; c < 3; c += 1)
      for (let k = 0; k < 3; k += 1) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return out;
};
const rotZ = (a: number): Matrix => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
const rotX = (a: number): Matrix => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const rotY = (a: number): Matrix => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];

/** Kamerakurs h (Uhrzeigersinn ab geografisch Nord), Blickhöhe e, Bildrollwinkel r (Hochformat = 0), Grad. */
const pose = (h: number, e: number, r = 0): Matrix =>
  multiply(multiply(rotZ(-h * DEG), rotX((90 + e) * DEG)), rotZ(r * DEG));

/** Blickrichtung der Rückkamera (Geräte-−Z) in Weltkoordinaten. */
const cameraDirection = (m: Matrix): [number, number, number] => [-m[2], -m[5], -m[8]];
const cameraHeadingDeg = (m: Matrix): number => {
  const [x, y] = cameraDirection(m);
  return Math.atan2(x, y) * RAD;
};

/** W3C-Zerlegung in Grad, Zeile für Zeile wie in WebCoreMotionManager.mm; alpha in [0, 360). */
function w3cEuler(m: Matrix): [number, number, number] {
  let z: number;
  let x: number;
  let y: number;
  if (m[8] > 0) {
    z = Math.atan2(-m[1], m[4]);
    x = Math.asin(m[7]);
    y = Math.atan2(-m[6], m[8]);
  } else if (m[8] < 0) {
    z = Math.atan2(m[1], -m[4]);
    x = -Math.asin(m[7]);
    x += x >= 0 ? -Math.PI : Math.PI;
    y = Math.atan2(m[6], -m[8]);
  } else if (m[6] > 0) {
    z = Math.atan2(-m[1], m[4]);
    x = Math.asin(m[7]);
    y = -Math.PI / 2;
  } else if (m[6] < 0) {
    z = Math.atan2(m[1], -m[4]);
    x = -Math.asin(m[7]);
    x += x >= 0 ? -Math.PI : Math.PI;
    y = -Math.PI / 2;
  } else {
    z = Math.atan2(m[3], m[0]);
    x = m[7] > 0 ? Math.PI / 2 : -Math.PI / 2;
    y = 0;
  }
  return [(z > 0 ? z : 2 * Math.PI + z) * RAD, x * RAD, y * RAD];
}

/**
 * Deutungen von `webkitCompassHeading` (geografisch, vor Abzug der Deklination):
 * `alpha` = −alpha der physischen Lage, `camera` = Kurs der Rückkamera.
 */
type Hypothesis = 'alpha' | 'camera';
const HYPOTHESES: Hypothesis[] = ['alpha', 'camera'];
const trueCompassDeg = (m: Matrix, hypothesis: Hypothesis): number =>
  wrap360(hypothesis === 'alpha' ? -w3cEuler(m)[0] : cameraHeadingDeg(m));

/**
 * Wahrheit als Szenen-Quaternion – unabhängig von eulerToAttitude. Szene: x Ost,
 * y oben, z Süd. Die Gerätelage der Fusion drückt auch das Gerätesystem in
 * dieser Achsenfolge aus (flach liegend = Einheitsdrehung), also S · M · Sᵀ.
 */
const SCENE_FROM_ENU: Matrix = [1, 0, 0, 0, 0, 1, 0, -1, 0];
const ENU_FROM_SCENE: Matrix = [1, 0, 0, 0, 0, -1, 0, 1, 0];
const truthMatrix = new Matrix4();
function truthQuaternion(m: Matrix, target = new Quaternion()): Quaternion {
  const s = multiply(multiply(SCENE_FROM_ENU, m), ENU_FROM_SCENE);
  truthMatrix.set(s[0], s[1], s[2], 0, s[3], s[4], s[5], 0, s[6], s[7], s[8], 0, 0, 0, 0, 1);
  return target.setFromRotationMatrix(truthMatrix);
}

const errorScratch = new Quaternion();
const truthScratch = new Quaternion();
/** Kursfehler der Anzeige in Grad: Drehung um den Zenit von der Wahrheit zur Anzeige. */
function yawErrorDeg(shown: Quaternion, m: Matrix): number {
  truthQuaternion(m, truthScratch);
  errorScratch.copy(truthScratch).invert().premultiply(shown);
  return angleDelta(2 * Math.atan2(errorScratch.y, errorScratch.w), 0) * RAD;
}

const cameraScratch = new Quaternion();
const forwardScratch = new Vector3();
/** Blickhöhe einer Gerätelage in Grad. */
function viewElevationDeg(attitude: Quaternion): number {
  attitudeToCamera(cameraScratch, attitude, 0);
  forwardScratch.set(0, 0, -1).applyQuaternion(cameraScratch);
  return Math.asin(clamp(forwardScratch.y, -1, 1)) * RAD;
}

/** Bildrollwinkel einer Kameralage in Grad: Bild-oben gegen die Projektion des Zenits. */
function imageRollDeg(camera: Quaternion): number {
  const forward = new Vector3(0, 0, -1).applyQuaternion(camera);
  const up = new Vector3(0, 1, 0).applyQuaternion(camera);
  const right = new Vector3(1, 0, 0).applyQuaternion(camera);
  const zenith = new Vector3(0, 1, 0).addScaledVector(forward, -forward.y);
  return Math.atan2(zenith.dot(right), zenith.dot(up)) * RAD;
}

/* --- Sensoren --- */

interface CompassReading {
  heading: number;
  accuracy: number;
}

function iosSample(
  timeMs: number,
  m: Matrix,
  gyroZeroDeg: number,
  compass: CompassReading | null,
  declinationDeg = 0,
): OrientationSample {
  const [, beta, gamma] = w3cEuler(m);
  const [alphaRelative] = w3cEuler(multiply(rotZ(gyroZeroDeg * DEG), m));
  return {
    timeMs,
    stream: 'deviceorientation',
    alphaRad: alphaRelative * DEG,
    betaRad: beta * DEG,
    gammaRad: gamma * DEG,
    absolute: false,
    compassHeadingRad: compass === null ? null : wrap360(compass.heading) * DEG,
    compassAccuracyDeg: compass === null ? null : compass.accuracy,
    declinationRad: declinationDeg * DEG,
  };
}

function androidSample(
  timeMs: number,
  m: Matrix,
  absolute: boolean,
  relativeZeroDeg: number,
  declinationDeg = 0,
  stream = absolute ? 'deviceorientationabsolute' : 'deviceorientation',
): OrientationSample {
  // Magnetischer Rahmen: Kurse sind um die Deklination kleiner (Drehung gegen den Uhrzeigersinn).
  const frame = absolute ? rotZ(declinationDeg * DEG) : rotZ(relativeZeroDeg * DEG);
  const [alpha, beta, gamma] = w3cEuler(multiply(frame, m));
  return {
    timeMs,
    stream,
    alphaRad: alpha * DEG,
    betaRad: beta * DEG,
    gammaRad: gamma * DEG,
    absolute,
    compassHeadingRad: null,
    compassAccuracyDeg: null,
    declinationRad: declinationDeg * DEG,
  };
}

/** Ergebnis eines Laufs: pro angezeigtem Sample Zeit, Kursfehler, Nordbezug. */
interface Trace {
  timeS: number[];
  errorDeg: number[];
  referenced: boolean[];
}

interface IosScenario {
  seconds: number;
  pose: (s: number) => Matrix;
  hypothesis: Hypothesis;
  gyroZeroDeg?: (s: number) => number;
  /** Zeitversatz des Kompasses gegenüber der Lage. */
  latencyMs?: number;
  noiseDeg?: number;
  seed?: number;
  declinationDeg?: number;
  /** Ersetzt die physische Kompassmessung (Störungen, Platzhalter, Genauigkeit). */
  compass?: (s: number, physical: number) => CompassReading | null;
  /** Überspringt Zeitpunkte (Pause). */
  timeOf?: (i: number) => number;
}

function runIos(scenario: IosScenario, fusion = new HeadingFusion()): Trace {
  const random = createRandom(scenario.seed ?? 1);
  const trace: Trace = { timeS: [], errorDeg: [], referenced: [] };
  const count = Math.round(scenario.seconds * 60);
  for (let i = 0; i < count; i += 1) {
    const timeMs = scenario.timeOf ? scenario.timeOf(i) : 1000 + i * PERIOD_MS;
    const s = (timeMs - 1000) / 1000;
    const m = scenario.pose(s);
    const lagged = scenario.pose(Math.max(0, s - (scenario.latencyMs ?? 0) / 1000));
    const physical =
      trueCompassDeg(lagged, scenario.hypothesis) -
      (scenario.declinationDeg ?? 0) +
      random.gauss(scenario.noiseDeg ?? 0);
    const compass = scenario.compass
      ? scenario.compass(s, physical)
      : { heading: physical, accuracy: 10 };
    const sample = iosSample(
      timeMs,
      m,
      scenario.gyroZeroDeg ? scenario.gyroZeroDeg(s) : 137,
      compass,
      scenario.declinationDeg ?? 0,
    );
    if (!fusion.push(sample)) continue;
    trace.timeS.push(s);
    trace.errorDeg.push(yawErrorDeg(fusion.attitude, m));
    trace.referenced.push(fusion.referenced);
  }
  return trace;
}

/** Größter Kursfehler (Betrag) im Zeitfenster [from, to) s. */
function maxError(trace: Trace, from = 0, to = Infinity): number {
  let worst = 0;
  trace.timeS.forEach((s, i) => {
    if (s >= from && s < to) worst = Math.max(worst, Math.abs(trace.errorDeg[i]));
  });
  return worst;
}

/**
 * Größte Änderung des Kursfehlers zwischen zwei angezeigten Samples – also
 * wie weit sich die Anzeige in einem Sample anders bewegt als das Gerät.
 */
function maxJump(trace: Trace, from = 0, to = Infinity): number {
  let worst = 0;
  for (let i = 1; i < trace.timeS.length; i += 1) {
    if (trace.timeS[i] < from || trace.timeS[i] >= to) continue;
    worst = Math.max(worst, Math.abs(wrap180(trace.errorDeg[i] - trace.errorDeg[i - 1])));
  }
  return worst;
}

/** Kursfehler zum Zeitpunkt s (nächstes angezeigtes Sample). */
function errorAt(trace: Trace, s: number): number {
  let best = 0;
  let distance = Infinity;
  trace.timeS.forEach((t, i) => {
    if (Math.abs(t - s) < distance) {
      distance = Math.abs(t - s);
      best = trace.errorDeg[i];
    }
  });
  return best;
}

/** Erste Zeit ab `from`, ab der der Fehler dauerhaft unter `limit` bleibt. */
function settledAfter(trace: Trace, limit: number, from = 0): number {
  let settled = NaN;
  trace.timeS.forEach((s, i) => {
    if (s < from) return;
    if (Math.abs(trace.errorDeg[i]) >= limit) settled = NaN;
    else if (Number.isNaN(settled)) settled = s;
  });
  return settled - from;
}

/**
 * Die bisherige Kursglättung aus useDeviceOrientation, unverändert nachgebaut.
 * `adaptive = false` friert den Gain auf den Grundwert 0,06 ein (Vergleichsgröße).
 */
class LegacyHeading {
  private sin = 0;
  private cos = 0;
  private ready = false;
  private sawAbsolute = false;
  private lastMs = 0;
  readonly attitude = new Quaternion();

  constructor(private readonly adaptive = true) {}

  push(
    timeMs: number,
    alphaDeg: number,
    betaDeg: number,
    gammaDeg: number,
    absolute: boolean,
    iosHeadingDeg: number | null,
  ): boolean {
    if (absolute) this.sawAbsolute = true;
    else if (this.sawAbsolute && iosHeadingDeg === null) return false;

    const headingRad =
      iosHeadingDeg !== null ? ((360 - iosHeadingDeg) % 360) * DEG : alphaDeg * DEG;
    const betaRad = betaDeg * DEG;
    const gammaRad = gammaDeg * DEG;
    const previousHeading = this.ready ? Math.atan2(this.sin, this.cos) : headingRad;
    const dt = this.lastMs > 0 ? Math.min(0.2, (timeMs - this.lastMs) / 1000) : 1 / 60;
    this.lastMs = timeMs;

    eulerToAttitude(this.attitude, previousHeading, betaRad, gammaRad);
    attitudeToCamera(cameraScratch, this.attitude, 0);
    forwardScratch.set(0, 0, -1).applyQuaternion(cameraScratch);
    const nearVertical = Math.abs(forwardScratch.y) > 0.97;

    if (!this.ready) {
      this.sin = Math.sin(headingRad);
      this.cos = Math.cos(headingRad);
      this.ready = true;
    } else if (!nearVertical) {
      const step = Math.abs(angleDelta(headingRad, previousHeading));
      const gain60 = this.adaptive ? clamp(0.06 + step * 1.6, 0.06, 0.6) : 0.06;
      const k = 1 - Math.pow(1 - gain60, dt * 60);
      this.sin += (Math.sin(headingRad) - this.sin) * k;
      this.cos += (Math.cos(headingRad) - this.cos) * k;
    }

    eulerToAttitude(this.attitude, Math.atan2(this.sin, this.cos), betaRad, gammaRad);
    return true;
  }

  pushIos(sample: OrientationSample, compassDeg: number | null): boolean {
    return this.push(
      sample.timeMs,
      sample.alphaRad * RAD,
      sample.betaRad * RAD,
      sample.gammaRad * RAD,
      false,
      compassDeg,
    );
  }
}

/** Spitze-Spitze einer Folge. */
class PeakToPeak {
  private min = Infinity;
  private max = -Infinity;
  add(value: number): void {
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
  }
  get value(): number {
    return this.max - this.min;
  }
}

/** Obergrenze der ψ-Nachführung je 60-Hz-Sample: k · 50° mit k = 1 − e^(−1/60). */
const MAX_TRACKING_STEP_DEG = (1 - Math.exp(-1 / 60)) * 50;

/* --- 0. Grundlage --- */
console.log('0. Sensormodell und Umrechnung in die Szene');
{
  const random = createRandom(10);
  let reconstruction = 0;
  let conversion = 0;
  let cameraAxis = 0;
  for (let i = 0; i < 4000; i += 1) {
    // Auch fast entartete Lagen: jede vierte exakt oder fast am Horizont.
    const e = i % 4 === 0 ? (random.uniform() - 0.5) * 1e-6 : (random.uniform() - 0.5) * 180;
    const m = pose(random.uniform() * 360, e, (random.uniform() - 0.5) * 360);
    const [alpha, beta, gamma] = w3cEuler(m);
    const back = multiply(multiply(rotZ(alpha * DEG), rotX(beta * DEG)), rotY(gamma * DEG));
    reconstruction = Math.max(reconstruction, ...back.map((v, k) => Math.abs(v - m[k])));
    const attitude = eulerToAttitude(new Quaternion(), alpha * DEG, beta * DEG, gamma * DEG);
    conversion = Math.max(conversion, attitude.angleTo(truthQuaternion(m)) * RAD);
    const [x, y, z] = cameraDirection(m);
    attitudeToCamera(cameraScratch, attitude, 0);
    forwardScratch.set(0, 0, -1).applyQuaternion(cameraScratch);
    cameraAxis = Math.max(cameraAxis, forwardScratch.angleTo(new Vector3(x, z, -y)) * RAD);
  }
  expect('WebKit-Zerlegung exakt', reconstruction < 1e-9, `Rekonstruktionsfehler ${reconstruction.toExponential(1)}`);
  expect(
    'eulerToAttitude und attitudeToCamera gegen die Matrix',
    conversion < 1e-4 && cameraAxis < 1e-4,
    `Lage ${conversion.toExponential(1)}°, Kameraachse ${cameraAxis.toExponential(1)}°`,
  );

  // Bildschirmdrehung: Wer das Gerät um r gegen den Uhrzeigersinn dreht
  // (Oberkante nach links), bekommt screen.orientation.angle = r (W3C; iOS
  // window.orientation 90 = „gegen den Uhrzeigersinn gedreht“). Das Bild muss
  // dann aufrecht stehen und dieselbe Richtung zeigen. Alle übrigen Prüfungen
  // laufen mit Winkel 0 und sähen ein falsches Vorzeichen nicht.
  let worstRoll = 0;
  let worstAxis = 0;
  for (const angle of [90, -90, 180]) {
    for (const [h, e] of [[40, 30], [200, 5], [310, 60]]) {
      const m = pose(h, e, angle);
      const q = truthQuaternion(m);
      attitudeToCamera(q, q, angle * DEG);
      worstRoll = Math.max(worstRoll, Math.abs(imageRollDeg(q)));
      const [x, y, z] = cameraDirection(m);
      forwardScratch.set(0, 0, -1).applyQuaternion(q);
      worstAxis = Math.max(worstAxis, forwardScratch.angleTo(new Vector3(x, z, -y)) * RAD);
    }
  }
  expect(
    'Bildschirmdrehung 90°, −90°, 180°',
    worstRoll < 1e-4 && worstAxis < 1e-4,
    `Bildrollwinkel höchstens ${worstRoll.toExponential(1)}°, Blickachse ${worstAxis.toExponential(1)}° (falsches Vorzeichen: 180° Roll)`,
  );
}

/* --- 1. Ausreißer bei gehaltenem Kurs --- */
console.log('1. Gehaltener Kurs mit Ausreißern (Blick 30° hoch, Kurs 30°)');
{
  const m = pose(30, 30);
  // a) Ein einzelner Ausreißer ohne Rauschen: reine Sprungantwort.
  const single = (filter: 'adaptive' | 'fixed' | 'fusion'): number => {
    const legacy = new LegacyHeading(filter === 'adaptive');
    const fusion = new HeadingFusion();
    let worst = 0;
    for (let i = 0; i < 240; i += 1) {
      const t = 1000 + i * PERIOD_MS;
      const heading = trueCompassDeg(m, 'camera') + (i === 120 ? 20 : 0);
      const sample = iosSample(t, m, 137, { heading, accuracy: 10 });
      const attitude =
        filter === 'fusion'
          ? fusion.push(sample)
            ? fusion.attitude
            : null
          : legacy.pushIos(sample, wrap360(heading))
            ? legacy.attitude
            : null;
      if (attitude && i >= 120) worst = Math.max(worst, Math.abs(yawErrorDeg(attitude, m)));
    }
    return worst;
  };
  const singleAdaptive = single('adaptive');
  const singleFixed = single('fixed');
  const singleFusion = single('fusion');
  expect(
    'Einzelausreißer 20°',
    singleFusion < 0.5 && singleFusion < singleFixed,
    `Ausschlag alt adaptiv ${f(singleAdaptive)}°, alt fester Gain 0,06 ${f(singleFixed)}°, neu ${f(singleFusion)}°`,
  );

  // b) Rauschen σ = 1° plus alle 0,5 s ein Ausreißer von ±20°, 12 s lang.
  const random = createRandom(1);
  const adaptive = new LegacyHeading(true);
  const fixed = new LegacyHeading(false);
  const fusion = new HeadingFusion();
  const p2p = { adaptive: new PeakToPeak(), fixed: new PeakToPeak(), fusion: new PeakToPeak() };
  for (let i = 0; i < 720; i += 1) {
    const t = 1000 + i * PERIOD_MS;
    const outlier = i % 30 === 15 ? (i % 60 === 15 ? 20 : -20) : 0;
    const heading = wrap360(trueCompassDeg(m, 'camera') + random.gauss(1) + outlier);
    const sample = iosSample(t, m, 137 + random.gauss(0.02), { heading, accuracy: 10 });
    const settled = i >= 240;
    if (adaptive.pushIos(sample, heading) && settled) p2p.adaptive.add(yawErrorDeg(adaptive.attitude, m));
    if (fixed.pushIos(sample, heading) && settled) p2p.fixed.add(yawErrorDeg(fixed.attitude, m));
    if (fusion.push(sample) && settled) p2p.fusion.add(yawErrorDeg(fusion.attitude, m));
  }
  expect(
    'Rauschen σ 1° + Ausreißer ±20° alle 0,5 s',
    p2p.fusion.value < p2p.adaptive.value / 3 && p2p.fusion.value < 1.5,
    `Spitze-Spitze alt adaptiv ${f(p2p.adaptive.value)}°, alt fest ${f(p2p.fixed.value)}°, neu ${f(p2p.fusion.value)}°`,
  );
}

/* --- 2. Drehung und Kompasslatenz --- */
console.log('2. Drehung mit 90°/s, Kompass 50 / 150 / 300 ms verzögert');
{
  // 0–2 s Stillstand, 2–3 s Drehung um 90°, danach Stillstand bis 6 s.
  const heading = (s: number) => 20 + 90 * clamp(s - 2, 0, 1);
  const rows: string[] = [];
  let worstAfterStop = 0;
  let worstDuring = 0;
  for (const latencyMs of [50, 150, 300]) {
    for (const hypothesis of HYPOTHESES) {
      const trace = runIos({
        seconds: 6,
        pose: (s) => pose(heading(s), 30),
        hypothesis,
        latencyMs,
        noiseDeg: 1,
        seed: 2,
      });
      const during = maxError(trace, 2, 3);
      const after = maxError(trace, 3, 6);
      worstDuring = Math.max(worstDuring, during);
      worstAfterStop = Math.max(worstAfterStop, after);
      if (hypothesis === 'camera') rows.push(`${latencyMs} ms: während ${f(during)}°, danach ${f(after)}°`);
    }
  }
  expect('Drehung trägt der Kreisel', worstDuring < 1, rows.join('; '));
  expect(
    'Restfehler nach dem Stopp bei jeder Latenz',
    worstAfterStop < 1,
    `höchstens ${f(worstAfterStop)}° (vorige Fassung bei 300 ms: 3,12°)`,
  );

  // Langsamer Schwenk knapp unter der Ratengrenze: Der Kompass hinkt um
  // Rate × Latenz hinterher, ψ läuft ihm mit τ = 1 s nach. Grenze 10°/s · 0,3 s.
  let slowWorst = 0;
  for (const hypothesis of HYPOTHESES) {
    const trace = runIos({
      seconds: 8,
      pose: (s) => pose(40 + 8 * clamp(s - 1, 0, 5), 30),
      hypothesis,
      latencyMs: 300,
      seed: 3,
    });
    slowWorst = Math.max(slowWorst, maxError(trace));
  }
  expect(
    'Schwenk 8°/s, Kompass 300 ms verzögert',
    slowWorst < 3,
    `größter Fehler ${f(slowWorst)}° (Schranke Ratengrenze × Latenz = 3°)`,
  );

  // Schwenk über der Ratengrenze: ψ ruht, der Kreisel trägt. Mit der vorigen
  // Grenze 30°/s lief ψ dem verzögerten Kompass nach (Prüfer: 2,84° bei 29°/s, 100 ms).
  let mediumWorst = 0;
  for (const hypothesis of HYPOTHESES) {
    const trace = runIos({
      seconds: 8,
      pose: (s) => pose(40 + 25 * clamp(s - 1, 0, 4), 30),
      hypothesis,
      latencyMs: 150,
      seed: 3,
    });
    mediumWorst = Math.max(mediumWorst, maxError(trace));
  }
  expect('Schwenk 25°/s, Kompass 150 ms verzögert', mediumWorst < 1, `größter Fehler ${f(mediumWorst)}°`);

  // Schwenk knapp über der Ratengrenze 10°/s bei langer Latenz: 15°/s · 0,3 s
  // = 4,5° Rückstand des Kompasses. Mit einer Grenze von 20°/s liefe ψ ihm nach.
  let justAbove = 0;
  for (const hypothesis of HYPOTHESES) {
    const trace = runIos({
      seconds: 9,
      pose: (s) => pose(40 + 15 * clamp(s - 1, 0, 5), 30),
      hypothesis,
      latencyMs: 300,
      seed: 3,
    });
    justAbove = Math.max(justAbove, maxError(trace));
  }
  expect(
    'Schwenk 15°/s, Kompass 300 ms verzögert',
    justAbove < 1,
    `größter Fehler ${f(justAbove)}° (Rückstand des Kompasses 4,5°)`,
  );

  // Vergleich mit der alten Glättung: Nachlauf während der Drehung, 50 ms Latenz.
  const legacy = new LegacyHeading(true);
  const fusion = new HeadingFusion();
  const random = createRandom(2);
  let lagLegacy = 0;
  let lagFusion = 0;
  let samples = 0;
  for (let i = 0; i < 360; i += 1) {
    const t = 1000 + i * PERIOD_MS;
    const s = i / 60;
    const m = pose(heading(s), 30);
    const lagged = wrap360(heading(Math.max(0, s - 0.05)) + random.gauss(1));
    const sample = iosSample(t, m, 137, { heading: lagged, accuracy: 10 });
    const okLegacy = legacy.pushIos(sample, lagged);
    const okFusion = fusion.push(sample);
    if (okLegacy && okFusion && s >= 2.5 && s < 3) {
      lagLegacy += Math.abs(yawErrorDeg(legacy.attitude, m));
      lagFusion += Math.abs(yawErrorDeg(fusion.attitude, m));
      samples += 1;
    }
  }
  expect(
    'Nachlauf während der Drehung',
    lagFusion / samples < 1 && lagFusion < lagLegacy,
    `alt ${f(lagLegacy / samples)}°, neu ${f(lagFusion / samples)}°`,
  );
}

/* --- 3. Quellwechsel, Aussetzer und Genauigkeit --- */
console.log('3. Quellwechsel, Aussetzer und Genauigkeit');
{
  // a) Aussetzer mit der echten WebKit-Signatur: Kurs 0 bei Genauigkeit −1
  //    (nie null). 1 s ganz ohne, 1 s jedes zweite Event ohne; Schwenk 5°/s.
  const rows: string[] = [];
  let worstError = 0;
  let worstJump = 0;
  for (const start of [30, 45, 150]) {
    for (const hypothesis of HYPOTHESES) {
      const trace = runIos({
        seconds: 7,
        pose: (s) => pose(start + 5 * s, 35),
        hypothesis,
        noiseDeg: 1,
        seed: 3,
        compass: (s, physical) => {
          const i = Math.round(s * 60);
          const dropout = (i >= 180 && i < 240) || (i >= 300 && i < 360 && i % 2 === 0);
          return dropout ? { heading: 0, accuracy: -1 } : { heading: physical, accuracy: 10 };
        },
      });
      const error = maxError(trace, 1);
      worstError = Math.max(worstError, error);
      worstJump = Math.max(worstJump, maxJump(trace));
      if (hypothesis === 'camera') rows.push(`Kurs ${start}°: ${f(error)}°`);
    }
  }
  expect(
    'Aussetzer als Kurs 0 / Genauigkeit −1',
    worstError < 1.5 && worstJump < 0.5,
    `größter Fehler ${rows.join(', ')} (vorige Fassung bei 30°/45°: 18,96°/28,45°); größter Sprung ${f(worstJump)}°`,
  );
}
{
  // b) Start: WebKit liefert die ersten Events ohne CLHeading (0 / −1).
  const rows: string[] = [];
  let worstFirst = 0;
  let worstJump = 0;
  for (const [trueHeading, placeholders] of [
    [150, 6],
    [90, 6],
    [40, 6],
    [150, 30],
  ] as Array<[number, number]>) {
    for (const hypothesis of HYPOTHESES) {
      const trace = runIos({
        seconds: 4,
        pose: () => pose(trueHeading, 30),
        hypothesis,
        noiseDeg: 1,
        seed: 7,
        compass: (s, physical) =>
          Math.round(s * 60) < placeholders
            ? { heading: 0, accuracy: -1 }
            : { heading: physical, accuracy: 10 },
      });
      const first = Math.abs(trace.errorDeg[0] ?? NaN);
      worstFirst = Math.max(worstFirst, first);
      worstJump = Math.max(worstJump, maxJump(trace));
      if (hypothesis === 'camera') {
        rows.push(`${trueHeading}°/${placeholders} Platzhalter: erste Anzeige ${f(trace.timeS[0] * 1000, 0)} ms, ${f(first)}° daneben`);
      }
    }
  }
  expect(
    'Start mit Platzhalterkurs',
    worstFirst < 3 && worstJump < 0.5,
    `${rows.join('; ')}; größter Sprung ${f(worstJump)}° (vorige Fassung: 149,9° in einem Sample)`,
  );

  // Kein Kompass überhaupt (headingAvailable = false): immer 0 / −1.
  const trace = runIos({
    seconds: 5,
    pose: (s) => pose(90 * clamp(s, 0, 1), 30),
    hypothesis: 'camera',
    compass: () => ({ heading: 0, accuracy: -1 }),
  });
  expect(
    'Nie ein gültiger Kurs',
    trace.referenced.every((r) => !r) && maxJump(trace) < 1e-6,
    `Nordbezug ${trace.referenced.some((r) => r) ? 'behauptet' : 'nie behauptet'}, größter Sprung ${f(maxJump(trace), 4)}° (vorige Fassung: 90° Sprung nach 1 s)`,
  );
}
{
  // c) Genauigkeit über der Grenze zählt nach inverser Varianz. Nach dem Start
  //    verschiebt sich der Kompass um 20° (innerhalb des Tors); gemessen wird,
  //    wie weit ψ nach 1 s gefolgt ist.
  const followed = (accuracy: number): number => {
    const trace = runIos({
      seconds: 4,
      pose: () => pose(60, 35),
      hypothesis: 'camera',
      compass: (s, physical) =>
        s < 2 ? { heading: physical, accuracy: 10 } : { heading: physical + 20, accuracy },
    });
    return Math.abs(errorAt(trace, 3));
  };
  const calibrated = followed(10);
  const poor = followed(50);
  // Erwartung: 20 · (1 − e^(−1)) = 12,6° bei vollem, 20 · (1 − e^(−0,25)) = 4,4° bei Viertelgewicht.
  expect(
    'Unkalibrierte Messung mit reduziertem Gewicht',
    Math.abs(calibrated - 12.6) < 1 && Math.abs(poor - 4.4) < 1,
    `nach 1 s gefolgt: Genauigkeit 10° → ${f(calibrated)}° (erwartet 12,6°), 50° → ${f(poor)}° (erwartet 4,4°)`,
  );
}
{
  // d) Pause mit neu gesetztem Kreiselnullpunkt.
  let worstAfter = 0;
  let firstAfter = NaN;
  for (const hypothesis of HYPOTHESES) {
    const trace = runIos({
      seconds: 13,
      pose: (s) => pose(40 + 3 * s, 35),
      hypothesis,
      noiseDeg: 1,
      seed: 4,
      gyroZeroDeg: (s) => (s < 10 ? 137 : -61),
      timeOf: (i) => 1000 + i * PERIOD_MS + (i >= 600 ? 1000 : 0),
    });
    const after = trace.timeS.map((s, i) => (s >= 10 ? Math.abs(trace.errorDeg[i]) : 0));
    const index = trace.timeS.findIndex((s) => s >= 10);
    if (hypothesis === 'camera') firstAfter = Math.abs(trace.errorDeg[index]);
    worstAfter = Math.max(worstAfter, ...after);
  }
  expect(
    'Neustart nach Pause mit neuem Kreiselnullpunkt',
    worstAfter < 3,
    `erstes angezeigtes Sample ${f(firstAfter)}° daneben, danach höchstens ${f(worstAfter)}°`,
  );
}
{
  // e) Android: relativer Strom ab 0 ms, erdfester erst ab 200 ms, 8 ms versetzt.
  const m = pose(70, 25);
  const fusion = new HeadingFusion();
  let worst = 0;
  for (let i = 0; i < 180; i += 1) {
    const base = 1000 + i * PERIOD_MS;
    const events: OrientationSample[] = [androidSample(base, m, false, 137)];
    if (base >= 1200) events.push(androidSample(base + 8, m, true, 0));
    for (const sample of events) {
      if (fusion.push(sample)) worst = Math.max(worst, Math.abs(yawErrorDeg(fusion.attitude, m)));
    }
  }
  expect('Android-Start: relativ vor erdfest', worst < 0.01, `größter angezeigter Fehler ${f(worst, 4)}°`);
}
{
  // f) Zwei erdfeste Ströme (auch `deviceorientation` meldet absolute = true)
  //    mit 0,8° Unterschied in der Höhe: Nick darf nicht pro Event alternieren.
  const legacy = new LegacyHeading(true);
  const fusion = new HeadingFusion();
  const p2pLegacy = new PeakToPeak();
  const p2pFusion = new PeakToPeak();
  for (let i = 0; i < 240; i += 1) {
    const base = 1000 + i * PERIOD_MS;
    for (const [t, stream, e] of [
      [base, 'deviceorientationabsolute', 30],
      [base + 8, 'deviceorientation', 30.8],
    ] as Array<[number, string, number]>) {
      const sample = androidSample(t, pose(10, e), true, 0, 0, stream);
      if (legacy.push(t, sample.alphaRad * RAD, sample.betaRad * RAD, sample.gammaRad * RAD, true, null) && i > 60) {
        p2pLegacy.add(viewElevationDeg(legacy.attitude));
      }
      if (fusion.push(sample) && i > 60) p2pFusion.add(viewElevationDeg(fusion.attitude));
    }
  }
  expect(
    'Zwei erdfeste Ströme',
    p2pFusion.value < 1e-6,
    `Nick-Zittern Spitze-Spitze alt ${f(p2pLegacy.value)}°, neu ${f(p2pFusion.value)}°`,
  );
}

{
  // g) Android-Start, während das Gerät angehoben wird (−40° → 30° in 0,8 s,
  //    rund 88°/s) oder schwenkt (30°/s über 3 s). Der erdfeste Strom setzt
  //    17 bzw. 200 ms nach dem relativen ein; jedes erdfeste Event kommt 8 ms
  //    nach dem relativen, aus einer schon weitergedrehten Lage. Der erste
  //    Nordbezug darf nicht auf das Ende der Bewegung warten, sonst läuft die
  //    Anzeige am willkürlichen Nullpunkt des relativen Stroms an (vorige
  //    Fassung: bis 180° daneben, erst nach 7,2 s unter 2°).
  const raise = (s: number) => pose(70, s < 0.8 ? -40 + 70 * (s / 0.8) : 30);
  const sweep = (s: number) => pose(70 + 30 * clamp(s, 0, 3), 30);
  const rows: string[] = [];
  let worstError = 0;
  let worstDelay = 0;
  for (const [label, motion] of [
    ['Anheben', raise],
    ['Schwenk 30°/s', sweep],
  ] as Array<[string, (s: number) => Matrix]>) {
    let labelError = 0;
    let labelDelay = 0;
    for (const absoluteFromMs of [17, 200]) {
      for (const zero of [0, 60, 137, 180]) {
        const fusion = new HeadingFusion();
        let firstAbsoluteMs = NaN;
        let firstShownMs = NaN;
        for (let i = 0; i < 360; i += 1) {
          const base = 1000 + i * PERIOD_MS;
          const s = i / 60;
          const events = [androidSample(base, motion(s), false, zero)];
          if (i * PERIOD_MS >= absoluteFromMs) events.push(androidSample(base + 8, motion(s + 0.008), true, 0));
          for (const sample of events) {
            if (sample.absolute && Number.isNaN(firstAbsoluteMs)) firstAbsoluteMs = sample.timeMs;
            if (!fusion.push(sample)) continue;
            if (Number.isNaN(firstShownMs)) firstShownMs = sample.timeMs;
            labelError = Math.max(labelError, Math.abs(yawErrorDeg(fusion.attitude, motion((sample.timeMs - 1000) / 1000))));
          }
        }
        labelDelay = Math.max(labelDelay, firstShownMs - firstAbsoluteMs);
      }
    }
    worstError = Math.max(worstError, labelError);
    worstDelay = Math.max(worstDelay, labelDelay);
    rows.push(`${label}: erste Anzeige höchstens ${f(labelDelay, 0)} ms nach dem ersten erdfesten Event, größter Fehler ${f(labelError)}°`);
  }
  expect(
    'Android-Start in Bewegung',
    worstError < 1 && worstDelay <= PERIOD_MS + 0.1,
    `${rows.join('; ')}; relative Nullpunkte 0/60/137/180°, erdfest ab 17/200 ms (Grenze: ein Sample; Fehler = Drehung in 8 ms, 30°/s · 8 ms = 0,24°)`,
  );
}
{
  // h) Rückkehr nach einer Lücke über 500 ms. Die Anzeige läuft sofort weiter;
  //    vorige Fassung: bis 1017 ms keine Ausgabe, das eingefrorene Bild bis 94°
  //    neben der Wahrheit, danach ein guter Nordbezug durch die Mitte beider
  //    Deutungen ersetzt (26,6° Fehler, dauerhaft).
  const lowered = (s: number) =>
    s < 4 ? pose(130, 30) : s < 5 ? pose(130, 30 - 27 * (s - 4), 4 * (s - 4)) : pose(130, 3, 4);
  // Während der blockierten 600 ms dreht sich das Gerät um 40° weiter; der
  // Kreisel zählt mit, die Anzeige muss also dem alten Versatz folgen und nicht
  // am eingefrorenen Bild ansetzen.
  const loweredTurned = (s: number) => (s < 6.3 ? lowered(s) : pose(170, 3, 4));
  const resumeAfter = (trace: Trace, resumeS: number) => {
    const index = trace.timeS.findIndex((s) => s >= resumeS);
    return {
      freezeMs: (trace.timeS[index] - resumeS) * 1000,
      after: { timeS: trace.timeS.slice(index), errorDeg: trace.errorDeg.slice(index), referenced: trace.referenced.slice(index) },
    };
  };
  const rows: string[] = [];
  let ok = true;
  for (const hypothesis of HYPOTHESES) {
    // 1. Mehrdeutige Lage (3° hoch, 4° Roll: Deutungen 53,2° auseinander),
    //    600 ms Lücke, Nullpunkt bleibt (blockierter Hauptthread), Gerät dreht
    //    in der Lücke um 40°.
    const blocked = runIos({
      seconds: 16,
      pose: loweredTurned,
      hypothesis,
      noiseDeg: 1,
      seed: 17,
      timeOf: (i) => 1000 + i * PERIOD_MS + (i >= 360 ? 600 : 0),
    });
    const kept = resumeAfter(blocked, 6.6);
    // 2. Dasselbe nach App-Wechsel: 5 s Lücke, Nullpunkt neu (198° weiter).
    const switched = runIos({
      seconds: 16,
      pose: lowered,
      hypothesis,
      noiseDeg: 1,
      seed: 17,
      gyroZeroDeg: (s) => (s < 6 ? 137 : -61),
      timeOf: (i) => 1000 + i * PERIOD_MS + (i >= 360 ? 5000 : 0),
    });
    const refuted = resumeAfter(switched, 11);
    const keptError = maxError(kept.after);
    const refutedError = maxError(refuted.after);
    ok &&= kept.freezeMs < 1 && refuted.freezeMs < 1 && keptError < 1.5 && refutedError < 26.6 + 1.5;
    ok &&= kept.after.referenced.every((r, i) => r === (kept.after.timeS[i] - 6.6 < 0.1));
    rows.push(
      `${hypothesis === 'alpha' ? '−alpha' : 'Kamerakurs'}: Nullpunkt bleibt ${f(keptError)}°, Nullpunkt neu ${f(refutedError)}°`,
    );
  }
  expect(
    'Rückkehr in mehrdeutiger Lage ohne Einfrieren',
    ok,
    `erste Ausgabe mit dem ersten Sample nach der Lücke; größter Fehler danach ${rows.join('; ')} (Grenze halbe Spreizung 26,6°); Status nach 100 ms „relativ“`,
  );

  // 3. Eindeutige Lage (30° hoch), App-Wechsel: Nullpunkt neu, danach 0,3 s
  //    WebKit-Platzhalter. Die Anzeige läuft sofort mit dem alten Versatz; der
  //    erste echte Kurs ersetzt ihn innerhalb der Frist direkt – der einzige
  //    Sprung, den die Fusion erlaubt. Danach nur begrenzte Nachführung.
  let firstError = 0;
  let settle = 0;
  let jumpAt = 0;
  let lateJump = 0;
  let freeze = 0;
  for (const hypothesis of HYPOTHESES) {
    const trace = runIos({
      seconds: 10,
      pose: (s) => (s < 6 ? pose(40, 30) : pose(130, 30)),
      hypothesis,
      noiseDeg: 1,
      seed: 18,
      gyroZeroDeg: (s) => (s < 6 ? 137 : -61),
      timeOf: (i) => 1000 + i * PERIOD_MS + (i >= 360 ? 5000 : 0),
      compass: (s, physical) =>
        s >= 11 && s < 11.3 ? { heading: 0, accuracy: -1 } : { heading: physical, accuracy: 10 },
    });
    const { freezeMs, after } = resumeAfter(trace, 11);
    freeze = Math.max(freeze, freezeMs);
    firstError = Math.max(firstError, Math.abs(after.errorDeg[0]));
    settle = Math.max(settle, settledAfter(after, 2, 11));
    let biggest = 0;
    after.timeS.forEach((s, i) => {
      if (i === 0) return;
      const step = Math.abs(wrap180(after.errorDeg[i] - after.errorDeg[i - 1]));
      if (step > biggest) {
        biggest = step;
        jumpAt = Math.max(jumpAt, s - 11);
      }
    });
    lateJump = Math.max(lateJump, maxJump(after, 12));
  }
  expect(
    'Rückkehr nach App-Wechsel mit Platzhalterkurs',
    freeze < 1 && settle < 0.35 && jumpAt < 1 && lateJump <= MAX_TRACKING_STEP_DEG + 0.05,
    `erste Ausgabe sofort, ${f(firstError, 0)}° daneben (alter Versatz); unter 2° nach ${f(settle)} s, Sprung bei ${f(jumpAt)} s (Frist 1 s); danach größte Änderung je Sample ${f(lateJump)}°`,
  );

  // 4. Android, Nullpunkt des relativen Stroms neu, relativer Strom zuerst:
  //    Das erste erdfeste Event 8 ms danach setzt den Nordbezug.
  const fusion = new HeadingFusion();
  let androidFreeze = NaN;
  let androidLate = 0;
  for (let i = 0; i < 600; i += 1) {
    const resumed = i >= 240;
    const base = 1000 + i * PERIOD_MS + (resumed ? 5000 : 0);
    const m = resumed ? pose(100 + 40 * clamp((i - 240) / 60, 0, 1.5), 30) : pose(40, 30);
    const zero = resumed ? -61 : 137;
    for (const sample of [androidSample(base, m, false, zero), androidSample(base + 8, m, true, 0)]) {
      if (!fusion.push(sample) || !resumed) continue;
      if (Number.isNaN(androidFreeze)) androidFreeze = base - (1000 + 240 * PERIOD_MS + 5000);
      if (i > 241) androidLate = Math.max(androidLate, Math.abs(yawErrorDeg(fusion.attitude, m)));
    }
  }
  expect(
    'Android-Rückkehr mit neuem Nullpunkt',
    androidFreeze < 1 && androidLate < 0.5,
    `erste Ausgabe ${f(androidFreeze, 0)} ms nach der Rückkehr, ab dem zweiten Sample höchstens ${f(androidLate)}° daneben`,
  );
}

{
  // i) iOS-Start mitten in einer schnellen Drehung (60°/s bis 1,5 s), die
  //    ersten 100 ms WebKit-Platzhalter, Kompass 300 ms verzögert. Anders als
  //    der erdfeste Android-Strom hinkt CLHeading hinterher (hier 18°): Auch der
  //    erste Nordbezug wartet, bis die Drehung 500 ms vorbei ist.
  let claimed = NaN;
  let worstEnd = 0;
  for (const hypothesis of HYPOTHESES) {
    const trace = runIos({
      seconds: 8,
      pose: (s) => pose(20 + 60 * clamp(s, 0, 1.5), 30),
      hypothesis,
      latencyMs: 300,
      compass: (s, physical) => (s < 0.1 ? { heading: 0, accuracy: -1 } : { heading: physical, accuracy: 10 }),
    });
    const index = trace.referenced.findIndex((r) => r);
    claimed = Math.min(Number.isNaN(claimed) ? Infinity : claimed, index < 0 ? Infinity : trace.timeS[index]);
    worstEnd = Math.max(worstEnd, maxError(trace, 7));
  }
  expect(
    'iOS-Start in schneller Drehung',
    claimed >= 2 && worstEnd < 1,
    `erdfest frühestens ab ${f(claimed)} s (Drehung bis 1,5 s + 0,5 s), Fehler am Ende ${f(worstEnd)}°`,
  );
}
{
  // j) Rückkehr in mehrdeutiger Lage, WebKit liefert die ersten 0,3 s noch den
  //    alten Kurs (Prüfer-Szenario S6), das Gerät wurde in der Pause um Δ
  //    gedreht. Ablauf: 2 s bei 30° Höhe (Nordbezug), 4 s in der mehrdeutigen
  //    Lage, 5 s Lücke, 9 s danach. Neue Nullpunkte 0°, 10°, … 350°.
  //    Vorige Fassung (einmal geprüft, mit dem ersten Sample): Median 66,6°,
  //    116,6°, 153,4° bei Δ = 40°, 90°, 180° statt 26,6° – die veraltete Mitte
  //    blieb stehen. Mit dem jüngsten Einzelwert statt der geglätteten Mitte:
  //    4,81° Änderung je Sample in der Frist, an der Toleranzgrenze Kippen um bis
  //    zu 70,3° (−alpha). Grenze 1° je Sample: Geglättet streut die Änderung je
  //    Sample mit k · σ · √(2/(2 − k)) = 0,154 · 1° · 1,04 = 0,16°; das Größte
  //    aus 36 · 4 Läufen à 60 Samples (knapp 4 Streuungen) erwartet 0,6°,
  //    gemessen 0,51°. Mit dem Einzelwert streut sie mit √2 · σ = 1,41°.
  const run = (held: (h: number) => Matrix, turn: number, zero: number | null, hypothesis: Hypothesis, seed: number) =>
    runIos({
      seconds: 15,
      pose: (s) => (s < 2 ? pose(130, 30) : held(s < 11 ? 130 : 130 + turn)),
      hypothesis,
      noiseDeg: 1,
      seed,
      // `null`: Nullpunkt bleibt (blockierter Hauptthread statt App-Wechsel).
      gyroZeroDeg: (s) => (s < 6 || zero === null ? 137 : zero),
      timeOf: (i) => 1000 + i * PERIOD_MS + (i >= 360 ? 5000 : 0),
      compass: (s, physical) => ({
        heading: s >= 11 && s < 11.3 ? trueCompassDeg(held(130), hypothesis) : physical,
        accuracy: 10,
      }),
    });
  const end = (trace: Trace) => Math.abs(trace.errorDeg[trace.errorDeg.length - 1]);
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const turns = [0, 40, 90, 180];
  const rows: string[] = [];
  let independent = true;
  let worstJitter = 0;
  for (const [label, held] of [
    ['3° hoch, 4° Roll', (h: number) => pose(h, 3, 4)],
    ['Querformat, 30° hoch', (h: number) => pose(h, 30, 90)],
  ] as Array<[string, (h: number) => Matrix]>) {
    for (const hypothesis of HYPOTHESES) {
      const medians: number[] = [];
      const maxima: number[] = [];
      for (const turn of turns) {
        const errors: number[] = [];
        for (let k = 0; k < 36; k += 1) {
          const trace = run(held, turn, k * 10, hypothesis, k + 1);
          errors.push(end(trace));
          // Ohne Drehung ist der alte Kurs nicht falsch: Jede Änderung der
          // Anzeige in der Frist ist dann Kursrauschen, das durchschlägt.
          if (turn === 0) worstJitter = Math.max(worstJitter, maxJump(trace, 11.01));
        }
        medians.push(median(errors));
        maxima.push(Math.max(...errors));
      }
      independent &&= medians.every((m) => Math.abs(m - medians[0]) < 1) && maxima.every((m) => m < maxima[0] + 1);
      if (hypothesis === 'camera') {
        rows.push(`${label}: Median ${medians.map((m) => f(m, 1)).join('/')}°, höchstens ${f(Math.max(...maxima), 1)}°`);
      }
    }
  }
  // Nullpunkt blieb, der alte Versatz stimmt also: Die veraltete Mitte darf ihn
  // widerlegen, die frischen Werte müssen ihn aber wieder einsetzen – entschieden
  // wird immer gegen den Versatz von vor der Lücke, nie gegen eine frühere Mitte.
  let worstKept = 0;
  for (const turn of turns) {
    for (let k = 0; k < 12; k += 1) worstKept = Math.max(worstKept, end(run((h) => pose(h, 3, 4), turn, null, 'camera', k + 1)));
  }
  expect(
    'Rückkehr mit veraltetem Kurs, in der Pause gedreht',
    independent && worstJitter < 1 && worstKept < 1.5,
    `Fehler nach 9 s bei Δ = ${turns.join('/')}°, Deutung Kamerakurs, 36 Nullpunkte: ${rows.join('; ')} (unabhängig von Δ in allen vier Fällen: ${independent ? 'ja' : 'nein'}; vorige Fassung Median 26,6/66,6/116,6/153,4° bzw. 45,0/85,0/135,0/135,0°); größte Änderung je Sample in der Frist ohne Drehung ${f(worstJitter)}° (mit jüngstem Einzelwert 4,81°, an der Toleranzgrenze 70,3°); Nullpunkt blieb: höchstens ${f(worstKept)}° daneben`,
  );
}

/* --- 4. Durchgang durch das Zenit-Band --- */
console.log('4. Steil nach oben, drehen, wieder herunter (Zenit-Band ab 75,9°)');
{
  // 0–1 s halten (40° hoch), 1–2 s auf 82° kippen, 2–3,5 s um 90° drehen, 3,5–4,5 s zurück.
  const elevation = (s: number) =>
    s < 1 ? 40 : s < 2 ? 40 + 42 * (s - 1) : s < 3.5 ? 82 : s < 4.5 ? 82 - 42 * (s - 3.5) : 40;
  let worstError = 0;
  let worstJump = 0;
  for (const hypothesis of HYPOTHESES) {
    const trace = runIos({
      seconds: 6.5,
      pose: (s) => pose(90 * clamp((s - 2) / 1.5, 0, 1), elevation(s)),
      hypothesis,
      noiseDeg: 1,
      seed: 4,
    });
    worstError = Math.max(worstError, maxError(trace));
    worstJump = Math.max(worstJump, maxJump(trace));
  }
  expect(
    'Kurs läuft durch das Band weiter',
    worstError < 2 && worstJump < 0.5,
    `größter Kursfehler ${f(worstError)}°, größter Sprung ${f(worstJump)}° (beide Deutungen)`,
  );
}

/* --- 5. Magnetische Deklination --- */
console.log('5. Magnetische Deklination (WMM2025, Grad 9)');
{
  // Offizielle WMM2025-Testwerte (Jahr, Höhe km, Breite, Länge, D) außerhalb der
  // Warnzonen (H ≥ 6000 nT), wörtlich aus WMM2025_TEST_VALUES.txt.
  const OFFICIAL: Array<[number, number, number, number, number]> = [
    [2025.0, 65, 43, 93, 0.5],
    [2025.0, 51, -33, 109, -5.49],
    [2025.0, 39, -59, -8, -15.75],
    [2025.0, 3, -50, -103, 27.96],
    [2025.0, 94, -29, -110, 15.74],
    [2025.0, 66, 14, 143, -0.19],
    [2025.5, 6, -36, -137, 20.28],
    [2025.5, 69, 38, -144, 12.93],
    [2025.5, 8, -66, 17, -33.14],
    [2025.5, 44, 33, -118, 11.1],
    [2026.0, 74, -57, 3, -22.51],
    [2026.0, 46, -24, -122, 14.01],
  ];
  let worstOfficial = 0;
  for (const [year, altitude, lat, lon, reference] of OFFICIAL) {
    const d = magneticDeclinationDeg(lat, lon, altitude, year) - reference;
    worstOfficial = Math.max(worstOfficial, Math.abs(d));
  }
  expect(
    `${OFFICIAL.length} offizielle Testwerte`,
    worstOfficial < 0.6,
    `größte Abweichung ${f(worstOfficial)}° (Kürzung auf Grad 9, dokumentiert ≤ 0,54°)`,
  );

  // Städte: Referenz ist das vollständige WMM2025 (Grad 12) zu 2026,5, mit
  // derselben Rechenvorschrift gerechnet, die alle 100 Testwerte auf 0,005° trifft.
  const CITIES: Array<[string, number, number, number, number]> = [
    ['Berlin', 52.52, 13.405, 0.04, 5.144],
    ['New York', 40.7128, -74.006, 0.01, -12.474],
    ['Seattle', 47.6062, -122.3321, 0.05, 14.905],
    ['Sydney', -33.8688, 151.2093, 0.02, 12.821],
    ['Kapstadt', -33.9249, 18.4241, 0.01, -26.741],
    ['Tokio', 35.6762, 139.6503, 0.04, -7.931],
  ];
  for (const [name, lat, lon, altitude, reference] of CITIES) {
    const value = magneticDeclinationDeg(lat, lon, altitude, 2026.5);
    const deviation = value - reference;
    expect(
      name,
      Math.sign(value) === Math.sign(reference) && Math.abs(deviation) < 0.6,
      `${f(value)}° (Referenz ${f(reference)}°, Abweichung ${f(deviation)}°)`,
    );
  }

  // Beide Plattformen messen magnetisch (WebKit reicht CLHeading.magneticHeading
  // durch). Der simulierte Sensor liefert Wahrheit minus Deklination; angezeigt
  // werden muss die Wahrheit – in Seattle 14,9° Unterschied.
  const declination = magneticDeclinationDeg(47.6062, -122.3321, 0.05, 2026.5);
  const m = pose(40, 30);
  const android = new HeadingFusion();
  for (let i = 0; i < 90; i += 1) {
    const t = 1000 + i * PERIOD_MS;
    android.push(androidSample(t, m, false, 211, declination));
    android.push(androidSample(t + 8, m, true, 0, declination));
  }
  const androidError = yawErrorDeg(android.attitude, m);
  let iosError = 0;
  for (const hypothesis of HYPOTHESES) {
    const trace = runIos({ seconds: 1.5, pose: () => m, hypothesis, declinationDeg: declination });
    iosError = Math.max(iosError, Math.abs(trace.errorDeg[trace.errorDeg.length - 1]));
  }
  expect(
    'Deklination auf Android und iOS',
    Math.abs(androidError) < 0.05 && iosError < 0.05,
    `Kursfehler Android ${f(androidError)}°, iOS ${f(iosError)}° (ohne Korrektur auf iOS: ${f(declination)}°)`,
  );
}

/* --- 6. Euler-Zweigwechsel am Horizont --- */
console.log('6. Hochformat senkrecht, 5° gerollt, Blick pendelt ±1° um den Horizont');
{
  // Erst 1,5 s 30° hoch ohne Roll (dort stimmen beide Deutungen überein), dann
  // an den Horizont mit 5° Roll. alpha springt dort mit jedem Zweigwechsel um
  // 180°; ein physischer Kompass (Kamerakurs) springt nicht, einer nach
  // Deutung A springt mit. Beides darf die Anzeige nicht bewegen.
  const random = createRandom(6);
  const tilt = Array.from({ length: 900 }, (_, i) => Math.sin(i / 40) + random.gauss(0.05));
  const elevation = (s: number) => {
    const i = Math.round(s * 60);
    if (s < 1.5) return 30;
    if (s < 2.5) return 30 + (tilt[i] - 30) * (s - 1.5);
    return tilt[i];
  };
  const roll = (s: number) => 5 * clamp(s - 1.5, 0, 1);
  let flips = 0;
  let previous: number | null = null;
  for (let i = 150; i < 900; i += 1) {
    const [alpha] = w3cEuler(pose(-40, elevation(i / 60), roll(i / 60)));
    if (previous !== null && Math.abs(wrap180(alpha - previous)) > 90) flips += 1;
    previous = alpha;
  }
  const rows: string[] = [];
  let worst = 0;
  for (const hypothesis of HYPOTHESES) {
    const trace = runIos({ seconds: 15, pose: (s) => pose(-40, elevation(s), roll(s)), hypothesis });
    worst = Math.max(worst, maxError(trace, 1.5), maxJump(trace));
    rows.push(`${hypothesis === 'alpha' ? 'Deutung −alpha' : 'Deutung Kamerakurs'} ${f(maxError(trace, 1.5), 4)}°`);
  }
  expect(
    'Zweigwechsel ohne Lagesprung',
    flips > 0 && worst < 0.05,
    `${flips} Sprünge von alpha um 180°; größter Kursfehler ${rows.join(', ')}`,
  );
}

/* --- 7. Pitch-Klammer --- */
console.log('7. Pitch-Klammer unter dem Horizont');
{
  const forward = new Vector3();
  const up = new Vector3();
  const axis = new Vector3();
  const fix = new Quaternion();
  /** Fassung aus dem letzten Commit: Drehachse allein aus dem waagrechten Blickanteil. */
  const legacyClamp = (q: Quaternion) => {
    forward.set(0, 0, -1).applyQuaternion(q);
    const horizontal = Math.hypot(forward.x, forward.z);
    const elevation = Math.atan2(forward.y, horizontal);
    if (elevation >= 0) return;
    if (horizontal > 1e-4) axis.set(-forward.z, 0, forward.x);
    else {
      up.set(0, 1, 0).applyQuaternion(q);
      axis.set(-up.z, 0, up.x);
    }
    if (axis.lengthSq() < 1e-8) return;
    fix.setFromAxisAngle(axis.normalize(), -elevation);
    q.premultiply(fix);
  };
  /** Kamera-Quaternion aus der physischen Lage (Kamerakurs, Höhe, Roll). */
  const cameraOf = (h: number, e: number, r: number): Quaternion => {
    const q = truthQuaternion(pose(h, e, r));
    return attitudeToCamera(q, q, 0);
  };
  const azimuthOf = (q: Quaternion): number => {
    forward.set(0, 0, -1).applyQuaternion(q);
    return Math.atan2(forward.x, -forward.z) * RAD;
  };
  const elevationOf = (q: Quaternion): number => {
    forward.set(0, 0, -1).applyQuaternion(q);
    return Math.asin(clamp(forward.y, -1, 1)) * RAD;
  };

  // a) Bis 60° Tiefe muss der Kurs exakt bleiben – gegen die physische Wahrheit,
  //    nicht gegen die alte Formel. Vorige Überarbeitung: 7,2° bei 15° Tiefe / 30° Roll.
  let worstShift = 0;
  let worstElevation = 0;
  let worstLegacy = 0;
  for (const depth of [0.01, 1, 5, 15, 30, 45, 60]) {
    for (const r of [-90, -60, -30, -10, 10, 30, 60, 90, 150, 180]) {
      const q = cameraOf(40, -depth, r);
      const legacy = q.clone();
      clampPitch(q);
      legacyClamp(legacy);
      worstShift = Math.max(worstShift, Math.abs(wrap180(azimuthOf(q) - 40)));
      worstElevation = Math.max(worstElevation, Math.abs(elevationOf(q)));
      worstLegacy = Math.max(worstLegacy, q.angleTo(legacy) * RAD);
    }
  }
  expect(
    'Kurs bis 60° Tiefe exakt, jeder Rollwinkel',
    worstShift < 1e-4 && worstElevation < 1e-4 && worstLegacy < 1e-4,
    `größter Kursversatz ${worstShift.toExponential(1)}°, Resthöhe ${worstElevation.toExponential(1)}°, Abstand zur Fassung aus dem Commit ${worstLegacy.toExponential(1)}°`,
  );

  // b) Lesehaltung 45° Tiefe, Hand rollt ±10°: angezeigter Kurs darf nicht wandern.
  const reading = [-10, -5, 0, 5, 10].map((r) => {
    const q = cameraOf(40, -45, r);
    clampPitch(q);
    return azimuthOf(q);
  });
  const readingSpan = Math.max(...reading) - Math.min(...reading);
  expect('Lesehaltung, Hand rollt ±10°', readingSpan < 1e-4, `Spanne des Kurses ${readingSpan.toExponential(1)}° (vorige Überarbeitung: 11,69°)`);

  // c) Kurz vor dem Nadir (0,05° daneben, acht Richtungen): Kurs aus Bildschirm-oben.
  const spread = (clampFn: (q: Quaternion) => void): number => {
    const azimuths: number[] = [];
    for (let k = 0; k < 8; k += 1) {
      const direction = (k / 8) * 2 * Math.PI;
      const q = eulerToAttitude(new Quaternion(), -45 * DEG, 0.05 * Math.cos(direction) * DEG, 0.05 * Math.sin(direction) * DEG);
      attitudeToCamera(q, q, 0);
      clampFn(q);
      azimuths.push(azimuthOf(q) * DEG);
    }
    let worst = 0;
    for (const a of azimuths) for (const b of azimuths) worst = Math.max(worst, Math.abs(angleDelta(a, b)));
    return worst * RAD;
  };
  const legacySpread = spread(legacyClamp);
  const newSpread = spread((q) => clampPitch(q));
  expect(
    'Kurz vor dem Nadir stabil',
    newSpread < 1,
    `Streuung des Horizont-Kurses Fassung aus dem Commit ${f(legacySpread)}°, neu ${f(newSpread)}°`,
  );

  // d) Stetigkeit: Tiefe 0 → 89,95° in 0,05°-Schritten, Rollwinkel bis ±120°.
  let worstStep = 0;
  let worstStepAt = '';
  for (let r = -120; r <= 120; r += 10) {
    let previous: number | null = null;
    for (let depth = 0.05; depth < 89.96; depth += 0.05) {
      const q = cameraOf(40, -depth, r);
      clampPitch(q);
      const azimuth = azimuthOf(q);
      if (previous !== null) {
        const step = Math.abs(wrap180(azimuth - previous));
        if (step > worstStep) {
          worstStep = step;
          worstStepAt = `Roll ${r}°, Tiefe ${f(depth, 1)}°`;
        }
      }
      previous = azimuth;
    }
  }
  expect('Kurs stetig über alle Tiefen', worstStep < 1, `größte Änderung je 0,05° Tiefe ${f(worstStep, 3)}° (${worstStepAt})`);

  // Knickfrei an den Rändern der Überblendung: smoothstep hat dort die
  // Steigung 0, der Kurs ändert sich beim Kippen durch 60° und 85° Tiefe ohne
  // Ruck. Eine lineare Überblendung knickt um (Kursunterschied beider
  // Richtungen) / 25° je Grad Tiefe.
  let worstKink = 0;
  for (const r of [10, 30, 60, 120]) {
    for (const edge of [60, 85]) {
      const az = (depth: number) => {
        const q = cameraOf(40, -depth, r);
        clampPitch(q);
        return azimuthOf(q);
      };
      const below = wrap180(az(edge) - az(edge - 0.05)) / 0.05;
      const above = wrap180(az(edge + 0.05) - az(edge)) / 0.05;
      worstKink = Math.max(worstKink, Math.abs(above - below));
    }
  }
  expect('Knickfrei bei 60° und 85° Tiefe', worstKink < 0.1, `größter Steigungssprung ${f(worstKink, 3)}° je Grad Tiefe`);

  // e) Wo die unvermeidliche Unstetigkeit liegt: Rollwinkel 178…182°.
  const flipSpan = (depth: number): number => {
    const values = [178, 179, 179.9, 180.1, 181, 182].map((r) => {
      const q = cameraOf(0, -depth, r);
      clampPitch(q);
      return azimuthOf(q) * DEG;
    });
    let worst = 0;
    for (const a of values) for (const b of values) worst = Math.max(worst, Math.abs(angleDelta(a, b)));
    return worst * RAD;
  };
  const spans = [45, 51.8, 60, 72.5, 85].map((depth) => `${f(depth, 1)}°: ${f(flipSpan(depth), 1)}°`);
  expect(
    'Unstetigkeit nur kopfüber nahe 72,5° Tiefe',
    flipSpan(45) < 1e-3 && flipSpan(51.8) < 1e-3 && flipSpan(60) < 1e-3 && flipSpan(85) < 5,
    `Kursspanne bei Roll 178…182° je Tiefe ${spans.join(', ')} (vorige Überarbeitung bei 51,8°: 174,9°)`,
  );
}

/* --- 8. Kameraglättung unabhängig von der Bildrate --- */
console.log('8. Kameraglättung');
{
  // Echte Slerps auf Quaternionen mit zufällig gestückelten Bildzeiten, die in
  // Summe 0,3 s ergeben. Ergebnis darf nicht von der Stückelung abhängen und
  // muss die Auslegung e^(−9,75 · 0,3) = 5,4 % Rest treffen.
  const random = createRandom(8);
  const target = new Quaternion().setFromAxisAngle(new Vector3(0.3, 1, 0.2).normalize(), 1.2);
  const remainingAfter = (deltas: number[], factor: (d: number) => number): number => {
    const camera = new Quaternion();
    for (const d of deltas) camera.slerp(target, factor(d));
    return camera.angleTo(target) / 1.2;
  };
  const partitions: Array<{ label: string; deltas: number[] }> = [10, 20, 30, 60, 120].map((fps) => ({
    label: `${fps} fps`,
    deltas: new Array<number>(Math.round(0.3 * fps)).fill(0.3 / Math.round(0.3 * fps)),
  }));
  const jittered: number[] = [];
  let left = 0.3;
  while (left > 1e-9) {
    const d = Math.min(left, 1 / 120 + random.uniform() * (1 / 20 - 1 / 120));
    jittered.push(d);
    left -= d;
  }
  partitions.push({ label: 'schwankend 20–120 fps', deltas: jittered });
  const fresh = partitions.map((p) => remainingAfter(p.deltas, arSmoothingFactor));
  const old = partitions.map((p) => remainingAfter(p.deltas, (d) => Math.min(1, d * 9)));
  const span = Math.max(...fresh) - Math.min(...fresh);
  expect(
    'Restabstand nach 0,3 s bei 10/20/30/60/120 fps und schwankend',
    span < 1e-6 && Math.abs(fresh[0] - Math.exp(-9.75 * 0.3)) < 0.001,
    `alt ${old.map((r) => f(r * 100, 1)).join(' / ')} %, neu ${fresh.map((r) => f(r * 100, 2)).join(' / ')} %`,
  );
  expect(
    'Zeitkonstante',
    Math.abs(1 / AR_SMOOTHING_RATE - 0.1026) < 5e-4,
    `τ = ${f((1 / AR_SMOOTHING_RATE) * 1000, 1)} ms`,
  );
  const afterPause = arSmoothingFactor(5);
  expect('Frame nach 5 s Pause', afterPause < 1, `Slerp-Anteil alt 1 (Sprung), neu ${f(afterPause)}`);
}

/* --- 9. Kompassstörung und echte Neukalibrierung --- */
console.log('9. Kompassstörung, Neukalibrierung, vorläufiger Start');
{
  const m = pose(100, 35);
  const disturbed = (from: number, seconds: number) => (s: number, physical: number): CompassReading => ({
    heading: s >= from && s < from + seconds ? physical + 100 : physical,
    accuracy: 10,
  });
  const run = (compass: IosScenario['compass'], hypothesis: Hypothesis, seconds = 20) =>
    runIos({ seconds, pose: () => m, hypothesis, noiseDeg: 1, seed: 9, compass });

  // a) 1,5 s gestört (200° statt 100°): muss folgenlos bleiben, also genau so
  //    wirken wie 1,5 s ohne gültigen Kurs (gleiches Rauschen, gleiche Zeiten).
  let shortDifference = 0;
  let shortJump = 0;
  for (const hypothesis of HYPOTHESES) {
    const clean = run(
      (s, physical) => (s >= 1 && s < 2.5 ? { heading: 0, accuracy: -1 } : { heading: physical, accuracy: 10 }),
      hypothesis,
      6,
    );
    const trace = run(disturbed(1, 1.5), hypothesis, 6);
    trace.errorDeg.forEach((e, i) => {
      shortDifference = Math.max(shortDifference, Math.abs(e - clean.errorDeg[i]));
    });
    shortJump = Math.max(shortJump, maxJump(trace));
  }
  expect(
    'Störung 1,5 s',
    shortDifference < 1e-9 && shortJump < 0.1,
    `Unterschied zu 1,5 s Aussetzer ${shortDifference.toExponential(1)}°, größter Sprung ${f(shortJump)}° (vorige Fassung: +98,6° und −98,0° je in einem Sample)`,
  );

  // b) 5 s gestört: ab 3 s Bestätigung folgt ψ mit 15°/s, danach zurück.
  const long = run(disturbed(1, 5), 'camera', 25);
  const longJump = maxJump(long);
  const longBack = settledAfter(long, 1, 6);
  expect(
    'Störung 5 s',
    maxError(long) < 35 && longJump <= MAX_TRACKING_STEP_DEG + 0.05 && longBack < 5,
    `größter Fehler ${f(maxError(long))}° (Auslegung (5 − 3) s · 15°/s = 30°), größte Änderung je Sample ${f(longJump)}° (Grenze ${f(MAX_TRACKING_STEP_DEG)}°), wieder unter 1° nach ${f(longBack, 1)} s`,
  );

  // c) Dauerhafte 90°-Korrektur (kalibriert): wird übernommen, als Schwenk.
  const permanent = run((s, physical) => ({ heading: physical + (s >= 1 ? 90 : 0), accuracy: 10 }), 'camera', 15);
  // Der Kompass sagt jetzt 90° mehr; die Anzeige soll dem folgen.
  const shifted: Trace = {
    ...permanent,
    errorDeg: permanent.errorDeg.map((e, i) => (permanent.timeS[i] >= 1 ? e + 90 : e)),
  };
  const followed = settledAfter(shifted, 2, 1);
  expect(
    'Dauerhafte Korrektur um 90°',
    followed < 10 && maxJump(permanent) <= MAX_TRACKING_STEP_DEG + 0.05,
    `übernommen (Rest < 2°) nach ${f(followed, 1)} s (Auslegung ≈ 9 s), größte Änderung je Sample ${f(maxJump(permanent))}°`,
  );

  // Dasselbe, aber jedes zweite Event ist ein WebKit-Platzhalter: Verworfene
  // Samples halten die Bestätigung nur an. Setzten sie sie zurück, würde die
  // Korrektur nie übernommen.
  const gappy = run(
    (s, physical) =>
      Math.round(s * 60) % 2 === 1 ? { heading: 0, accuracy: -1 } : { heading: physical + (s >= 1 ? 90 : 0), accuracy: 10 },
    'camera',
    25,
  );
  const gappyFollowed = settledAfter(
    { ...gappy, errorDeg: gappy.errorDeg.map((e, i) => (gappy.timeS[i] >= 1 ? e + 90 : e)) },
    2,
    1,
  );
  expect(
    'Korrektur um 90° bei halber Kompassrate',
    gappyFollowed < 20,
    `übernommen nach ${f(gappyFollowed, 1)} s (Bestätigen, Folgen und Einschwingen laufen bei halber Rate halb so schnell: 1 + 6 + 5,3 + 6,4 s ≈ 19 s)`,
  );

  // d) Start unkalibriert (Genauigkeit 40°, Kurs 60° daneben), ab 2 s kalibriert:
  //    vorläufiges ψ wird ohne Bestätigungszeit, aber begrenzt korrigiert.
  const provisional = run(
    (s, physical) => (s < 2 ? { heading: physical + 60, accuracy: 40 } : { heading: physical, accuracy: 10 }),
    'camera',
    10,
  );
  const provisionalSettled = settledAfter(provisional, 2, 2);
  expect(
    'Vorläufiger Start, dann kalibriert',
    provisionalSettled < 5 && maxJump(provisional) <= MAX_TRACKING_STEP_DEG + 0.05,
    `Fehler zu Beginn ${f(Math.abs(provisional.errorDeg[0]))}°, unter 2° nach ${f(provisionalSettled, 1)} s, größte Änderung je Sample ${f(maxJump(provisional))}°`,
  );

  // e) Störung 8 s mit schlechter Genauigkeit (40°): Unkalibrierte Ausreißer
  //    zählen nur zu 3/10 zur Bestätigung (8 s → 2,4 s < 3 s) und bleiben
  //    folgenlos. Dieselbe Störung kalibriert wird nach 3 s übernommen.
  let uncalibratedShift = 0;
  let calibratedShift = 0;
  for (const hypothesis of HYPOTHESES) {
    const poor = run(
      (s, physical) => (s >= 1 && s < 9 ? { heading: physical + 100, accuracy: 40 } : { heading: physical, accuracy: 10 }),
      hypothesis,
      12,
    );
    uncalibratedShift = Math.max(uncalibratedShift, maxError(poor, 1));
    calibratedShift = Math.max(calibratedShift, maxError(run(disturbed(1, 8), hypothesis, 12), 1));
  }
  expect(
    'Störung 8 s, unkalibriert',
    uncalibratedShift < 1.5 && calibratedShift > 30,
    `größter Fehler ${f(uncalibratedShift)}° (dieselbe Störung kalibriert: ${f(calibratedShift, 1)}°)`,
  );

  // f) Erster Wert 100° daneben, danach richtig, aber iOS meldet dauerhaft nur
  //    26° bis 40° Genauigkeit. Vorige Fassung: unkalibrierte Ausreißer
  //    bestätigten nie etwas, der Fehler blieb für immer bei 100,1°. Auslegung
  //    bei 40°: 0,5 s + 10 s Bestätigung + 50°/(15°/s · 0,39) = 8,5 s Folgen +
  //    τ/0,39 · ln(50°/2°) = 8,2 s Einschwingen ≈ 27 s.
  const rows: string[] = [];
  let worstSettle = 0;
  let worstStep = 0;
  for (const [firstAccuracy, accuracy] of [
    [40, 26],
    [40, 30],
    [40, 40],
    [10, 30],
  ]) {
    const trace = run(
      (s, physical) => (s < 0.5 ? { heading: physical + 100, accuracy: firstAccuracy } : { heading: physical, accuracy }),
      'camera',
      45,
    );
    const settled = settledAfter(trace, 2);
    worstSettle = Math.max(worstSettle, Number.isNaN(settled) ? Infinity : settled);
    worstStep = Math.max(worstStep, maxJump(trace));
    rows.push(`${firstAccuracy}°/${accuracy}°: ${f(settled, 1)} s`);
  }
  expect(
    'Falscher erster Wert, danach nur unkalibriert',
    worstSettle < 35 && worstStep <= MAX_TRACKING_STEP_DEG + 0.05,
    `unter 2° nach (Genauigkeit erster Wert/danach) ${rows.join(', ')}; größte Änderung je Sample ${f(worstStep)}°`,
  );
}

/* --- 10. Start am Horizont mit Rollwinkel --- */
console.log('10. Start am Horizont (±0,5°, 5° gerollt), dann auf 30° hochkippen');
{
  const rows: string[] = [];
  let worstJump = 0;
  let worstEnd = 0;
  let worstFirst = 0;
  for (const start of [-0.5, 0.5]) {
    for (const hypothesis of HYPOTHESES) {
      const elevation = (s: number) => (s < 1.5 ? start : s < 2.5 ? start + (30 - start) * (s - 1.5) : 30);
      const trace = runIos({
        seconds: 12,
        pose: (s) => pose(40, elevation(s), 5 * clamp(2.5 - s, 0, 1)),
        hypothesis,
        noiseDeg: 1,
        seed: 10,
      });
      worstJump = Math.max(worstJump, maxJump(trace));
      worstEnd = Math.max(worstEnd, maxError(trace, 10));
      worstFirst = Math.max(worstFirst, Math.abs(trace.errorDeg[0]));
      if (hypothesis === 'camera') {
        const unreferenced = trace.referenced.filter((r) => !r).length / 60;
        rows.push(`Start ${f(start, 1)}°: ${f(unreferenced, 1)} s ohne Nordbezug angezeigt`);
      }
    }
  }
  // Startwert ist die Mitte beider Deutungen: höchstens die halbe Spreizung
  // atan(tan 5° / sin 0,5°) / 2 = 42,2° daneben, der Kreiselnullpunkt bis 180°.
  expect(
    'Kein Sprung beim Hochkippen',
    worstJump <= MAX_TRACKING_STEP_DEG + 0.05 && worstEnd < 1.5 && worstFirst < 42.2 + 1.5,
    `${rows.join('; ')}; erste Anzeige höchstens ${f(worstFirst, 1)}° daneben (Grenze halbe Spreizung 42,2°); größte Änderung je Sample ${f(worstJump)}° (vorige Fassung: 74°–94°), Fehler nach 10 s ${f(worstEnd)}°`,
  );
}

/* --- 11. Nur erdfester Strom (ohne Kreisel) --- */
console.log('11. Nur deviceorientationabsolute, Kursrauschen σ 2°');
{
  const random = createRandom(11);
  const fusion = new HeadingFusion();
  const legacy = new LegacyHeading(true);
  const kc = arSmoothingFactor(1 / 60);
  let cameraNew: Quaternion | null = null;
  let cameraOld: Quaternion | null = null;
  const errorsNew: number[] = [];
  const errorsOld: number[] = [];
  for (let i = 0; i < 1200; i += 1) {
    const t = 1000 + i * PERIOD_MS;
    const m = pose(60 + random.gauss(2), 30);
    const sample = androidSample(t, m, true, 0);
    fusion.push(sample);
    legacy.push(t, sample.alphaRad * RAD, sample.betaRad * RAD, sample.gammaRad * RAD, true, null);
    if (!cameraNew) cameraNew = fusion.attitude.clone();
    else cameraNew.slerp(fusion.attitude, kc);
    if (!cameraOld) cameraOld = legacy.attitude.clone();
    else cameraOld.slerp(legacy.attitude, kc);
    if (i > 120) {
      errorsNew.push(yawErrorDeg(cameraNew, pose(60, 30)));
      errorsOld.push(yawErrorDeg(cameraOld, pose(60, 30)));
    }
  }
  const sd = (a: number[]) => {
    const mean = a.reduce((x, y) => x + y, 0) / a.length;
    return Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length);
  };
  const p2p = (a: number[]) => Math.max(...a) - Math.min(...a);
  expect(
    'Rauschen gedämpft wie bisher',
    sd(errorsNew) <= sd(errorsOld) * 1.05 && p2p(errorsNew) <= p2p(errorsOld) * 1.1,
    `Streuung alt ${f(sd(errorsOld))}° / Spitze-Spitze ${f(p2p(errorsOld))}°, neu ${f(sd(errorsNew))}° / ${f(p2p(errorsNew))}° (vorige Fassung: 0,61° / 4,00°)`,
  );

  // Echte Drehung 90° in 1 s: Der Filter muss öffnen, nicht nachschleppen.
  const turn = new HeadingFusion();
  let lagAfter = 0;
  for (let i = 0; i < 180; i += 1) {
    const t = 1000 + i * PERIOD_MS;
    const m = pose(10 + 90 * clamp(i / 60 - 1, 0, 1), 30);
    turn.push(androidSample(t, m, true, 0));
    if (i >= 150) lagAfter = Math.max(lagAfter, Math.abs(yawErrorDeg(turn.attitude, m)));
  }
  expect('Drehung ohne Kreisel', lagAfter < 1, `Restfehler 0,5 s nach dem Stopp ${f(lagAfter)}°`);
}

/* --- 12. Offene Kompass-Deutung: Querformat und Rollwinkel --- */
console.log('12. Beide Deutungen von webkitCompassHeading: Rollen, Querformat');
{
  const rows: string[] = [];
  let worstJump = 0;
  let worstError = 0;
  for (const hypothesis of HYPOTHESES) {
    // a) 30° hoch, 1 s Hochformat, dann in 1 s ins Querformat, 10 s halten.
    const landscape = runIos({
      seconds: 14,
      pose: (s) => pose(100, 30, 90 * clamp(s - 1.5, 0, 1)),
      hypothesis,
      noiseDeg: 1,
      seed: 12,
    });
    // b) Hand rollt langsam ±20° (Periode 30 s, höchstens 4,2°/s – unter der
    //    Ratengrenze, der Kompass wird also gehört), 60 s lang.
    const rolling = runIos({
      seconds: 62,
      pose: (s) => pose(100, 30, 20 * Math.sin((2 * Math.PI * Math.max(0, s - 1.5)) / 30)),
      hypothesis,
      noiseDeg: 1,
      seed: 13,
    });
    // c) Hand hält 4° Roll 20 s lang: Spreizung d = atan(tan 4° / sin 30°) = 8,0°,
    //    ψ läuft auf die Mitte zu – der Fehler ist unter jeder Deutung d/2 = 4,0°.
    const held = runIos({
      seconds: 22,
      pose: (s) => pose(100, 30, 4 * clamp(s - 1.5, 0, 1)),
      hypothesis,
      noiseDeg: 1,
      seed: 15,
    });
    // d) Ungünstigster Fall: 7° Roll gehalten, d = 13,8°, knapp unter der
    //    Spreizgrenze 15°. Erwartet d/2 = 6,9° unter jeder Deutung.
    const edge = runIos({
      seconds: 42,
      pose: (s) => pose(100, 30, 7 * clamp(s - 1.5, 0, 1)),
      hypothesis,
      noiseDeg: 1,
      seed: 16,
    });
    worstJump = Math.max(worstJump, maxJump(landscape), maxJump(rolling), maxJump(held), maxJump(edge));
    worstError = Math.max(worstError, maxError(landscape), maxError(rolling), maxError(held), maxError(edge));
    rows.push(
      `${hypothesis === 'alpha' ? '−alpha' : 'Kamerakurs'}: Querformat ${f(maxError(landscape))}°, Rollen ±20° ${f(maxError(rolling))}°, 4° Roll gehalten ${f(errorAt(held, 21))}°, 7° Roll gehalten ${f(errorAt(edge, 41))}°`,
    );
  }
  expect(
    'Kein Sprung, Fehler ≤ halbe Spreizgrenze',
    worstJump < 0.3 && worstError < 7.5 + 1,
    `${rows.join('; ')}; größte Änderung je Sample ${f(worstJump)}° (vorige Fassung, Deutung Kamerakurs: 90° Sprung im Querformat, 49° bei 30° Roll)`,
  );

  // c) Bekannte Grenze: Start im Querformat. Kein Nordbezug, bis das Gerät
  //    kurz im Hochformat gehalten wird – dann ohne Sprung herangeführt.
  const startLandscape = runIos({
    seconds: 14,
    pose: (s) => pose(100, 30, 90 * clamp(3 - s, 0, 1)),
    hypothesis: 'camera',
    noiseDeg: 1,
    seed: 14,
  });
  const unreferenced = startLandscape.referenced.filter((r) => !r).length / 60;
  expect(
    'Start im Querformat, später Hochformat',
    maxJump(startLandscape) <= MAX_TRACKING_STEP_DEG + 0.05 && maxError(startLandscape, 12) < 1.5,
    `${f(unreferenced, 1)} s ohne Nordbezug angezeigt, größte Änderung je Sample ${f(maxJump(startLandscape))}°, Fehler am Ende ${f(maxError(startLandscape, 12))}°`,
  );
}

/* --- 13. Übergabe AR → Touch --- */
console.log('13. Übergabe AR → Touch, sofort weitergezogen');
{
  // AR zeigte Kurs 90°, 30° hoch, 15° Roll. Danach richtet OrbitControls per
  // lookAt ohne Roll aus; der Nutzer zieht sofort mit 104°/s weiter.
  const lookAt = (azimuthDeg: number, elevationDeg: number): Quaternion => {
    const q = truthQuaternion(pose(azimuthDeg, elevationDeg, 0));
    return attitudeToCamera(q, q, 0);
  };
  const shown = truthQuaternion(pose(90, 30, 15));
  attitudeToCamera(shown, shown, 0);
  const handover = new RollHandover();
  handover.begin(shown);
  const oldHandover = shown.clone();
  let firstStep = 0;
  let lagAfter = 0;
  let oldLagAfter = 0;
  let activeFrames = 0;
  for (let i = 0; i < 180; i += 1) {
    const target = lookAt(90 + (104 * i) / 60, 30);
    const camera = target.clone();
    handover.apply(camera, 1 / 60);
    if (handover.active) activeFrames = i + 1;
    // Vorige Überarbeitung: eigene Lage hinter dem bewegten Ziel hergeslerpt.
    oldHandover.slerp(target, arSmoothingFactor(1 / 60));
    if (i === 0) firstStep = camera.angleTo(shown) * RAD;
    if (i >= 21) {
      lagAfter = Math.max(lagAfter, camera.angleTo(target) * RAD);
      oldLagAfter = Math.max(oldLagAfter, oldHandover.angleTo(target) * RAD);
    }
  }
  expect(
    'Ziehen ohne Nachlauf',
    lagAfter < 0.6 && activeFrames < 40 && firstStep < 4,
    `Abstand zur Touch-Lage ab 0,35 s ${f(lagAfter)}° (vorige Überarbeitung ${f(oldLagAfter)}°), Übergabe endet nach ${activeFrames} Bildern, erster Schritt ${f(firstStep)}°`,
  );

  // Ohne vorheriges AR darf die Übergabe nichts verändern (Touch-Modus unverändert).
  const idle = new RollHandover();
  const touch = lookAt(12, 34);
  const before = touch.clone();
  idle.apply(touch, 1 / 60);
  expect(
    'Touch-Modus unberührt',
    touch.x === before.x && touch.y === before.y && touch.z === before.z && touch.w === before.w,
    'Quaternion bitgleich',
  );
}

/* --- 14. Vom Browser-Event zur Kameralage (useDeviceOrientation) --- */
console.log('14. Echte Event-Objekte durch Umwandlung, Listener und Status aus useDeviceOrientation');

interface OrientationEventInit {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  absolute: boolean;
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

/**
 * DeviceOrientationEvent gibt es in Node nicht. Nachgebaut als echtes `Event`
 * mit den Winkeln als Getter wie im Browser; die WebKit-Felder nur, wenn iOS
 * sie senden würde.
 */
class TestOrientationEvent extends Event {
  readonly #init: OrientationEventInit;

  constructor(type: string, init: OrientationEventInit) {
    super(type);
    this.#init = init;
    if (init.webkitCompassHeading !== undefined) {
      Object.defineProperty(this, 'webkitCompassHeading', { get: () => init.webkitCompassHeading });
      Object.defineProperty(this, 'webkitCompassAccuracy', { get: () => init.webkitCompassAccuracy });
    }
  }

  get alpha(): number | null {
    return this.#init.alpha;
  }

  get beta(): number | null {
    return this.#init.beta;
  }

  get gamma(): number | null {
    return this.#init.gamma;
  }

  get absolute(): boolean {
    return this.#init.absolute;
  }
}

/** iOS-Event aus der physischen Lage: `deviceorientation`, relativ, mit WebKit-Kurs. */
function iosEvent(m: Matrix, gyroZeroDeg: number, compass: CompassReading): TestOrientationEvent {
  const sample = iosSample(0, m, gyroZeroDeg, null);
  return new TestOrientationEvent('deviceorientation', {
    alpha: sample.alphaRad * RAD,
    beta: sample.betaRad * RAD,
    gamma: sample.gammaRad * RAD,
    absolute: false,
    webkitCompassHeading: wrap360(compass.heading),
    webkitCompassAccuracy: compass.accuracy,
  });
}

/** Android-Event: relativer Strom auf `deviceorientation`, erdfester (magnetisch) auf `deviceorientationabsolute`. */
function androidEvent(m: Matrix, absolute: boolean, relativeZeroDeg: number, declinationDeg = 0): TestOrientationEvent {
  const sample = androidSample(0, m, absolute, relativeZeroDeg, declinationDeg);
  return new TestOrientationEvent(absolute ? 'deviceorientationabsolute' : 'deviceorientation', {
    alpha: sample.alphaRad * RAD,
    beta: sample.betaRad * RAD,
    gamma: sample.gammaRad * RAD,
    absolute,
  });
}

/** Der Handler des Hooks an einem EventTarget, mit eigener Uhr und eigenem Zustand. */
function hookHarness(declinationDeg: number, screenAngleDeg = 0) {
  const state: OrientationState = {
    quaternion: new Quaternion(),
    available: false,
    headingDeg: 0,
    screenAngle: 0,
    accuracyDeg: null,
  };
  let clock = 0;
  const statuses: CompassStatus[] = [];
  const seen = new Set<string>();
  const handler = createOrientationHandler({
    state,
    now: () => clock,
    declinationRad: () => declinationDeg * DEG,
    screenAngleRad: () => screenAngleDeg * DEG,
    publishStatus: (status) => {
      if (statuses[statuses.length - 1] !== status) statuses.push(status);
    },
  });
  const target = new EventTarget();
  const stop = listenForOrientation(target, (event) => {
    seen.add(event.type);
    handler(event);
  });
  const dispatch = (event: Event, timeMs: number) => {
    clock = timeMs;
    target.dispatchEvent(event);
  };
  return { state, statuses, seen, stop, dispatch };
}

/** Wahre Kameralage (mit Bildschirmdrehung) einer physischen Lage. */
function truthCamera(m: Matrix, screenAngleDeg = 0): Quaternion {
  const q = truthQuaternion(m);
  return attitudeToCamera(q, q, screenAngleDeg * DEG);
}

{
  // a) Einzelne Events. Die Deklination gilt auf jedem Event – auch iOS
  //    (`webkitCompassHeading` ist magnetisch); der WebKit-Platzhalter kommt mit
  //    seiner Genauigkeit −1 bei der Fusion an, sonst würde Kurs 0 zum Nordbezug.
  const m = pose(150, 30);
  const placeholder = orientationSample(iosEvent(m, 137, { heading: 0, accuracy: -1 }), 5, 0.3);
  const valid = orientationSample(iosEvent(m, 137, { heading: 123.5, accuracy: 10 }), 5, 0.3);
  const invalid = orientationSample(
    new TestOrientationEvent('deviceorientation', {
      alpha: 10,
      beta: 20,
      gamma: 30,
      absolute: false,
      webkitCompassHeading: -1,
      webkitCompassAccuracy: -1,
    }),
    5,
    0.3,
  );
  const relative = orientationSample(androidEvent(m, false, 137), 5, 0.3);
  const absolute = orientationSample(androidEvent(m, true, 0), 5, 0.3);
  const flagged = orientationSample(
    new TestOrientationEvent('deviceorientation', { alpha: 10, beta: 20, gamma: 30, absolute: true }),
    5,
    0.3,
  );
  const empty = orientationSample(
    new TestOrientationEvent('deviceorientation', { alpha: null, beta: null, gamma: null, absolute: false }),
    5,
    0.3,
  );
  const failures: string[] = [];
  if (placeholder?.compassHeadingRad !== 0 || placeholder.compassAccuracyDeg !== -1) failures.push('Platzhalter 0/−1');
  if (Math.abs((valid?.compassHeadingRad ?? NaN) - 123.5 * DEG) > 1e-12 || valid?.compassAccuracyDeg !== 10) failures.push('gültiger Kurs');
  if (invalid?.compassHeadingRad !== null || invalid.compassAccuracyDeg !== null) failures.push('Kurs −1');
  for (const [name, sample] of [['iOS', valid], ['Android relativ', relative], ['Android erdfest', absolute]] as const) {
    if (sample?.declinationRad !== 0.3) failures.push(`Deklination ${name}`);
  }
  if (relative?.absolute !== false || relative.compassHeadingRad !== null) failures.push('Android relativ');
  if (absolute?.absolute !== true || absolute.stream !== 'deviceorientationabsolute') failures.push('Android erdfest');
  if (flagged?.absolute !== true || flagged.stream !== 'deviceorientation') failures.push('absolute = true');
  if (empty !== null) failures.push('Event ohne Winkel');
  if (valid?.timeMs !== 5 || Math.abs(valid.betaRad - iosSample(0, m, 137, null).betaRad) > 1e-12) failures.push('Zeit/Winkel');
  expect(
    'Umwandlung einzelner Events',
    failures.length === 0,
    failures.length === 0
      ? 'Platzhalter 0/−1 unverändert weitergereicht, Kurs −1 verworfen, Deklination auf iOS-, relativen und erdfesten Events, absolute = true erkannt, Event ohne Winkel ignoriert'
      : `falsch: ${failures.join(', ')}`,
  );
}
{
  // b) iOS-Start über echte Events in Seattle (Deklination 15°): WebKit sendet
  //    die ersten sechs Events den Platzhalter Kurs 0 / Genauigkeit −1.
  //    Vorige Fehler im Hook: Deklination nur auf erdfesten Events (15°
  //    daneben), Genauigkeit nicht weitergereicht (Platzhalter als Nordbezug,
  //    150° daneben, erst nach 13 s unter 2°).
  const declination = magneticDeclinationDeg(47.6062, -122.3321, 0.05, 2026.5);
  const rows: string[] = [];
  let worst = 0;
  let statusOk = true;
  for (const hypothesis of HYPOTHESES) {
    const m = pose(150, 30);
    const hook = hookHarness(declination);
    let firstShown = NaN;
    for (let i = 0; i < 180; i += 1) {
      const t = 1000 + i * PERIOD_MS;
      const compass = i < 6 ? { heading: 0, accuracy: -1 } : { heading: trueCompassDeg(m, hypothesis) - declination, accuracy: 10 };
      hook.dispatch(iosEvent(m, 137, compass), t);
      if (!hook.state.available) continue;
      if (Number.isNaN(firstShown)) firstShown = t - 1000;
      worst = Math.max(worst, hook.state.quaternion.angleTo(truthCamera(m)) * RAD);
    }
    statusOk &&= hook.statuses.join() === 'ok' && hook.state.accuracyDeg === 10;
    rows.push(`${hypothesis === 'alpha' ? '−alpha' : 'Kamerakurs'}: erste Anzeige ${f(firstShown, 0)} ms`);
  }
  expect(
    'iOS über echte Events: Platzhalter und Deklination',
    worst < 0.5 && statusOk,
    `${rows.join(', ')}; größter Lagefehler ${f(worst)}° (Deklination ${f(declination)}°), Status ${statusOk ? 'nur „ok“' : 'falsch'}`,
  );
}
{
  // c) Beide Listener-Ströme (Android): relativer Kreisel auf
  //    `deviceorientation`, Nordbezug auf `deviceorientationabsolute`. Nach dem
  //    Abmelden darf kein Event mehr ankommen.
  const hook = hookHarness(5);
  const heading = (s: number) => 70 + 40 * clamp(s - 1, 0, 1);
  let worst = 0;
  for (let i = 0; i < 180; i += 1) {
    const t = 1000 + i * PERIOD_MS;
    const m = pose(heading(i / 60), 25);
    hook.dispatch(androidEvent(m, false, 137), t);
    hook.dispatch(androidEvent(m, true, 0, 5), t + 8);
    if (hook.state.available) worst = Math.max(worst, hook.state.quaternion.angleTo(truthCamera(m)) * RAD);
  }
  const before = hook.state.quaternion.clone();
  hook.stop();
  hook.dispatch(androidEvent(pose(300, 50), false, 137), 5000);
  hook.dispatch(androidEvent(pose(300, 50), true, 0, 5), 5008);
  const detached = hook.state.quaternion.equals(before);
  expect(
    'Beide Listener-Ströme (Android)',
    hook.seen.has('deviceorientation') && hook.seen.has('deviceorientationabsolute') && worst < 0.1 && detached && hook.statuses.join() === 'ok',
    `empfangen: ${[...hook.seen].join(', ')}; größter Lagefehler ${f(worst, 3)}° (Deklination 5°), Status ${hook.statuses.join(' → ')}; nach dem Abmelden ${detached ? 'keine Wirkung' : 'noch verarbeitet'}`,
  );
}
{
  // d) Status: kalibriert „ok“, Genauigkeit 40° „calibrating“, nie ein
  //    gültiger Kurs „relative“.
  const statusOf = (compass: CompassReading) => {
    const hook = hookHarness(0);
    const m = pose(60, 30);
    for (let i = 0; i < 90; i += 1) hook.dispatch(iosEvent(m, 137, compass), 1000 + i * PERIOD_MS);
    return hook.statuses.join(' → ');
  };
  const m = pose(60, 30);
  const calibrated = statusOf({ heading: trueCompassDeg(m, 'camera'), accuracy: 10 });
  const poor = statusOf({ heading: trueCompassDeg(m, 'camera'), accuracy: 40 });
  const none = statusOf({ heading: 0, accuracy: -1 });
  expect(
    'Kompassstatus',
    calibrated === 'ok' && poor === 'calibrating' && none === 'relative',
    `Genauigkeit 10°: ${calibrated}; 40°: ${poor}; nur Platzhalter: ${none}`,
  );
}
{
  // e) Querformat über den Hook: Gerät gegen den Uhrzeigersinn gedreht,
  //    screen.orientation.angle = 90. Das Bild steht aufrecht.
  const hook = hookHarness(0, 90);
  const m = pose(200, 35, 90);
  for (let i = 0; i < 60; i += 1) {
    hook.dispatch(androidEvent(m, false, 137), 1000 + i * PERIOD_MS);
    hook.dispatch(androidEvent(m, true, 0), 1008 + i * PERIOD_MS);
  }
  const roll = imageRollDeg(hook.state.quaternion);
  const headingError = wrap180(hook.state.headingDeg - 200);
  // Unter dem Horizont (30° Tiefe) rastet die Ansicht am Horizont ein.
  const below = pose(120, -30);
  for (let i = 60; i < 90; i += 1) {
    hook.dispatch(androidEvent(below, false, 137), 1000 + i * PERIOD_MS);
    hook.dispatch(androidEvent(below, true, 0), 1008 + i * PERIOD_MS);
  }
  forwardScratch.set(0, 0, -1).applyQuaternion(hook.state.quaternion);
  const clampedElevation = Math.asin(clamp(forwardScratch.y, -1, 1)) * RAD;
  const clampedHeading = wrap180(hook.state.headingDeg - 120);
  expect(
    'Querformat und Blick unter den Horizont über den Hook',
    Math.abs(roll) < 0.01 &&
      Math.abs(headingError) < 0.01 &&
      hook.state.screenAngle === 90 * DEG &&
      Math.abs(clampedElevation) < 1e-3 &&
      Math.abs(clampedHeading) < 0.01,
    `Querformat: Bildrollwinkel ${f(roll, 3)}°, Kursfehler ${f(headingError, 3)}°; 30° Tiefe: angezeigte Höhe ${f(clampedElevation, 3)}°, Kursfehler ${f(clampedHeading, 3)}°`,
  );
}
{
  // f) Deklination aus dem Standort: gerechnet nur bei neuem Standortobjekt.
  const seattle = { latitudeDeg: 47.6062, longitudeDeg: -122.3321, altitudeKm: 0.05 };
  const berlin = { latitudeDeg: 52.52, longitudeDeg: 13.405, altitudeKm: 0.04 };
  let observer: typeof seattle | null = null;
  let clockCalls = 0;
  const read = createDeclinationReader(
    () => observer,
    () => {
      clockCalls += 1;
      return new Date(Date.UTC(2026, 6, 2));
    },
  );
  const none = read() * RAD;
  observer = seattle;
  const first = read() * RAD;
  const again = read() * RAD;
  observer = berlin;
  const moved = read() * RAD;
  const reference = magneticDeclinationDeg(seattle.latitudeDeg, seattle.longitudeDeg, seattle.altitudeKm, 2026.5);
  expect(
    'Deklination aus dem Standort',
    none === 0 && Math.abs(first - reference) < 0.01 && again === first && Math.abs(moved - 5.1) < 0.3 && clockCalls === 2,
    `ohne Standort ${f(none)}°, Seattle ${f(first)}° (Modell 2026,5: ${f(reference)}°), Berlin ${f(moved)}°, ${clockCalls} Berechnungen für 4 Abfragen`,
  );
}

/* --- 15. Lage-Tore --- */
console.log('15. Lage-Tore: Kompass- und Kreiselfusion sehen die Lage um 1° verschieden');
{
  // CLHeading und CMDeviceMotion sind getrennte Fusionen. Modell, nicht
  // gemessen: Der Kompass rechnet mit einer um 1° (um die Geräteachse x, y
  // oder z) gedrehten Lage. Bei 30° Höhe kostet das 0 bis 2°; an zwei Stellen
  // wird es verstärkt, dort müssen die Lage-Tore den Kompass draußen halten:
  // - Nahe am Horizont (5° hoch, 1° Roll, |cos β| = 0,09 < 0,25): Die
  //   Spreizung beider Deutungen ist mit 11,3° klein genug für das Spreiz-Tor,
  //   draußen hält den Kompass nur MIN_ALPHA_CONDITION. Mit mehr Roll greift
  //   schon das Spreiz-Tor (2° hoch, 2° Roll: Spreizung 45°).
  // - Zenit-Band (80° hoch, |cos β · cos γ| = 0,98 > 0,97): Unter der Deutung
  //   Kamerakurs verschiebt 1° Seitenneigung den Kurs um 1/sin 10° = 5,7° statt
  //   1,15° bei 30° Höhe. Draußen hält ihn NEAR_VERTICAL.
  // Gegenprobe mit ausgeschaltetem Tor (gemessen): MIN_ALPHA_CONDITION = 0
  // ließ ψ am Horizont um bis zu 14,2° wandern (halbe Spreizung 5,7° plus
  // verstärkter Lageunterschied unter −alpha, Achse z), NEAR_VERTICAL = 1,01
  // im Zenit-Band um 4,6° (Kamerakurs, Achse y).
  // Ablauf: 2 s bei 30° Höhe (Nordbezug), in 1 s in die Lage, 20 s halten.
  const rotX1 = [1, 0, 0, 0, Math.cos(DEG), -Math.sin(DEG), 0, Math.sin(DEG), Math.cos(DEG)];
  const rotY1 = [Math.cos(DEG), 0, Math.sin(DEG), 0, 1, 0, -Math.sin(DEG), 0, Math.cos(DEG)];
  const rotZ1 = rotZ(DEG);
  const cases: Array<[string, (s: number) => Matrix]> = [
    ['Horizont 5° hoch, 1° Roll', (s) => pose(100, s < 2 ? 30 : s < 3 ? 30 - 25 * (s - 2) : 5, clamp(s - 2, 0, 1))],
    ['Zenit-Band 80° hoch', (s) => pose(100, s < 2 ? 30 : s < 3 ? 30 + 50 * (s - 2) : 80)],
  ];
  const rows: string[] = [];
  let worstDrift = 0;
  for (const [label, motion] of cases) {
    for (const [axis, rotation] of [['x', rotX1], ['y', rotY1], ['z', rotZ1]] as Array<[string, Matrix]>) {
      for (const hypothesis of HYPOTHESES) {
        const trace = runIos({
          seconds: 23,
          pose: motion,
          hypothesis,
          seed: 19,
          compass: (s) => ({ heading: trueCompassDeg(multiply(motion(s), rotation), hypothesis), accuracy: 10 }),
        });
        const drift = Math.abs(errorAt(trace, 22.9) - errorAt(trace, 1.9));
        worstDrift = Math.max(worstDrift, drift);
        if (drift > 0.5) rows.push(`${label}, Achse ${axis}, ${hypothesis === 'alpha' ? '−alpha' : 'Kamerakurs'}: ${f(drift)}°`);
      }
    }
  }
  expect(
    'Verstärkte Lageunterschiede ändern ψ nicht',
    worstDrift < 1,
    `größte Änderung des Kursfehlers nach 20 s in der Lage ${f(worstDrift)}° (ohne Tore gemessen: 14,2° am Horizont, 4,6° im Zenit-Band)${rows.length ? `; ${rows.join('; ')}` : ''}`,
  );
}

console.log(`${checks} Prüfungen, ${failures} Fehlschläge`);
if (failures > 0) process.exit(1);
console.log('✓ Orientierungspipeline verhält sich wie spezifiziert');
