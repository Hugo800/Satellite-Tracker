import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { PerspectiveCamera, Vector3 } from 'three';
import { RAD, angleDelta, clamp, normalizeAngle } from '../../math/coords';
import { RollHandover, arSmoothingFactor, clampPitch } from '../../math/orientation';
import { orientationState, viewState } from '../../state/runtime';
import { useAppStore } from '../../state/store';

const MIN_FOV = 22;
const MAX_FOV = 95;
/** Kamera sitzt praktisch im Ursprung; der Mini-Offset hält OrbitControls stabil. */
const EPS_DISTANCE = 1e-4;

const handoverForward = new Vector3();

/**
 * Priorität des Moduswechsels: vor dem Frame des drei-Wrappers von
 * OrbitControls (Priorität −1, @react-three/drei core/OrbitControls.js), der
 * `enabled` liest und nur dann `update()` ruft – so gilt ein Wechsel im selben
 * Bild. Die übrige Kameraführung läuft danach mit Priorität 0.
 */
export const AR_SWITCH_PRIORITY = -2;

/** Was die Bildlogik von OrbitControls braucht (three-stdlib erfüllt es). */
export interface RigControls {
  enabled: boolean;
  getAzimuthalAngle(): number;
  getPolarAngle(): number;
  setAzimuthalAngle(value: number): void;
  setPolarAngle(value: number): void;
  update(): void;
}

export interface CameraRigFrame {
  /** Priorität `AR_SWITCH_PRIORITY`: Moduswechsel AR ↔ Touch, `controls.enabled`. */
  beforeControls: () => void;
  /** Priorität 0: AR-Nachführung oder Touch-Fokus, Übergabe, `viewState`. */
  afterControls: (deltaS: number) => void;
}

/**
 * Die Bildlogik des CameraRig ohne React: Die Komponente hängt nur die beiden
 * Funktionen in den Frame-Takt. So prüft scripts/verify-rig.ts genau diesen Code
 * mit dem echten OrbitControls aus three-stdlib, statt einer Nachbildung.
 */
// eslint-disable-next-line react-refresh/only-export-components -- für scripts/verify-rig.ts; kostet nur Fast Refresh dieser Datei
export function createCameraRigFrame(
  camera: PerspectiveCamera,
  controls: () => RigControls | null,
  arEnabled: () => boolean,
  fovDeg: () => number,
): CameraRigFrame {
  let arActive = false;
  /** Rollwinkel der letzten AR-Lage; klingt auf der OrbitControls-Lage aus. */
  const handover = new RollHandover();

  const beforeControls = () => {
    const active = arEnabled() && orientationState.available;

    if (arActive && !active) {
      // OrbitControls leitet die Blickrichtung allein aus der Kameraposition ab,
      // die AR nie verändert. Ohne diese Übergabe spränge die Ansicht auf die
      // Richtung von vor dem AR-Modus zurück.
      handoverForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
      camera.position.copy(handoverForward).multiplyScalar(-EPS_DISTANCE);
      handover.begin(camera.quaternion);
    } else if (active) {
      handover.cancel();
    }

    arActive = active;
    const current = controls();
    if (current) current.enabled = !active;
  };

  const afterControls = (delta: number) => {
    const current = controls();

    if (arActive) {
      // Fokusanfragen gelten der Touch-Ansicht; im AR-Modus bestimmt das Gerät
      // die Richtung. Liegen gelassen, schlüge die Anfrage beim Verlassen von AR
      // als Kameraschwenk zu.
      viewState.focus = null;
      // Leichtes Slerp glättet den Restjitter der Sensorfusion; die Kursführung
      // selbst passiert bereits in useDeviceOrientation.
      camera.quaternion.slerp(orientationState.quaternion, arSmoothingFactor(delta));
      // Auch der Zwischenschritt der Interpolation bleibt über dem Horizont.
      clampPitch(camera.quaternion);
    } else if (current && viewState.focus) {
      const targetTheta = -viewState.focus.azimuth;
      const targetPhi = clamp(Math.PI / 2 + viewState.focus.elevation, 0.02, Math.PI - 0.02);
      const theta = current.getAzimuthalAngle();
      const phi = current.getPolarAngle();
      const dTheta = angleDelta(targetTheta, theta);
      const dPhi = targetPhi - phi;
      const k = Math.min(1, delta * 4.5);

      current.setAzimuthalAngle(theta + dTheta * k);
      current.setPolarAngle(phi + dPhi * k);
      current.update();

      if (Math.abs(dTheta) < 0.004 && Math.abs(dPhi) < 0.004) viewState.focus = null;
    }

    // OrbitControls richtet per lookAt ohne Rollwinkel aus; der Rollwinkel der
    // zuletzt gezeigten AR-Lage klingt als Versatz auf der aktuellen lookAt-Lage
    // ab. Ziehen wirkt sofort, ohne Nachlauf. Ohne vorheriges AR ein No-op.
    if (!arActive) handover.apply(camera.quaternion, delta);

    const fov = fovDeg();
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    camera.getWorldDirection(viewState.forward);
    viewState.quaternion.copy(camera.quaternion);
    viewState.fovDeg = camera.fov;
    viewState.aspect = camera.aspect;
    viewState.azimuthDeg =
      normalizeAngle(Math.atan2(viewState.forward.x, -viewState.forward.z)) * RAD;
    viewState.elevationDeg =
      Math.atan2(viewState.forward.y, Math.hypot(viewState.forward.x, viewState.forward.z)) * RAD;
  };

  return { beforeControls, afterControls };
}

/**
 * Kamerasteuerung im Zentrum der Himmelskugel.
 *
 * - Touch/Maus: OrbitControls mit invertierter Rotationsrichtung ("Himmel ziehen").
 * - Pinch/Wheel: verändert die Brennweite (FOV) statt der Distanz.
 * - AR-Modus: Quaternion des Geräte-Sensors wird direkt auf die Kamera geslerpt.
 *   Beim Verlassen übernimmt OrbitControls die zuletzt gezeigte Blickrichtung.
 *
 * Sämtliche Winkel leben in Refs bzw. im Modulzustand – nie im React-State.
 */
export function CameraRig(): React.JSX.Element {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const arEnabled = useAppStore((s) => s.arEnabled);
  const arRef = useRef(arEnabled);
  const fovRef = useRef(viewState.fovDeg);
  const frame = useMemo(
    () =>
      createCameraRigFrame(
        camera,
        () => controlsRef.current,
        () => arRef.current,
        () => fovRef.current,
      ),
    [camera],
  );

  arRef.current = arEnabled;

  useEffect(() => {
    camera.position.set(0, 0, EPS_DISTANCE);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
  }, [camera]);

  // Pinch-to-Zoom / Wheel -> FOV. Eigene Listener, damit OrbitControls' Dolly aus bleibt.
  useEffect(() => {
    const element = gl.domElement;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchStart = 0;
    let fovStart = fovRef.current;

    const distance = () => {
      const [a, b] = [...pointers.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };

    const onPointerDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        pinchStart = distance();
        fovStart = fovRef.current;
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size !== 2 || pinchStart <= 0) return;
      const ratio = distance() / pinchStart;
      fovRef.current = clamp(fovStart / ratio, MIN_FOV, MAX_FOV);
    };

    const onPointerUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = 0;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      fovRef.current = clamp(fovRef.current + e.deltaY * 0.04, MIN_FOV, MAX_FOV);
    };

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);
    element.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
      element.removeEventListener('wheel', onWheel);
    };
  }, [gl]);

  useFrame(frame.beforeControls, AR_SWITCH_PRIORITY);
  useFrame((_, delta) => frame.afterControls(delta));

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      target={[0, 0, 0]}
      enablePan={false}
      enableZoom={false}
      enableDamping
      dampingFactor={0.09}
      rotateSpeed={-0.32}
      minDistance={EPS_DISTANCE}
      maxDistance={EPS_DISTANCE}
    />
  );
}
