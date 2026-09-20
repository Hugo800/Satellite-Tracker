import { useEffect, useRef } from 'react';
import {
  TELEMETRY_STRIDE,
  T_AZ,
  T_ECLIPSED,
  T_EL,
  T_MAG,
  T_RANGE,
} from '../../math/telemetryLayout';
import { passesSkyFilter } from '../../math/visibility';
import { telemetry, viewState } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import type { SatelliteGroup } from '../../types';

const SIZE = 168;
const PADDING = 16;

const GROUP_COLORS: Record<SatelliteGroup, string> = {
  stations: '#fbbf24',
  brightest: '#f1f5f9',
  weather: '#34d399',
  starlink: '#60a5fa',
};

/**
 * Polar-Radar: Zenit im Mittelpunkt, Horizont am Außenrand.
 *
 * Zeichnet in einer eigenen rAF-Schleife direkt aus den Telemetrie-Buffern –
 * völlig entkoppelt von React und vom R3F-Renderloop.
 */
export function RadarMap(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const catalog = useAppStore((s) => s.catalog);
  const mode = useAppStore((s) => s.filters.mode);
  const selectedIndex = useAppStore((s) => s.selectedIndex);

  const catalogRef = useRef(catalog);
  const modeRef = useRef(mode);
  const selectedRef = useRef(selectedIndex);
  catalogRef.current = catalog;
  modeRef.current = mode;
  selectedRef.current = selectedIndex;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    ctx.scale(dpr, dpr);

    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const radius = SIZE / 2 - PADDING;

    let frame = 0;

    const draw = () => {
      frame = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, SIZE, SIZE);

      // Grundscheibe
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(2, 8, 20, 0.72)';
      ctx.fill();

      // Sichtfeld-Kegel der Kamera
      const hFovRad =
        2 * Math.atan(Math.tan((viewState.fovDeg * Math.PI) / 360) * Math.max(viewState.aspect, 0.1));
      const halfH = (hFovRad * 180) / Math.PI / 2;
      const halfV = viewState.fovDeg / 2;
      const viewAz = viewState.azimuthDeg;
      const viewEl = viewState.elevationDeg;
      const rInner = (1 - Math.min(90, Math.max(-5, viewEl + halfV)) / 90) * radius;
      const rOuter = (1 - Math.min(90, Math.max(-5, viewEl - halfV)) / 90) * radius;
      const a0 = ((viewAz - halfH) * Math.PI) / 180 - Math.PI / 2;
      const a1 = ((viewAz + halfH) * Math.PI) / 180 - Math.PI / 2;

      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0, Math.min(rInner, radius)), a0, a1);
      ctx.arc(cx, cy, Math.max(0, Math.min(rOuter, radius)), a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = 'rgba(56, 189, 248, 0.16)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Elevationsringe 0°/30°/60°
      ctx.strokeStyle = 'rgba(103, 232, 249, 0.28)';
      for (const elevation of [0, 30, 60]) {
        ctx.beginPath();
        ctx.arc(cx, cy, (1 - elevation / 90) * radius, 0, Math.PI * 2);
        ctx.lineWidth = elevation === 0 ? 1.4 : 0.7;
        ctx.stroke();
      }

      // Azimut-Kreuz
      ctx.strokeStyle = 'rgba(103, 232, 249, 0.18)';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(cx - radius, cy);
      ctx.lineTo(cx + radius, cy);
      ctx.moveTo(cx, cy - radius);
      ctx.lineTo(cx, cy + radius);
      ctx.stroke();

      // Satelliten
      const data = telemetry.data;
      const activeMode = modeRef.current;
      const selected = selectedRef.current;

      for (const sat of catalogRef.current) {
        if (sat.index >= telemetry.count) continue;
        const base = sat.index * TELEMETRY_STRIDE;
        const elevation = data[base + T_EL];
        const eclipsed = data[base + T_ECLIPSED] > 0.5;
        if (!Number.isFinite(data[base + T_RANGE])) continue;
        if (
          !passesSkyFilter(
            activeMode,
            sat.group === 'starlink',
            elevation,
            eclipsed,
            data[base + T_MAG],
          )
        ) {
          continue;
        }

        const elevationDeg = (elevation * 180) / Math.PI;
        const azimuthDeg = (data[base + T_AZ] * 180) / Math.PI;
        const r = (1 - elevationDeg / 90) * radius;
        const x = cx + r * Math.sin((azimuthDeg * Math.PI) / 180);
        const y = cy - r * Math.cos((azimuthDeg * Math.PI) / 180);
        const isSelected = selected === sat.index;

        ctx.beginPath();
        ctx.arc(x, y, isSelected ? 3.6 : sat.highlight ? 2.8 : 1.6, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? '#f472b6' : GROUP_COLORS[sat.group];
        ctx.globalAlpha = eclipsed ? 0.22 : 1;
        ctx.fill();
        ctx.globalAlpha = 1;

        if (isSelected) {
          ctx.beginPath();
          ctx.arc(x, y, 7, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(244, 114, 182, 0.8)';
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }

      // Himmelsrichtungen
      ctx.fillStyle = 'rgba(186, 230, 253, 0.85)';
      ctx.font = '600 9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', cx, cy - radius - 7);
      ctx.fillText('S', cx, cy + radius + 7);
      ctx.fillText('O', cx + radius + 7, cy);
      ctx.fillText('W', cx - radius - 7, cy);

      // Zenit-Markierung
      ctx.beginPath();
      ctx.arc(cx, cy, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(103, 232, 249, 0.7)';
      ctx.fill();
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="hud-panel hud-scan pointer-events-none relative overflow-hidden rounded-xl">
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        style={{ width: SIZE, height: SIZE }}
        aria-label="Polar-Radar der sichtbaren Satelliten"
      />
      <span className="absolute left-2 top-1.5 text-[9px] uppercase tracking-[0.18em] text-sky-300/70">
        Radar
      </span>
    </div>
  );
}
