import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Crosshair,
  Eye,
  EyeOff,
  Radio,
  Timer,
  X,
} from 'lucide-react';
import { RAD, compassLabel } from '../../math/coords';
import { readSample, requestFocus } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import { formatClock, formatCountdown, formatDurationSec, formatNumber } from '../../utils/format';

interface LiveFieldProps {
  label: string;
  unit: string;
}

function LiveField({
  label,
  unit,
  valueRef,
}: LiveFieldProps & { valueRef: (node: HTMLSpanElement | null) => void }): React.JSX.Element {
  return (
    <div className="rounded-md border border-sky-400/15 bg-sky-950/30 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-[0.16em] text-sky-300/60">{label}</div>
      <div className="flex items-baseline gap-1">
        <span ref={valueRef} className="text-base font-semibold text-sky-100 tabular-nums">
          –
        </span>
        <span className="text-[10px] text-sky-300/60">{unit}</span>
      </div>
    </div>
  );
}

/**
 * Sci-Fi-HUD mit Live-Telemetrie des selektierten Objekts.
 *
 * Die Zahlenwerte werden per rAF direkt in die DOM-Knoten geschrieben –
 * dadurch bleibt der React-Baum bei 10 Hz Telemetrie komplett re-render-frei.
 */
export function TelemetryPanel(): React.JSX.Element | null {
  const selectedIndex = useAppStore((s) => s.selectedIndex);
  const catalogByIndex = useAppStore((s) => s.catalogByIndex);
  const pass = useAppStore((s) => s.pass);
  const passPending = useAppStore((s) => s.passPending);
  const select = useAppStore((s) => s.select);
  const [expanded, setExpanded] = useState(true);

  const elevationRef = useRef<HTMLSpanElement | null>(null);
  const azimuthRef = useRef<HTMLSpanElement | null>(null);
  const altitudeRef = useRef<HTMLSpanElement | null>(null);
  const rangeRef = useRef<HTMLSpanElement | null>(null);
  const speedRef = useRef<HTMLSpanElement | null>(null);
  const subPointRef = useRef<HTMLSpanElement | null>(null);
  const lightRef = useRef<HTMLSpanElement | null>(null);
  const countdownRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (selectedIndex === null) return;
    let frame = 0;

    const update = () => {
      frame = requestAnimationFrame(update);
      const sample = readSample(selectedIndex);
      if (!sample) return;

      const azimuthDeg = sample.azimuth * RAD;
      const elevationDeg = sample.elevation * RAD;

      if (elevationRef.current) elevationRef.current.textContent = formatNumber(elevationDeg, 2);
      if (azimuthRef.current) {
        azimuthRef.current.textContent = `${formatNumber(azimuthDeg, 1)}° ${compassLabel(azimuthDeg)}`;
      }
      if (altitudeRef.current) altitudeRef.current.textContent = formatNumber(sample.altitudeKm, 1);
      if (rangeRef.current) rangeRef.current.textContent = formatNumber(sample.rangeKm, 1);
      if (speedRef.current) speedRef.current.textContent = formatNumber(sample.speedKmS, 3);
      if (subPointRef.current) {
        subPointRef.current.textContent = `${formatNumber(sample.latitudeDeg, 2)}° / ${formatNumber(
          sample.longitudeDeg,
          2,
        )}°`;
      }
      if (lightRef.current) {
        lightRef.current.textContent = sample.eclipsed ? 'Erdschatten' : 'Sonnenbeschienen';
        lightRef.current.className = sample.eclipsed
          ? 'text-[11px] font-semibold text-slate-400'
          : 'text-[11px] font-semibold text-amber-300';
      }
    };

    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [selectedIndex, expanded]);

  useEffect(() => {
    if (!pass) return;
    const id = window.setInterval(() => {
      if (countdownRef.current) countdownRef.current.textContent = formatCountdown(pass.aos);
    }, 1000);
    if (countdownRef.current) countdownRef.current.textContent = formatCountdown(pass.aos);
    return () => window.clearInterval(id);
  }, [pass]);

  if (selectedIndex === null) return null;
  const meta = catalogByIndex.get(selectedIndex);

  return (
    <div className="hud-panel hud-scan pointer-events-auto relative w-[min(92vw,22rem)] overflow-hidden rounded-xl">
      <div className="flex items-center gap-2 border-b border-sky-400/20 px-3 py-2">
        <Radio size={14} className="text-sky-300 animate-hud-pulse" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold tracking-wide text-sky-100">
            {meta?.name ?? `Objekt #${selectedIndex}`}
          </div>
          <div className="truncate text-[10px] uppercase tracking-[0.18em] text-sky-300/60">
            NORAD {meta?.noradId ?? '—'} · {formatNumber(meta?.periodMin ?? 0, 1)} min Periode ·{' '}
            {formatNumber(meta?.inclinationDeg ?? 0, 1)}° Inklination
          </div>
        </div>
        <button
          type="button"
          aria-label="Kamera ausrichten"
          className="rounded p-1 text-sky-300 transition hover:bg-sky-400/15"
          onClick={() => {
            const sample = readSample(selectedIndex);
            if (sample) requestFocus(sample.azimuth, sample.elevation);
          }}
        >
          <Crosshair size={16} />
        </button>
        <button
          type="button"
          aria-label={expanded ? 'Einklappen' : 'Ausklappen'}
          className="rounded p-1 text-sky-300 transition hover:bg-sky-400/15"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
        <button
          type="button"
          aria-label="Auswahl aufheben"
          className="rounded p-1 text-sky-300 transition hover:bg-sky-400/15"
          onClick={() => select(null)}
        >
          <X size={16} />
        </button>
      </div>

      {expanded && (
        <div className="space-y-2 px-3 py-2.5">
          <div className="grid grid-cols-3 gap-1.5">
            <LiveField
              label="Elevation"
              unit="°"
              valueRef={(n) => {
                elevationRef.current = n;
              }}
            />
            <LiveField
              label="Azimut"
              unit=""
              valueRef={(n) => {
                azimuthRef.current = n;
              }}
            />
            <LiveField
              label="Distanz"
              unit="km"
              valueRef={(n) => {
                rangeRef.current = n;
              }}
            />
            <LiveField
              label="Bahnhöhe"
              unit="km"
              valueRef={(n) => {
                altitudeRef.current = n;
              }}
            />
            <LiveField
              label="Speed"
              unit="km/s"
              valueRef={(n) => {
                speedRef.current = n;
              }}
            />
            <LiveField
              label="Subpunkt"
              unit=""
              valueRef={(n) => {
                subPointRef.current = n;
              }}
            />
          </div>

          <div className="flex items-center gap-2 rounded-md border border-sky-400/15 bg-sky-950/30 px-2 py-1.5">
            {/* Beleuchtungsstatus entscheidet, ob das Objekt am Nachthimmel sichtbar ist. */}
            <Eye size={13} className="text-amber-300" />
            <span ref={lightRef} className="text-[11px] font-semibold text-amber-300">
              –
            </span>
          </div>

          <div className="rounded-md border border-sky-400/15 bg-sky-950/30 px-2 py-2">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-sky-300/60">
              <Timer size={12} /> Nächster Überflug
            </div>

            {passPending && <div className="text-xs text-sky-300/70">Berechne Ephemeriden …</div>}

            {!passPending && !pass && (
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <EyeOff size={12} /> Kein Überflug in den nächsten 48 h
              </div>
            )}

            {!passPending && pass && (
              <div className="space-y-1 text-xs text-sky-100">
                <div className="flex items-center justify-between">
                  <span className="text-sky-300/70">AOS (Aufgang)</span>
                  <span className="tabular-nums">
                    {formatClock(pass.aos)} · {formatNumber(pass.aosAzimuthDeg, 0)}°{' '}
                    {compassLabel(pass.aosAzimuthDeg)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sky-300/70">TCA (Höchststand)</span>
                  <span className="tabular-nums">
                    {formatClock(pass.tca)} · {formatNumber(pass.maxElevationDeg, 0)}° Elev.
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sky-300/70">LOS (Untergang)</span>
                  <span className="tabular-nums">
                    {formatClock(pass.los)} · {formatNumber(pass.losAzimuthDeg, 0)}°{' '}
                    {compassLabel(pass.losAzimuthDeg)}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t border-sky-400/10 pt-1">
                  <span ref={countdownRef} className="font-semibold text-sky-200">
                    –
                  </span>
                  <span className="text-sky-300/70">
                    {formatDurationSec(pass.durationSec)} ·{' '}
                    {pass.visible ? 'sonnenbeschienen' : 'im Erdschatten'}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
