/**
 * Prüft die Verdrahtung, die scripts/verify-rig.ts und
 * scripts/verify-orientation.ts nicht erreichen, weil sie die Bild- und
 * Eventlogik direkt aufrufen: wie CameraRig seine Bildfunktionen in den
 * Frame-Takt hängt und was der Effekt-Rumpf von useDeviceOrientation
 * anmeldet, abmeldet und zurücksetzt. Dazu, ob die Bahnspur aus OrbitTrail
 * tatsächlich gezeichnet würde: Objekt *und* Material sichtbar, gelesen in
 * dem Moment, in dem R3F `gl.render` aufruft (Abschnitt C).
 *
 * Dafür laufen die echten Komponenten im echten Renderer von React Three Fiber
 * (`createRoot`, `frameloop: 'never'`, Bilder per `advance`), mit dem echten
 * <OrbitControls> aus drei. WebGL braucht das nicht: R3F nimmt als Renderer
 * jedes Objekt mit `render()`, hier eines, das nichts zeichnet. Den Browser
 * ersetzen ein EventTarget als `window`, `screen` und eine eigene Uhr als
 * `performance`.
 *
 * Warum zur Laufzeit statt per Quelltextsuche: Geprüft wird, was R3F
 * tatsächlich registriert und in welcher Reihenfolge es die Bildfunktionen
 * ruft – auch eine Umstellung, die kein Suchmuster vorhersieht.
 *
 * Aufruf: npm run verify:wiring
 */
import { createElement, type FunctionComponent } from 'react';
import { act, advance, createRoot, type RootState } from '@react-three/fiber';
import { Euler, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { Line2 } from 'three-stdlib';
import type { StoreApi, UseBoundStore } from 'zustand';
import { CameraRig } from '../src/components/canvas/CameraRig';
import { OrbitTrail } from '../src/components/canvas/OrbitTrail';
import { useDeviceOrientation } from '../src/hooks/useDeviceOrientation';
import { DEG, RAD, angleDelta, normalizeAngle } from '../src/math/coords';
import { decimalYear, magneticDeclinationDeg } from '../src/math/declination';
import { arSmoothingFactor, attitudeToCamera } from '../src/math/orientation';
import { orientationState, trailState, viewState } from '../src/state/runtime';
import { useAppStore } from '../src/state/store';

// React prüft Updates nur innerhalb von act() synchron durch.
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

// drei <Line> legt seine Anfangsgeometrie aus `Vector3`-Punkten an und prüft
// sie per `instanceof`. Das esbuild-Bündel enthält three zweimal, die Prüfung
// schlägt fehl, und three meldet beim Einhängen einen NaN-Radius (wie in
// scripts/verify-selection.ts). OrbitTrail überschreibt die Geometrie mit der
// ersten Spur; im Vite-Build gibt es nur ein three.
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (first.startsWith('THREE.LineSegmentsGeometry.computeBoundingSphere')) return;
  consoleError(...args);
};

const f = (value: number, digits = 2): string => value.toFixed(digits).replace('.', ',');
const wrap180 = (deg: number): number => angleDelta(deg * DEG, 0) * RAD;
const DT = 1 / 60;
const PERIOD_MS = 1000 / 60;

/* --- Renderer ohne WebGL --- */

/** Zeigerereignisse für OrbitControls und die Pinch-Listener von CameraRig. */
class FakeTarget {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
}

type Store = UseBoundStore<StoreApi<RootState>>;

/**
 * Hängt `component` in eine eigene R3F-Wurzel; Bilder laufen nur über
 * `frame()`. `onRender` läuft bei jedem `gl.render` – nach allen
 * Bildfunktionen, also mit dem Stand, der gezeichnet würde.
 */
async function mount(
  component: FunctionComponent,
  camera = new PerspectiveCamera(70, 0.5, 0.01, 2000),
  onRender: () => void = () => {},
) {
  const element = Object.assign(new FakeTarget(), {
    style: {},
    clientWidth: 400,
    clientHeight: 800,
    ownerDocument: new FakeTarget(),
    setPointerCapture() {},
    releasePointerCapture() {},
  });
  // R3F erkennt einen fertigen Renderer an `render`; gezeichnet wird nichts.
  const gl = { domElement: element, render: onRender, setSize() {}, setPixelRatio() {} };
  const root = createRoot({} as HTMLCanvasElement);
  let store: Store | null = null;
  await act(async () => {
    await root.configure({
      gl: gl as never,
      camera,
      size: { width: 400, height: 800, top: 0, left: 0 },
      frameloop: 'never',
      dpr: 1,
    });
    store = root.render(createElement(component));
  });
  const mounted = store as Store | null;
  if (!mounted) throw new Error('R3F-Wurzel ohne Store');
  let timeS = 0;
  return {
    camera,
    store: mounted,
    /** Ein Bild des Frame-Takts: alle useFrame-Abonnenten in der Reihenfolge von R3F. */
    frame(): void {
      timeS += DT;
      advance(timeS, true, mounted.getState());
    },
    unmount: () => act(async () => root.unmount()),
  };
}

const setStore = (partial: Parameters<typeof useAppStore.setState>[0]) => act(async () => useAppStore.setState(partial));

/* --- Winkel --- */

/** Kamera-Quaternion aus Blickkurs, Blickhöhe und Bildrollwinkel (Szene: −Z Nord, +X Ost, +Y Zenit). */
const cameraQuaternion = (azimuthDeg: number, elevationDeg: number, rollDeg: number): Quaternion =>
  new Quaternion().setFromEuler(new Euler(elevationDeg * DEG, -azimuthDeg * DEG, rollDeg * DEG, 'YXZ'));

function azimuthElevation(q: Quaternion): [number, number] {
  const forward = new Vector3(0, 0, -1).applyQuaternion(q);
  return [
    normalizeAngle(Math.atan2(forward.x, -forward.z)) * RAD,
    Math.atan2(forward.y, Math.hypot(forward.x, forward.z)) * RAD,
  ];
}

/** Bildrollwinkel: Bild-oben gegen die Projektion des Zenits auf die Bildebene. */
function rollOf(q: Quaternion): number {
  const forward = new Vector3(0, 0, -1).applyQuaternion(q);
  const up = new Vector3(0, 1, 0).applyQuaternion(q);
  const right = new Vector3(1, 0, 0).applyQuaternion(q);
  const zenith = new Vector3(0, 1, 0).addScaledVector(forward, -forward.y);
  return Math.atan2(zenith.dot(right), zenith.dot(up)) * RAD;
}

/* --- A. CameraRig im Frame-Takt von R3F --- */
console.log('A. CameraRig im echten Frame-Takt: Moduswechsel vor OrbitControls.update()');
{
  // Wie verify-rig Abschnitt B, aber mit den Funktionen, die CameraRig selbst
  // per useFrame anmeldet, und der Reihenfolge, in der R3F sie ruft. Hängt der
  // Moduswechsel hinter dem drei-Wrapper (Priorität fehlt oder vertauscht),
  // richtet OrbitControls die Kamera ein Bild nach dem Verlassen von AR per
  // lookAt aus: Der ganze Rollwinkel springt in einem Bild (gemessen 15°, 20°
  // bzw. 90°) statt mit 15 % je Bild abzuklingen.
  const share = arSmoothingFactor(DT);
  const rows: string[] = [];
  let ok = true;
  let order = '';
  for (const [az, el, roll] of [
    [120, 40, 15],
    [250, 80, 20],
    [10, 5, 90],
  ]) {
    orientationState.available = false;
    orientationState.quaternion.identity();
    viewState.focus = null;
    await setStore({ arEnabled: false });
    const rig = await mount(CameraRig);
    order = rig.store
      .getState()
      .internal.subscribers.map((s) => s.priority)
      .join(', ');
    for (let i = 0; i < 30; i += 1) rig.frame();

    const sensor = cameraQuaternion(az, el, roll);
    orientationState.quaternion.copy(sensor);
    orientationState.available = true;
    await setStore({ arEnabled: true });
    for (let i = 0; i < 180; i += 1) rig.frame();
    const followed = rig.camera.quaternion.angleTo(sensor) * RAD;
    const controlsOff = rig.store.getState().controls !== null && !(rig.store.getState().controls as { enabled: boolean }).enabled;

    // Verlassen wie im Betrieb: Store aus, der Hook setzt `available` zurück.
    const shown = rig.camera.quaternion.clone();
    await setStore({ arEnabled: false });
    orientationState.available = false;
    let maxStep = 0;
    let rollAfter1s = NaN;
    let previous = shown.clone();
    for (let i = 0; i < 120; i += 1) {
      rig.frame();
      maxStep = Math.max(maxStep, previous.angleTo(rig.camera.quaternion) * RAD);
      previous = rig.camera.quaternion.clone();
      if (i === 59) rollAfter1s = Math.abs(rollOf(rig.camera.quaternion));
    }
    const [azShown, elShown] = azimuthElevation(shown);
    const [azNow, elNow] = azimuthElevation(rig.camera.quaternion);
    const direction = Math.max(Math.abs(wrap180(azNow - azShown)), Math.abs(elNow - elShown));
    ok &&= followed < 0.01 && controlsOff && maxStep < share * roll + 0.05 && rollAfter1s < 0.1 && direction < 0.05;
    rows.push(`Roll ${roll}°: größter Schritt ${f(maxStep)}° (Grenze ${f(share * roll + 0.05)}°), Roll nach 1 s ${f(rollAfter1s, 3)}°, Richtung ${f(direction, 3)}° daneben`);
    await rig.unmount();
  }
  expect(
    'Übergabe AR → Touch über die registrierten Bildfunktionen',
    ok,
    `Prioritäten im Frame-Takt ${order} (CameraRig −2, drei-Wrapper −1, CameraRig 0); ${rows.join('; ')}; in AR folgt die Kamera dem Sensor, OrbitControls aus`,
  );
}

/* --- Sensormodell (wie scripts/verify-orientation.ts, ohne three.js) --- */

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
/** Kamerakurs h (Uhrzeigersinn ab geografisch Nord), Blickhöhe e, Bildrollwinkel r, Grad. Gerät → Welt (x Ost, y Nord, z oben). */
const pose = (h: number, e: number, r = 0): Matrix => multiply(multiply(rotZ(-h * DEG), rotX((90 + e) * DEG)), rotZ(r * DEG));

/** W3C-Zerlegung in Grad wie in WebKit (WebCoreMotionManager.mm), alpha in [0, 360). */
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
  } else {
    z = Math.atan2(m[3], m[0]);
    x = m[7] > 0 ? Math.PI / 2 : -Math.PI / 2;
    y = 0;
  }
  return [(z > 0 ? z : 2 * Math.PI + z) * RAD, x * RAD, y * RAD];
}

/** Kurs der Rückkamera; ohne Rollwinkel gleich −alpha, beide Deutungen von `webkitCompassHeading` fallen zusammen. */
const cameraHeadingDeg = (m: Matrix): number => Math.atan2(-m[2], -m[5]) * RAD;

const SCENE_FROM_ENU: Matrix = [1, 0, 0, 0, 0, 1, 0, -1, 0];
const ENU_FROM_SCENE: Matrix = [1, 0, 0, 0, 0, -1, 0, 1, 0];
/** Wahre Kameralage einer physischen Lage, unabhängig von eulerToAttitude. */
function truthCamera(m: Matrix, screenAngleDeg = 0): Quaternion {
  const s = multiply(multiply(SCENE_FROM_ENU, m), ENU_FROM_SCENE);
  const q = new Quaternion().setFromRotationMatrix(
    new Matrix4().set(s[0], s[1], s[2], 0, s[3], s[4], s[5], 0, s[6], s[7], s[8], 0, 0, 0, 0, 1),
  );
  return attitudeToCamera(q, q, screenAngleDeg * DEG);
}

/** DeviceOrientationEvent gibt es in Node nicht: echtes `Event` mit den Feldern als Getter wie im Browser. */
class TestOrientationEvent extends Event {
  constructor(
    type: string,
    readonly alpha: number,
    readonly beta: number,
    readonly gamma: number,
    readonly absolute: boolean,
    compass?: { heading: number; accuracy: number },
  ) {
    super(type);
    if (compass) {
      Object.defineProperty(this, 'webkitCompassHeading', { get: () => ((compass.heading % 360) + 360) % 360 });
      Object.defineProperty(this, 'webkitCompassAccuracy', { get: () => compass.accuracy });
    }
  }
}

/** iOS: `deviceorientation` relativ zum Kreiselnullpunkt, Kurs magnetisch (Wahrheit minus Deklination). */
function iosEvent(m: Matrix, declinationDeg: number): TestOrientationEvent {
  const [, beta, gamma] = w3cEuler(m);
  const [alpha] = w3cEuler(multiply(rotZ(137 * DEG), m));
  return new TestOrientationEvent('deviceorientation', alpha, beta, gamma, false, {
    heading: cameraHeadingDeg(m) - declinationDeg,
    accuracy: 10,
  });
}

/** Android: relativer Kreisel auf `deviceorientation`, magnetisch erdfest auf `deviceorientationabsolute`. */
function androidEvents(m: Matrix, declinationDeg: number): TestOrientationEvent[] {
  const [alpha, beta, gamma] = w3cEuler(multiply(rotZ(137 * DEG), m));
  const [alphaAbsolute, betaAbsolute, gammaAbsolute] = w3cEuler(multiply(rotZ(declinationDeg * DEG), m));
  return [
    new TestOrientationEvent('deviceorientation', alpha, beta, gamma, false),
    new TestOrientationEvent('deviceorientationabsolute', alphaAbsolute, betaAbsolute, gammaAbsolute, true),
  ];
}

/* --- B. useDeviceOrientation: Effekt-Rumpf --- */
console.log('B. useDeviceOrientation im echten Effekt: Deklination, Bildschirmdrehung, Abmelden, Zurücksetzen');

/**
 * `window` des Hooks: echtes EventTarget, zählt die angemeldeten Listener.
 * Timer laufen nicht – die Warnung „Keine Sensordaten“ nach 2,5 s prüft hier
 * nichts, ebenso wenig die Nachführung der Bahnspur in Abschnitt C.
 */
class FakeWindow extends EventTarget {
  readonly DeviceOrientationEvent = class {};
  orientation: number | undefined = undefined;
  private readonly attached = new Set<string>();
  private readonly ids = new WeakMap<object, number>();
  private nextId = 1;

  get listenerCount(): number {
    return this.attached.size;
  }

  private key(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): string {
    if (listener && !this.ids.has(listener)) this.ids.set(listener, this.nextId++);
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    return `${type}|${listener ? this.ids.get(listener) : 0}|${capture}`;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    this.attached.add(this.key(type, listener, options));
    super.addEventListener(type, listener, options);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    this.attached.delete(this.key(type, listener, options));
    super.removeEventListener(type, listener, options);
  }

  setTimeout(): number {
    return 0;
  }

  clearTimeout(): void {}

  setInterval(): number {
    return 0;
  }

  clearInterval(): void {}
}

const fakeWindow = new FakeWindow();
const fakeScreen: { orientation?: { angle: number } } = { orientation: { angle: 0 } };
let clockMs = 0;
// Nur `now` läuft auf der eigenen Uhr; alles andere (React misst im
// Entwicklungsbuild mit `performance.measure`) geht an das echte Objekt.
const realPerformance = globalThis.performance;
const fakePerformance = new Proxy(realPerformance, {
  get(target, property) {
    if (property === 'now') return () => clockMs;
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
// Erst jetzt ersetzen: React und R3F haben ihre Uhr und ihre Umgebung beim
// Laden gelesen; der Hook liest `window`, `screen` und `performance` bei jedem
// Aufruf.
for (const [name, value] of [
  ['window', fakeWindow],
  ['screen', fakeScreen],
  ['performance', fakePerformance],
] as const) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function Probe(): null {
  useDeviceOrientation();
  return null;
}

/** Schickt Events im 60-Hz-Takt an `window`; die Uhr läuft vom jetzigen Stand weiter, mehrere Events eines Takts 8 ms versetzt. */
function dispatchFor(seconds: number, events: (i: number) => Event[]): void {
  const startMs = clockMs;
  for (let i = 0; i < Math.round(seconds * 60); i += 1) {
    events(i).forEach((event, j) => {
      clockMs = startMs + i * PERIOD_MS + j * 8;
      fakeWindow.dispatchEvent(event);
    });
  }
  clockMs = startMs + seconds * 1000;
}

const headingError = (m: Matrix): number => Math.abs(wrap180(orientationState.headingDeg - cameraHeadingDeg(m)));

{
  // a) Deklination im Betrieb verdrahtet: Der Hook reicht den Standort aus dem
  //    Store an die Fusion. Ohne sie (Fehlerklasse M1, zweimal dagewesen) zeigt
  //    iOS in Seattle 15,0° daneben, Android in Kapstadt 26,8° (WMM2025, heute).
  const places = [
    ['iOS, Seattle', { latitudeDeg: 47.6062, longitudeDeg: -122.3321, altitudeKm: 0.05 }, 'ios'],
    ['Android, Kapstadt', { latitudeDeg: -33.9249, longitudeDeg: 18.4241, altitudeKm: 0.02 }, 'android'],
  ] as const;
  const rows: string[] = [];
  let worst = 0;
  const probe = await mount(Probe);
  for (const [label, observer, platform] of places) {
    const declination = magneticDeclinationDeg(observer.latitudeDeg, observer.longitudeDeg, observer.altitudeKm, decimalYear(new Date()));
    await setStore({ observer, arEnabled: true });
    const m = pose(150, 30);
    dispatchFor(1.5, () => (platform === 'ios' ? [iosEvent(m, declination)] : androidEvents(m, declination)));
    const error = headingError(m);
    const attitude = orientationState.quaternion.angleTo(truthCamera(m)) * RAD;
    worst = Math.max(worst, error, attitude);
    rows.push(`${label} (Deklination ${f(declination, 1)}°): Kursfehler ${f(error)}°, Lagefehler ${f(attitude)}°`);
    await setStore({ arEnabled: false });
  }
  expect('Deklination aus dem Standort erreicht die Fusion', worst < 0.5, rows.join('; '));

  // b) Bildschirmdrehung: Querformat gegen den Uhrzeigersinn (Winkel 90°) über
  //    `screen.orientation.angle` und über das ältere `window.orientation`.
  //    Mit falschem Vorzeichen stünde das Bild auf dem Kopf (180° Roll).
  await setStore({ observer: null });
  const landscape = pose(200, 35, 90);
  const screenRows: string[] = [];
  let screenOk = true;
  for (const [label, useLegacy] of [
    ['screen.orientation', false],
    ['window.orientation', true],
  ] as const) {
    fakeScreen.orientation = useLegacy ? undefined : { angle: 90 };
    fakeWindow.orientation = useLegacy ? 90 : undefined;
    await setStore({ arEnabled: true });
    dispatchFor(1, () => androidEvents(landscape, 0));
    const roll = rollOf(orientationState.quaternion);
    const error = headingError(landscape);
    const attitude = orientationState.quaternion.angleTo(truthCamera(landscape, 90)) * RAD;
    screenOk &&= orientationState.screenAngle === 90 * DEG && Math.abs(roll) < 0.01 && error < 0.01 && attitude < 0.01;
    screenRows.push(`${label}: Bildschirmwinkel ${f(orientationState.screenAngle * RAD, 1)}°, Bildrollwinkel ${f(roll, 3)}°, Kursfehler ${f(error, 3)}°`);
    await setStore({ arEnabled: false });
  }
  fakeScreen.orientation = { angle: 0 };
  fakeWindow.orientation = undefined;
  expect('Querformat über den Hook', screenOk, screenRows.join('; '));

  // c) AR aus: Listener abgemeldet, spätere Events ohne Wirkung. Sonst
  //    schriebe der alte Handler weiter in `orientationState` und setzte
  //    `available` wieder auf true – CameraRig ginge ohne Nutzerwunsch in AR.
  await setStore({ arEnabled: true });
  const attachedOn = fakeWindow.listenerCount;
  dispatchFor(0.5, () => androidEvents(pose(80, 30), 0));
  const availableOn = orientationState.available;
  await setStore({ arEnabled: false });
  const attachedOff = fakeWindow.listenerCount;
  const before = orientationState.quaternion.clone();
  dispatchFor(0.5, () => [...androidEvents(pose(300, 50), 0), iosEvent(pose(300, 50), 0)]);
  const detached = !orientationState.available && orientationState.quaternion.equals(before);
  expect(
    'AR aus: Listener abgemeldet',
    attachedOn === 2 && availableOn && attachedOff === 0 && detached,
    `angemeldet ${attachedOn} (erwartet 2: deviceorientationabsolute, deviceorientation), danach ${attachedOff}; Events nach dem Beenden ${detached ? 'ohne Wirkung' : 'noch verarbeitet'}`,
  );

  // d) Aushängen bei laufendem AR (z. B. Seitenwechsel): Nur hier läuft allein
  //    das Aufräumen ohne neuen Effekt-Durchlauf, der `available` ohnehin
  //    zurücksetzt. Bliebe es true, hielte CameraRig AR mit eingefrorener Lage.
  await setStore({ arEnabled: true });
  dispatchFor(0.5, () => androidEvents(pose(80, 30), 0));
  const availableBefore = orientationState.available;
  await probe.unmount();
  const availableAfter = orientationState.available;
  const attachedAfter = fakeWindow.listenerCount;
  expect(
    'Aushängen bei laufendem AR',
    availableBefore && !availableAfter && attachedAfter === 0,
    `available vorher ${availableBefore}, nach dem Aushängen ${availableAfter}; Listener danach ${attachedAfter}`,
  );
  await setStore({ arEnabled: false });
}

/* --- C. OrbitTrail: Ist die Bahnspur beim Zeichnen sichtbar? --- */
console.log('C. OrbitTrail: Objekt und Material der Bahnspur beim Zeichnen sichtbar');
{
  // Anlass: OrbitTrail gab `visible={false}` als Prop an drei <Line>. drei
  // reicht es auch an das LineMaterial weiter; `material.visible` blieb false,
  // und das in useFrame gesetzte `line.visible = true` erzeugte nie einen
  // Draw-Call (Commit e49bcde). Eine Prüfung nur von `line.visible` sieht das
  // nicht. Hier wird bei jedem `gl.render` gelesen, was R3F zeichnen würde:
  // Objekt und Material sichtbar, und nie die Platzhalterpunkte im Nadir.
  //
  // Ohne Worker-Pool: `engine.requestTrail` findet keinen Pool und schickt
  // nichts; die Antwort des Shards wird in `trailState` geschrieben wie vom
  // Hook (useSatelliteEngine.ts, Fall 'trail').
  const SAMPLES = 220;
  const ID = '25544';
  /** Spur über dem Horizont: Höhe 20° … 60°, Azimut 100° … 250°. */
  const trailPoints = (): Float32Array => {
    const points = new Float32Array(SAMPLES * 3);
    for (let i = 0; i < SAMPLES; i += 1) {
      const az = (100 + (150 * i) / (SAMPLES - 1)) * DEG;
      const el = (20 + 40 * Math.sin((Math.PI * i) / (SAMPLES - 1))) * DEG;
      points[i * 3] = Math.cos(el) * Math.sin(az);
      points[i * 3 + 1] = Math.sin(el);
      points[i * 3 + 2] = -Math.cos(el) * Math.cos(az);
    }
    return points;
  };
  const deliver = () => {
    trailState.noradId = ID;
    trailState.points = trailPoints();
    trailState.timeMs = Date.now();
    trailState.version += 1;
  };

  let store: Store | null = null;
  const findLine = (): Line2 | null => {
    let line: Line2 | null = null;
    store?.getState().scene.traverse((object) => {
      if ((object as Line2).isLine2) line = object as Line2;
    });
    return line;
  };
  /** Je `gl.render`: Linie da? Objekt, Material sichtbar? Höhe des ersten Punkts (NaN ohne Linie). */
  let renders: Array<{ line: boolean; visible: boolean; material: boolean; firstY: number }> = [];
  const trail = await mount(OrbitTrail, undefined, () => {
    const line = findLine();
    const start = line?.geometry.getAttribute('instanceStart') as { data: { array: Float32Array } } | undefined;
    renders.push({
      line: line !== null,
      visible: line?.visible === true,
      material: line !== null && (line.material as { visible: boolean }).visible,
      firstY: start ? start.data.array[1] : Number.NaN,
    });
  });
  store = trail.store;
  /** Liefert die seit dem letzten Aufruf gesammelten Bilder und beginnt neu. */
  const take = () => {
    const list = renders;
    renders = [];
    return list;
  };
  const drawn = (list: typeof renders) => list.filter((r) => r.line && r.visible && r.material);
  const placeholder = (list: typeof renders) => drawn(list).filter((r) => !(r.firstY > 0));

  // 1. Auswahl ohne Spur: Die Linie hängt, wird aber nie gezeichnet.
  await setStore({ showTrails: true });
  await act(async () => useAppStore.getState().select(ID));
  take();
  for (let i = 0; i < 5; i += 1) trail.frame();
  const waiting = take();
  // 2. Spur trifft ein.
  deliver();
  for (let i = 0; i < 3; i += 1) trail.frame();
  const arrived = take();
  // 3. Spuren aus und wieder an; die Antwort trifft vor dem ersten Bild nach
  //    dem Wiedereinhängen ein. Die neue Linie erscheint dann gleich im ersten
  //    Bild – mit den Punkten der Spur, nie mit den Platzhaltern.
  await setStore({ showTrails: false });
  trail.frame();
  take();
  await setStore({ showTrails: true });
  deliver();
  for (let i = 0; i < 3; i += 1) trail.frame();
  const remounted = take();
  // 4. Abwählen und neu wählen: bis zur neuen Spur nichts zu sehen.
  await act(async () => useAppStore.getState().select(null));
  trail.frame();
  take();
  await act(async () => useAppStore.getState().select(ID));
  for (let i = 0; i < 5; i += 1) trail.frame();
  const reselected = take();
  await trail.unmount();
  await act(async () => useAppStore.getState().select(null));

  const lastArrived = arrived[arrived.length - 1];
  expect(
    'Bahnspur wird gezeichnet: Objekt und Material sichtbar',
    waiting.length === 5 && waiting.every((r) => r.line) && drawn(waiting).length === 0 &&
      lastArrived !== undefined && lastArrived.visible && lastArrived.material && placeholder(arrived).length === 0,
    `vor der Spur ${drawn(waiting).length} von ${waiting.length} Bildern gezeichnet (Linie eingehängt: ` +
      `${waiting.every((r) => r.line) ? 'ja' : 'nein'}); nach der Spur line.visible ${lastArrived?.visible}, ` +
      `material.visible ${lastArrived?.material}, erster Punkt bei y = ${f(lastArrived?.firstY ?? Number.NaN, 1)} (über dem Horizont)`,
  );
  expect(
    'Nach Wiedereinhängen nie die Platzhalter im Nadir',
    placeholder(remounted).length === 0 && drawn(remounted).length === remounted.length && remounted.length === 3 &&
      reselected.length === 5 && drawn(reselected).length === 0,
    `Spuren aus/an mit eingetroffener Spur: ${drawn(remounted).length} von ${remounted.length} Bildern gezeichnet, ` +
      `${placeholder(remounted).length} davon mit Platzhaltern; neu gewählt ohne Spur: ` +
      `${drawn(reselected).length} von ${reselected.length} gezeichnet`,
  );
}

console.log(`${checks} Prüfungen, ${failures} Fehlschläge`);
if (failures > 0) process.exit(1);
console.log('✓ Verdrahtung verhält sich wie spezifiziert');
// Der Scheduler von React hält den Prozess sonst offen.
process.exit(0);
