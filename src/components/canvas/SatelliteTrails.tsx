import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { BufferAttribute, BufferGeometry, Color, LineSegments } from 'three';
import { DEG, angleDelta } from '../../math/coords';
import { TELEMETRY_STRIDE, T_AZ, T_ECLIPSED, T_EL, T_MAG, T_RANGE } from '../../math/telemetryLayout';
import { passesSkyFilter } from '../../math/visibility';
import { telemetry } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import { GROUP_COLORS, GROUP_ORDER, MAX_INSTANCES, SKY_RADIUS } from './SatelliteField';

/** Anzahl gespeicherter Stützstellen je Satellit. */
const HISTORY_LEN = 20;
/** Abstand der Stützstellen – 20 × 900 ms = 18 s zurückliegende Bahn (≈ 6° bei LEO). */
const SAMPLE_INTERVAL_MS = 900;
/**
 * Obergrenze gleichzeitig gezeichneter Spuren. Im Modus „Alle“ können mehrere
 * hundert Objekte über dem Horizont stehen; der Puffer bleibt trotzdem fix.
 */
const MAX_TRAILS = 900;
const MAX_VERTICES = MAX_TRAILS * HISTORY_LEN * 2;

const TRAIL_RADIUS = SKY_RADIUS * 0.995;
/** Deckkraft am Kopf der Spur; zum Ende läuft sie auf 0 aus. */
const HEAD_ALPHA = 0.75;
/** Segmente mit größerem Azimutsprung stammen aus einer Lücke – nicht verbinden. */
const MAX_SEGMENT_STEP = 0.5;

const STARLINK_GROUP_ID = GROUP_ORDER.indexOf('starlink');

const vertexShader = /* glsl */ `
  attribute vec3 aColor;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision mediump float;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    if (vAlpha < 0.01) discard;
    gl_FragColor = vec4(vColor, vAlpha);
  }
`;

/**
 * Bewegungsspuren: zeigt für jeden dargestellten Satelliten den zuletzt
 * zurückgelegten Bahnabschnitt als ausblendenden Schweif.
 *
 * Alles liegt in vorab allozierten Typed Arrays; pro Telemetrie-Tick wird nur
 * der genutzte Bereich neu befüllt und per `setDrawRange` gezeichnet.
 */
export function SatelliteTrails(): React.JSX.Element | null {
  const lineRef = useRef<LineSegments>(null);
  const catalog = useAppStore((s) => s.catalog);
  const mode = useAppStore((s) => s.filters.mode);
  const showTrails = useAppStore((s) => s.showTrails);

  const modeRef = useRef(mode);
  modeRef.current = mode;

  const groupIds = useMemo(() => {
    const ids = new Uint8Array(MAX_INSTANCES);
    catalog.forEach((sat) => {
      if (sat.index < MAX_INSTANCES) ids[sat.index] = GROUP_ORDER.indexOf(sat.group);
    });
    return ids;
  }, [catalog]);

  const palette = useMemo(() => GROUP_ORDER.map((g) => new Color(GROUP_COLORS[g])), []);

  const buffers = useMemo(
    () => ({
      histAz: new Float32Array(MAX_INSTANCES * HISTORY_LEN),
      histEl: new Float32Array(MAX_INSTANCES * HISTORY_LEN),
      positions: new Float32Array(MAX_VERTICES * 3),
      colors: new Float32Array(MAX_VERTICES * 3),
      alphas: new Float32Array(MAX_VERTICES),
    }),
    [],
  );

  const history = useRef({ writeIndex: 0, filled: 0, lastSampleMs: 0, revision: -1 });

  // Nach einem Katalogwechsel zeigen die alten Indizes auf andere Objekte.
  useEffect(() => {
    history.current.filled = 0;
    history.current.writeIndex = 0;
  }, [catalog]);

  const geometry = useMemo(() => {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(buffers.positions, 3));
    geo.setAttribute('aColor', new BufferAttribute(buffers.colors, 3));
    geo.setAttribute('aAlpha', new BufferAttribute(buffers.alphas, 1));
    geo.setDrawRange(0, 0);
    return geo;
  }, [buffers]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame(() => {
    const line = lineRef.current;
    if (!line) return;

    const state = history.current;
    if (state.revision === telemetry.revision) return;
    state.revision = telemetry.revision;

    const count = Math.min(telemetry.count, MAX_INSTANCES);
    if (count === 0) {
      geometry.setDrawRange(0, 0);
      return;
    }

    const data = telemetry.data;
    const now = telemetry.timeMs;

    if (now - state.lastSampleMs >= SAMPLE_INTERVAL_MS) {
      state.lastSampleMs = now;
      for (let i = 0; i < count; i += 1) {
        const base = i * TELEMETRY_STRIDE;
        const slot = i * HISTORY_LEN + state.writeIndex;
        buffers.histAz[slot] = data[base + T_AZ];
        buffers.histEl[slot] = data[base + T_EL];
      }
      state.writeIndex = (state.writeIndex + 1) % HISTORY_LEN;
      state.filled = Math.min(state.filled + 1, HISTORY_LEN);
    }

    if (state.filled < 2) {
      geometry.setDrawRange(0, 0);
      return;
    }

    const activeMode = modeRef.current;
    let vertex = 0;

    for (let i = 0; i < count && vertex + HISTORY_LEN * 2 <= MAX_VERTICES; i += 1) {
      const base = i * TELEMETRY_STRIDE;
      const groupId = groupIds[i];
      const shown =
        Number.isFinite(data[base + T_RANGE]) &&
        passesSkyFilter(
          activeMode,
          groupId === STARLINK_GROUP_ID,
          data[base + T_EL],
          data[base + T_ECLIPSED] > 0.5,
          data[base + T_MAG],
        );
      if (!shown) continue;

      const color = palette[groupId];

      // Von der ältesten Stützstelle bis zur aktuellen Position.
      let prevAz = 0;
      let prevEl = 0;
      let hasPrev = false;

      for (let k = 0; k <= state.filled; k += 1) {
        let az: number;
        let el: number;

        if (k === state.filled) {
          az = data[base + T_AZ];
          el = data[base + T_EL];
        } else {
          const slot =
            i * HISTORY_LEN +
            ((state.writeIndex - state.filled + k + HISTORY_LEN * 2) % HISTORY_LEN);
          az = buffers.histAz[slot];
          el = buffers.histEl[slot];
        }

        if (hasPrev && el > 0 && prevEl > 0 && Math.abs(angleDelta(az, prevAz)) < MAX_SEGMENT_STEP) {
          const alphaTail = (HEAD_ALPHA * (k - 1)) / state.filled;
          const alphaHead = (HEAD_ALPHA * k) / state.filled;
          vertex = writeSegment(
            buffers,
            vertex,
            prevAz,
            prevEl,
            az,
            el,
            color,
            alphaTail,
            alphaHead,
          );
        }

        prevAz = az;
        prevEl = el;
        hasPrev = true;
      }
    }

    geometry.setDrawRange(0, vertex);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aColor.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
    if (vertex > 0) geometry.computeBoundingSphere();
  });

  if (!showTrails) return null;

  return (
    <lineSegments ref={lineRef} geometry={geometry} frustumCulled={false} renderOrder={4}>
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        depthTest={false}
      />
    </lineSegments>
  );
}

interface TrailBuffers {
  positions: Float32Array;
  colors: Float32Array;
  alphas: Float32Array;
}

/** Schreibt ein Liniensegment (zwei Vertices) und liefert den neuen Schreibindex. */
function writeSegment(
  buffers: TrailBuffers,
  vertex: number,
  az0: number,
  el0: number,
  az1: number,
  el1: number,
  color: Color,
  alpha0: number,
  alpha1: number,
): number {
  const write = (index: number, az: number, el: number, alpha: number) => {
    const cosEl = Math.cos(el);
    buffers.positions[index * 3 + 0] = TRAIL_RADIUS * cosEl * Math.sin(az);
    buffers.positions[index * 3 + 1] = TRAIL_RADIUS * Math.sin(el);
    buffers.positions[index * 3 + 2] = -TRAIL_RADIUS * cosEl * Math.cos(az);
    buffers.colors[index * 3 + 0] = color.r;
    buffers.colors[index * 3 + 1] = color.g;
    buffers.colors[index * 3 + 2] = color.b;
    // Horizontnahe Abschnitte zusätzlich ausblenden.
    buffers.alphas[index] = alpha * Math.min(1, Math.max(0, el / (4 * DEG)));
  };

  write(vertex, az0, el0, alpha0);
  write(vertex + 1, az1, el1, alpha1);
  return vertex + 2;
}
