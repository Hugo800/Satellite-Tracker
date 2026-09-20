import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import type { Line2 } from 'three-stdlib';
import { Color, Vector3 } from 'three';
import { engine } from '../../hooks/useSatelliteEngine';
import { trailState } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import { SKY_RADIUS } from './SatelliteField';

const SAMPLES = 220;
const TRAIL_RADIUS = SKY_RADIUS * 0.99;
/** Bahnspur regelmäßig nachführen, damit sie nicht hinter dem Objekt zurückbleibt. */
const REFRESH_MS = 12_000;

/**
 * Bahnspur des selektierten Satelliten als Line2 (screen-space Linienbreite).
 * Die Geometrie wird direkt in der Renderloop aktualisiert – kein Re-Render.
 */
export function OrbitTrail(): React.JSX.Element | null {
  const lineRef = useRef<Line2>(null);
  const seenVersion = useRef(-1);
  const selectedIndex = useAppStore((s) => s.selectedIndex);
  const showTrails = useAppStore((s) => s.showTrails);

  const { points, colors } = useMemo(() => {
    const pts: Vector3[] = [];
    const cols: Color[] = [];
    const head = new Color('#f9a8d4');
    const tail = new Color('#3b0764');
    for (let i = 0; i < SAMPLES; i += 1) {
      pts.push(new Vector3(0, -TRAIL_RADIUS, 0));
      cols.push(tail.clone().lerp(head, i / (SAMPLES - 1)));
    }
    return { points: pts, colors: cols };
  }, []);

  useEffect(() => {
    if (selectedIndex === null || !showTrails) {
      trailState.points = null;
      trailState.version += 1;
      return;
    }
    engine.requestTrail(selectedIndex, -25, 70, SAMPLES);
    const id = window.setInterval(
      () => engine.requestTrail(selectedIndex, -25, 70, SAMPLES),
      REFRESH_MS,
    );
    return () => window.clearInterval(id);
  }, [selectedIndex, showTrails]);

  useFrame(() => {
    const line = lineRef.current;
    if (!line || trailState.version === seenVersion.current) return;
    seenVersion.current = trailState.version;

    const source = trailState.points;
    if (!source || source.length !== SAMPLES * 3) {
      line.visible = false;
      return;
    }

    const scaled = new Float32Array(source.length);
    for (let i = 0; i < source.length; i += 1) scaled[i] = source[i] * TRAIL_RADIUS;
    line.geometry.setPositions(scaled);
    line.computeLineDistances();
    line.visible = true;
  });

  if (selectedIndex === null || !showTrails) return null;

  return (
    <Line
      ref={lineRef}
      points={points}
      vertexColors={colors}
      lineWidth={2.4}
      transparent
      opacity={0.85}
      depthWrite={false}
      visible={false}
      renderOrder={4}
    />
  );
}
