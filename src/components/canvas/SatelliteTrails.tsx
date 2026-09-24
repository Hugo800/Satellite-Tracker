import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, LineSegments } from 'three';
import { DEG, angleDelta } from '../../math/coords';
import { TELEMETRY_STRIDE, T_AZ, T_ECLIPSED, T_EL, T_MAG, T_RANGE } from '../../math/telemetryLayout';
import { passesSkyFilter } from '../../math/visibility';
import { catalogIndex, telemetry } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import { GROUP_COLORS, GROUP_ORDER, SKY_RADIUS } from '../../data/groups';

/** Anzahl gespeicherter Stützstellen je Satellit. */
const HISTORY_LEN = 20;
/**
 * Abstand der Stützstellen in *virtueller* Zeit – in Echtzeit maximal
 * 20 × 900 ms = 18 s zurückliegende Bahn.
 *
 * Im Zeitraffer ab ×9 liegt schon zwischen zwei Ticks im Zieltakt (100 ms)
 * mindestens dieser Abstand – bei ×9 genau er, darüber mehr –, und jeder
 * solche Tick wird Stützstelle. Das ist gewollt: Die Spur zeigt dann die Bahn
 * der letzten 20 Ticks, begrenzt durch `MAX_TRAIL_ARC`. In Echtzeit
 * abgetastet, lägen bei ×600 zwischen zwei Stützstellen 9 min Bahn – für ein
 * LEO-Objekt der größte Teil eines Überflugs, ein einziges Segment weit über
 * `MAX_TRAIL_ARC`.
 */
const SAMPLE_INTERVAL_MS = 900;
/** Kapazität wächst blockweise mit dem Katalog – es gibt keine feste Obergrenze. */
const CAPACITY_CHUNK = 2048;

const TRAIL_RADIUS = SKY_RADIUS * 0.995;
/** Deckkraft am Kopf der Spur; zum Ende läuft sie auf 0 aus. */
const HEAD_ALPHA = 0.75;
/** Segmente mit größerem Azimutsprung stammen aus einer Lücke – nicht verbinden. */
const MAX_SEGMENT_STEP = 0.5;
/**
 * Maximale Winkellänge einer Spur – unabhängig von Zeitfenster oder
 * Winkelgeschwindigkeit des Satelliten, damit die Spur immer nur ein kurzes
 * Stück (≈ 3 cm bei typischem Zoom/Betrachtungsabstand) hinter dem Objekt
 * herzieht statt sich über Minuten hinweg über den Bildschirm zu ziehen.
 */
const MAX_TRAIL_ARC = 4 * DEG;

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

interface TrailBufferSet {
  capacity: number;
  histAz: Float32Array;
  histEl: Float32Array;
  positions: Float32Array;
  colors: Float32Array;
  alphas: Float32Array;
  tmpAz: Float32Array;
  tmpEl: Float32Array;
}

function createBuffers(capacity: number): TrailBufferSet {
  const vertices = capacity * HISTORY_LEN * 2;
  return {
    capacity,
    histAz: new Float32Array(capacity * HISTORY_LEN),
    histEl: new Float32Array(capacity * HISTORY_LEN),
    positions: new Float32Array(vertices * 3),
    colors: new Float32Array(vertices * 3),
    alphas: new Float32Array(vertices),
    // Wiederverwendete Kratzer für die Stützstellen eines einzelnen Satelliten,
    // um pro Frame keine neuen Arrays zu allozieren.
    tmpAz: new Float32Array(HISTORY_LEN + 1),
    tmpEl: new Float32Array(HISTORY_LEN + 1),
  };
}

/**
 * Bewegungsspuren: zeigt für jeden dargestellten Satelliten den zuletzt
 * zurückgelegten Bahnabschnitt als ausblendenden Schweif.
 *
 * Alles liegt in vorab allozierten Typed Arrays, deren Größe dem Katalog folgt
 * – eine feste Obergrenze an gleichzeitig gezeichneten Spuren gibt es nicht.
 * Pro Telemetrie-Tick wird nur der genutzte Bereich neu befüllt, per
 * `addUpdateRange` hochgeladen und per `setDrawRange` gezeichnet.
 */
export function SatelliteTrails(): React.JSX.Element | null {
  const lineRef = useRef<LineSegments>(null);
  const catalog = useAppStore((s) => s.catalog);
  const mode = useAppStore((s) => s.filters.mode);
  const showTrails = useAppStore((s) => s.showTrails);

  const modeRef = useRef(mode);
  modeRef.current = mode;

  const capacity = Math.max(
    CAPACITY_CHUNK,
    Math.ceil(Math.max(catalog.length, telemetry.count) / CAPACITY_CHUNK) * CAPACITY_CHUNK,
  );

  const buffers = useMemo(() => createBuffers(capacity), [capacity]);
  const palette = useMemo(() => GROUP_ORDER.map((g) => new Color(GROUP_COLORS[g])), []);

  const history = useRef({
    writeIndex: 0,
    filled: 0,
    lastSampleMs: 0,
    revision: -1,
    /** `telemetry.epoch` der Stützstellen im Ringpuffer. */
    epoch: -1,
    /** Vorzeichen des letzten Abtastschritts: 1 vorwärts, −1 rückwärts, 0 noch unbekannt. */
    direction: 0,
  });

  // Neue Buffer starten leer; erst nach zwei Abtastungen entsteht wieder ein Segment.
  useEffect(() => {
    history.current.filled = 0;
    history.current.writeIndex = 0;
    history.current.revision = -1;
    history.current.direction = 0;
  }, [buffers]);

  const { geometry, attributes } = useMemo(() => {
    const geo = new BufferGeometry();
    const position = new BufferAttribute(buffers.positions, 3);
    const color = new BufferAttribute(buffers.colors, 3);
    const alpha = new BufferAttribute(buffers.alphas, 1);
    for (const attribute of [position, color, alpha]) attribute.setUsage(DynamicDrawUsage);
    geo.setAttribute('position', position);
    geo.setAttribute('aColor', color);
    geo.setAttribute('aAlpha', alpha);
    geo.setDrawRange(0, 0);
    return { geometry: geo, attributes: { position, color, alpha } };
  }, [buffers]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame(() => {
    const line = lineRef.current;
    if (!line) return;

    const state = history.current;
    if (state.revision === telemetry.revision) return;
    state.revision = telemetry.revision;

    const count = Math.min(telemetry.count, buffers.capacity);
    if (count === 0) {
      geometry.setDrawRange(0, 0);
      return;
    }

    const data = telemetry.data;
    const now = telemetry.timeMs;
    const maxVertices = buffers.alphas.length;

    // Zeitsprung: Die Stützstellen stammen aus der alten Zeit. Verbunden mit
    // der neuen Position ergäben sie Segmente quer über den Himmel, und nach
    // einem Sprung zurück läge `now` vor der letzten Stützstelle.
    if (state.epoch !== telemetry.epoch) {
      state.epoch = telemetry.epoch;
      state.filled = 0;
      state.writeIndex = 0;
      state.direction = 0;
    }

    // Betrag statt Differenz: Im Rückwärtslauf wird `now` kleiner, und
    // `now - lastSampleMs` bliebe für immer negativ – die Spuren stünden.
    const step = now - state.lastSampleMs;
    if (state.filled === 0 || Math.abs(step) >= SAMPLE_INTERVAL_MS) {
      const direction = state.filled === 0 ? 0 : Math.sign(step);
      if (direction !== 0 && state.direction !== 0 && direction !== state.direction) {
        // Richtungsumkehr: Die bisherigen Stützstellen liegen jetzt vor dem
        // Objekt, nicht hinter ihm. Die Spur beginnt am Umkehrpunkt neu.
        state.filled = 0;
        state.writeIndex = 0;
        state.direction = 0;
      } else if (direction !== 0) {
        state.direction = direction;
      }
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
    const groupIds = catalogIndex.groupIds;
    const starlinkFlags = catalogIndex.starlink;
    let vertex = 0;

    for (let i = 0; i < count && vertex + HISTORY_LEN * 2 <= maxVertices; i += 1) {
      const base = i * TELEMETRY_STRIDE;
      const groupId = groupIds[i] ?? 0;
      const shown =
        Number.isFinite(data[base + T_RANGE]) &&
        passesSkyFilter(
          activeMode,
          starlinkFlags[i] === 1,
          data[base + T_EL],
          data[base + T_ECLIPSED] > 0.5,
          data[base + T_MAG],
        );
      if (!shown) continue;

      const color = palette[groupId] ?? palette[0];
      const filled = state.filled;

      // Stützstellen einmal in einen Kratzer laden (Ringpuffer + aktuelle Position).
      for (let k = 0; k <= filled; k += 1) {
        if (k === filled) {
          buffers.tmpAz[k] = data[base + T_AZ];
          buffers.tmpEl[k] = data[base + T_EL];
        } else {
          const slot =
            i * HISTORY_LEN + ((state.writeIndex - filled + k + HISTORY_LEN * 2) % HISTORY_LEN);
          buffers.tmpAz[k] = buffers.histAz[slot];
          buffers.tmpEl[k] = buffers.histEl[slot];
        }
      }

      // Von hinten (Kopf) nach vorn (Schwanz) die zurückgelegte Winkellänge
      // aufsummieren und dort abschneiden, wo `MAX_TRAIL_ARC` erreicht ist –
      // so bleibt die Spur immer gleich kurz, egal wie schnell/lang die
      // Historie ist.
      let startK = 0;
      let arc = 0;
      for (let j = filled; j >= 1; j -= 1) {
        const az1 = buffers.tmpAz[j];
        const el1 = buffers.tmpEl[j];
        const az0 = buffers.tmpAz[j - 1];
        const el0 = buffers.tmpEl[j - 1];
        const gap = el1 <= 0 || el0 <= 0 || Math.abs(angleDelta(az1, az0)) >= MAX_SEGMENT_STEP;
        if (gap) {
          startK = j;
          break;
        }
        arc += Math.hypot(angleDelta(az1, az0), el1 - el0);
        if (arc > MAX_TRAIL_ARC) {
          startK = j;
          break;
        }
        startK = j - 1;
      }

      const span = Math.max(1, filled - startK);

      // Von der abgeschnittenen ältesten Stützstelle bis zur aktuellen Position.
      let prevAz = 0;
      let prevEl = 0;
      let hasPrev = false;

      for (let k = startK; k <= filled; k += 1) {
        const az = buffers.tmpAz[k];
        const el = buffers.tmpEl[k];

        if (hasPrev && el > 0 && prevEl > 0 && Math.abs(angleDelta(az, prevAz)) < MAX_SEGMENT_STEP) {
          const alphaTail = (HEAD_ALPHA * (k - 1 - startK)) / span;
          const alphaHead = (HEAD_ALPHA * (k - startK)) / span;
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
    if (vertex > 0) {
      // Nur den beschriebenen Bereich hochladen – bei wenigen Spuren bleibt das
      // ein Bruchteil des allozierten Buffers.
      attributes.position.addUpdateRange(0, vertex * 3);
      attributes.color.addUpdateRange(0, vertex * 3);
      attributes.alpha.addUpdateRange(0, vertex);
      attributes.position.needsUpdate = true;
      attributes.color.needsUpdate = true;
      attributes.alpha.needsUpdate = true;
    }
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
