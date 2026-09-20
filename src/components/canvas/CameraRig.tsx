import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { PerspectiveCamera } from 'three';
import { RAD, angleDelta, clamp, normalizeAngle } from '../../math/coords';
import { orientationState, viewState } from '../../state/runtime';
import { useAppStore } from '../../state/store';

const MIN_FOV = 22;
const MAX_FOV = 95;
/** Kamera sitzt praktisch im Ursprung; der Mini-Offset hält OrbitControls stabil. */
const EPS_DISTANCE = 1e-4;

/**
 * Kamerasteuerung im Zentrum der Himmelskugel.
 *
 * - Touch/Maus: OrbitControls mit invertierter Rotationsrichtung ("Himmel ziehen").
 * - Pinch/Wheel: verändert die Brennweite (FOV) statt der Distanz.
 * - AR-Modus: Quaternion des Geräte-Sensors wird direkt auf die Kamera geslerpt.
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

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    const arActive = arRef.current && orientationState.available;

    if (controls) controls.enabled = !arActive;

    if (arActive) {
      // Leichtes Slerp glättet Sensorrauschen, ohne spürbare Latenz zu erzeugen.
      camera.quaternion.slerp(orientationState.quaternion, Math.min(1, delta * 12));
    } else if (controls && viewState.focus) {
      const targetTheta = -viewState.focus.azimuth;
      const targetPhi = clamp(Math.PI / 2 + viewState.focus.elevation, 0.02, Math.PI - 0.02);
      const theta = controls.getAzimuthalAngle();
      const phi = controls.getPolarAngle();
      const dTheta = angleDelta(targetTheta, theta);
      const dPhi = targetPhi - phi;
      const k = Math.min(1, delta * 4.5);

      controls.setAzimuthalAngle(theta + dTheta * k);
      controls.setPolarAngle(phi + dPhi * k);
      controls.update();

      if (Math.abs(dTheta) < 0.004 && Math.abs(dPhi) < 0.004) viewState.focus = null;
    }

    if (Math.abs(camera.fov - fovRef.current) > 0.01) {
      camera.fov = fovRef.current;
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
  });

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
