import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, InstancedMesh, Matrix4, Object3D } from 'three';
import { angleDelta, azElToVector } from '../../math/coords';
import { TELEMETRY_STRIDE, T_AZ, T_ECLIPSED, T_EL, T_RANGE } from '../../math/telemetryLayout';
import { telemetry } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import type { SatelliteGroup, SatelliteMeta } from '../../types';

export const SKY_RADIUS = 430;

const GROUP_COLORS: Record<SatelliteGroup, string> = {
  stations: '#fbbf24',
  brightest: '#f1f5f9',
  weather: '#34d399',
  starlink: '#60a5fa',
};

const SELECTED_COLOR = '#f472b6';
/** Restlicht für Satelliten im Erdschatten – sichtbar, aber klar abgesetzt. */
const ECLIPSE_FACTOR = 0.12;

const dummy = new Object3D();
const zeroMatrix = new Matrix4().makeScale(0, 0, 0);
const colorScratch = new Color();

interface Interpolator {
  prevAz: Float32Array;
  prevEl: Float32Array;
  curAz: Float32Array;
  curEl: Float32Array;
  revision: number;
  elapsed: number;
}

function ensureCapacity(state: Interpolator, count: number): void {
  if (state.curAz.length >= count) return;
  state.prevAz = new Float32Array(count);
  state.prevEl = new Float32Array(count);
  state.curAz = new Float32Array(count);
  state.curEl = new Float32Array(count);
  state.revision = -1;
}

/**
 * Massen-Rendering aller Katalogobjekte in einem einzigen Draw-Call.
 *
 * Der Worker liefert Telemetrie mit 10 Hz; zwischen den Ticks wird die
 * Blickrichtung interpoliert, sodass die Bewegung mit voller Framerate läuft.
 */
export function SatelliteField({
  tickIntervalMs = 100,
}: {
  tickIntervalMs?: number;
}): React.JSX.Element | null {
  const meshRef = useRef<InstancedMesh>(null);
  const catalog = useAppStore((s) => s.catalog);
  const filters = useAppStore((s) => s.filters);
  const selectedIndex = useAppStore((s) => s.selectedIndex);

  const filtersRef = useRef(filters);
  const selectedRef = useRef(selectedIndex);
  filtersRef.current = filters;
  selectedRef.current = selectedIndex;

  const capacity = Math.max(catalog.length, 1);

  /** Gruppenzuordnung als typisiertes Array – Zugriff in der Renderloop ohne Objekt-Lookups. */
  const groupIds = useMemo(() => {
    const order: SatelliteGroup[] = ['stations', 'brightest', 'weather', 'starlink'];
    const ids = new Uint8Array(capacity);
    catalog.forEach((sat: SatelliteMeta) => {
      ids[sat.index] = order.indexOf(sat.group);
    });
    return ids;
  }, [catalog, capacity]);

  const palette = useMemo(
    () =>
      (['stations', 'brightest', 'weather', 'starlink'] as SatelliteGroup[]).map(
        (g) => new Color(GROUP_COLORS[g]),
      ),
    [],
  );
  const selectedColor = useMemo(() => new Color(SELECTED_COLOR), []);

  const interpolator = useRef<Interpolator>({
    prevAz: new Float32Array(0),
    prevEl: new Float32Array(0),
    curAz: new Float32Array(0),
    curEl: new Float32Array(0),
    revision: -1,
    elapsed: 0,
  });

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < mesh.count; i += 1) mesh.setMatrixAt(i, zeroMatrix);
    mesh.instanceMatrix.needsUpdate = true;
  }, [capacity]);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const count = Math.min(telemetry.count, mesh.count);
    if (count === 0) return;

    const state = interpolator.current;
    ensureCapacity(state, mesh.count);

    const data = telemetry.data;

    if (state.revision !== telemetry.revision) {
      const first = state.revision === -1;
      for (let i = 0; i < count; i += 1) {
        const base = i * TELEMETRY_STRIDE;
        state.prevAz[i] = first ? data[base + T_AZ] : state.curAz[i];
        state.prevEl[i] = first ? data[base + T_EL] : state.curEl[i];
        state.curAz[i] = data[base + T_AZ];
        state.curEl[i] = data[base + T_EL];
      }
      state.revision = telemetry.revision;
      state.elapsed = 0;
    }

    state.elapsed += delta * 1000;
    const t = Math.min(1, state.elapsed / tickIntervalMs);

    const f = filtersRef.current;
    const groupVisible = [f.stations, f.brightest, f.weather, f.starlink];
    const selected = selectedRef.current;

    for (let i = 0; i < count; i += 1) {
      const base = i * TELEMETRY_STRIDE;
      const elevation = state.prevEl[i] + (state.curEl[i] - state.prevEl[i]) * t;
      const visible =
        elevation > 0 && groupVisible[groupIds[i]] && Number.isFinite(data[base + T_RANGE]);

      if (!visible) {
        mesh.setMatrixAt(i, zeroMatrix);
        continue;
      }

      const azimuth = state.prevAz[i] + angleDelta(state.curAz[i], state.prevAz[i]) * t;
      azElToVector(azimuth, elevation, SKY_RADIUS, dummy.position);

      const isSelected = selected === i;
      const eclipsed = data[base + T_ECLIPSED] > 0.5;
      // Horizontnahe Objekte wirken kleiner – simple Atmosphären-/Distanzabschwächung.
      const horizonFade = 0.55 + 0.45 * Math.min(1, elevation / 0.35);
      const scale = (isSelected ? 5.4 : 2.6) * horizonFade * (eclipsed ? 0.62 : 1);

      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const source = isSelected ? selectedColor : palette[groupIds[i]];
      colorScratch.copy(source);
      if (eclipsed && !isSelected) colorScratch.multiplyScalar(ECLIPSE_FACTOR);
      else colorScratch.multiplyScalar(0.6 + 0.4 * horizonFade);
      mesh.setColorAt(i, colorScratch);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  if (catalog.length === 0) return null;

  return (
    <instancedMesh
      key={capacity}
      ref={meshRef}
      args={[undefined, undefined, capacity]}
      frustumCulled={false}
      renderOrder={5}
    >
      <icosahedronGeometry args={[1, 0]} />
      <meshBasicMaterial toneMapped={false} transparent opacity={0.96} />
    </instancedMesh>
  );
}
