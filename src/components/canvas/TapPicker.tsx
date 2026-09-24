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
import { catalogIndex, telemetry } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import { registerTapListeners, type TapEventSource, type TapPointerEvent } from './tapTracker';

/** Winkeltoleranz bei 70° FOV – skaliert mit dem Zoom, damit Treffer fair bleiben. */
const BASE_PICK_ANGLE_DEG = 3.2;

/** Erlaubt Aufrufe ohne echtes window (z. B. scripts/verify-selection.ts, dessen
 * gestelltes `window` kein addEventListener besitzt) ohne Zweig im Effekt selbst. */
const NOOP_EVENT_SOURCE: TapEventSource = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

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

  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const element = gl.domElement;

    // Trifft den Sehstrahl im Moment des Tap-Endes gegen alle sichtbaren Satelliten.
    // Bekommt von registerTapListeners nur die Feldwerte, die dafür nötig sind – die
    // Entscheidung "war das überhaupt ein Tap" liegt vollständig in tapTracker.ts.
    const handleTap = (e: TapPointerEvent) => {
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
      // Vorberechnete Flags statt String-Vergleich je Objekt – der Katalog kann
      // fünfstellig sein, und der Tap darf nicht spürbar hängen.
      const starlinkFlags = catalogIndex.starlink;
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
            starlinkFlags[i] === 1,
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

      // Die Suche läuft über Plätze; erst der Treffer wird in seine Identität
      // übersetzt – einmal, O(1). Die Überflugliste fordert
      // useSatelliteEngine an, sobald die Auswahl steht.
      select(bestIndex >= 0 ? (catalogIndex.meta[bestIndex]?.noradId ?? null) : null);
    };

    // Testattrappen (scripts/verify-selection.ts) stellen ein `window` ohne
    // addEventListener bereit – registerTapListeners bekommt dafür eine Quelle, die
    // sich anmelden lässt, aber nichts tut, statt im Effekt selbst zu verzweigen.
    const windowSource: TapEventSource =
      typeof window !== 'undefined' && typeof window.addEventListener === 'function'
        ? window
        : NOOP_EVENT_SOURCE;

    return registerTapListeners(element, windowSource, handleTap);
  }, [camera, gl, select]);

  return null;
}
