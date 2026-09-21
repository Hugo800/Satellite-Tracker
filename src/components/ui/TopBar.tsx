import { useCallback, useEffect, useRef } from 'react';
import {
  AlertTriangle,
  Compass,
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
import { useDeviceOrientation } from '../../hooks/useDeviceOrientation';
import { TELEMETRY_STRIDE, T_ECLIPSED, T_EL, T_MAG, T_RANGE } from '../../math/telemetryLayout';
import { passesSkyFilter } from '../../math/visibility';
import { catalogIndex, telemetry, viewState } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import { formatCount, formatNumber } from '../../utils/format';
import type { ThemePreference } from '../../types';
import { ModeSwitch } from './ModeSwitch';

const THEME_CYCLE: ThemePreference[] = ['system', 'light', 'dark'];
const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'Erscheinungsbild: System',
  light: 'Erscheinungsbild: Hell',
  dark: 'Erscheinungsbild: Dunkel',
};

function IconButton({
  active,
  label,
  onClick,
  children,
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
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

/** Kopfzeile: Standort, Sonnen-/Mondstand, Blickrichtung und Moduswahl. */
export function TopBar(): React.JSX.Element {
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

  const { enable, disable } = useDeviceOrientation();
  const headingRef = useRef<HTMLSpanElement>(null);
  const skyCountRef = useRef<HTMLSpanElement>(null);

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

  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-2.5 p-3"
      style={{
        paddingTop: 'calc(var(--safe-top) + 0.75rem)',
        paddingLeft: 'calc(var(--safe-left) + 0.75rem)',
        paddingRight: 'calc(var(--safe-right) + 0.75rem)',
      }}
    >
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

        <div className="material pointer-events-auto flex shrink-0 rounded-[var(--radius-md)] p-0.5">
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

      <div className="material pointer-events-auto w-full max-w-[22rem] rounded-[var(--radius-sm)] p-0">
        <ModeSwitch compact />
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
  );
}

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
