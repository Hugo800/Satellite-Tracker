import { useEffect, useRef } from 'react';
import { Eye } from 'lucide-react';
import { Vector3 } from 'three';
import { FORECAST_WINDOWS_MIN } from '../../data/forecast';
import type { ForecastWindowMin } from '../../data/forecast';
import { vectorToAzEl } from '../../math/coords';
import { FORECAST_NEXT_PREFIX, forecastPointAt } from '../../state/forecastView';
import { forecastView, requestFocus } from '../../state/runtime';
import type { ForecastNext, ForecastSlot } from '../../state/runtime';
import { selectTimeScale, useAppStore, virtualNow } from '../../state/store';
import type { ForecastEntry, NoradId } from '../../types';

/** Leeres Array als stabile Referenz, solange kein gültiger Stand vorliegt – vermeidet ein neues `[]` je Render. */
const NO_SLOTS: readonly ForecastSlot[] = [];

/** Nächstes Zeitfenster im Zyklus des Knopfs im Listenkopf: 5 → 10 → 20 → 5. */
function nextForecastWindow(current: ForecastWindowMin): ForecastWindowMin {
  const i = FORECAST_WINDOWS_MIN.indexOf(current);
  return FORECAST_WINDOWS_MIN[(i + 1) % FORECAST_WINDOWS_MIN.length];
}

/**
 * Zugänglicher Name der Kandidatenzeile. Ersetzt den Inhalt der Zeile für
 * VoiceOver – deshalb schreibt ihn das Intervall wie die sichtbaren Texte
 * fort; beim Render festgeschrieben sagte er nach 30 min noch „in 47 min“,
 * während die Zeile „in 17 min“ zeigte (React rendert beim Minutenwechsel
 * absichtlich nicht).
 */
function nextAriaLabel(next: ForecastNext): string {
  return `Nächster sichtbarer Satellit: ${next.name} ${next.detailText} – tippen zum Auswählen`;
}

/**
 * Kopf der angetippten Spur – wiederverwendet statt je Klick neu angelegt.
 * `forecastPointAt` schreibt nur `x`/`y`/`z`, ein `Vector3` taugt also direkt
 * als Ziel UND als Eingabe für `vectorToAzEl`, ohne zweite Allokation.
 */
const tapHead = new Vector3();

/**
 * Liste „Demnächst sichtbar“ – bis zu `FORECAST_MAX_SLOTS` Zeilen rechts neben
 * dem Radar (Hud.tsx), nur solange der Filter „Sichtbar“ aktiv und nichts
 * gewählt ist (§8.5 der Spezifikation).
 *
 * Daten ausschließlich aus `forecastView` (src/state/runtime.ts) – außerhalb
 * von React, vom Controller-Hook (useVisibilityForecast) alle 250 ms aus der
 * virtuellen Zeit abgeleitet. React rendert nur, wenn `forecastRevision`
 * steigt, also wenn sich die Menge der Einträge ändert; Countdown, Farbe und
 * Unterzeile schreibt stattdessen ein Intervall per `textContent` – wie beim
 * Überflug-Countdown in TelemetryPanel.tsx. Das fängt auch zwei Fälle, in
 * denen sich NUR Texte ändern, ohne dass die Menge es tut: ein Eintrag wird
 * mit derselben NORAD-ID neu beschrieben (Nachführung, `entry` wechselt die
 * Referenz, `noradId` nicht), und die Ausblick-Zeile altert allein durch den
 * Minutenwechsel (`formatForecastNext`), ohne dass `farStatus` oder der
 * Kandidat selbst wechseln. Nie die Wanduhr direkt, nie React-State je Takt.
 *
 * Zeilen nur aus Utilities (Tailwind-v4-Ebenenfalle, siehe
 * ~/Git/agent/docs/tailwind-v4-ebenen-vorrang.md); `hairline-b` ausschließlich
 * für den Trennstrich, der sonst keine Eigenschaft einer Utility überschreibt.
 */
export function ForecastList(): React.JSX.Element {
  const forecastRevision = useAppStore((s) => s.forecastRevision);
  const windowMin = useAppStore((s) => s.forecastWindowMin);
  const setForecastWindow = useAppStore((s) => s.setForecastWindow);
  const select = useAppStore((s) => s.select);
  const timeScale = useAppStore(selectTimeScale);

  const countdownRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const detailRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const nextTextRef = useRef<HTMLSpanElement | null>(null);
  const nextNameRef = useRef<HTMLSpanElement | null>(null);
  const nextDetailRef = useRef<HTMLSpanElement | null>(null);
  const nextButtonRef = useRef<HTMLButtonElement | null>(null);

  const view = forecastView;
  const slots = view.status === 'ready' ? view.slots : NO_SLOTS;

  // Schreibt Countdown, Farbe, Unterzeile und Ausblick-Zeile aus dem
  // jeweils AKTUELLEN `forecastView` – nicht aus der oben erfassten `slots`-
  // Variable, die nach einem Neuschreiben ohne Mengenänderung veraltet wäre.
  useEffect(() => {
    const write = () => {
      const current = forecastView.slots;
      for (let i = 0; i < current.length; i += 1) {
        const slot = current[i];
        const countdown = countdownRefs.current[i];
        if (countdown) {
          countdown.textContent = slot.countdownText;
          countdown.style.color = slot.visibleNow ? 'var(--highlight)' : 'var(--label)';
        }
        const detail = detailRefs.current[i];
        if (detail) detail.textContent = slot.detailText;
      }
      const next = forecastView.next;
      // Ohne Kandidat der Text der Zeile, mit Kandidat nur der Name – der
      // Vorsatz „Nächster:“ steht fest davor. Der Name kann wechseln, ohne
      // dass React rendert (Katalog nachgeladen, „NORAD 22219“ → Name).
      if (nextTextRef.current) nextTextRef.current.textContent = forecastView.nextText;
      if (nextNameRef.current && next) nextNameRef.current.textContent = next.name;
      if (nextDetailRef.current && next) nextDetailRef.current.textContent = next.detailText;
      if (nextButtonRef.current && next) nextButtonRef.current.setAttribute('aria-label', nextAriaLabel(next));
    };
    write();
    const id = window.setInterval(write, Math.abs(timeScale) > 1 ? 250 : 1000);
    return () => window.clearInterval(id);
  }, [forecastRevision, timeScale]);

  /** Wählt ein Objekt aus und richtet die Kamera auf seinen (ggf. noch unter dem Horizont liegenden) Kopf aus. */
  const focusAndSelect = (entry: ForecastEntry, noradId: NoradId): void => {
    forecastPointAt(entry, virtualNow(), tapHead);
    const { azimuth, elevation } = vectorToAzEl(tapHead);
    select(noradId);
    requestFocus(azimuth, elevation);
  };

  return (
    // `overflow-hidden` an der Karte beschneidet auch die Trefferfläche des
    // Zeitfenster-Knopfs samt runder Ecken – nichts Antippbares ragt in den
    // Himmel (siehe dort).
    // `@container`: Die Kopfzeile richtet sich nach der Breite der Karte, nicht
    // des Bildschirms – bei 320 px bleiben ihr neben dem Radar nur 122 px.
    <div className="material @container pointer-events-auto flex h-[164px] min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-md)] sm:w-60 sm:flex-none">
      {/*
        Bei 320 px Bildschirmbreite (Karte 122 px) passten „DEMNÄCHST“ und
        „10 min“ nicht nebeneinander; der Knopf brach in zwei Zeilen um, die
        Kopfzeile wuchs auf 45 px, und von drei Zeilen waren nur zwei ganz zu
        sehen (gemessen 09.10.2026, headless Chromium). Jetzt bricht der Knopf
        nie um, der Titel kürzt sich, und unter 9 rem Kartenbreite weicht das
        Auge.
      */}
      <div className="flex items-center gap-1 px-2.5 pt-2 pb-1">
        <Eye size={11} aria-hidden className="shrink-0 @max-[9rem]:hidden" />
        <span className="min-w-0 truncate text-[9.5px] font-semibold uppercase tracking-[0.12em] text-label-3">
          DEMNÄCHST
        </span>
        {/*
          Sichtbar klein (16,5 px hoch); die Trefferfläche wächst per ::before
          auf die ganze Höhe der Kopfzeile – von der Oberkante der Karte
          (`-top-2` = `pt-2`) bis zur ersten Zeile der Liste (`-bottom-1` =
          `pb-1`), 28,5 px – und in der Breite bis an den rechten Rand der
          Karte und 16 px nach links. 44 px Höhe gehen in der Karte
          nicht: Sie ist so hoch wie das Radar (164 px) und trägt drei
          44-px-Zeilen. Über die Oberkante hinaus darf die Fläche nicht: Dort
          ist Himmel, und ein Tap, dessen `pointerdown` nicht am Canvas
          ankommt, verwirft tapTracker.ts – der Satellit darunter war nicht
          wählbar, stattdessen sprang das Zeitfenster um (gemessen 09.10.2026,
          headless Chromium, 393 und 320 px: 15,5 × 55,5 px Himmel über der
          Karte gehörten dem Knopf). Abgesichert statisch in
          scripts/verify-forecast.ts (Abschnitt T: kein `before:-top-*` über
          `pt-2` hinaus, Karte mit `overflow-hidden`) und gemessen in
          scripts/verify-forecast-layout.ts.
        */}
        <button
          type="button"
          className="relative ml-auto shrink-0 whitespace-nowrap text-[11px] font-semibold text-accent tabular-nums before:absolute before:-top-2 before:-right-2.5 before:-bottom-1 before:-left-4 before:content-['']"
          aria-label={`Zeitfenster ${windowMin} Minuten – tippen für ${nextForecastWindow(windowMin)} Minuten`}
          onClick={() => setForecastWindow(nextForecastWindow(windowMin))}
        >
          {windowMin} min
        </button>
      </div>

      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0 overflow-y-auto rounded-b-[var(--radius-md)]">
          {slots.length > 0 ? (
            slots.map((slot, i) => (
              <button
                key={slot.noradId}
                type="button"
                className="hairline-b flex h-11 w-full items-center gap-2 px-2.5 text-left"
                onClick={() => focusAndSelect(slot.entry, slot.noradId)}
              >
                <div className="min-w-0 flex-1">
                  {/* Ein Verbund (§13) zeigt hinter dem Namen des Anführers „+5“ –
                      eigenes Element, damit die Kürzung nur den Namen trifft. */}
                  <div className="flex min-w-0 items-baseline gap-1">
                    <span className="truncate text-[13px] font-medium text-label">{slot.name}</span>
                    {slot.groupText && (
                      <span className="flex-none text-[11px] font-semibold text-label-2 tabular-nums">
                        {slot.groupText}
                      </span>
                    )}
                  </div>
                  <div
                    ref={(node) => {
                      detailRefs.current[i] = node;
                    }}
                    className="truncate text-[10.5px] text-label-2"
                  >
                    {slot.detailText}
                  </div>
                </div>
                <span
                  ref={(node) => {
                    countdownRefs.current[i] = node;
                  }}
                  className="shrink-0 text-[12px] font-semibold tabular-nums"
                  style={{ color: slot.visibleNow ? 'var(--highlight)' : 'var(--label)' }}
                >
                  {slot.countdownText}
                </span>
              </button>
            ))
          ) : (
            // Zustandstext zentriert; bei `ready` (also 0 Treffer im gewählten
            // Fenster) darunter die Ausblick-Zeile des Lang-Scans (§1, §12.1) –
            // ohne Kandidat nur Text, mit Kandidat eine eigene Zeile, antippbar
            // wie die normalen Einträge oben. Kein Eintrag in Radar oder Himmel.
            // `justify-center-safe` statt `justify-center`: Passt der Inhalt
            // nicht in die 133,5 px (320 px Bildschirmbreite mit zweizeiligem
            // Namen, siehe unten), bleibt er oben bündig und läuft nur nach
            // unten über – dort scrollt der Container. Zentriert ragte er oben
            // und unten je 2 px hinaus, und oben kommt kein Scrollen hin.
            <div className="flex h-full flex-col items-center justify-center-safe gap-1 px-3 text-center">
              <span className="text-[11.5px] text-label-2">{view.statusText}</span>
              {view.status === 'ready' &&
                (view.next ? (
                  // `shrink-0`: `min-h-11` ersetzt das `min-height: auto` eines
                  // Flex-Kinds, ohne es dürfte die Spalte den Knopf bis auf
                  // 44 px stauchen – die Unterzeile ragte dann aus dem Knopf.
                  <button
                    ref={nextButtonRef}
                    type="button"
                    className="flex min-h-11 w-full shrink-0 flex-col items-center justify-center rounded-[var(--radius-sm)] px-2"
                    aria-label={nextAriaLabel(view.next)}
                    onClick={() => view.next && focusAndSelect(view.next.entry, view.next.noradId)}
                  >
                    {/*
                      Vorsatz und Name als eigene Elemente in einer
                      umbrechenden Zeile: Passen beide nebeneinander, steht
                      „Nächster: ISS (ZARYA)“ wie bisher in einer Zeile; sonst
                      rutscht der Name in eine eigene und bekommt die ganze
                      Breite, ein zu langer Name bricht dort in höchstens
                      zwei Zeilen um. Am Stück gekürzt blieb bei 320 px
                      Bildschirmbreite (Karte 122 px, Zeile 80 px) nur
                      „Nächster: I…“ – der Vorsatz allein ist 61 px breit
                      (gemessen 09.10.2026, headless Chromium). Platz ist
                      knapp: Bei 393 px brauchen Zustandstext und Kandidat
                      (einzeilig) 81 der 133,5 px unter der Kopfzeile; bei
                      320 px, sobald der Name zwei Zeilen braucht (COSMOS 2219
                      DEB, STARLINK-31234, jeder gekürzte Name), ≈ 137 px –
                      3–4 px mehr, als da sind, keine Reserve. Dank
                      `justify-center-safe` an der Spalte und `shrink-0` am
                      Knopf (oben) läuft der Rest nach unten über und bleibt
                      scrollbar. Wer hier eine Zeile ergänzt, braucht eine
                      höhere Karte. Gemessen: scripts/verify-forecast-layout.ts.
                    */}
                    <span className="flex max-w-full flex-wrap justify-center gap-x-1 text-[12px] font-medium text-label">
                      <span className="shrink-0">{FORECAST_NEXT_PREFIX}</span>
                      <span ref={nextNameRef} className="line-clamp-2 min-w-0 max-w-full wrap-anywhere">
                        {view.next.name}
                      </span>
                    </span>
                    <span ref={nextDetailRef} className="text-[10.5px] text-label-2 tabular-nums">
                      {view.next.detailText}
                    </span>
                  </button>
                ) : (
                  <span ref={nextTextRef} className="text-[11px] text-label-3">
                    {view.nextText}
                  </span>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
