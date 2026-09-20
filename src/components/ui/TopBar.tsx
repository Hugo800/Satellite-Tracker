import { useEffect, useMemo, useRef } from 'react';
import {
  AlertTriangle,
  Compass,
  List,
  MapPin,
  Moon,
  Orbit,
  Satellite,
  Sunrise,
} from 'lucide-react';
import { compassLabel } from '../../math/coords';
import { useDeviceOrientation } from '../../hooks/useDeviceOrientation';
import { TELEMETRY_STRIDE, T_ECLIPSED, T_EL, T_MAG, T_RANGE } from '../../math/telemetryLayout';
import { passesSkyFilter } from '../../math/visibility';
import { telemetry, viewState } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import { formatNumber } from '../../utils/format';
import { ModeSwitch } from './ModeSwitch';

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
      className={`flex h-10 w-10 items-center justify-center rounded-lg border transition ${
        active
          ? 'border-sky-400/70 bg-sky-400/25 text-sky-100'
          : 'border-sky-400/20 bg-slate-900/70 text-sky-300 hover:bg-sky-400/10'
      }`}
    >
      {children}
    </button>
  );
}

/** Kopfzeile: Standort, Sonnen-/Mondstand, Blickrichtung und Moduswahl. */
export function TopBar(): React.JSX.Element {
  const observer = useAppStore((s) => s.observer);
  const sun = useAppStore((s) => s.sun);
  const moon = useAppStore((s) => s.moon);
  const status = useAppStore((s) => s.status);
  const loading = useAppStore((s) => s.loading);
  const catalog = useAppStore((s) => s.catalog);
  const mode = useAppStore((s) => s.filters.mode);
  const arEnabled = useAppStore((s) => s.arEnabled);
  const arSupported = useAppStore((s) => s.arSupported);
  const compassStatus = useAppStore((s) => s.compassStatus);
  const nightMode = useAppStore((s) => s.nightMode);
  const toggleNightMode = useAppStore((s) => s.toggleNightMode);
  const showTrails = useAppStore((s) => s.showTrails);
  const toggleTrails = useAppStore((s) => s.toggleTrails);
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen);
  const errors = useAppStore((s) => s.errors);
  const geoError = useAppStore((s) => s.geoError);

  const { enable, disable } = useDeviceOrientation();
  const headingRef = useRef<HTMLSpanElement>(null);
  const skyCountRef = useRef<HTMLSpanElement>(null);

  const starlinkFlags = useMemo(() => {
    let maxIndex = 0;
    for (const meta of catalog) maxIndex = Math.max(maxIndex, meta.index);
    const flags = new Uint8Array(maxIndex + 1);
    for (const meta of catalog) flags[meta.index] = meta.group === 'starlink' ? 1 : 0;
    return flags;
  }, [catalog]);

  // Nur 1 Hz und ohne Re-Render: Der Zähler macht sichtbar, dass stets nur ein
  // kleiner Teil des Katalogs gleichzeitig über dem Horizont steht.
  useEffect(() => {
    const update = () => {
      const node = skyCountRef.current;
      if (!node) return;
      const data = telemetry.data;
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
      node.textContent = String(count);
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [mode, starlinkFlags]);

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

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-2 p-3"
      style={{ paddingTop: 'calc(var(--safe-top) + 0.75rem)' }}
    >
      <div className="flex items-start gap-2">
        <div className="hud-panel hud-scan pointer-events-auto relative min-w-0 flex-1 overflow-hidden rounded-xl px-3 py-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.18em] text-sky-200 uppercase">
            <Satellite size={13} className={loading ? 'animate-hud-pulse' : ''} />
            Orbital Atlas
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-sky-300/70">
            <span
              className="inline-flex items-center gap-1 tabular-nums"
              title="Objekte im Sichtbereich / Objekte im Katalog"
            >
              <Orbit size={10} />
              <span ref={skyCountRef}>0</span>/{catalog.length} Obj.
            </span>
            <span className="inline-flex items-center gap-1">
              <MapPin size={10} />
              {observer
                ? `${formatNumber(observer.latitudeDeg, 3)}°, ${formatNumber(observer.longitudeDeg, 3)}°`
                : 'Ortung läuft …'}
            </span>
            <span className="inline-flex items-center gap-1">
              <Sunrise size={10} />
              Sonne {formatNumber(sun.altitudeDeg, 0)}°
            </span>
            <span className="inline-flex items-center gap-1">
              <Moon size={10} />
              Mond {formatNumber(moon.altitudeDeg, 0)}°
            </span>
            <span className="inline-flex items-center gap-1">
              <Compass size={10} />
              <span ref={headingRef} className="tabular-nums">
                –
              </span>
            </span>
          </div>

          <div className="mt-0.5 truncate text-[10px] text-slate-500">{status}</div>
        </div>

        <div className="pointer-events-auto flex gap-1.5">
          <IconButton
            active={arEnabled}
            label={arEnabled ? 'AR-Modus beenden' : 'AR-Modus (Kompass) starten'}
            onClick={() => {
              if (arEnabled) disable();
              else void enable();
            }}
          >
            <Compass size={18} />
          </IconButton>
          <IconButton active={showTrails} label="Bahnspur ein/aus" onClick={toggleTrails}>
            <Orbit size={18} />
          </IconButton>
          <IconButton active={nightMode} label="Nachtmodus (Rotlicht)" onClick={toggleNightMode}>
            <Moon size={18} />
          </IconButton>
          <IconButton label="Satellitenliste" onClick={() => setDrawerOpen(true)}>
            <List size={18} />
          </IconButton>
        </div>
      </div>

      {!arSupported && (
        <div className="pointer-events-none self-start rounded-md border border-amber-400/30 bg-amber-950/40 px-2 py-1 text-[10px] text-amber-200">
          Kein Orientierungssensor erkannt – Touch-Navigation aktiv.
        </div>
      )}

      <div className="pointer-events-auto w-full max-w-xs">
        <ModeSwitch compact />
      </div>

      {arEnabled && compassStatus === 'calibrating' && (
        <div className="pointer-events-none self-start rounded-md border border-amber-400/30 bg-amber-950/40 px-2 py-1 text-[10px] text-amber-200">
          Kompass unpräzise – Gerät einige Male in einer liegenden Acht bewegen.
        </div>
      )}

      {arEnabled && compassStatus === 'relative' && (
        <div className="pointer-events-none self-start rounded-md border border-amber-400/30 bg-amber-950/40 px-2 py-1 text-[10px] text-amber-200">
          Kein erdfester Kompass verfügbar – Nordrichtung kann abweichen.
        </div>
      )}

      {geoError && (
        <div className="pointer-events-none flex max-w-[92vw] items-start gap-1.5 self-start rounded-md border border-amber-400/30 bg-amber-950/40 px-2 py-1 text-[10px] text-amber-200">
          <MapPin size={11} className="mt-px shrink-0" />
          <span>{geoError}</span>
        </div>
      )}

      {/* Gleiche Meldung kann mehrfach auflaufen (Retry pro Gruppe) – daher
          Position statt Text als React-Key. */}
      {errors.slice(-2).map((message, i) => (
        <div
          key={`${i}-${message}`}
          className="pointer-events-none flex max-w-[92vw] items-start gap-1.5 self-start rounded-md border border-rose-400/30 bg-rose-950/50 px-2 py-1 text-[10px] text-rose-200"
        >
          <AlertTriangle size={11} className="mt-px shrink-0" />
          <span>{message}</span>
        </div>
      ))}
    </div>
  );
}
