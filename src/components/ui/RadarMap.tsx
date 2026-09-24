import { useEffect, useRef } from 'react';
import { GROUP_COLORS, GROUP_ORDER } from '../../data/groups';
import {
  TELEMETRY_STRIDE,
  T_AZ,
  T_ECLIPSED,
  T_EL,
  T_MAG,
  T_RANGE,
} from '../../math/telemetryLayout';
import { passesSkyFilter } from '../../math/visibility';
import { catalogIndex, telemetry, viewState } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import { useResolvedTheme } from '../../hooks/useTheme';

const SIZE = 164;
const PADDING = 17;
const TAU = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;

/** 30 Hz genügen für eine Übersichtskarte und halbieren die Zeichenlast. */
const FRAME_INTERVAL_MS = 1000 / 30;

const GROUP_COLOR_LIST = GROUP_ORDER.map((g) => GROUP_COLORS[g]);

interface Palette {
  disc: string;
  ring: string;
  ringStrong: string;
  cross: string;
  cone: string;
  coneLine: string;
  label: string;
  zenith: string;
  selection: string;
}

const PALETTES: Record<'light' | 'dark', Palette> = {
  dark: {
    disc: 'rgba(0, 0, 0, 0.45)',
    ring: 'rgba(235, 235, 245, 0.18)',
    ringStrong: 'rgba(235, 235, 245, 0.34)',
    cross: 'rgba(235, 235, 245, 0.1)',
    cone: 'rgba(10, 132, 255, 0.18)',
    coneLine: 'rgba(10, 132, 255, 0.5)',
    label: 'rgba(235, 235, 245, 0.66)',
    zenith: 'rgba(235, 235, 245, 0.5)',
    selection: '#ff375f',
  },
  light: {
    // Die Scheibe bleibt auch hier dunkel: Sie bildet den Nachthimmel ab, und
    // helle Gruppenfarben (etwa die der hellsten Objekte, #f5f5f7) wären auf
    // einer hellen Fläche schlicht nicht mehr zu sehen. Gerahmt wird sie vom
    // hellen Material, sodass sie als eingelassene Himmelsansicht wirkt.
    disc: 'rgba(18, 20, 26, 0.9)',
    ring: 'rgba(235, 235, 245, 0.2)',
    ringStrong: 'rgba(235, 235, 245, 0.4)',
    cross: 'rgba(235, 235, 245, 0.12)',
    cone: 'rgba(0, 122, 255, 0.26)',
    coneLine: 'rgba(90, 170, 255, 0.7)',
    // N/S/O/W stehen im Rand *außerhalb* der Scheibe, also auf dem hellen
    // Material – sie folgen deshalb dem Erscheinungsbild, nicht der Scheibe.
    label: 'rgba(60, 60, 67, 0.75)',
    zenith: 'rgba(235, 235, 245, 0.55)',
    selection: '#ff375f',
  },
};

interface Bucket {
  xy: Float32Array;
  length: number;
}

/**
 * Ein Eimer je Gruppe und Beleuchtungszustand, in der Zeichenschleife
 * wiederverwendet. Die Kapazität folgt dem Katalog, damit auch bei
 * fünfstelligen Objektzahlen nichts nachalloziert wird.
 */
function makeBuckets(): { list: Bucket[]; capacity: number } {
  return {
    list: Array.from({ length: GROUP_COLOR_LIST.length * 2 }, () => ({
      xy: new Float32Array(0),
      length: 0,
    })),
    capacity: 0,
  };
}

/**
 * Polar-Radar: Zenit im Mittelpunkt, Horizont am Außenrand.
 *
 * Zeichnet in einer eigenen rAF-Schleife direkt aus den Telemetrie-Buffern –
 * völlig entkoppelt von React und vom R3F-Renderloop. Die Schleife läuft über
 * Indizes statt über Katalogobjekte und nutzt die vorberechneten Gruppenflags;
 * die Punkte werden zudem je Gruppe zu einem einzigen Pfad gebündelt, sodass
 * auch mehrere tausend gleichzeitig sichtbare Objekte mit einer Handvoll
 * `fill()`-Aufrufen auskommen.
 */
export function RadarMap(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mode = useAppStore((s) => s.filters.mode);
  // Platz, nicht NORAD-ID: Die Zeichenschleife vergleicht je Objekt nur
  // Zahlen (`i === selected`). -1 (ID nicht im Katalog) trifft keinen Platz.
  const selectedIndex = useAppStore((s) => s.selectedIndex);
  const scheme = useResolvedTheme();

  const modeRef = useRef(mode);
  const selectedRef = useRef(selectedIndex);
  const paletteRef = useRef(PALETTES[scheme]);
  modeRef.current = mode;
  selectedRef.current = selectedIndex;
  paletteRef.current = PALETTES[scheme];

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
    let lastDrawn = 0;
    const store = makeBuckets();

    const ensureBuckets = (count: number): Bucket[] => {
      if (count > store.capacity) {
        store.capacity = Math.max(1024, Math.ceil(count / 1024) * 1024);
        for (const bucket of store.list) bucket.xy = new Float32Array(store.capacity * 3);
      }
      return store.list;
    };

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - lastDrawn < FRAME_INTERVAL_MS) return;
      lastDrawn = now;

      const p = paletteRef.current;
      ctx.clearRect(0, 0, SIZE, SIZE);

      // Grundscheibe
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.fillStyle = p.disc;
      ctx.fill();

      // Sichtfeld-Kegel der Kamera
      const hFovRad =
        2 * Math.atan(Math.tan(viewState.fovDeg * DEG_TO_RAD * 0.5) * Math.max(viewState.aspect, 0.1));
      const halfH = (hFovRad / DEG_TO_RAD) / 2;
      const halfV = viewState.fovDeg / 2;
      const viewAz = viewState.azimuthDeg;
      const viewEl = viewState.elevationDeg;
      const rInner = (1 - Math.min(90, Math.max(-5, viewEl + halfV)) / 90) * radius;
      const rOuter = (1 - Math.min(90, Math.max(-5, viewEl - halfV)) / 90) * radius;
      const a0 = (viewAz - halfH) * DEG_TO_RAD - Math.PI / 2;
      const a1 = (viewAz + halfH) * DEG_TO_RAD - Math.PI / 2;

      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0, Math.min(rInner, radius)), a0, a1);
      ctx.arc(cx, cy, Math.max(0, Math.min(rOuter, radius)), a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = p.cone;
      ctx.fill();
      ctx.strokeStyle = p.coneLine;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Elevationsringe 0°/30°/60°
      for (const elevation of [0, 30, 60]) {
        ctx.beginPath();
        ctx.arc(cx, cy, (1 - elevation / 90) * radius, 0, TAU);
        ctx.strokeStyle = elevation === 0 ? p.ringStrong : p.ring;
        ctx.lineWidth = elevation === 0 ? 1.2 : 0.6;
        ctx.stroke();
      }

      // Azimut-Kreuz
      ctx.strokeStyle = p.cross;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(cx - radius, cy);
      ctx.lineTo(cx + radius, cy);
      ctx.moveTo(cx, cy - radius);
      ctx.lineTo(cx, cy + radius);
      ctx.stroke();

      /* --- Satelliten: ein Durchlauf, danach je Eimer ein Pfad --- */
      const data = telemetry.data;
      const groupIds = catalogIndex.groupIds;
      const starlinkFlags = catalogIndex.starlink;
      const highlightFlags = catalogIndex.highlight;
      const activeMode = modeRef.current;
      const selected = selectedRef.current;
      const count = telemetry.count;

      let selectedX = 0;
      let selectedY = 0;
      let selectedVisible = false;

      const buckets = ensureBuckets(count);
      for (const bucket of buckets) bucket.length = 0;

      for (let i = 0; i < count; i += 1) {
        const base = i * TELEMETRY_STRIDE;
        if (!Number.isFinite(data[base + T_RANGE])) continue;

        const elevation = data[base + T_EL];
        const eclipsed = data[base + T_ECLIPSED] > 0.5;
        if (
          !passesSkyFilter(
            activeMode,
            starlinkFlags[i] === 1,
            elevation,
            eclipsed,
            data[base + T_MAG],
          )
        ) {
          continue;
        }

        const r = (1 - elevation / DEG_TO_RAD / 90) * radius;
        const azimuth = data[base + T_AZ];
        const x = cx + r * Math.sin(azimuth);
        const y = cy - r * Math.cos(azimuth);

        if (i === selected) {
          selectedX = x;
          selectedY = y;
          selectedVisible = true;
          continue;
        }

        // Eimer = Gruppe × Beleuchtung: Farbe und Deckkraft stehen damit je
        // Pfad fest, und es bleibt bei höchstens zehn `fill()`-Aufrufen.
        const bucket = buckets[(groupIds[i] ?? 0) * 2 + (eclipsed ? 1 : 0)];
        const at = bucket.length;
        bucket.xy[at * 3] = x;
        bucket.xy[at * 3 + 1] = y;
        bucket.xy[at * 3 + 2] = highlightFlags[i] === 1 ? 2.6 : 1.5;
        bucket.length = at + 1;
      }

      for (let b = 0; b < buckets.length; b += 1) {
        const bucket = buckets[b];
        if (bucket.length === 0) continue;
        ctx.globalAlpha = b % 2 === 1 ? 0.28 : 1;
        ctx.beginPath();
        for (let k = 0; k < bucket.length; k += 1) {
          const x = bucket.xy[k * 3];
          const y = bucket.xy[k * 3 + 1];
          const dot = bucket.xy[k * 3 + 2];
          ctx.moveTo(x + dot, y);
          ctx.arc(x, y, dot, 0, TAU);
        }
        ctx.fillStyle = GROUP_COLOR_LIST[b >> 1];
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (selectedVisible) {
        ctx.beginPath();
        ctx.arc(selectedX, selectedY, 3.4, 0, TAU);
        ctx.fillStyle = p.selection;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(selectedX, selectedY, 7, 0, TAU);
        ctx.strokeStyle = p.selection;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // Himmelsrichtungen
      ctx.fillStyle = p.label;
      ctx.font = '600 9.5px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', cx, cy - radius - 8);
      ctx.fillText('S', cx, cy + radius + 8);
      ctx.fillText('O', cx + radius + 8, cy);
      ctx.fillText('W', cx - radius - 8, cy);

      // Zenit-Markierung
      ctx.beginPath();
      ctx.arc(cx, cy, 1.6, 0, TAU);
      ctx.fillStyle = p.zenith;
      ctx.fill();
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="material pointer-events-none relative overflow-hidden rounded-[var(--radius-md)]">
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        style={{ width: SIZE, height: SIZE, display: 'block' }}
        aria-label="Polar-Radar der sichtbaren Satelliten"
      />
      <span className="absolute left-2.5 top-2 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-label-3">
        Radar
      </span>
    </div>
  );
}
