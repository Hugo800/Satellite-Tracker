import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, InstancedMesh, Matrix4, Mesh, Object3D, PlaneGeometry } from 'three';
import { angleDelta, azElToVector, clamp } from '../../math/coords';
import {
  TELEMETRY_STRIDE,
  T_AZ,
  T_ECLIPSED,
  T_EL,
  T_MAG,
  T_RANGE,
} from '../../math/telemetryLayout';
import { passesSkyFilter } from '../../math/visibility';
import { telemetry } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import type { SatelliteGroup, SatelliteMeta } from '../../types';
import {
  createSatelliteDotTexture,
  createSatelliteTexture,
  createSelectionTexture,
} from './satelliteTextures';

export const SKY_RADIUS = 430;

/** Obergrenze über alle Kataloggruppen – fix, damit die Mesh nie neu montiert wird. */
export const MAX_INSTANCES = 4096;

export const GROUP_COLORS: Record<SatelliteGroup, string> = {
  stations: '#fbbf24',
  brightest: '#f1f5f9',
  weather: '#34d399',
  starlink: '#60a5fa',
};

export const GROUP_ORDER: SatelliteGroup[] = ['stations', 'brightest', 'weather', 'starlink'];
const STARLINK_GROUP_ID = GROUP_ORDER.indexOf('starlink');

/** Restlicht für Satelliten im Erdschatten – sichtbar, aber klar abgesetzt. */
const ECLIPSE_FACTOR = 0.14;

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
  colorRevision: number;
  colorMode: string;
  colorSelected: number | null;
}

/**
 * Massen-Rendering aller Katalogobjekte in einem einzigen Draw-Call.
 *
 * Der Worker liefert Telemetrie mit 10 Hz; zwischen den Ticks wird die
 * Blickrichtung interpoliert, sodass die Bewegung mit voller Framerate läuft.
 * Die Instanzen sind bildschirmparallele Billboards – dafür genügt es, die
 * Kamera-Quaternion einmal pro Frame zu übernehmen.
 */
export function SatelliteField({
  tickIntervalMs = 100,
}: {
  tickIntervalMs?: number;
}): React.JSX.Element {
  const meshRef = useRef<InstancedMesh>(null);
  const selectionRef = useRef<Mesh>(null);
  const camera = useThree((s) => s.camera);

  const catalog = useAppStore((s) => s.catalog);
  const mode = useAppStore((s) => s.filters.mode);
  const selectedIndex = useAppStore((s) => s.selectedIndex);

  const modeRef = useRef(mode);
  const selectedRef = useRef(selectedIndex);
  modeRef.current = mode;
  selectedRef.current = selectedIndex;

  const dotTexture = useMemo(createSatelliteDotTexture, []);
  const iconTexture = useMemo(createSatelliteTexture, []);
  const selectionTexture = useMemo(createSelectionTexture, []);
  const geometry = useMemo(() => new PlaneGeometry(1, 1), []);

  useEffect(
    () => () => {
      dotTexture.dispose();
      iconTexture.dispose();
      selectionTexture.dispose();
      geometry.dispose();
    },
    [dotTexture, iconTexture, selectionTexture, geometry],
  );

  // Wenige, große Objekte vertragen das detaillierte Symbol; bei Hunderten
  // gleichzeitig ist ein Leuchtpunkt deutlich lesbarer.
  const activeTexture = mode === 'nakedEye' ? iconTexture : dotTexture;
  const baseSize = mode === 'nakedEye' ? 18 : 12;
  const baseSizeRef = useRef(baseSize);
  baseSizeRef.current = baseSize;

  /** Gruppenzuordnung als typisiertes Array – Zugriff in der Renderloop ohne Objekt-Lookups. */
  const groupIds = useMemo(() => {
    const ids = new Uint8Array(MAX_INSTANCES);
    catalog.forEach((sat: SatelliteMeta) => {
      if (sat.index < MAX_INSTANCES) ids[sat.index] = GROUP_ORDER.indexOf(sat.group);
    });
    return ids;
  }, [catalog]);

  const palette = useMemo(() => GROUP_ORDER.map((g) => new Color(GROUP_COLORS[g])), []);

  const interpolator = useRef<Interpolator>({
    prevAz: new Float32Array(MAX_INSTANCES),
    prevEl: new Float32Array(MAX_INSTANCES),
    curAz: new Float32Array(MAX_INSTANCES),
    curEl: new Float32Array(MAX_INSTANCES),
    revision: -1,
    elapsed: 0,
    colorRevision: -1,
    colorMode: '',
    colorSelected: null,
  });

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // Erstzuweisung legt `instanceColor` an und räumt Altlasten aus den Matrizen.
    for (let i = 0; i < MAX_INSTANCES; i += 1) {
      mesh.setMatrixAt(i, zeroMatrix);
      mesh.setColorAt(i, colorScratch.setRGB(1, 1, 1));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, []);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const count = Math.min(telemetry.count, MAX_INSTANCES);
    mesh.count = count;
    if (count === 0) return;

    const state = interpolator.current;
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

    const activeMode = modeRef.current;
    const selected = selectedRef.current;
    const size = baseSizeRef.current;

    // Farben hängen nur an Telemetrie und Moduswahl, nicht an der Interpolation.
    // Der instanceColor-Upload läuft dadurch mit 10 Hz statt mit voller Framerate.
    const refreshColors =
      state.colorRevision !== telemetry.revision ||
      state.colorMode !== activeMode ||
      state.colorSelected !== selected;
    state.colorRevision = telemetry.revision;
    state.colorMode = activeMode;
    state.colorSelected = selected;

    // Alle Instanzen sind bildschirmparallel – eine Quaternion für alle.
    dummy.quaternion.copy(camera.quaternion);

    let selectedVisible = false;

    for (let i = 0; i < count; i += 1) {
      const base = i * TELEMETRY_STRIDE;
      const elevation = state.prevEl[i] + (state.curEl[i] - state.prevEl[i]) * t;
      const eclipsed = data[base + T_ECLIPSED] > 0.5;
      const magnitude = data[base + T_MAG];
      const groupId = groupIds[i];

      const visible =
        Number.isFinite(data[base + T_RANGE]) &&
        passesSkyFilter(
          activeMode,
          groupId === STARLINK_GROUP_ID,
          elevation,
          eclipsed,
          magnitude,
        );

      if (!visible) {
        mesh.setMatrixAt(i, zeroMatrix);
        continue;
      }

      const azimuth = state.prevAz[i] + angleDelta(state.curAz[i], state.prevAz[i]) * t;
      azElToVector(azimuth, elevation, SKY_RADIUS, dummy.position);

      // Hellere Objekte wirken größer; horizontnahe werden zusätzlich gedämpft.
      const brightnessScale = clamp(1.35 - 0.12 * (magnitude - 1), 0.6, 1.5);
      const horizonFade = 0.6 + 0.4 * Math.min(1, elevation / 0.35);
      dummy.scale.setScalar(size * brightnessScale * horizonFade * (eclipsed ? 0.6 : 1));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      colorScratch.copy(palette[groupId]);
      colorScratch.multiplyScalar(eclipsed ? ECLIPSE_FACTOR : 0.7 + 0.3 * horizonFade);
      if (refreshColors) mesh.setColorAt(i, colorScratch);

      if (i === selected) {
        selectedVisible = true;
        const ring = selectionRef.current;
        if (ring) {
          ring.position.copy(dummy.position);
          ring.quaternion.copy(camera.quaternion);
          ring.scale.setScalar(size * 2.6);
        }
      }
    }

    if (selectionRef.current) selectionRef.current.visible = selectedVisible;

    mesh.instanceMatrix.needsUpdate = true;
    if (refreshColors && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <group>
      <instancedMesh
        ref={meshRef}
        args={[geometry, undefined, MAX_INSTANCES]}
        frustumCulled={false}
        renderOrder={5}
      >
        <meshBasicMaterial
          map={activeTexture}
          transparent
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
        />
      </instancedMesh>

      <mesh ref={selectionRef} geometry={geometry} visible={false} renderOrder={6}>
        <meshBasicMaterial
          map={selectionTexture}
          color="#f472b6"
          transparent
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
