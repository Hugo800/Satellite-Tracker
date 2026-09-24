/**
 * Reine Zeigerlogik für TapPicker – ohne DOM, ohne React.
 *
 * Zwei unabhängige Teile:
 *  1. Zustandsmaschine (createTapTrackerState/processPointerEvent): entscheidet anhand
 *     der Menge aktiver Zeiger-IDs, ob ein pointerup ein Tap ist. Eine Menge statt einer
 *     einfachen Zahl, damit ein verlorenes pointerup den Zähler nicht dauerhaft zu hoch
 *     stehen lässt – das war der ursprüngliche Fehler (jeder weitere Tap galt danach als
 *     Mehrfinger-Geste).
 *  2. Verdrahtung (registerTapListeners): hängt die Handler an ein Zielelement und an ein
 *     window-artiges Objekt. TapPicker.tsx UND scripts/verify-tappicker.ts rufen dieselbe
 *     Funktion auf – die Prüfung testet damit die echte Verdrahtung, nicht eine Kopie davon.
 */

export const TAP_MOVE_TOLERANCE_PX = 12;
export const TAP_DURATION_MS = 450;

export type TapPointerEventType = 'pointerdown' | 'pointerup' | 'pointercancel';

/** Die Teile eines PointerEvent, die die Tap-Erkennung tatsächlich braucht. */
export interface TapPointerEvent {
  type: TapPointerEventType;
  pointerId: number;
  clientX: number;
  clientY: number;
  timeStamp: number;
}

export interface TapTrackerState {
  active: Set<number>;
  startX: number;
  startY: number;
  startTime: number;
  hadMultiTouch: boolean;
}

export function createTapTrackerState(): TapTrackerState {
  return { active: new Set<number>(), startX: 0, startY: 0, startTime: 0, hadMultiTouch: false };
}

/**
 * Verarbeitet genau ein Zeiger-Ereignis, mutiert `state` und meldet, ob damit ein
 * gültiger Ein-Finger-Tap abgeschlossen wurde (nur bei `type: 'pointerup'` möglich).
 */
export function processPointerEvent(event: TapPointerEvent, state: TapTrackerState): boolean {
  if (event.type === 'pointerdown') {
    // Nur beim ersten Finger einer neuen Berührung Start-Position und -Zeit setzen –
    // bei weiteren Fingern bleibt der ursprüngliche Startpunkt maßgeblich.
    if (state.active.size === 0) {
      state.startX = event.clientX;
      state.startY = event.clientY;
      state.startTime = event.timeStamp;
      state.hadMultiTouch = false;
    }
    state.active.add(event.pointerId);
    if (state.active.size > 1) {
      state.hadMultiTouch = true;
    }
    return false;
  }

  if (event.type === 'pointercancel') {
    state.active.delete(event.pointerId);
    return false;
  }

  // pointerup: Nur Zeiger werten, die auf dem Canvas begonnen haben. Über den
  // window-Listener kommt auch das pointerup eines Taps auf einen HUD-Knopf an; ohne
  // diese Prüfung zählte es als Tap, wenn es binnen TAP_DURATION_MS nahe am letzten
  // Canvas-Tap liegt (die Maus hat immer dieselbe pointerId).
  if (!state.active.delete(event.pointerId)) return false;
  // Tap nur werten, wenn gerade der letzte Finger losgelassen wird.
  if (state.active.size > 0) return false;
  if (state.hadMultiTouch) return false;
  if (event.timeStamp - state.startTime > TAP_DURATION_MS) return false;
  if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > TAP_MOVE_TOLERANCE_PX) {
    return false;
  }
  return true;
}

/** Minimaler Ausschnitt von EventTarget, den registerTapListeners braucht – erfüllt von
 * echten DOM-Knoten (Canvas, window) genauso wie von schlanken Testattrappen. */
export interface TapEventSource {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

function toTapEvent(type: TapPointerEventType, e: PointerEvent): TapPointerEvent {
  return { type, pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY, timeStamp: e.timeStamp };
}

/**
 * Hängt die Tap-Erkennung an `element` (Beginn der Geste) und `win` (Ende der Geste) und
 * ruft `onTap` bei jedem erkannten Tap genau einmal auf. Gibt eine Abmeldefunktion zurück.
 *
 * Warum pointerup/pointercancel an ZWEI Zielen hängen, ohne doppelt auszulösen:
 *  - `element` allein reicht nicht: Wird der Finger außerhalb des Canvas losgelassen
 *    (oder das Zielelement wechselt aus anderem Grund), bekommt das Canvas gar kein
 *    pointerup – das war der ursprüngliche Fehler.
 *  - `win` allein reicht in dieser Umgebung nicht: Testattrappen wie FakeCanvas in
 *    scripts/verify-selection.ts simulieren kein Bubbling und rufen Listener nur direkt
 *    am Element auf; ein reines window-Objekt ohne addEventListener wird dort verwendet.
 *  - Beide zugleich bergen die Gefahr, ein und dasselbe physische pointerup doppelt zu
 *    verarbeiten: OrbitControls (three-stdlib 2.36.1, node_modules/three-stdlib/controls/
 *    OrbitControls.js) ruft bei keinem seiner Pointer-Handler stopPropagation() auf – im
 *    Quelltext gibt es dafür keinen einzigen Treffer. Ein auf dem Canvas losgelassener
 *    Finger blubbert das Event deshalb unverändert bis zum window, und dort kommt exakt
 *    dasselbe Event-Objekt an wie am Canvas. Ein WeakSet über bereits verarbeitete
 *    Event-Objekte lässt die zweite Zustellung folgenlos verpuffen – ohne dass die reine
 *    Zustandsmaschine oben etwas von alldem wissen muss.
 */
export function registerTapListeners(
  element: TapEventSource,
  win: TapEventSource,
  onTap: (event: TapPointerEvent) => void,
): () => void {
  const state = createTapTrackerState();
  const handledEvents = new WeakSet<object>();

  const runOnce = (raw: Event, run: (tapEvent: TapPointerEvent) => void, type: TapPointerEventType) => {
    if (typeof raw === 'object' && raw !== null) {
      if (handledEvents.has(raw)) return;
      handledEvents.add(raw);
    }
    run(toTapEvent(type, raw as PointerEvent));
  };

  const onPointerDown = (raw: Event) => {
    processPointerEvent(toTapEvent('pointerdown', raw as PointerEvent), state);
  };
  const onPointerUp = (raw: Event) => {
    runOnce(raw, (tapEvent) => {
      if (processPointerEvent(tapEvent, state)) {
        onTap(tapEvent);
      }
    }, 'pointerup');
  };
  const onPointerCancel = (raw: Event) => {
    runOnce(raw, (tapEvent) => processPointerEvent(tapEvent, state), 'pointercancel');
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerCancel);
  win.addEventListener('pointerup', onPointerUp);
  win.addEventListener('pointercancel', onPointerCancel);

  return () => {
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointerup', onPointerUp);
    element.removeEventListener('pointercancel', onPointerCancel);
    win.removeEventListener('pointerup', onPointerUp);
    win.removeEventListener('pointercancel', onPointerCancel);
  };
}
