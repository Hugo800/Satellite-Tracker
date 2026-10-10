import { Fragment, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import type { LineSegments2 } from 'three-stdlib';
import { Sphere, Vector3, type InterleavedBufferAttribute, type Sprite } from 'three';
import { FORECAST_COLOR, FORECAST_MAX_SLOTS } from '../../data/forecast';
import { SKY_RADIUS } from '../../data/groups';
import { DEG } from '../../math/coords';
import { FORECAST_TRACE_MAX_POINTS } from '../../math/forecast';
import { forecastPointAt } from '../../state/forecastView';
import { forecastLabels, forecastView, type ForecastSlot } from '../../state/runtime';
import { useAppStore, virtualNow } from '../../state/store';
import type { ForecastEntry, Vec3 } from '../../types';
import { createReusableLabel } from './textSprite';

/** Knapp innerhalb der Bahnspur (0,99) – die Vorhersage liegt über ihr. */
const FORECAST_LINE_RADIUS = SKY_RADIUS * 0.992;
/** Wie die Labels von HighlightMarkers. */
const FORECAST_LABEL_RADIUS = SKY_RADIUS * 0.985;
/**
 * Spätestens nach so viel Wanduhr wird die Geometrie neu geschrieben, damit
 * der Kopf der Linie dem Objekt folgt. Häufiger nicht: Das Label wandert in
 * jedem Bild, die Linie in Schritten von höchstens 100 ms – bei ×1 sind das
 * Bruchteile eines Grads.
 */
const FORECAST_GEOMETRY_REFRESH_MS = 100;
/** Liegen zwei Label-Anker näher beieinander, zeigt nur der frühere Eintrag sein Label. */
const FORECAST_LABEL_MERGE_DEG = 3;
const LABEL_MERGE_COS = Math.cos(FORECAST_LABEL_MERGE_DEG * DEG);

/** Höhe des Labels in Szeneneinheiten; die Breite folgt dem Seitenverhältnis der Canvas. */
const LABEL_HEIGHT = 11;
/** Label über dem Kopf, in Weltkoordinaten +y. */
const LABEL_OFFSET_Y = 12;
/**
 * Highlight-Objekte tragen über ihrem Marker schon ein Namenslabel
 * (HighlightMarkers, +16 über dem Ring). Der Countdown stünde bei +12 genau
 * darauf; er rückt deshalb gespiegelt unter den Marker – aber nur, solange
 * der Marker auch zu sehen ist, also das Objekt über dem Horizont steht
 * (Kopf ab `traceStartMs`). Davor sitzt das Label wie alle über dem
 * Aufgangspunkt.
 */
const HIGHLIGHT_LABEL_OFFSET_Y = -16;
/**
 * Breiter als der Vorgabewert 512: Bei 44 px Schrift (≈ 26 px je Zeichen)
 * passen dort nur 19 Zeichen, „STARLINK-31234 · noch 12:34“ hat 27. Der
 * transparente Rand kostet nichts außer Füllrate.
 */
const LABEL_CANVAS_WIDTH = 1024;

/**
 * Platzhalter für die Anfangsgeometrie von drei `<Line>`: so viele Punkte,
 * wie eine Spur höchstens hat – damit hat der Instanzpuffer genug Platz für
 * jede Teilspur, und `useFrame` beschreibt ihn nur noch. Als Zahlentupel
 * statt `Vector3`: drei prüft per `instanceof`, und in esbuild-Bündeln der
 * Prüfskripte gibt es three zweimal (scripts/verify-wiring.ts).
 *
 * Kapazität: Eine Teilspur hat ihre beiden Endpunkte plus alle Spurpunkte
 * echt dazwischen. Beide Enden liegen in [traceStartMs, letzter Punkt], also
 * höchstens `n − 2` innere Punkte, zusammen `n` Ecken, `n − 1` Segmente –
 * genau so viele, wie `n` Platzhalter anlegen.
 */
const PLACEHOLDER_POINTS: Array<[number, number, number]> = Array.from(
  { length: FORECAST_TRACE_MAX_POINTS },
  () => [0, -FORECAST_LINE_RADIUS, 0],
);
const SLOT_INDICES = Array.from({ length: FORECAST_MAX_SLOTS }, (_, i) => i);
const NO_SLOTS: readonly ForecastSlot[] = [];

/** Kopf der Spur und Endpunkte der Teilspuren – wiederverwendet, je Bild keine Allokation. */
const head: Vec3 = { x: 0, y: 0, z: 0 };
const edge: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Schreibziel der laufenden Polylinie. Modulzustand statt Closure oder
 * Rückgabeobjekt: `writeTrace` läuft bis zu 20-mal je Neuschreiben und darf
 * nichts allozieren.
 */
const polyline = {
  segments: new Float32Array(0) as Float32Array,
  distances: new Float32Array(0) as Float32Array,
  capacity: 0,
  count: 0,
  distance: 0,
  started: false,
  x: 0,
  y: 0,
  z: 0,
};

/** Hängt eine Ecke an: ab der zweiten entsteht je Ecke ein Segment samt Strichdistanz. */
function pushVertex(v: Vec3): void {
  const x = v.x * FORECAST_LINE_RADIUS;
  const y = v.y * FORECAST_LINE_RADIUS;
  const z = v.z * FORECAST_LINE_RADIUS;
  if (polyline.started && polyline.count < polyline.capacity) {
    const s = polyline.count * 6;
    const segments = polyline.segments;
    segments[s] = polyline.x;
    segments[s + 1] = polyline.y;
    segments[s + 2] = polyline.z;
    segments[s + 3] = x;
    segments[s + 4] = y;
    segments[s + 5] = z;
    const dx = x - polyline.x;
    const dy = y - polyline.y;
    const dz = z - polyline.z;
    const d = polyline.count * 2;
    polyline.distances[d] = polyline.distance;
    polyline.distance += Math.sqrt(dx * dx + dy * dy + dz * dz);
    polyline.distances[d + 1] = polyline.distance;
    polyline.count += 1;
  }
  polyline.started = true;
  polyline.x = x;
  polyline.y = y;
  polyline.z = z;
}

/** Spurpunkt `k` des Eintrags als Ecke. */
function pushPoint(points: Float32Array, k: number): void {
  edge.x = points[k * 3];
  edge.y = points[k * 3 + 1];
  edge.z = points[k * 3 + 2];
  pushVertex(edge);
}

/**
 * Schreibt die Spur des Eintrags von `fromMs` nach `toMs` in den
 * Instanzpuffer der Linie – vorwärts oder rückwärts, je nachdem, welche Zeit
 * größer ist. Die Strichdistanz beginnt bei `fromMs` mit 0: Wer rückwärts vom
 * Sichtbeginn zum Kopf schreibt, verankert das Strichmuster am Sichtbeginn,
 * und es wandert nicht mit dem Kopf.
 *
 * In-place, ohne `setPositions`/`computeLineDistances`: Beide legen bei jedem
 * Aufruf neue Puffer an (node_modules/three-stdlib/lines/LineSegmentsGeometry.js,
 * LineSegments2.js). Liefert die Zahl der Segmente.
 */
function writeTrace(line: LineSegments2, entry: ForecastEntry, fromMs: number, toMs: number): number {
  const geometry = line.geometry;
  const start = geometry.getAttribute('instanceStart') as InterleavedBufferAttribute | undefined;
  if (start === undefined) return 0;
  let distance = geometry.getAttribute('instanceDistanceStart') as InterleavedBufferAttribute | undefined;
  if (distance === undefined) {
    // drei legt die Distanzen nach dem Einhängen selbst an (useLayoutEffect);
    // fehlen sie doch, einmalig hier – danach nur noch in-place.
    line.computeLineDistances();
    distance = geometry.getAttribute('instanceDistanceStart') as InterleavedBufferAttribute | undefined;
    if (distance === undefined) return 0;
  }
  // Einmalig: Die Platzhalter liegen alle im Nadir, three hat daraus Radius 0
  // berechnet. Mit `frustumCulled={false}` ohne Wirkung aufs Zeichnen, aber
  // ehrlich für jeden, der die Kugel liest (Sortierung, Raycast).
  if (geometry.boundingSphere === null) {
    geometry.boundingSphere = new Sphere(new Vector3(), FORECAST_LINE_RADIUS);
  } else if (geometry.boundingSphere.radius !== FORECAST_LINE_RADIUS) {
    geometry.boundingSphere.center.set(0, 0, 0);
    geometry.boundingSphere.radius = FORECAST_LINE_RADIUS;
  }

  const points = entry.points;
  const count = Math.floor(points.length / 3);
  const first = entry.traceStartMs;
  const step = entry.stepMs;
  const last = first + (count - 1) * step;
  // Dieselbe Klemmung wie forecastPointAt: vor dem Aufgang der Aufgangspunkt.
  const a = Math.min(Math.max(fromMs, first), last);
  const b = Math.min(Math.max(toMs, first), last);

  polyline.segments = start.data.array as Float32Array;
  polyline.distances = distance.data.array as Float32Array;
  polyline.capacity = Math.min(start.count, distance.count);
  polyline.count = 0;
  polyline.distance = 0;
  polyline.started = false;

  if (count >= 2 && step > 0 && a !== b) {
    forecastPointAt(entry, a, edge);
    pushVertex(edge);
    if (a < b) {
      // Vorwärts: alle Spurpunkte echt zwischen a und b.
      for (let k = Math.floor((a - first) / step) + 1; k < count && first + k * step < b; k += 1) {
        pushPoint(points, k);
      }
    } else {
      // Rückwärts: vom größten Spurpunkt echt unter a abwärts bis echt über b.
      for (let k = Math.ceil((a - first) / step) - 1; k >= 0 && first + k * step > b; k -= 1) {
        pushPoint(points, k);
      }
    }
    forecastPointAt(entry, b, edge);
    pushVertex(edge);
  }

  geometry.instanceCount = polyline.count;
  if (polyline.count > 0) {
    start.data.needsUpdate = true;
    distance.data.needsUpdate = true;
  }
  return polyline.count;
}

/**
 * Spuren und Countdown-Labels der Vorhersage „Demnächst sichtbar“ am Himmel.
 *
 * Nur im Filter „Sichtbar“ eingehängt. Alles Weitere liest die Bildfunktion
 * aus `forecastView` (src/state/runtime.ts), die der Controller-Hook alle
 * 250 ms aus der virtuellen Zeit ableitet – Texte entstehen dort, hier wird
 * nur kopiert.
 */
export function VisibilityForecast(): React.JSX.Element | null {
  const mode = useAppStore((s) => s.filters.mode);
  if (mode !== 'nakedEye') return null;
  return <ForecastTraces />;
}

/**
 * Zehn feste Plätze, je zwei Linien und ein Label. Platz `i` zeigt
 * `forecastView.slots[i]` – bei einem Verbund (§13) eine Spur und ein Label
 * („+5 · in 3:20“) für alle seine Objekte. React rendert dafür nie neu –
 * Geometrie, Text und Sichtbarkeit setzt allein die Bildfunktion.
 */
function ForecastTraces(): React.JSX.Element {
  const dimRefs = useRef<Array<LineSegments2 | null>>([]);
  const brightRefs = useRef<Array<LineSegments2 | null>>([]);
  const spriteRefs = useRef<Array<Sprite | null>>([]);

  // `showTrails` blendet nur die Linien aus; Labels bleiben. Als Ref, damit
  // das Umschalten nichts neu rendert.
  const showTrailsRef = useRef(useAppStore.getState().showTrails);
  useEffect(() => {
    showTrailsRef.current = useAppStore.getState().showTrails;
    return useAppStore.subscribe((state) => {
      showTrailsRef.current = state.showTrails;
    });
  }, []);

  const labels = useMemo(
    () =>
      SLOT_INDICES.map(() =>
        createReusableLabel({
          width: LABEL_CANVAS_WIDTH,
          color: FORECAST_COLOR,
          glow: 'rgba(255, 159, 10, 0.75)',
        }),
      ),
    [],
  );
  useEffect(() => () => labels.forEach((label) => label.dispose()), [labels]);
  // Ohne Szene kein Label, das TapPicker treffen könnte.
  useEffect(
    () => () => {
      forecastLabels.visible.fill(0);
    },
    [],
  );

  const frameState = useRef({
    /** `forecastView.version` beim letzten Neuschreiben. */
    version: -1,
    /** performance.now() beim letzten Neuschreiben. */
    writtenAt: -Infinity,
    /** Segmente je Platz seit dem letzten Neuschreiben. */
    dimSegments: new Int32Array(FORECAST_MAX_SLOTS),
    brightSegments: new Int32Array(FORECAST_MAX_SLOTS),
    /** Zuletzt gezeichneter Labeltext je Platz – neu gezeichnet wird nur bei Wechsel. */
    drawnText: SLOT_INDICES.map(() => ''),
    /** Anker der schon gezeigten Labels dieses Bilds (Einheitsvektoren). */
    anchors: new Float32Array(FORECAST_MAX_SLOTS * 3),
  });

  // Eine Bildfunktion für alle Plätze. Sie läuft vor jedem `gl.render`, also
  // auch vor dem ersten: Die Platzhalter im Nadir werden nie gezeichnet.
  useFrame(() => {
    const state = frameState.current;
    const view = forecastView;
    const slots = view.status === 'ready' ? view.slots : NO_SLOTS;
    // Die Köpfe folgen der angezeigten Zeit, nicht der Wanduhr.
    const nowMs = slots.length > 0 ? virtualNow() : 0;
    const wallMs = performance.now();
    const rewrite =
      slots.length > 0 &&
      (view.version !== state.version || wallMs - state.writtenAt >= FORECAST_GEOMETRY_REFRESH_MS);
    if (rewrite) {
      state.version = view.version;
      state.writtenAt = wallMs;
    }
    const showTrails = showTrailsRef.current;
    let anchorCount = 0;

    for (let i = 0; i < FORECAST_MAX_SLOTS; i += 1) {
      const dim = dimRefs.current[i] ?? null;
      const bright = brightRefs.current[i] ?? null;
      const sprite = spriteRefs.current[i] ?? null;
      const slot = i < slots.length ? slots[i] : undefined;
      forecastLabels.visible[i] = 0;
      if (slot === undefined) {
        if (dim) dim.visible = false;
        if (bright) bright.visible = false;
        if (sprite) sprite.visible = false;
        continue;
      }

      const entry = slot.entry;
      // Vor `traceStartMs` klemmt das auf den ersten Spurpunkt: den Aufgangspunkt.
      forecastPointAt(entry, nowMs, head);

      if (rewrite) {
        // Gestrichelt rückwärts vom Sichtbeginn zum Kopf; kräftig vom späteren
        // aus Kopf und Sichtbeginn bis zum Sichtende.
        state.dimSegments[i] = dim && nowMs < entry.startMs ? writeTrace(dim, entry, entry.startMs, nowMs) : 0;
        const brightFrom = Math.max(nowMs, entry.startMs);
        state.brightSegments[i] =
          bright && brightFrom < entry.endMs ? writeTrace(bright, entry, brightFrom, entry.endMs) : 0;
      }
      if (dim) dim.visible = showTrails && state.dimSegments[i] > 0;
      if (bright) bright.visible = showTrails && state.brightSegments[i] > 0;

      if (!sprite) continue;
      // Kollisionsregel: Ein Anker näher als 3° an einem schon gezeigten
      // Label des Bilds bleibt ohne Label – der frühere Eintrag gewinnt.
      let free = true;
      for (let k = 0; k < anchorCount; k += 1) {
        const base = k * 3;
        const dot =
          state.anchors[base] * head.x + state.anchors[base + 1] * head.y + state.anchors[base + 2] * head.z;
        if (dot > LABEL_MERGE_COS) {
          free = false;
          break;
        }
      }
      sprite.visible = free;
      if (!free) continue;
      state.anchors[anchorCount * 3] = head.x;
      state.anchors[anchorCount * 3 + 1] = head.y;
      state.anchors[anchorCount * 3 + 2] = head.z;
      anchorCount += 1;

      const offsetY =
        slot.highlight && nowMs >= entry.traceStartMs ? HIGHLIGHT_LABEL_OFFSET_Y : LABEL_OFFSET_Y;
      sprite.position.set(
        head.x * FORECAST_LABEL_RADIUS,
        head.y * FORECAST_LABEL_RADIUS + offsetY,
        head.z * FORECAST_LABEL_RADIUS,
      );
      if (state.drawnText[i] !== slot.labelText) {
        labels[i].draw(slot.labelText);
        state.drawnText[i] = slot.labelText;
      }

      // Die gezeigte Fläche für TapPicker: Mitte des Sprites und der bemalte
      // Text darin (mittig gezeichnet, Rest der Canvas transparent).
      forecastLabels.noradIds[i] = slot.noradId;
      forecastLabels.centers[i * 3] = sprite.position.x;
      forecastLabels.centers[i * 3 + 1] = sprite.position.y;
      forecastLabels.centers[i * 3 + 2] = sprite.position.z;
      forecastLabels.halfWidths[i] = ((labels[i].textWidth / LABEL_CANVAS_WIDTH) * LABEL_HEIGHT * labels[i].aspect) / 2;
      forecastLabels.halfHeights[i] = LABEL_HEIGHT / 2;
      forecastLabels.visible[i] = 1;
    }
  });

  // Kein `visible`-Prop an <Line>: drei verteilt alle Zusatz-Props über
  // `...rest` sowohl an das Line2-Objekt als auch an das LineMaterial
  // (node_modules/@react-three/drei/core/Line.js, zwei `_extends({...}, rest)`-
  // Aufrufe). `visible={false}` setzte damit `material.visible` dauerhaft auf
  // false – das in useFrame gesetzte `line.visible = true` erzeugte dann nie
  // einen Draw-Call (OrbitTrail.tsx, Commit e49bcde).
  //
  // Beide Linien transparent: Nur in derselben Renderliste wie die Bahnspur
  // (OrbitTrail, renderOrder 4) liegen sie per renderOrder 5/6 über ihr.
  return (
    <>
      {SLOT_INDICES.map((i) => (
        <Fragment key={i}>
          <Line
            ref={(node) => {
              dimRefs.current[i] = node;
            }}
            points={PLACEHOLDER_POINTS}
            color={FORECAST_COLOR}
            dashed
            dashSize={5}
            gapSize={4}
            lineWidth={1.6}
            transparent
            opacity={0.6}
            depthWrite={false}
            renderOrder={5}
            frustumCulled={false}
          />
          <Line
            ref={(node) => {
              brightRefs.current[i] = node;
            }}
            points={PLACEHOLDER_POINTS}
            color={FORECAST_COLOR}
            lineWidth={2.8}
            transparent
            opacity={0.95}
            depthWrite={false}
            renderOrder={6}
            frustumCulled={false}
          />
          <sprite
            ref={(node) => {
              spriteRefs.current[i] = node;
            }}
            renderOrder={9}
            scale={[LABEL_HEIGHT * labels[i].aspect, LABEL_HEIGHT, 1]}
          >
            <spriteMaterial map={labels[i].texture} transparent depthWrite={false} depthTest={false} />
          </sprite>
        </Fragment>
      ))}
    </>
  );
}
