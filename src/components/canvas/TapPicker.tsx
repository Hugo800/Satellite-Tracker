import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { Raycaster, Vector2, Vector3 } from 'three';
import { FORECAST_MAX_SLOTS } from '../../data/forecast';
import {
  TELEMETRY_STRIDE,
  T_AZ,
  T_ECLIPSED,
  T_EL,
  T_MAG,
  T_RANGE,
} from '../../math/telemetryLayout';
import { passesSkyFilter } from '../../math/visibility';
import { pickForecastTrace } from '../../state/forecastView';
import { catalogIndex, forecastLabels, forecastView, telemetry } from '../../state/runtime';
import { useAppStore, virtualNow } from '../../state/store';
import { registerTapListeners, type TapEventSource, type TapPointerEvent } from './tapTracker';

/** Winkeltoleranz bei 70° FOV – skaliert mit dem Zoom, damit Treffer fair bleiben. */
const BASE_PICK_ANGLE_DEG = 3.2;
/**
 * Mindestmaß der Trefferfläche eines Vorhersage-Labels in CSS-Pixeln (44 pt
 * nach HIG, wie `--tap` in index.css), um die Mitte des Labels. Das Label
 * selbst ist bei FOV 70 nur ≈ 18 px hoch; beim Zoomen wächst es mit, die
 * Mindestfläche bleibt – sie schrumpft nicht mit dem FOV wie die
 * Winkeltoleranz der Satelliten.
 */
const FORECAST_LABEL_MIN_TARGET_PX = 44;

/** Erlaubt Aufrufe ohne echtes window (z. B. scripts/verify-selection.ts, dessen
 * gestelltes `window` kein addEventListener besitzt) ohne Zweig im Effekt selbst. */
const NOOP_EVENT_SOURCE: TapEventSource = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const raycaster = new Raycaster();
const ndc = new Vector2();
const satDir = new Vector3();
/** Sehstrahl und Label-Mitte im Kamerasystem – wiederverwendet. */
const viewRay = new Vector3();
const labelCenter = new Vector3();

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
      let bestId = bestIndex >= 0 ? (catalogIndex.meta[bestIndex]?.noradId ?? null) : null;
      let bestAngle = bestId !== null ? Math.acos(Math.min(1, bestDot)) : Infinity;

      // Vorhersage „Demnächst sichtbar“: Label und Spur eines Eintrags sind
      // ebenfalls Ziele – das Objekt selbst ist oft noch unter dem Horizont
      // oder zu schwach für den Filter und fehlt in der Schleife oben. Es
      // gewinnt der kleinste Winkel aus Satellit, Label und Spur. Ein Verbund
      // (ISS mit Modulen) hat nur Label und Spur seines Anführers – der
      // Treffer wählt ihn.
      const view = forecastView;
      if (activeMode === 'nakedEye' && view.status === 'ready' && view.slots.length > 0) {
        // (a) Labels: die Fläche, die VisibilityForecast im letzten Bild
        // gezeigt hat (`forecastLabels`), mindestens 44 × 44 px um ihre Mitte.
        // Sprites stehen im Kamerasystem achsparallel; geprüft wird dort, wo
        // der Sehstrahl die Ebene des Labels schneidet. Auf dem Text zählt
        // der Treffer mit Winkel 0, in der Mindestfläche daneben mit dem
        // Winkelabstand zum Text. Verdeckte Labels (Kollisionsregel) zählen
        // nicht – zu sehen ist dort ein anderes.
        const viewMatrix = camera.matrixWorldInverse;
        viewRay.copy(ray).transformDirection(viewMatrix);
        // Szeneneinheiten je CSS-Pixel in Tiefe 1: Höhe des Bildes in NDC (2)
        // durch die Brennweite der Projektion und die Höhe des Canvas.
        const unitsPerPxAtDepth1 = 2 / (camera.projectionMatrix.elements[5] * rect.height);
        for (let i = 0; i < FORECAST_MAX_SLOTS; i += 1) {
          if (forecastLabels.visible[i] !== 1) continue;
          labelCenter
            .set(forecastLabels.centers[i * 3], forecastLabels.centers[i * 3 + 1], forecastLabels.centers[i * 3 + 2])
            .applyMatrix4(viewMatrix);
          const depth = -labelCenter.z;
          if (!(depth > 0) || !(viewRay.z < 0)) continue;
          const along = depth / -viewRay.z;
          const offX = Math.abs(viewRay.x * along - labelCenter.x);
          const offY = Math.abs(viewRay.y * along - labelCenter.y);
          const halfWidth = forecastLabels.halfWidths[i];
          const halfHeight = forecastLabels.halfHeights[i];
          const halfTarget = (FORECAST_LABEL_MIN_TARGET_PX / 2) * unitsPerPxAtDepth1 * depth;
          if (offX > Math.max(halfWidth, halfTarget) || offY > Math.max(halfHeight, halfTarget)) continue;
          const outside = Math.hypot(Math.max(0, offX - halfWidth), Math.max(0, offY - halfHeight));
          const angle = Math.atan2(outside, depth);
          if (angle < bestAngle) {
            bestAngle = angle;
            bestId = forecastLabels.noradIds[i];
          }
        }
        // (b) Spuren – nur, wenn sie zu sehen sind: `showTrails` blendet sie
        // aus (VisibilityForecast, RadarMap), dann ist dort leerer Himmel, und
        // ein Tap hebt die Auswahl auf. Gegen die angezeigte Zeit, wie in
        // VisibilityForecast.
        if (useAppStore.getState().showTrails) {
          const trace = pickForecastTrace(ray, view.slots, virtualNow(), maxAngle);
          if (trace !== null && trace.angleRad < bestAngle) {
            bestAngle = trace.angleRad;
            bestId = trace.noradId;
          }
        }
      }

      // Tap ins Leere hebt die Auswahl auf.
      select(bestId);
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
