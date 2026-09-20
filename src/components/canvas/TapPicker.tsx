import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { Raycaster, Vector2, Vector3 } from 'three';
import { TELEMETRY_STRIDE, T_AZ, T_EL, T_RANGE } from '../../math/telemetryLayout';
import { telemetry } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import { engine } from '../../hooks/useSatelliteEngine';
import type { SatelliteGroup } from '../../types';

const TAP_MOVE_TOLERANCE_PX = 12;
const TAP_DURATION_MS = 450;
/** Winkeltoleranz bei 70° FOV – skaliert mit dem Zoom, damit Treffer fair bleiben. */
const BASE_PICK_ANGLE_DEG = 3.2;

const raycaster = new Raycaster();
const ndc = new Vector2();
const satDir = new Vector3();

/**
 * Auswahl per Tap – bewusst ohne `InstancedMesh.raycast`.
 *
 * Statt Dreieck-Tests gegen tausende Instanzen (was R3F bei jedem
 * `pointermove` täte) wird der Winkelabstand zwischen Sehstrahl und
 * Satellitenrichtung verglichen: O(n) Skalarprodukte, nur beim Tap.
 */
export function TapPicker(): null {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const select = useAppStore((s) => s.select);
  const filters = useAppStore((s) => s.filters);
  const catalog = useAppStore((s) => s.catalog);

  const filtersRef = useRef(filters);
  const catalogRef = useRef(catalog);
  filtersRef.current = filters;
  catalogRef.current = catalog;

  useEffect(() => {
    const element = gl.domElement;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let pointerCount = 0;

    const onPointerDown = (e: PointerEvent) => {
      pointerCount += 1;
      startX = e.clientX;
      startY = e.clientY;
      startTime = performance.now();
    };

    const onPointerUp = (e: PointerEvent) => {
      const wasMultiTouch = pointerCount > 1;
      pointerCount = Math.max(0, pointerCount - 1);
      if (wasMultiTouch) return;
      if (performance.now() - startTime > TAP_DURATION_MS) return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > TAP_MOVE_TOLERANCE_PX) return;

      const rect = element.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const ray = raycaster.ray.direction;

      const fov = (camera as { fov?: number }).fov ?? 70;
      const maxAngle = (BASE_PICK_ANGLE_DEG * Math.PI) / 180 * Math.min(1.6, fov / 70);
      const minDot = Math.cos(maxAngle);

      const f = filtersRef.current;
      const groupVisible: Record<SatelliteGroup, boolean> = {
        stations: f.stations,
        brightest: f.brightest,
        weather: f.weather,
        starlink: f.starlink,
      };

      const allowed = new Uint8Array(telemetry.count);
      for (const sat of catalogRef.current) {
        if (sat.index < allowed.length) allowed[sat.index] = groupVisible[sat.group] ? 1 : 0;
      }

      const data = telemetry.data;
      let bestIndex = -1;
      let bestDot = minDot;

      for (let i = 0; i < telemetry.count; i += 1) {
        if (!allowed[i]) continue;
        const base = i * TELEMETRY_STRIDE;
        const elevation = data[base + T_EL];
        if (elevation <= 0 || !Number.isFinite(data[base + T_RANGE])) continue;

        const azimuth = data[base + T_AZ];
        const cosEl = Math.cos(elevation);
        satDir.set(cosEl * Math.sin(azimuth), Math.sin(elevation), -cosEl * Math.cos(azimuth));

        const dot = satDir.dot(ray);
        if (dot > bestDot) {
          bestDot = dot;
          bestIndex = i;
        }
      }

      if (bestIndex >= 0) {
        select(bestIndex);
        engine.requestPass(bestIndex);
      } else {
        select(null);
      }
    };

    const onPointerCancel = () => {
      pointerCount = Math.max(0, pointerCount - 1);
    };

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerCancel);

    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [camera, gl, select]);

  return null;
}
