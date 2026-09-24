/**
 * Prüft die Bildlogik von CameraRig ohne Browser – den echten Code aus
 * src/components/canvas/CameraRig.tsx mit dem echten OrbitControls aus
 * three-stdlib, in der Reihenfolge des Frame-Takts von React Three Fiber:
 *
 *   Priorität −2  CameraRig `beforeControls` (Moduswechsel AR ↔ Touch)
 *   Priorität −1  drei-Wrapper von OrbitControls: `if (enabled) update()`
 *   Priorität  0  SatelliteField-Frame, dann CameraRig `afterControls`
 *   Zeichnen      SatelliteField: Auswahlring übernimmt die Render-Kamera
 *
 * Nachgebildet sind nur der drei-Wrapper (eine Zeile, Quelle geprüft in
 * Abschnitt 0), die JSX-Props von <OrbitControls> und das Zeichnen des Rings.
 * Vergleichsgröße ist die Fassung aus dem letzten Commit, Zeile für Zeile
 * nachgebaut. Übernommen aus der Rig-Simulation der Prüfer
 * (node_modules/.cache/regress/rig-sim.ts), jetzt gegen den echten Code statt
 * gegen eine Nachbildung.
 *
 * React Three Fiber und drei ersetzt esbuild durch scripts/stubs (siehe
 * package.json): Gerendert wird nichts, nur die Bildfunktionen laufen. Ob
 * CameraRig sie mit den richtigen Prioritäten in den Frame-Takt hängt, prüft
 * scripts/verify-wiring.ts im echten Renderer von R3F.
 *
 * Aufruf: npm run verify:rig
 */
import { readFileSync } from 'node:fs';
import { Euler, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { OrbitControls } from 'three-stdlib';
import {
  AR_SWITCH_PRIORITY,
  createCameraRigFrame,
  type CameraRigFrame,
} from '../src/components/canvas/CameraRig';
import { DEG, RAD, angleDelta, clamp, normalizeAngle } from '../src/math/coords';
import { arSmoothingFactor } from '../src/math/orientation';
import { orientationState, viewState } from '../src/state/runtime';

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
const e = (value: number): string => value.toExponential(2).replace('.', ',');

/** Wie in CameraRig.tsx: Kamera praktisch im Ursprung. */
const EPS_DISTANCE = 1e-4;
const DT = 1 / 60;

/* --- Kleines DOM für OrbitControls (Zeigerereignisse) --- */

class FakeTarget {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

const pointer = (x: number, y: number) => ({
  pointerId: 1,
  pointerType: 'mouse',
  button: 0,
  clientX: x,
  clientY: y,
  pageX: x,
  pageY: y,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  preventDefault() {},
});

interface World {
  camera: PerspectiveCamera;
  controls: OrbitControls;
  element: FakeTarget;
  doc: FakeTarget;
}

function makeWorld(): World {
  const camera = new PerspectiveCamera(70, 0.5, 0.01, 2000);
  // useEffect in CameraRig.tsx
  camera.position.set(0, 0, EPS_DISTANCE);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);
  const doc = new FakeTarget();
  const element = Object.assign(new FakeTarget(), {
    style: {},
    clientHeight: 800,
    clientWidth: 400,
    ownerDocument: doc,
    setPointerCapture() {},
    releasePointerCapture() {},
  });
  const controls = new OrbitControls(camera);
  controls.connect(element as unknown as HTMLElement);
  // JSX-Props von <OrbitControls> in CameraRig.tsx
  controls.target.set(0, 0, 0);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.rotateSpeed = -0.32;
  controls.minDistance = EPS_DISTANCE;
  controls.maxDistance = EPS_DISTANCE;
  return { camera, controls, element, doc };
}

type Focus = { azimuth: number; elevation: number } | null;

/** Der echte CameraRig im Frame-Takt, dazu der Auswahlring von SatelliteField. */
class Rig {
  arEnabled = false;
  /** SatelliteField-Frame (Priorität 0, vor CameraRig eingehängt): so stand es vor dem onBeforeRender-Fix. */
  readonly ringAtFrame = new Quaternion();
  /** SatelliteField.onBeforeRender: Render-Kamera beim Zeichnen. */
  readonly ringAtDraw = new Quaternion();
  private readonly frame: CameraRigFrame;

  constructor(readonly w: World) {
    this.frame = createCameraRigFrame(w.camera, () => w.controls, () => this.arEnabled, () => 70);
  }

  set focus(value: Focus) {
    viewState.focus = value;
  }

  get focus(): Focus {
    return viewState.focus;
  }

  step(delta: number): void {
    this.frame.beforeControls();
    // drei core/OrbitControls.js, useFrame(…, −1)
    if (this.w.controls.enabled) this.w.controls.update();
    this.ringAtFrame.copy(this.w.camera.quaternion);
    this.frame.afterControls(delta);
    this.ringAtDraw.copy(this.w.camera.quaternion);
  }
}

/* --- Fassung aus dem letzten Commit (HEAD), nachgebaut --- */

const headForward = new Vector3();
const headUp = new Vector3();
const headAxis = new Vector3();
const headFix = new Quaternion();
function clampPitchHead(q: Quaternion): void {
  headForward.set(0, 0, -1).applyQuaternion(q);
  const horizontal = Math.hypot(headForward.x, headForward.z);
  const elevation = Math.atan2(headForward.y, horizontal);
  if (elevation >= 0) return;
  if (horizontal > 1e-4) headAxis.set(-headForward.z, 0, headForward.x);
  else {
    headUp.set(0, 1, 0).applyQuaternion(q);
    headAxis.set(-headUp.z, 0, headUp.x);
  }
  if (headAxis.lengthSq() < 1e-8) return;
  headFix.setFromAxisAngle(headAxis.normalize(), -elevation);
  q.premultiply(headFix);
}

class HeadRig {
  arEnabled = false;
  focus: Focus = null;

  constructor(readonly w: World) {}

  step(delta: number): void {
    const { camera, controls } = this.w;
    if (controls.enabled) controls.update();
    const arActive = this.arEnabled && orientationState.available;
    controls.enabled = !arActive;
    if (arActive) {
      camera.quaternion.slerp(orientationState.quaternion, Math.min(1, delta * 9));
      clampPitchHead(camera.quaternion);
    } else if (this.focus) {
      const targetTheta = -this.focus.azimuth;
      const targetPhi = clamp(Math.PI / 2 + this.focus.elevation, 0.02, Math.PI - 0.02);
      const theta = controls.getAzimuthalAngle();
      const phi = controls.getPolarAngle();
      const dTheta = angleDelta(targetTheta, theta);
      const dPhi = targetPhi - phi;
      const k = Math.min(1, delta * 4.5);
      controls.setAzimuthalAngle(theta + dTheta * k);
      controls.setPolarAngle(phi + dPhi * k);
      controls.update();
      if (Math.abs(dTheta) < 0.004 && Math.abs(dPhi) < 0.004) this.focus = null;
    }
  }
}

/* --- Winkel --- */

/** Kamera-Quaternion aus Blickkurs, Blickhöhe und Bildrollwinkel (Szene: −Z Nord, +X Ost, +Y Zenit). */
const cameraQuaternion = (azimuthDeg: number, elevationDeg: number, rollDeg: number): Quaternion =>
  new Quaternion().setFromEuler(new Euler(elevationDeg * DEG, -azimuthDeg * DEG, rollDeg * DEG, 'YXZ'));

const probe = new Vector3();
function azimuthElevation(q: Quaternion): [number, number] {
  probe.set(0, 0, -1).applyQuaternion(q);
  return [
    normalizeAngle(Math.atan2(probe.x, -probe.z)) * RAD,
    Math.atan2(probe.y, Math.hypot(probe.x, probe.z)) * RAD,
  ];
}

/** Bildrollwinkel: Winkel zwischen Bild-oben und der Projektion des Zenits auf die Bildebene. */
function rollOf(q: Quaternion): number {
  const forward = new Vector3(0, 0, -1).applyQuaternion(q);
  const up = new Vector3(0, 1, 0).applyQuaternion(q);
  const right = new Vector3(1, 0, 0).applyQuaternion(q);
  const zenith = new Vector3(0, 1, 0).addScaledVector(forward, -forward.y);
  return Math.atan2(zenith.dot(right), zenith.dot(up)) * RAD;
}

/** Richtungsabstand zweier Kameralagen (ohne Rollwinkel) in Grad. */
function directionGap(a: Quaternion, b: Quaternion): number {
  const [azA, elA] = azimuthElevation(a);
  const [azB, elB] = azimuthElevation(b);
  return Math.max(Math.abs(angleDelta(azA * DEG, azB * DEG)) * RAD, Math.abs(elA - elB));
}

function resetShared(): void {
  orientationState.available = false;
  orientationState.quaternion.identity();
  viewState.focus = null;
}

/** Lässt beide Fassungen dieselben Frames laufen und liefert die größte Abweichung. */
function compareWithHead(
  frames: number,
  arEnabled: boolean,
  script: (i: number, worlds: World[], setFocus: (focus: Focus) => void) => void,
): { angle: number; position: number; identical: boolean } {
  resetShared();
  const head = new HeadRig(makeWorld());
  const rig = new Rig(makeWorld());
  head.arEnabled = arEnabled;
  rig.arEnabled = arEnabled;
  let angle = 0;
  let position = 0;
  let identical = true;
  for (let i = 0; i < frames; i += 1) {
    script(i, [head.w, rig.w], (focus) => {
      head.focus = focus && { ...focus };
      rig.focus = focus && { ...focus };
    });
    const delta = i % 7 === 0 ? 0.05 : DT;
    head.step(delta);
    rig.step(delta);
    const a = head.w.camera;
    const b = rig.w.camera;
    angle = Math.max(angle, a.quaternion.angleTo(b.quaternion));
    position = Math.max(position, a.position.distanceTo(b.position) / EPS_DISTANCE);
    identical &&=
      a.quaternion.x === b.quaternion.x &&
      a.quaternion.y === b.quaternion.y &&
      a.quaternion.z === b.quaternion.z &&
      a.quaternion.w === b.quaternion.w &&
      a.position.equals(b.position);
  }
  return { angle, position, identical };
}

/* --- 0. Annahmen über den Frame-Takt --- */
console.log('0. Frame-Takt und Auswahlring');
{
  // Pfade relativ zum Projekt: npm führt das Skript dort aus.
  const drei = readFileSync('node_modules/@react-three/drei/core/OrbitControls.js', 'utf8');
  const match = /if \(controls\.enabled\) controls\.update\(\);\s*\},\s*(-?\d+)\)/.exec(drei);
  const dreiPriority = match ? Number(match[1]) : NaN;
  expect(
    'Moduswechsel vor OrbitControls.update()',
    Number.isFinite(dreiPriority) && AR_SWITCH_PRIORITY < dreiPriority && dreiPriority < 0,
    `CameraRig ${AR_SWITCH_PRIORITY}, drei-Wrapper ${dreiPriority}, Kameraführung 0`,
  );

  // SatelliteField lässt sich ohne WebGL und Worker nicht ausführen; geprüft
  // wird deshalb der Quelltext: Der Ring übernimmt die Lage beim Zeichnen von
  // der Render-Kamera, und nirgends sonst wird sie gesetzt. Warum das zählt,
  // misst Abschnitt G.
  const field = readFileSync('src/components/canvas/SatelliteField.tsx', 'utf8');
  const hook = /(\w+)\.onBeforeRender\s*=\s*\(\s*\w+\s*,\s*\w+\s*,\s*(\w+)\s*\)\s*=>\s*\{([^}]*)\}/.exec(field);
  const copiesRenderCamera =
    hook !== null && new RegExp(`${hook[1]}\\.quaternion\\.copy\\(\\s*${hook[2]}\\.quaternion\\s*\\)`).test(hook[3]);
  const writes = field.match(/\bring\.quaternion\.(copy|set|setFrom\w+|multiply|premultiply|slerp)\(/g) ?? [];
  expect(
    'Auswahlring richtet sich beim Zeichnen aus',
    copiesRenderCamera && writes.length === 1,
    `onBeforeRender übernimmt die Render-Kamera: ${copiesRenderCamera ? 'ja' : 'nein'}, Schreibzugriffe auf ring.quaternion: ${writes.length} (erwartet 1)`,
  );
}

/* --- A. Touch-Modus bitgleich --- */
console.log('A. Touch-Modus ohne AR gegen die Fassung aus dem Commit');
{
  let x = 200;
  let y = 400;
  const touch = compareWithHead(1200, false, (i, worlds, setFocus) => {
    if (i === 10) for (const w of worlds) w.element.dispatch('pointerdown', pointer(x, y));
    if (i > 10 && i < 200) {
      x += 7 * Math.sin(i / 20);
      y += 3 * Math.cos(i / 30);
      for (const w of worlds) w.doc.dispatch('pointermove', pointer(x, y));
    }
    if (i === 200) for (const w of worlds) w.doc.dispatch('pointerup', pointer(x, y));
    if (i === 400) setFocus({ azimuth: 2.1, elevation: 0.7 });
    if (i === 700) setFocus({ azimuth: -1.0, elevation: 1.45 });
  });
  expect(
    '1200 Frames Ziehen, Nachlauf, zwei Fokusanfragen',
    touch.identical,
    `Quaternion und Position ${touch.identical ? 'bitgleich' : 'verschieden'}; angleTo höchstens ${e(touch.angle)} rad (Rundungsgrenze von acos nahe 1), Position ${e(touch.position)}`,
  );
  const noSensor = compareWithHead(300, true, (i, _worlds, setFocus) => {
    if (i === 5) setFocus({ azimuth: 1, elevation: 0.3 });
  });
  expect(
    'AR eingeschaltet, aber kein Sensor',
    noSensor.identical,
    `${noSensor.identical ? 'bitgleich' : 'verschieden'}, angleTo höchstens ${e(noSensor.angle)} rad`,
  );
}

/* --- B. Übergabe AR → Touch --- */
console.log('B. AR verlassen: Blickrichtung bleibt, Rollwinkel klingt ab');
{
  const rowsNew: string[] = [];
  const rowsHead: string[] = [];
  let worstDirection = 0;
  let worstStepExcess = -Infinity;
  let worstRollLeft = 0;
  let worstHeadStep = 0;
  // Ein Frame Glättung trägt den Anteil 1 − e^(−9,75/60) = 15 % des Rollwinkels ab.
  const share = arSmoothingFactor(DT);
  for (const [az, el, roll] of [
    [120, 40, 15],
    [250, 80, 20],
    [30, 89, 5],
    [10, 5, 90],
  ]) {
    for (const kind of ['neu', 'HEAD'] as const) {
      resetShared();
      const w = makeWorld();
      const rig = kind === 'neu' ? new Rig(w) : new HeadRig(w);
      rig.focus = { azimuth: 0, elevation: 20 * DEG };
      for (let i = 0; i < 300; i += 1) rig.step(DT);
      orientationState.quaternion.copy(cameraQuaternion(az, el, roll));
      orientationState.available = true;
      rig.arEnabled = true;
      for (let i = 0; i < 180; i += 1) rig.step(DT);
      const shown = w.camera.quaternion.clone();
      rig.arEnabled = false;
      orientationState.available = false;
      let maxStep = 0;
      let previous = shown.clone();
      let rollAfter1s = 0;
      for (let i = 0; i < 120; i += 1) {
        rig.step(DT);
        maxStep = Math.max(maxStep, previous.angleTo(w.camera.quaternion) * RAD);
        previous = w.camera.quaternion.clone();
        if (i === 59) rollAfter1s = Math.abs(rollOf(w.camera.quaternion));
      }
      const direction = directionGap(shown, w.camera.quaternion);
      if (kind === 'neu') {
        worstDirection = Math.max(worstDirection, direction);
        worstStepExcess = Math.max(worstStepExcess, maxStep - share * roll);
        worstRollLeft = Math.max(worstRollLeft, rollAfter1s);
        rowsNew.push(`${az}/${el}/Roll ${roll}: Richtung ${f(direction, 3)}° daneben, größter Schritt ${f(maxStep)}°, Roll nach 1 s ${f(rollAfter1s, 3)}°`);
      } else {
        worstHeadStep = Math.max(worstHeadStep, maxStep);
        rowsHead.push(`${f(maxStep, 1)}°`);
      }
    }
  }
  expect(
    'Richtung gehalten, kein Rollsprung',
    worstDirection < 0.05 && worstStepExcess < 0.05 && worstRollLeft < 0.1,
    `${rowsNew.join('; ')}. Grenze je Bild: 15 % des Rollwinkels. Fassung aus dem Commit: größter Schritt ${rowsHead.join(' / ')}`,
  );
}

/* --- C. Sofort weiterziehen --- */
console.log('C. Direkt nach dem Verlassen von AR ziehen');
{
  const rows: string[] = [];
  let worstLag = 0;
  let worstFrames = 0;
  for (const pixelsPerFrame of [4, 12, 25]) {
    resetShared();
    const w = makeWorld();
    const rig = new Rig(w);
    orientationState.quaternion.copy(cameraQuaternion(90, 30, 10));
    orientationState.available = true;
    rig.arEnabled = true;
    for (let i = 0; i < 120; i += 1) rig.step(DT);
    rig.arEnabled = false;
    orientationState.available = false;
    rig.step(DT);
    rig.step(DT);
    let x = 200;
    const y = 400;
    w.element.dispatch('pointerdown', pointer(x, y));
    let maxLag = 0;
    let activeFrames = 0;
    const lookAt = new PerspectiveCamera();
    for (let i = 0; i < 180; i += 1) {
      x += pixelsPerFrame;
      w.doc.dispatch('pointermove', pointer(x, y));
      rig.step(DT);
      lookAt.position.copy(w.camera.position);
      lookAt.up.set(0, 1, 0);
      lookAt.lookAt(0, 0, 0);
      const lag = lookAt.quaternion.angleTo(w.camera.quaternion) * RAD;
      if (i > 20) maxLag = Math.max(maxLag, lag);
      if (lag > 1e-3 * RAD) activeFrames = i + 1;
    }
    w.doc.dispatch('pointerup', pointer(x, y));
    worstLag = Math.max(worstLag, maxLag);
    worstFrames = Math.max(worstFrames, activeFrames);
    const rate = ((2 * Math.PI * pixelsPerFrame * 0.32) / 800) * 60 * RAD;
    rows.push(`${pixelsPerFrame} px/Bild (${f(rate, 0)}°/s): Abstand zur Touch-Lage ab 0,35 s ${f(maxLag)}°`);
  }
  expect(
    'Ziehen ohne Nachlauf',
    worstLag < 0.6 && worstFrames < 40,
    `${rows.join('; ')}; Übergabe sichtbar in höchstens ${worstFrames} Bildern (vorige Überarbeitung: 9,8° Nachlauf bei 104°/s)`,
  );
}

/* --- D. AR an → aus → an --- */
console.log('D. AR an, nach 5 Bildern aus, wieder an');
{
  resetShared();
  const w = makeWorld();
  const rig = new Rig(w);
  const sensor = cameraQuaternion(200, 50, 25);
  orientationState.quaternion.copy(sensor);
  orientationState.available = true;
  rig.arEnabled = true;
  for (let i = 0; i < 120; i += 1) rig.step(DT);
  rig.arEnabled = false;
  orientationState.available = false;
  for (let i = 0; i < 5; i += 1) rig.step(DT);
  rig.arEnabled = true;
  orientationState.available = true;
  let maxStep = 0;
  let previous = w.camera.quaternion.clone();
  for (let i = 0; i < 60; i += 1) {
    rig.step(DT);
    maxStep = Math.max(maxStep, previous.angleTo(w.camera.quaternion) * RAD);
    previous = w.camera.quaternion.clone();
  }
  const rest = w.camera.quaternion.angleTo(sensor) * RAD;
  const controlsOff = !w.controls.enabled;
  rig.arEnabled = false;
  orientationState.available = false;
  for (let i = 0; i < 120; i += 1) rig.step(DT);
  const direction = directionGap(sensor, w.camera.quaternion);
  expect(
    'Wechsel während der Übergabe',
    maxStep < 4 && rest < 0.01 && controlsOff && direction < 0.05,
    `größter Schritt ${f(maxStep)}°, Rest zum Sensor ${f(rest, 3)}°, OrbitControls ${controlsOff ? 'aus' : 'an'}; danach aus: Richtung ${f(direction, 3)}° neben der AR-Lage`,
  );
}

/* --- E. Fokusanfrage während AR --- */
console.log('E. Fokusanfrage während AR');
{
  const result: Record<string, string> = {};
  let newDirection = Infinity;
  let focusLeft = true;
  for (const kind of ['neu', 'HEAD'] as const) {
    resetShared();
    const w = makeWorld();
    const rig = kind === 'neu' ? new Rig(w) : new HeadRig(w);
    const sensor = cameraQuaternion(100, 30, 0);
    orientationState.quaternion.copy(sensor);
    orientationState.available = true;
    rig.arEnabled = true;
    for (let i = 0; i < 60; i += 1) rig.step(DT);
    rig.focus = { azimuth: 300 * DEG, elevation: 60 * DEG };
    for (let i = 0; i < 60; i += 1) rig.step(DT);
    rig.arEnabled = false;
    orientationState.available = false;
    for (let i = 0; i < 240; i += 1) rig.step(DT);
    const [az, el] = azimuthElevation(w.camera.quaternion);
    result[kind] = `Kurs ${f(az, 1)}°, Höhe ${f(el, 1)}°`;
    if (kind === 'neu') {
      newDirection = directionGap(sensor, w.camera.quaternion);
      focusLeft = rig.focus !== null;
    }
  }
  expect(
    'Anfrage verfällt, Blick bleibt bei der AR-Lage (100°/30°)',
    newDirection < 0.05 && !focusLeft,
    `neu ${result.neu}, Fassung aus dem Commit ${result.HEAD} (Anfrage 300°/60° schlug beim Verlassen zu)`,
  );
}

/* --- F. Einstieg in AR aus einer Touch-Ansicht unter dem Horizont --- */
console.log('F. AR einschalten, während die Touch-Ansicht 60° unter den Horizont blickt');
{
  // Touch darf unter den Horizont blicken, AR nicht. Die Sensorlage kommt schon
  // geklemmt an; der Zwischenschritt des Slerp beginnt aber unter dem Horizont
  // und muss im Rig selbst angehoben werden.
  resetShared();
  const w = makeWorld();
  const rig = new Rig(w);
  rig.focus = { azimuth: 30 * DEG, elevation: -60 * DEG };
  for (let i = 0; i < 300; i += 1) rig.step(DT);
  const [, before] = azimuthElevation(w.camera.quaternion);
  orientationState.quaternion.copy(cameraQuaternion(200, 20, 0));
  orientationState.available = true;
  rig.arEnabled = true;
  let lowest = Infinity;
  for (let i = 0; i < 60; i += 1) {
    rig.step(DT);
    lowest = Math.min(lowest, azimuthElevation(w.camera.quaternion)[1]);
  }
  expect(
    'AR bleibt über dem Horizont',
    before < -50 && lowest > -1e-3,
    `Touch-Ansicht ${f(before, 1)}°, tiefste AR-Ansicht ${f(lowest, 3)}°`,
  );
}

/* --- G. Auswahlring nach dem Verlassen von AR --- */
console.log('G. Auswahlring gegen die gezeigte Kamera, AR mit 15° Roll verlassen');
{
  resetShared();
  const w = makeWorld();
  const rig = new Rig(w);
  orientationState.quaternion.copy(cameraQuaternion(90, 30, 15));
  orientationState.available = true;
  rig.arEnabled = true;
  for (let i = 0; i < 120; i += 1) rig.step(DT);
  rig.arEnabled = false;
  orientationState.available = false;
  let atDraw = 0;
  let atFrame = 0;
  for (let i = 0; i < 60; i += 1) {
    rig.step(DT);
    atDraw = Math.max(atDraw, rig.ringAtDraw.angleTo(w.camera.quaternion) * RAD);
    atFrame = Math.max(atFrame, rig.ringAtFrame.angleTo(w.camera.quaternion) * RAD);
  }
  expect(
    'Ring folgt der gezeigten Lage',
    atDraw < 1e-4 && atFrame > 5,
    `beim Zeichnen ausgerichtet ${f(atDraw, 4)}°; im Frame-Takt vor CameraRig wären es bis ${f(atFrame)}° (Rollwinkel der Übergabe)`,
  );
}

resetShared();
console.log(`${checks} Prüfungen, ${failures} Fehlschläge`);
if (failures > 0) process.exit(1);
console.log('✓ Kameraführung verhält sich wie spezifiziert');
