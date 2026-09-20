import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { Raycaster, Vector2, Vector3 } from 'three';
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
import { engine } from '../../hooks/useSatelliteEngine';
import { GROUP_ORDER, MAX_INSTANCES } from './SatelliteField';

const TAP_MOVE_TOLERANCE_PX = 12;
const TAP_DURATION_MS = 450;
/** Winkeltoleranz bei 70° FOV – skaliert mit dem Zoom, damit Treffer fair bleiben. */
const BASE_PICK_ANGLE_DEG = 3.2;

const STARLINK_GROUP_ID = GROUP_ORDER.indexOf('starlink');

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
  const mode = useAppStore((s) => s.filters.mode);
  const catalog = useAppStore((s) => s.catalog);

  const modeRef = useRef(mode);
  const groupIdsRef = useRef<Uint8Array>(new Uint8Array(MAX_INSTANCES));
  modeRef.current = mode;

  useEffect(() => {
    const ids = new Uint8Array(MAX_INSTANCES);
    for (const sat of catalog) {
      if (sat.index < MAX_INSTANCES) ids[sat.index] = GROUP_ORDER.indexOf(sat.group);
    }
    groupIdsRef.current = ids;
  }, [catalog]);

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
      const maxAngle = ((BASE_PICK_ANGLE_DEG * Math.PI) / 180) * Math.min(1.6, fov / 70);
      const minDot = Math.cos(maxAngle);

      const data = telemetry.data;
      const groupIds = groupIdsRef.current;
      const activeMode = modeRef.current;

      let bestIndex = -1;
      let bestDot = minDot;

      for (let i = 0; i < telemetry.count; i += 1) {
        const base = i * TELEMETRY_STRIDE;
        const elevation = data[base + T_EL];
        if (!Number.isFinite(data[base + T_RANGE])) continue;
        if (
          !passesSkyFilter(
            activeMode,
            groupIds[i] === STARLINK_GROUP_ID,
            elevation,
            data[base + T_ECLIPSED] > 0.5,
            data[base + T_MAG],
          )
        ) {
          continue;
        }

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
