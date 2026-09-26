import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { History, X } from 'lucide-react';
import { engine } from '../../hooks/useSatelliteEngine';
import { useAppStore, virtualNow } from '../../state/store';
import { formatClock, formatDay } from '../../utils/format';

/**
 * Angebotene Geschwindigkeiten. 0 = Pause, negativ = rückwärts – beides von
 * `engine.setTimeScale` ausdrücklich erlaubt (useSatelliteEngine.ts).
 */
const SPEEDS = [-3600, -600, -60, 0, 1, 60, 600, 3600] as const;

/**
 * Beschriftung einer Stufe: „Pause“ oder „×<Faktor>“. Negative Faktoren mit
 * dem ASCII-Minus, das auch `formatNumber` (Intl, de-DE) für Sonnen- und
 * Mondhöhe in der TopBar ausgibt – so steht in der ganzen Kopfzeile und im
 * Versatz unten dasselbe Zeichen. Gleichlautend in TopBar.tsx
 * (Echtzeit-Hinweis): Eine Komponentendatei soll für Fast Refresh nur
 * Komponenten exportieren (Lint-Regel react-refresh/only-export-components).
 */
function speedLabel(scale: number): string {
  return scale === 0 ? 'Pause' : `×${scale}`;
}

/** Versatzregler: ±48 h um die Wanduhr, in 5-Minuten-Schritten. */
const OFFSET_RANGE_H = 48;
const OFFSET_MIN_MS = -OFFSET_RANGE_H * 3_600_000;
const OFFSET_MAX_MS = OFFSET_RANGE_H * 3_600_000;
const OFFSET_STEP_MS = 5 * 60_000;

/**
 * Abstand, den das Blatt zum unteren Bildrand (über der Safe-Area) hält.
 *
 * Mit gewähltem Satelliten steht dort das Telemetrie-Panel. Hud.tsx lässt
 * dessen Container höchstens bis `100% − 3.75rem − Safe-Area unten − 0.75rem`
 * nach oben reichen (Hud.tsx:141) und gibt ihm unten 0.75rem plus Safe-Area
 * Innenabstand (Hud.tsx:142). Die Kopfzeile des Panels beginnt also
 * frühestens 4.5rem über der Safe-Area – endet das Blatt darüber, verdeckt es
 * sie nicht, und das Panel verdeckt das Blatt nicht.
 *
 * Ohne Auswahl gibt es kein Panel; dann genügt derselbe Randabstand, den das
 * HUD unten überall einhält.
 */
const PANEL_RESERVE = '4.5rem';
const EDGE_GAP = '0.75rem';

/** Tasten, mit denen ein Range-Regler seinen Wert ändert. */
const STEP_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

/**
 * Zerlegt einen Betrag in Tage/Stunden/Minuten, auf Minuten gerundet. Bis
 * unter 48 h als Stunden und Minuten, darüber als Tage und volle Stunden –
 * „+100 h“ liest sich schlechter als „+4 d 4 h“.
 */
function offsetParts(absMs: number): { days: number; hours: number; minutes: number } {
  const totalMin = Math.round(absMs / 60_000);
  if (totalMin < OFFSET_RANGE_H * 60) {
    return { days: 0, hours: Math.floor(totalMin / 60), minutes: totalMin % 60 };
  }
  const totalH = Math.round(totalMin / 60);
  return { days: Math.floor(totalH / 24), hours: totalH % 24, minutes: 0 };
}

/**
 * Versatz zur Wanduhr: „± 0“, „+45 min“, „-6 h“, „+6 h 30 min“, „+4 d 4 h“.
 * Nicht auf den Reglerbereich gekappt – Zeitraffer und `jumpTo` tragen die
 * Szene beliebig weit von der Wanduhr weg; der Regler steht dann am Anschlag,
 * die Anzeige nennt trotzdem den echten Abstand.
 */
function formatOffset(ms: number): string {
  const rounded = Math.round(ms / 60_000) * 60_000;
  if (rounded === 0) return '± 0';
  const sign = rounded < 0 ? '-' : '+';
  const { days, hours, minutes } = offsetParts(Math.abs(rounded));
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} d`);
  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0) parts.push(`${minutes} min`);
  return sign + parts.join(' ');
}

/** Derselbe Versatz zum Vorlesen (`aria-valuetext`): „6 Stunden 30 Minuten zurück“. */
function spokenOffset(ms: number): string {
  const rounded = Math.round(ms / 60_000) * 60_000;
  if (rounded === 0) return 'kein Versatz zur Wanduhr';
  const { days, hours, minutes } = offsetParts(Math.abs(rounded));
  const unit = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (days > 0) parts.push(unit(days, 'Tag', 'Tage'));
  if (hours > 0) parts.push(unit(hours, 'Stunde', 'Stunden'));
  if (minutes > 0) parts.push(unit(minutes, 'Minute', 'Minuten'));
  return `${parts.join(' ')} ${rounded < 0 ? 'zurück' : 'voraus'}`;
}

/**
 * Zeit-Blatt der Zeitmaschine: laufende virtuelle Zeit, „Jetzt“ und
 * Schließen im Kopf, daneben oder darunter Geschwindigkeitsstufen und
 * Versatzregler (Aufteilung: `.time-sheet` in index.css).
 *
 * Hängt als letztes Kind im Wurzelknoten von TopBar.tsx. Dessen Unterkante
 * misst Hud.tsx per ResizeObserver und gibt sie als `--hud-top-free` an
 * Radar und Telemetrie-Panel weiter – die rücken damit auch vor dem offenen
 * Blatt zurück.
 *
 * Geschwindigkeit und Versatz sind zwei getrennte Wege zur selben Zeitbasis:
 * Ein Klick auf eine Stufe ändert nur `scale` (`setTimeScale`, stetig, kein
 * Sprung). Der Regler dagegen zielt auf eine absolute Zeit und braucht daher
 * `jumpTo` – und jeder `jumpTo` beginnt eine neue Epoche: Die Bahnspur wird
 * verworfen (`applyTimeBase` in useSatelliteEngine.ts), die Überflugliste
 * geleert (`setTimeBase` in store.ts) und vom Effekt an `timeEpoch` neu
 * angefordert (useSatelliteEngine.ts:640-655). Während des Ziehens springt
 * die Szene deshalb nicht mit, der Regler zeigt den Zielwert nur an.
 *
 * Wann gesprungen wird:
 * - Maus und Finger: beim `change`-Ereignis, also beim Loslassen.
 * - Tastatur: beim `keyup` der Wertetaste. Chrome feuert `input` und
 *   `change` schon beim Drücken und bei jeder Wiederholung einer gehaltenen
 *   Taste; solange eine Wertetaste unten ist, übergeht der `change`-Handler
 *   den Sprung deshalb.
 * - Hilfstechnik wie VoiceOver: beim `change`, das dort ohne Zeiger- oder
 *   Tastenereignis kommt (im Test nachgestellt, nicht am Gerät geprüft).
 */
export function TimeMachine({
  onClose,
  headRef,
}: {
  onClose: () => void;
  /** Alles, was in der TopBar über dem Blatt steht – verschiebt es beim Wachsen nach unten. */
  headRef: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  // Die ganze Basis statt nur `scale`: Auch ein Sprung bei gleicher
  // Geschwindigkeit („Jetzt“, Regler) soll Uhr und Regler sofort nachführen.
  const timeBase = useAppStore((s) => s.timeBase);
  const panelShown = useAppStore((s) => s.selectedId !== null);

  const sheetRef = useRef<HTMLDivElement>(null);
  const sheetHeadRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const dayRef = useRef<HTMLSpanElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const offsetTextRef = useRef<HTMLSpanElement>(null);
  // true vom ersten `input` eines Ziehens oder einer Tastenfolge bis zum
  // Sprung (oder bis `pointercancel`). Solange überschreibt der Abgleich
  // unten den Regler nicht – der Zielwert spränge sonst mitten im Ziehen auf
  // den tatsächlichen Versatz zurück.
  const draggingRef = useRef(false);
  // true, solange eine Pfeil-/Bild-/Pos1-/Ende-Taste auf dem Regler gedrückt ist.
  const keyStepRef = useRef(false);

  const writeOffset = useCallback((ms: number) => {
    if (offsetTextRef.current) offsetTextRef.current.textContent = formatOffset(ms);
    sliderRef.current?.setAttribute('aria-valuetext', spokenOffset(ms));
  }, []);

  // Tatsächlichen Abstand der Szene zur Wanduhr in Regler und Anzeige
  // schreiben. Der Regler kann nur ±48 h, die Anzeige nennt den vollen Wert.
  const showOffset = useCallback(
    (raw: number) => {
      const clamped = Math.max(OFFSET_MIN_MS, Math.min(OFFSET_MAX_MS, raw));
      if (sliderRef.current) sliderRef.current.value = String(clamped);
      writeOffset(raw);
    },
    [writeOffset],
  );

  // Laufende virtuelle Zeit: 4× je Sekunde ab |Zeitraffer| > 1, sonst 1×
  // (gleiche Abwägung wie der Countdown in TelemetryPanel.tsx – bei ×600
  // vergehen zwischen zwei Sekundenschritten 10 virtuelle Minuten, das soll
  // sich lesbar bewegen, ohne bei Echtzeit unnötig oft zu schreiben). Jede
  // neue Zeitbasis schreibt sofort, nicht erst beim nächsten Takt.
  useEffect(() => {
    const update = () => {
      const now = virtualNow();
      if (clockRef.current) clockRef.current.textContent = formatClock(now);
      if (dayRef.current) dayRef.current.textContent = formatDay(now);
    };
    update();
    const id = window.setInterval(update, Math.abs(timeBase.scale) > 1 ? 250 : 1000);
    return () => window.clearInterval(id);
  }, [timeBase]);

  // Regler und Anzeige mit der Szene abgleichen, solange nicht gerade
  // gezogen wird: sofort bei jeder neuen Zeitbasis (Stufe, „Jetzt“, Sprung,
  // Echtzeit-Hinweis), danach im Sekundentakt, weil der Versatz im Zeitraffer
  // und bei Pause mit der Wanduhr wandert. Ohne den sofortigen Abgleich stünde
  // der Regler nach „Jetzt“ bis zum nächsten Takt auf dem alten Wert, und ein
  // Tastenschritt in dieser Zeit ginge von dort aus.
  useEffect(() => {
    const sync = () => {
      if (draggingRef.current) return;
      const raw = virtualNow() - Date.now();
      showOffset(raw);
    };
    sync();
    const id = window.setInterval(sync, 1000);
    return () => window.clearInterval(id);
  }, [showOffset, timeBase]);

  const handleInput = useCallback(
    (e: React.FormEvent<HTMLInputElement>) => {
      draggingRef.current = true;
      writeOffset(e.currentTarget.valueAsNumber);
    },
    [writeOffset],
  );

  // Genau ein Sprung auf den angezeigten Wert, aber nur, wenn seit dem
  // letzten Sprung tatsächlich `input` gefeuert hat. Ohne die Prüfung
  // sprängen auch reine Fokuswechsel: Tab auf den Regler löst dort `keyup`
  // aus, ohne den Wert zu ändern.
  const commit = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const ms = sliderRef.current?.valueAsNumber;
    if (ms === undefined) return;
    engine.jumpTo(Date.now() + ms);
  }, []);

  // `change` als natives Ereignis: Reacts `onChange` feuert bei Eingabefeldern
  // schon bei jedem `input`, also bei jedem Zwischenschritt eines Ziehens.
  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider) return;
    const onChange = () => {
      if (!keyStepRef.current) commit();
    };
    slider.addEventListener('change', onChange);
    return () => slider.removeEventListener('change', onChange);
  }, [commit]);

  // Eine senkrechte Wischgeste auf der Spur setzt den Wert schon beim
  // Berühren (`input`), dann übernimmt der Browser das Scrollen und meldet
  // `pointercancel` statt `pointerup`. Gemeint war Scrollen, nicht Springen:
  // Zugzustand beenden und den echten Stand zeigen. Sonst bliebe der
  // Abgleich ausgesetzt, und das nächste Festschreiben (`change`, `keyup`,
  // `onBlur`) spränge auf den nur berührten Wert.
  const cancelDrag = useCallback(() => {
    draggingRef.current = false;
    showOffset(virtualNow() - Date.now());
  }, [showOffset]);

  // Höhe und Lage des Blatts aus dem tatsächlich freien Platz: von der
  // Stelle, an der das Blatt ohne Verschiebung beginnt, bis zum unteren
  // Bildrand, abzüglich Safe-Area und Abstand (PANEL_RESERVE bzw. EDGE_GAP).
  // `window.innerHeight` ist die Höhe von #root (`position: fixed; inset: 0`,
  // index.css), also dieselbe Bezugsgröße wie das `100%` in Hud.tsx.
  //
  // Mindestens sichtbar bleiben muss, was ohne Wischen erreichbar sein soll:
  // im einspaltigen Blatt die Kopfzeile mit „Jetzt“ und Schließen (der Körper
  // darunter scrollt), im breiten Querformat das ganze Blatt, dort stehen
  // Stufen und Regler neben der Kopfspalte. Reicht der Platz unter dem Block
  // darüber dafür nicht – etwa mit mehreren Hinweiszeilen auf einem
  // niedrigen Bildschirm –, rückt das Blatt per negativem Außenabstand nach
  // oben und legt sich über den unteren Teil dieses Blocks. Als späteres
  // Geschwister liegt es dort obenauf. Meist trifft es Hinweiszeilen, und die
  // nehmen ohnehin keine Zeiger an (`pointer-events-none`, Notice in
  // TopBar.tsx).
  //
  // Neu gerechnet wird, sobald sich über dem Blatt etwas in der Höhe ändert
  // (ResizeObserver auf `headRef`; beobachtet wird bewusst nicht die TopBar
  // selbst, deren Höhe ändert sich durch diese Rechnung ja mit), bei jeder
  // Größenänderung des Fensters und wenn das Panel kommt oder geht.
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    const head = headRef.current;
    const sheetHead = sheetHeadRef.current;
    const body = bodyRef.current;
    if (!sheet || !head || !sheetHead || !body) return;
    const gap = panelShown ? PANEL_RESERVE : EDGE_GAP;
    const fit = () => {
      const style = getComputedStyle(sheet);
      const top = sheet.getBoundingClientRect().top - parseFloat(style.marginTop);
      const room = window.innerHeight - top;
      const frame = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const wide = style.flexDirection === 'row';
      const need = Math.ceil(
        frame + (wide ? Math.max(sheetHead.scrollHeight, body.scrollHeight) : sheetHead.getBoundingClientRect().height),
      );
      const free = `${room}px - var(--safe-bottom) - ${gap}`;
      sheet.style.maxHeight = `max(${need}px, ${free})`;
      sheet.style.marginTop = `min(0px, ${free} - ${need}px)`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(head);
    window.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [headRef, panelShown]);

  return (
    <div
      ref={sheetRef}
      data-hud="time-sheet"
      role="region"
      aria-label="Zeitmaschine"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      className="material time-sheet pointer-events-auto"
    >
      {/*
        Kopf mit Uhr, „Jetzt“ und Schließen: Er scrollt nie mit, der Rückweg
        zur Echtzeit ist also in jedem Zustand ohne Wischen erreichbar.
      */}
      <div ref={sheetHeadRef} className="time-sheet-head hairline-b">
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[11px] text-label-2">
            Zeitmaschine · <span ref={dayRef}>–</span>
          </div>
          <div className="text-[22px] font-semibold tracking-[-0.01em] tabular-nums text-label">
            <span ref={clockRef}>–</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => engine.resetToRealTime()}
          aria-label="Zur Echtzeit springen"
          className="time-now"
        >
          <History size={15} strokeWidth={2.2} aria-hidden />
          Jetzt
        </button>
        <button
          type="button"
          aria-label="Zeitmaschine schließen"
          onClick={onClose}
          className="icon-button"
        >
          <X size={18} strokeWidth={2} aria-hidden />
        </button>
      </div>

      <div ref={bodyRef} className="time-sheet-body overflow-y-auto overscroll-contain">
        <div role="group" aria-label="Zeitraffer" className="time-speeds">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={timeBase.scale === s}
              onClick={() => engine.setTimeScale(s)}
              className="time-speed"
            >
              {speedLabel(s)}
            </button>
          ))}
        </div>

        <div className="time-offset">
          {/*
            Eine Zeile, auch wenn der Versatz lang wird: Im Querformat steht
            die Spalte schmal, und ein Umbruch machte das Blatt höher, als die
            Höhenrechnung oben es beim Öffnen vermessen hat.
          */}
          <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-label-2">
            <span id="time-offset-label" className="min-w-0 truncate">
              Versatz zur Wanduhr
            </span>
            <span ref={offsetTextRef} className="shrink-0 font-medium tabular-nums text-label">
              ± 0
            </span>
          </div>
          {/*
            Tastatur: Solange eine Wertetaste gedrückt ist, wartet der Sprung
            auf deren `keyup` (Kopfkommentar). `onBlur` fängt den Fall ab, dass
            der Fokus mitten in einer Tastenfolge wechselt – dann landet das
            `keyup` woanders, und ohne Festschreiben bliebe der Zugzustand
            stehen und der Abgleich ausgesetzt.
          */}
          <input
            ref={sliderRef}
            type="range"
            className="time-slider"
            aria-labelledby="time-offset-label"
            min={OFFSET_MIN_MS}
            max={OFFSET_MAX_MS}
            step={OFFSET_STEP_MS}
            defaultValue={0}
            onInput={handleInput}
            onPointerCancel={cancelDrag}
            onKeyDown={(e) => {
              if (STEP_KEYS.has(e.key)) keyStepRef.current = true;
            }}
            onKeyUp={(e) => {
              if (STEP_KEYS.has(e.key)) keyStepRef.current = false;
              if (!keyStepRef.current) commit();
            }}
            onBlur={() => {
              keyStepRef.current = false;
              commit();
            }}
          />
          <div className="flex justify-between text-[10px] text-label-3" aria-hidden>
            <span>-{OFFSET_RANGE_H} h</span>
            <span>+{OFFSET_RANGE_H} h</span>
          </div>
        </div>
      </div>
    </div>
  );
}
