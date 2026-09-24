/**
 * Prüft die Tap-Erkennung von TapPicker – ohne Browser, ohne DOM.
 *
 * Importiert dieselbe Datei wie TapPicker.tsx (src/components/canvas/tapTracker.ts),
 * keine nachgebaute Kopie der Logik. Zwei Ebenen:
 *
 *  A. Zustandsmaschine (processPointerEvent): Tap, Zwei-Finger-Geste, verlorenes
 *     pointerup, zu lange/zu weite Geste, pointercancel, pointerup ohne pointerdown.
 *  B. Verdrahtung (registerTapListeners): ein winziges Ereignis-Modell mit Bubbling vom
 *     Canvas zum window (wie im echten DOM, s. Begründung in tapTracker.ts) hängt die
 *     ECHTE Verdrahtung daran und zählt, wie oft der Tap-Handler pro physischem Tap
 *     läuft – deckt Doppel-Feuern auf, das Ebene A strukturell nicht sehen kann, weil
 *     dort kein Event-Objekt und kein Bubbling existiert.
 *
 * Aufruf: npm run verify:tappicker
 */
import {
  createTapTrackerState,
  processPointerEvent,
  registerTapListeners,
  TAP_DURATION_MS,
  TAP_MOVE_TOLERANCE_PX,
  type TapPointerEvent,
  type TapPointerEventType,
} from '../src/components/canvas/tapTracker';

let checks = 0;
let failures = 0;

function test(label: string, condition: boolean): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  ✗ ${label}`);
  }
}

const baseTime = 1000;

/* ------------------------------------------------------------------ */
/* A. Zustandsmaschine (processPointerEvent)                            */
/* ------------------------------------------------------------------ */

/* Test A1: Einfacher Tap wird erkannt */
{
  const state = createTapTrackerState();
  const down = processPointerEvent(
    { type: 'pointerdown', pointerId: 1, clientX: 100, clientY: 200, timeStamp: baseTime },
    state,
  );
  test('A1: pointerdown nicht als Tap erkannt', !down);
  test('A1: active Menge hat ID 1', state.active.has(1));

  const up = processPointerEvent(
    { type: 'pointerup', pointerId: 1, clientX: 100, clientY: 200, timeStamp: baseTime + 100 },
    state,
  );
  test('A1: pointerup als Tap erkannt', up);
  test('A1: active Menge leer nach pointerup', state.active.size === 0);
}

/* Test A2: Zwei-Finger-Geste wird nicht als Tap erkannt (Schwelle active.size > 1) */
{
  const state = createTapTrackerState();
  processPointerEvent(
    { type: 'pointerdown', pointerId: 1, clientX: 100, clientY: 200, timeStamp: baseTime },
    state,
  );
  test('A2: erster Finger – hadMultiTouch false', !state.hadMultiTouch);

  processPointerEvent(
    { type: 'pointerdown', pointerId: 2, clientX: 150, clientY: 250, timeStamp: baseTime + 50 },
    state,
  );
  test('A2: zweiter Finger – hadMultiTouch true', state.hadMultiTouch);
  test('A2: zweiter Finger – active.size = 2', state.active.size === 2);

  const upFirst = processPointerEvent(
    { type: 'pointerup', pointerId: 1, clientX: 100, clientY: 200, timeStamp: baseTime + 100 },
    state,
  );
  test('A2: erster Finger hoch – kein Tap', !upFirst);

  const upSecond = processPointerEvent(
    { type: 'pointerup', pointerId: 2, clientX: 150, clientY: 250, timeStamp: baseTime + 150 },
    state,
  );
  test('A2: zweiter Finger hoch – kein Tap (hadMultiTouch)', !upSecond);
}

/* Test A3: Verlorenes pointerup – pointercancel räumt die ID trotzdem auf, ein neuer
 * Tap ist danach wieder möglich (der ursprüngliche Fehler: ein verlorenes Event ließ
 * den Zähler dauerhaft zu hoch stehen). */
{
  const state = createTapTrackerState();
  processPointerEvent(
    { type: 'pointerdown', pointerId: 1, clientX: 100, clientY: 200, timeStamp: baseTime },
    state,
  );
  processPointerEvent(
    { type: 'pointercancel', pointerId: 1, clientX: 100, clientY: 200, timeStamp: baseTime + 100 },
    state,
  );
  test('A3: pointercancel räumt active Menge (Mutant: active.delete entfernt)', state.active.size === 0);

  const tapAfter = processPointerEvent(
    { type: 'pointerdown', pointerId: 2, clientX: 50, clientY: 50, timeStamp: baseTime + 500 },
    state,
  );
  test('A3: neuer Tap – pointerdown nicht als Tap', !tapAfter);
  test('A3: neuer Tap – hadMultiTouch zurückgesetzt', !state.hadMultiTouch);

  const tapUp = processPointerEvent(
    { type: 'pointerup', pointerId: 2, clientX: 50, clientY: 50, timeStamp: baseTime + 600 },
    state,
  );
  test('A3: neuer Tap nach Cancel wird erkannt', tapUp);
}

/* Test A4: Zu lange Geste ist kein Tap */
{
  const state = createTapTrackerState();
  processPointerEvent(
    { type: 'pointerdown', pointerId: 1, clientX: 100, clientY: 200, timeStamp: baseTime },
    state,
  );
  const tap = processPointerEvent(
    {
      type: 'pointerup',
      pointerId: 1,
      clientX: 100,
      clientY: 200,
      timeStamp: baseTime + TAP_DURATION_MS + 1,
    },
    state,
  );
  test('A4: zu lange Geste – kein Tap', !tap);
}

/* Test A5: Zu weit bewegter Tap ist kein Tap */
{
  const state = createTapTrackerState();
  processPointerEvent(
    { type: 'pointerdown', pointerId: 1, clientX: 100, clientY: 200, timeStamp: baseTime },
    state,
  );
  const tap = processPointerEvent(
    {
      type: 'pointerup',
      pointerId: 1,
      clientX: 100 + TAP_MOVE_TOLERANCE_PX + 1,
      clientY: 200,
      timeStamp: baseTime + 100,
    },
    state,
  );
  test('A5: zu weit bewegter Tap – kein Tap', !tap);
}

/* Test A6: pointerup eines Zeigers, der nicht auf dem Canvas begonnen hat (etwa ein
 * Klick auf einen HUD-Knopf, dessen pointerup über window ankommt), ist kein Tap –
 * auch nicht kurz nach einem Canvas-Tap an derselben Stelle mit derselben pointerId. */
{
  const state = createTapTrackerState();
  processPointerEvent(
    { type: 'pointerdown', pointerId: 1, clientX: 100, clientY: 200, timeStamp: baseTime },
    state,
  );
  const first = processPointerEvent(
    { type: 'pointerup', pointerId: 1, clientX: 100, clientY: 200, timeStamp: baseTime + 50 },
    state,
  );
  test('A6: Canvas-Tap erkannt', first);
  const stray = processPointerEvent(
    { type: 'pointerup', pointerId: 1, clientX: 102, clientY: 201, timeStamp: baseTime + 200 },
    state,
  );
  test('A6: pointerup ohne pointerdown auf dem Canvas ist kein Tap', !stray);
}

/* ------------------------------------------------------------------ */
/* B. Verdrahtung (registerTapListeners) mit einem Bubbling-Modell      */
/* ------------------------------------------------------------------ */

/** Knoten des Minimal-Ereignismodells: sammelt Listener wie ein echtes EventTarget.
 * Signatur exakt wie TapEventSource aus tapTracker.ts, damit FakeNode dort ohne
 * Zusatzannahmen über Parameter-Varianz eingesetzt werden kann. */
class FakeNode {
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  addEventListener(type: string, listener: (event: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  /** Ruft alle an diesem Knoten registrierten Listener für `type` auf. */
  fire(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** Baut ein Objekt, das sich wie das für die Tap-Logik relevante Teil eines
 * PointerEvent liest – dieselbe Referenz wird bei einem bubbelnden Ereignis an
 * Canvas UND window übergeben, damit ein WeakSet-Dedup darauf greifen kann. Als
 * `Event` getarnt: registerTapListeners liest ohnehin nur pointerId/clientX/clientY/
 * timeStamp per Cast heraus, echte DOM-Event-Methoden braucht das Modell nicht. */
function makeRawPointerEvent(pointerId: number, clientX: number, clientY: number, timeStamp: number): Event {
  return { pointerId, clientX, clientY, timeStamp } as unknown as Event;
}

/**
 * Simuliert ein physisches pointerdown/pointerup/pointercancel, das am Canvas
 * beginnt und – weil OrbitControls laut tapTracker.ts kein stopPropagation() ruft –
 * bis zum window blubbert: dieselbe Ereignis-Referenz erreicht beide Knoten.
 */
function dispatchOnCanvasBubbling(
  canvas: FakeNode,
  win: FakeNode,
  type: TapPointerEventType,
  pointerId: number,
  clientX: number,
  clientY: number,
  timeStamp: number,
): void {
  const raw = makeRawPointerEvent(pointerId, clientX, clientY, timeStamp);
  canvas.fire(type, raw);
  win.fire(type, raw);
}

/**
 * Simuliert ein Loslassen außerhalb des Canvas: Nur window bekommt das Ereignis,
 * der Canvas-Listener sieht nichts (kein Bubbling zu einem Knoten, der nie Ziel war).
 */
function dispatchOutsideCanvas(
  win: FakeNode,
  type: TapPointerEventType,
  pointerId: number,
  clientX: number,
  clientY: number,
  timeStamp: number,
): void {
  win.fire(type, makeRawPointerEvent(pointerId, clientX, clientY, timeStamp));
}

function setupWiring() {
  const canvas = new FakeNode();
  const win = new FakeNode();
  let tapCount = 0;
  const tapEvents: TapPointerEvent[] = [];
  const unregister = registerTapListeners(canvas, win, (event) => {
    tapCount += 1;
    tapEvents.push(event);
  });
  return { canvas, win, unregister, tapEvents, getTapCount: () => tapCount };
}

/* Test B1: normaler Tap (Finger bleibt auf dem Canvas) löst select() genau einmal
 * aus – Mutant "Handler doppelt registriert" (pointerup zusätzlich ohne Dedup am
 * Canvas UND window verarbeitet) würde hier auf 2 kommen. */
{
  const { canvas, win, unregister, getTapCount } = setupWiring();
  dispatchOnCanvasBubbling(canvas, win, 'pointerdown', 1, 100, 200, baseTime);
  dispatchOnCanvasBubbling(canvas, win, 'pointerup', 1, 100, 200, baseTime + 50);
  test('B1: Tap auf dem Canvas löst Handler genau einmal aus', getTapCount() === 1);
  unregister();
}

/* Test B2: Finger wird knapp außerhalb des Canvas losgelassen (kein Bubbling zum
 * Canvas möglich, da das Ereignis dort nie ankommt) – window allein fängt es auf
 * und wertet es trotzdem als Tap, weil die Bewegung innerhalb der Toleranz bleibt.
 * Genau das war der ursprüngliche Fehler: ohne window-Listener bliebe active.size
 * hier auf 1 stehen und JEDER folgende Tap gälte fälschlich als Mehrfinger-Geste.
 * Mutant "window-Listener für pointerup entfernt" fängt sich hier zweimal: weder
 * dieser Tap noch der nächste würden erkannt. */
{
  const { canvas, win, unregister, getTapCount } = setupWiring();
  dispatchOnCanvasBubbling(canvas, win, 'pointerdown', 1, 100, 200, baseTime);
  dispatchOutsideCanvas(win, 'pointerup', 1, 105, 205, baseTime + 50);
  test('B2: außerhalb (aber innerhalb der Toleranz) losgelassener Finger ist ein Tap', getTapCount() === 1);

  dispatchOnCanvasBubbling(canvas, win, 'pointerdown', 2, 50, 50, baseTime + 500);
  dispatchOnCanvasBubbling(canvas, win, 'pointerup', 2, 50, 50, baseTime + 550);
  test('B2: nächster Tap funktioniert (kein hängengebliebener Zeiger)', getTapCount() === 2);
  unregister();
}

/* Test B3: Zwei-Finger-Pinch (beide Finger bleiben auf dem Canvas) löst keinen
 * Tap aus. */
{
  const { canvas, win, unregister, getTapCount } = setupWiring();
  dispatchOnCanvasBubbling(canvas, win, 'pointerdown', 1, 100, 200, baseTime);
  dispatchOnCanvasBubbling(canvas, win, 'pointerdown', 2, 150, 250, baseTime + 20);
  dispatchOnCanvasBubbling(canvas, win, 'pointerup', 1, 100, 200, baseTime + 100);
  dispatchOnCanvasBubbling(canvas, win, 'pointerup', 2, 150, 250, baseTime + 120);
  test('B3: Zwei-Finger-Pinch löst keinen Tap aus', getTapCount() === 0);
  unregister();
}

/* Test B4: pointercancel (z. B. Systemgeste übernimmt) räumt den Zeiger auf, ohne
 * einen Tap zu melden; ein Mutant, der das window-pointercancel entfernt, lässt den
 * nächsten Tap ausbleiben. */
{
  const { canvas, win, unregister, getTapCount } = setupWiring();
  dispatchOnCanvasBubbling(canvas, win, 'pointerdown', 1, 100, 200, baseTime);
  dispatchOutsideCanvas(win, 'pointercancel', 1, 900, 900, baseTime + 50);
  test('B4: pointercancel selbst löst keinen Tap aus', getTapCount() === 0);

  dispatchOnCanvasBubbling(canvas, win, 'pointerdown', 2, 50, 50, baseTime + 500);
  dispatchOnCanvasBubbling(canvas, win, 'pointerup', 2, 50, 50, baseTime + 550);
  test('B4: Tap danach funktioniert wieder', getTapCount() === 1);
  unregister();
}

/* Test B6: Klick auf einen HUD-Knopf kurz nach einem Canvas-Tap. pointerdown landet
 * am Knopf (nicht am Canvas), das pointerup blubbert nur bis window. */
{
  const { canvas, win, unregister, getTapCount } = setupWiring();
  dispatchOnCanvasBubbling(canvas, win, 'pointerdown', 1, 100, 200, baseTime);
  dispatchOnCanvasBubbling(canvas, win, 'pointerup', 1, 100, 200, baseTime + 50);
  dispatchOutsideCanvas(win, 'pointerup', 1, 103, 202, baseTime + 250);
  test('B6: pointerup eines HUD-Klicks löst keinen zweiten Tap aus', getTapCount() === 1);
  unregister();
}

/* Test B5: unregister() meldet ab – danach löst kein Ereignis mehr etwas aus. */
{
  const { canvas, win, unregister, getTapCount } = setupWiring();
  unregister();
  dispatchOnCanvasBubbling(canvas, win, 'pointerdown', 1, 100, 200, baseTime);
  dispatchOnCanvasBubbling(canvas, win, 'pointerup', 1, 100, 200, baseTime + 50);
  test('B5: nach unregister() kein Tap mehr', getTapCount() === 0);
}

console.log(`${checks} Prüfungen, ${failures} Fehlschläge`);
if (failures > 0) process.exit(1);
