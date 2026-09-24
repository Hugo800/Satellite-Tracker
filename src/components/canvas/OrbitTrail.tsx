import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import type { Line2 } from 'three-stdlib';
import { Color, Vector3 } from 'three';
import { engine } from '../../hooks/useSatelliteEngine';
import { trailState } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import { SKY_RADIUS } from '../../data/groups';

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
  const selectedId = useAppStore((s) => s.selectedId);
  // Nur als Auslöser: `null`, solange die ID nicht im Katalog steht; ein neues
  // Objekt bei neuen Bahndaten oder neuem Platz (store.ts).
  const selectedMeta = useAppStore((s) => s.selectedMeta);
  const showTrails = useAppStore((s) => s.showTrails);

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

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
    // Die Spur des vorigen Objekts sofort verwerfen, nicht erst, wenn die neue
    // eintrifft – bis dahin stünde sie sonst unter dem neuen Ring.
    trailState.noradId = null;
    trailState.points = null;
    trailState.version += 1;
    // Angefragt wird erst, wenn die ID einen Platz hat: Ohne ihn weiß der
    // Main-Thread nicht, welcher Shard rechnet. Löst sie sich später auf (neue
    // Gruppe, neu aufgebauter Pool) oder kommen neue Bahndaten, läuft der
    // Effekt erneut.
    if (selectedMeta === null || !showTrails) return;
    const noradId = selectedMeta.noradId;
    engine.requestTrail(noradId, -25, 70, SAMPLES);
    const id = window.setInterval(() => engine.requestTrail(noradId, -25, 70, SAMPLES), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [selectedId, selectedMeta, showTrails]);

  useLayoutEffect(() => {
    // Anfangssichtbarkeit *nicht* als `visible`-Prop an <Line> geben (siehe
    // JSX unten): drei verteilt alle Zusatz-Props über `...rest` sowohl an
    // das Line2-Objekt als auch an das LineMaterial (node_modules/@react-three/
    // drei/core/Line.js, zwei `_extends({...}, rest)`-Aufrufe). `visible={false}`
    // als Prop setzt damit `material.visible` dauerhaft auf false – das später
    // in useFrame gesetzte `line.visible = true` erzeugt dann nie einen
    // Draw-Call (gl.info.render.calls bleibt gleich, mit und ohne Linie).
    // Deshalb hier direkt am Objekt verstecken, bevor der erste Frame steht;
    // das Material bleibt dabei auf seinem Default (sichtbar).
    const line = lineRef.current;
    if (line) line.visible = false;
  }, []);

  useFrame(() => {
    const line = lineRef.current;
    if (!line) return;
    // Bezugsprüfung in jedem Bild – ein einziger Vergleich, nicht einer je
    // Objekt: Gezeichnet wird nur eine Spur, die zur aktuellen Auswahl gehört.
    // Das greift auch in dem Moment, in dem die Auswahl schon gewechselt hat,
    // der Effekt oben die alte Spur aber noch nicht verworfen hat.
    if (trailState.noradId !== selectedRef.current) {
      line.visible = false;
      seenVersion.current = -1;
      return;
    }
    if (trailState.version === seenVersion.current) return;
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

  if (selectedId === null || !showTrails) return null;

  return (
    <Line
      ref={lineRef}
      points={points}
      vertexColors={colors}
      lineWidth={2.4}
      transparent
      opacity={0.85}
      depthWrite={false}
      renderOrder={4}
    />
  );
}
