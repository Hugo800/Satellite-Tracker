import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Clock,
  Compass,
  History,
  List,
  MapPin,
  Monitor,
  Moon,
  MoonStar,
  Orbit,
  Satellite,
  Sun,
  Sunrise,
} from 'lucide-react';
import { compassLabel } from '../../math/coords';
import { engine } from '../../hooks/useSatelliteEngine';
import { useDeviceOrientation } from '../../hooks/useDeviceOrientation';
import { TELEMETRY_STRIDE, T_ECLIPSED, T_EL, T_MAG, T_RANGE } from '../../math/telemetryLayout';
import { passesSkyFilter } from '../../math/visibility';
import { catalogIndex, telemetry, viewState } from '../../state/runtime';
import { isRealtime, useAppStore, virtualNow } from '../../state/store';
import { formatClockShort, formatCount, formatDay, formatNumber } from '../../utils/format';
import type { ThemePreference } from '../../types';
import { ModeSwitch } from './ModeSwitch';
import { TimeMachine } from './TimeMachine';

const THEME_CYCLE: ThemePreference[] = ['system', 'light', 'dark'];
const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'Erscheinungsbild: System',
  light: 'Erscheinungsbild: Hell',
  dark: 'Erscheinungsbild: Dunkel',
};

/**
 * Beschriftung einer Geschwindigkeit: „Pause“ oder „×<Faktor>“, negative
 * Faktoren mit ASCII-Minus. Gleichlautend in TimeMachine.tsx (Stufenknöpfe):
 * Eine Komponentendatei soll für Fast Refresh nur Komponenten exportieren.
 */
function speedLabel(scale: number): string {
  return scale === 0 ? 'Pause' : `×${scale}`;
}

/**
 * Name des Echtzeit-Hinweises. Er nennt den Zustand, der gerade von der
 * Echtzeit abweicht – „Zeitraffer“ wäre bei Pause oder nach einem reinen
 * Sprung mit ×1 falsch. Stufe und virtuelle Zeit liefert `aria-describedby`.
 */
function timeNoticeLabel(scale: number): string {
  const state =
    scale === 0
      ? 'Zeit angehalten'
      : scale === 1
        ? 'Zeitsprung aktiv'
        : scale < 0
          ? 'Zeitraffer rückwärts aktiv'
          : scale < 1
            ? 'Zeitlupe aktiv'
            : 'Zeitraffer aktiv';
  return `${state} – zur Echtzeit zurückkehren`;
}

function IconButton({
  active,
  label,
  onClick,
  buttonRef,
  children,
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      ref={buttonRef}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className="icon-button"
    >
      {children}
    </button>
  );
}

function Stat({
  icon,
  children,
  title,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  title?: string;
}): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 text-[11.5px] text-label-2"
      title={title}
    >
      <span className="text-label-3" aria-hidden>
        {icon}
      </span>
      {children}
    </span>
  );
}

/**
 * Kopfzeile: Standort, Sonnen-/Mondstand, Blickrichtung, Moduswahl und die
 * Zeitmaschine.
 *
 * Der `ref` zeigt auf die äußere Hülle, die alle Zeilen umschließt –
 * Infokarte, Buttonleiste, Echtzeit-Hinweis, Moduswahl, die variable Zahl an
 * Hinweiszeilen (Geo-, Kompass-, Ladefehler) und das Zeit-Blatt. Hud.tsx
 * misst über diesen Knoten die tatsächliche Unterkante der TopBar per
 * ResizeObserver, um Radar und Telemetrie-Panel nie darüber wachsen zu lassen.
 */
export const TopBar = forwardRef<HTMLDivElement>(function TopBar(_props, ref) {
  const observer = useAppStore((s) => s.observer);
  const sun = useAppStore((s) => s.sun);
  const moon = useAppStore((s) => s.moon);
  const status = useAppStore((s) => s.status);
  const loading = useAppStore((s) => s.loading);
  const catalogSize = useAppStore((s) => s.catalog.length);
  const mode = useAppStore((s) => s.filters.mode);
  const arEnabled = useAppStore((s) => s.arEnabled);
  const arSupported = useAppStore((s) => s.arSupported);
  const compassStatus = useAppStore((s) => s.compassStatus);
  const nightMode = useAppStore((s) => s.nightMode);
  const toggleNightMode = useAppStore((s) => s.toggleNightMode);
  const showTrails = useAppStore((s) => s.showTrails);
  const toggleTrails = useAppStore((s) => s.toggleTrails);
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const errors = useAppStore((s) => s.errors);
  const geoError = useAppStore((s) => s.geoError);
  // Die ganze Basis statt nur `scale`: Auch ein Sprung bei gleicher
  // Geschwindigkeit soll den Hinweistext sofort nachführen.
  const timeBase = useAppStore((s) => s.timeBase);
  const timeRealtime = isRealtime(timeBase);

  const { enable, disable } = useDeviceOrientation();
  const headingRef = useRef<HTMLSpanElement>(null);
  const skyCountRef = useRef<HTMLSpanElement>(null);
  const timeNoticeRef = useRef<HTMLSpanElement>(null);
  const timeToggleRef = useRef<HTMLButtonElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  // Lokal statt im Store: Außerhalb dieser Datei fragt niemand, ob das
  // Zeit-Blatt offen ist.
  const [timeOpen, setTimeOpen] = useState(false);

  // Schließen über „×“ oder Escape im Blatt: Der fokussierte Knopf
  // verschwindet mit dem Blatt, der Fokus fiele auf <body>, und Tastatur-
  // wie VoiceOver-Nutzer müssten die Kopfzeile von vorn durchlaufen. Deshalb
  // zurück auf den Uhr-Knopf, der das Blatt geöffnet hat.
  const closeTime = useCallback(() => {
    setTimeOpen(false);
    timeToggleRef.current?.focus();
  }, []);

  const cycleTheme = useCallback(() => {
    setTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]);
  }, [theme, setTheme]);

  // Nur 1 Hz und ohne Re-Render: Der Zähler macht sichtbar, wie viel des
  // Katalogs gerade tatsächlich über dem Horizont steht. Die Starlink-Flags
  // kommen aus dem vorberechneten Index – bei fünfstelligen Katalogen wäre ein
  // String-Vergleich je Objekt spürbar.
  useEffect(() => {
    const update = () => {
      const node = skyCountRef.current;
      if (!node) return;
      const data = telemetry.data;
      const starlinkFlags = catalogIndex.starlink;
      let count = 0;
      for (let i = 0; i < telemetry.count; i += 1) {
        const base = i * TELEMETRY_STRIDE;
        if (!Number.isFinite(data[base + T_RANGE])) continue;
        if (
          passesSkyFilter(
            mode,
            starlinkFlags[i] === 1,
            data[base + T_EL],
            data[base + T_ECLIPSED] > 0.5,
            data[base + T_MAG],
          )
        ) {
          count += 1;
        }
      }
      node.textContent = formatCount(count);
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [mode]);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = requestAnimationFrame(update);
      if (!headingRef.current) return;
      headingRef.current.textContent = `${formatNumber(viewState.azimuthDeg, 0)}° ${compassLabel(
        viewState.azimuthDeg,
      )} · ${formatNumber(viewState.elevationDeg, 0)}°`;
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, []);

  // Hinweistext „×600 · Do., 24.09. 14:32“ im Sekundentakt: Er zeigt keine
  // Sekunden und soll auch im Zeitraffer eine ruhige Statuszeile bleiben;
  // flüssiger läuft die große Uhr im Blatt (TimeMachine.tsx). Jede neue
  // Zeitbasis schreibt sofort. Läuft nur, solange der Hinweis zu sehen ist –
  // bei offenem Blatt zeigt dessen Kopf Uhr und „Jetzt“.
  const timeNoticeShown = !timeRealtime && !timeOpen;
  useEffect(() => {
    if (!timeNoticeShown) return;
    const update = () => {
      if (!timeNoticeRef.current) return;
      const now = virtualNow();
      timeNoticeRef.current.textContent = `${speedLabel(timeBase.scale)} · ${formatDay(now)} ${formatClockShort(now)}`;
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [timeNoticeShown, timeBase]);

  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return (
    <div
      ref={ref}
      data-hud="topbar"
      className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-2.5 p-3"
      style={{
        paddingTop: 'calc(var(--safe-top) + 0.75rem)',
        paddingLeft: 'calc(var(--safe-left) + 0.75rem)',
        paddingRight: 'calc(var(--safe-right) + 0.75rem)',
      }}
    >
      {/*
        Alles über dem Zeit-Blatt. TimeMachine.tsx beobachtet diesen Block per
        ResizeObserver: Ändert sich seine Höhe, verschiebt sich das Blatt, und
        dessen Höhe und Lage werden neu gerechnet.
      */}
      <div ref={headRef} className="flex flex-col gap-2.5">
        <div className="flex items-start gap-2">
          <div className="material pointer-events-auto min-w-0 flex-1 rounded-[var(--radius-md)] px-3.5 py-2.5">
            <div className="flex items-center gap-1.5">
              <Satellite
                size={14}
                strokeWidth={2.2}
                className={loading ? 'animate-soft-pulse text-accent' : 'text-accent'}
                aria-hidden
              />
              <span className="text-[15px] font-semibold tracking-[-0.01em] text-label">
                Orbital Atlas
              </span>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <Stat
                icon={<Orbit size={11} strokeWidth={2.2} />}
                title="Objekte über dem Horizont / Objekte im Katalog"
              >
                <span className="font-medium text-label">
                  <span ref={skyCountRef}>0</span>
                </span>
                <span className="text-label-3">/ {formatCount(catalogSize)}</span>
              </Stat>
              <Stat icon={<MapPin size={11} strokeWidth={2.2} />}>
                {observer
                  ? `${formatNumber(observer.latitudeDeg, 3)}°, ${formatNumber(observer.longitudeDeg, 3)}°`
                  : 'Ortung läuft …'}
              </Stat>
              <Stat icon={<Sunrise size={11} strokeWidth={2.2} />} title="Sonnenhöhe">
                {formatNumber(sun.altitudeDeg, 0)}°
              </Stat>
              <Stat icon={<MoonStar size={11} strokeWidth={2.2} />} title="Mondhöhe">
                {formatNumber(moon.altitudeDeg, 0)}°
              </Stat>
              <Stat icon={<Compass size={11} strokeWidth={2.2} />} title="Blickrichtung">
                <span ref={headingRef}>–</span>
              </Stat>
            </div>

            <div className="mt-1 text-[11px] leading-snug text-label-3">{status}</div>
          </div>

          {/*
            Sechs Knöpfe: unter `md` in zwei Reihen zu je drei, bündig ohne
            Innenabstand. In einer Reihe nähmen sie der Infokarte daneben auf
            schmalen Breiten so viel Platz, dass Titel oder Angaben umbrechen
            und die TopBar tiefer reicht. Ab `md` ist neben der einen Reihe
            genug Platz für die Karte.
          */}
          <div className="material pointer-events-auto grid shrink-0 grid-cols-3 rounded-[var(--radius-md)] p-0 md:flex md:p-0.5">
            <IconButton
              active={timeOpen}
              label={timeOpen ? 'Zeitmaschine schließen' : 'Zeitmaschine öffnen'}
              onClick={() => setTimeOpen((v) => !v)}
              buttonRef={timeToggleRef}
            >
              <Clock size={19} strokeWidth={2} aria-hidden />
            </IconButton>
            <IconButton
              active={arEnabled}
              label={arEnabled ? 'AR-Modus beenden' : 'AR-Modus (Kompass) starten'}
              onClick={() => {
                if (arEnabled) disable();
                else void enable();
              }}
            >
              <Compass size={19} strokeWidth={2} aria-hidden />
            </IconButton>
            <IconButton active={showTrails} label="Bahnspuren ein/aus" onClick={toggleTrails}>
              <Orbit size={19} strokeWidth={2} aria-hidden />
            </IconButton>
            <IconButton
              active={nightMode}
              label="Nachtmodus (Rotlicht)"
              onClick={toggleNightMode}
            >
              <MoonStar size={19} strokeWidth={2} aria-hidden />
            </IconButton>
            <IconButton label={THEME_LABEL[theme]} onClick={cycleTheme}>
              <ThemeIcon size={19} strokeWidth={2} aria-hidden />
            </IconButton>
            <IconButton label="Satellitenliste öffnen" onClick={() => setDrawerOpen(true)}>
              <List size={19} strokeWidth={2} aria-hidden />
            </IconButton>
          </div>
        </div>

        {/*
          Echtzeit-Hinweis: sichtbar, solange die Szene nicht in Echtzeit
          läuft und das Blatt zu ist – bei offenem Blatt zeigt dessen Kopf Uhr
          und „Jetzt“, ein zweiter Rückweg daneben wäre doppelt. Ein eigenes
          Element statt einer Zeile in der Infokarte: Auf Telefonbreite steht
          er in einer eigenen Zeile unter Karte und Knöpfen, ab `sm` rechts
          neben der Moduswahl, wo sonst nichts steht. Quer kostet er so keine
          Höhe; eine weitere Zeile schöbe die Hinweiszeilen tiefer, die dort
          bis in die Spalte des Telemetrie-Panels reichen. `sm:-my-1` hält
          die Zeile so hoch wie die Moduswahl, der Knopf selbst behält die
          volle Trefferhöhe und ragt in die Abstände darüber und darunter.

          Akzentfarbe (Rand, Tönung, Symbole) statt der Warntöne der
          Hinweiszeilen: Er ist ein Rückweg, keine Störung. Die Schrift bleibt
          in `text-label`, Systemblau wäre auf der blau getönten Fläche im
          hellen Erscheinungsbild zu kontrastarm. `min-h-[var(--tap)]`: Er ist
          ein Knopf, auch wenn er wie eine Statuszeile aussieht.
        */}
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-2">
          {timeNoticeShown && (
            <button
              type="button"
              onClick={() => engine.resetToRealTime()}
              aria-label={timeNoticeLabel(timeBase.scale)}
              aria-describedby="time-notice-text"
              className="material pointer-events-auto flex min-h-[var(--tap)] w-full max-w-[22rem] min-w-0 items-center gap-1.5 rounded-[var(--radius-sm)] px-3 text-[12.5px] font-semibold text-label sm:order-last sm:-my-1"
              style={{
                backgroundImage:
                  'linear-gradient(color-mix(in srgb, var(--accent) 14%, transparent), color-mix(in srgb, var(--accent) 14%, transparent))',
                borderColor: 'color-mix(in srgb, var(--accent) 45%, transparent)',
              }}
            >
              <Clock size={13} strokeWidth={2.2} className="shrink-0 text-accent" aria-hidden />
              <span id="time-notice-text" ref={timeNoticeRef} className="min-w-0 truncate tabular-nums">
                –
              </span>
              <span className="ml-auto inline-flex shrink-0 items-center gap-1" aria-hidden>
                <History size={13} strokeWidth={2.2} className="text-accent" />
                Jetzt
              </span>
            </button>
          )}

          <div className="material pointer-events-auto w-full max-w-[22rem] rounded-[var(--radius-sm)] p-0 sm:shrink-0">
            <ModeSwitch compact />
          </div>
        </div>

        {!arSupported && (
          <Notice tone="warning">Kein Orientierungssensor erkannt – Touch-Navigation aktiv.</Notice>
        )}

        {arEnabled && compassStatus === 'calibrating' && (
          <Notice tone="warning">
            Kompass unpräzise – Gerät einige Male in einer liegenden Acht bewegen.
          </Notice>
        )}

        {arEnabled && compassStatus === 'relative' && (
          <Notice tone="warning">
            Kein erdfester Kompass verfügbar – Nordrichtung kann abweichen.
          </Notice>
        )}

        {geoError && (
          <Notice tone="warning" icon={<MapPin size={12} strokeWidth={2.2} aria-hidden />}>
            {geoError}
          </Notice>
        )}

        {/* Gleiche Meldung kann mehrfach auflaufen (Retry pro Gruppe) – daher
            Position statt Text als React-Key. */}
        {errors.slice(-2).map((message, i) => (
          <Notice
            key={`${i}-${message}`}
            tone="critical"
            icon={<AlertTriangle size={12} strokeWidth={2.2} aria-hidden />}
          >
            {message}
          </Notice>
        ))}
      </div>

      {/*
        Das Blatt hängt als Letztes an, nach den Hinweiszeilen: Die sind
        Daueranzeigen (Ortung, Kompass, Ladefehler) und bleiben beim Öffnen
        stehen. Quer reichen sie bis in die Spalte des Telemetrie-Panels –
        unter dem Blatt gerieten sie in dessen Kopfzeile. Reicht der Platz
        unter ihnen nicht, legt sich das Blatt über die untersten
        (TimeMachine.tsx, Höhe und Lage des Blatts).
      */}
      {timeOpen && <TimeMachine headRef={headRef} onClose={closeTime} />}
    </div>
  );
});

function Notice({
  tone,
  icon,
  children,
}: {
  tone: 'warning' | 'critical';
  icon?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  const color = tone === 'critical' ? 'var(--critical)' : 'var(--warning)';
  return (
    <div
      role="status"
      className="material pointer-events-none flex max-w-[92vw] items-start gap-1.5 self-start rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[12px] leading-snug"
      style={{ color, borderColor: `color-mix(in srgb, ${color} 34%, transparent)` }}
    >
      {icon && <span className="mt-px shrink-0">{icon}</span>}
      <span>{children}</span>
    </div>
  );
}
