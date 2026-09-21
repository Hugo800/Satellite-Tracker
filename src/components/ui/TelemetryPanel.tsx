import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Crosshair, Eye, EyeOff, Radio, Timer, X } from 'lucide-react';
import { RAD, compassLabel } from '../../math/coords';
import { readSample, requestFocus } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import {
  formatClockShort,
  formatCountdown,
  formatDay,
  formatDurationSec,
  formatNumber,
} from '../../utils/format';
import type { PassPrediction } from '../../types';

function LiveField({
  label,
  unit,
  valueRef,
}: {
  label: string;
  unit: string;
  valueRef: (node: HTMLSpanElement | null) => void;
}): React.JSX.Element {
  return (
    <div
      className="rounded-[var(--radius-sm)] px-2.5 py-2"
      style={{ background: 'var(--fill)' }}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-label-3">
        {label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span ref={valueRef} className="text-[17px] font-semibold tracking-[-0.02em] text-label">
          –
        </span>
        {unit && <span className="text-[11px] text-label-2">{unit}</span>}
      </div>
    </div>
  );
}

/**
 * Ein Überflug in der Liste.
 *
 * Maßgeblich ist das sonnenbeschienene Fenster: Nur darin ist der Satellit
 * überhaupt am Himmel zu sehen – der Rest des Bogens liegt im Erdschatten.
 */
function PassRow({ pass }: { pass: PassPrediction }): React.JSX.Element {
  const sunlit = pass.sunlitSec > 0 && pass.sunlitStart !== null;
  const startMs = sunlit ? (pass.sunlitStart as number) : pass.aos;
  const endMs = sunlit ? (pass.sunlitEnd as number) : pass.los;
  const seconds = sunlit ? pass.sunlitSec : pass.durationSec;

  const badge = !sunlit
    ? { text: 'Erdschatten', color: 'var(--label-2)' }
    : pass.nakedEye
      ? { text: 'bloßes Auge', color: 'var(--highlight)' }
      : { text: 'nur optisch', color: 'var(--accent)' };

  return (
    <li className="rounded-[var(--radius-sm)] px-2.5 py-2" style={{ background: 'var(--fill)' }}>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[11px] text-label-2">{formatDay(startMs)}</span>
        <span className="text-[13px] font-semibold text-label">
          {formatClockShort(startMs)} – {formatClockShort(endMs)}
        </span>
        <span
          className="ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold"
          style={{
            color: badge.color,
            background: `color-mix(in srgb, ${badge.color} 16%, transparent)`,
          }}
        >
          {badge.text}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-label-2">
        <span>{formatDurationSec(seconds)}</span>
        <span>· max. {formatNumber(pass.maxElevationDeg, 0)}°</span>
        <span>
          · {formatNumber(pass.aosAzimuthDeg, 0)}° {compassLabel(pass.aosAzimuthDeg)} →{' '}
          {formatNumber(pass.losAzimuthDeg, 0)}° {compassLabel(pass.losAzimuthDeg)}
        </span>
        {sunlit && (
          <span style={pass.nakedEye ? { color: 'var(--highlight)' } : undefined}>
            · {formatNumber(pass.peakMagnitude, 1)} mag ·{' '}
            {formatNumber(pass.illumination * 100, 0)} % beleuchtet
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * Informationskarte des selektierten Objekts.
 *
 * Die Zahlenwerte werden per rAF direkt in die DOM-Knoten geschrieben –
 * dadurch bleibt der React-Baum bei 10 Hz Telemetrie komplett re-render-frei.
 */
export function TelemetryPanel(): React.JSX.Element | null {
  const selectedIndex = useAppStore((s) => s.selectedIndex);
  const catalogByIndex = useAppStore((s) => s.catalogByIndex);
  const passes = useAppStore((s) => s.passes);
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
        lightRef.current.style.color = sample.eclipsed ? 'var(--label-2)' : 'var(--highlight)';
      }
    };

    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [selectedIndex, expanded]);

  const nextPass = passes.length > 0 ? passes[0] : null;
  useEffect(() => {
    if (!nextPass) return;
    const write = () => {
      if (countdownRef.current) {
        countdownRef.current.textContent = formatCountdown(nextPass.sunlitStart ?? nextPass.aos);
      }
    };
    write();
    const id = window.setInterval(write, 1000);
    return () => window.clearInterval(id);
  }, [nextPass]);

  if (selectedIndex === null) return null;
  const meta = catalogByIndex.get(selectedIndex);

  return (
    <div className="material pointer-events-auto w-[min(92vw,22.5rem)] overflow-hidden rounded-[var(--radius-md)]">
      <div className="hairline-b flex items-center gap-1 px-3 py-2">
        <Radio size={15} strokeWidth={2.2} className="animate-soft-pulse text-accent" aria-hidden />
        <div className="ml-1 min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold tracking-[-0.01em] text-label">
            {meta?.name ?? `Objekt #${selectedIndex}`}
          </div>
          <div className="truncate text-[11px] text-label-2">
            NORAD {meta?.noradId ?? '—'} · {formatNumber(meta?.periodMin ?? 0, 1)} min ·{' '}
            {formatNumber(meta?.inclinationDeg ?? 0, 1)}° Inkl.
          </div>
        </div>
        <button
          type="button"
          aria-label="Kamera auf Objekt ausrichten"
          className="icon-button"
          onClick={() => {
            const sample = readSample(selectedIndex);
            if (sample) requestFocus(sample.azimuth, sample.elevation);
          }}
        >
          <Crosshair size={18} strokeWidth={2} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={expanded ? 'Einklappen' : 'Ausklappen'}
          aria-expanded={expanded}
          className="icon-button"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <ChevronDown size={18} strokeWidth={2} aria-hidden />
          ) : (
            <ChevronUp size={18} strokeWidth={2} aria-hidden />
          )}
        </button>
        <button
          type="button"
          aria-label="Auswahl aufheben"
          className="icon-button"
          onClick={() => select(null)}
        >
          <X size={18} strokeWidth={2} aria-hidden />
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

          <div
            className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-2"
            style={{ background: 'var(--fill)' }}
          >
            {/* Beleuchtungsstatus entscheidet, ob das Objekt am Nachthimmel sichtbar ist. */}
            <Eye size={14} strokeWidth={2.2} style={{ color: 'var(--highlight)' }} aria-hidden />
            <span ref={lightRef} className="text-[12.5px] font-semibold">
              –
            </span>
          </div>

          <div
            className="rounded-[var(--radius-sm)] px-2.5 py-2"
            style={{ background: 'var(--fill)' }}
          >
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-label-3">
              <Timer size={12} strokeWidth={2.2} aria-hidden /> Überflüge · nächste 48 h
              {passes.length > 0 && (
                <span className="ml-auto text-[11px] font-medium normal-case tracking-normal text-accent">
                  <span ref={countdownRef}>–</span>
                </span>
              )}
            </div>

            {passPending && (
              <div className="text-[12.5px] text-label-2">Berechne Ephemeriden …</div>
            )}

            {!passPending && passes.length === 0 && (
              <div className="flex items-center gap-1.5 text-[12.5px] text-label-2">
                <EyeOff size={13} strokeWidth={2.2} aria-hidden /> Kein Überflug in den nächsten 48 h
              </div>
            )}

            {!passPending && passes.length > 0 && (
              <ul className="no-scrollbar max-h-56 space-y-1.5 overflow-y-auto overscroll-contain pr-0.5">
                {passes.map((p) => (
                  <PassRow key={p.aos} pass={p} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
