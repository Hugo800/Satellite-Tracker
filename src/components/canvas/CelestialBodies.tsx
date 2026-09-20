import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending,
  CanvasTexture,
  LinearFilter,
  SRGBColorSpace,
  Vector3,
  type SpriteMaterial,
} from 'three';
import { DEG, azElToVector, clamp } from '../../math/coords';
import { useAppStore } from '../../state/store';
import { SKY_RADIUS } from './SatelliteField';

/** Sonne und Mond liegen hinter den Satelliten, aber vor dem Sternenhimmel. */
const BODY_RADIUS = SKY_RADIUS * 1.08;
/**
 * Beide Scheiben messen real nur rund 0,5°. Auf einem Handydisplay wäre das
 * kaum auszumachen, daher werden sie – wie in Planetariums-Apps üblich – auf
 * etwa 1,8° vergrößert.
 */
const DISC_UNITS = BODY_RADIUS * 1.8 * DEG;
/** Anteil der Texturkante, den die eigentliche Scheibe einnimmt. */
const SUN_DISC_FRACTION = 0.36;
const MOON_DISC_FRACTION = 0.6;
const SUN_SIZE = DISC_UNITS / SUN_DISC_FRACTION;
const MOON_SIZE = DISC_UNITS / MOON_DISC_FRACTION;
/** Darunter steht der Körper unter dem Horizont und wird ausgeblendet. */
const MIN_ALTITUDE_DEG = -0.5;

const TEXTURE_SIZE = 256;

/** Feste Mare-Positionen (Einheiten des Scheibenradius) – kein Flackern pro Frame. */
const MARIA = [
  { x: -0.3, y: -0.22, r: 0.2 },
  { x: 0.16, y: -0.34, r: 0.13 },
  { x: 0.34, y: 0.2, r: 0.17 },
  { x: -0.18, y: 0.34, r: 0.11 },
  { x: -0.44, y: 0.14, r: 0.09 },
  { x: 0.02, y: 0.06, r: 0.14 },
];

function createCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D-Kontext nicht verfügbar');
  return { canvas, ctx };
}

function toTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function createSunTexture(): CanvasTexture {
  const { canvas, ctx } = createCanvas();
  const c = TEXTURE_SIZE / 2;
  const discEdge = SUN_DISC_FRACTION / 2;

  const gradient = ctx.createRadialGradient(c, c, 0, c, c, c);
  gradient.addColorStop(0, 'rgba(255, 253, 242, 1)');
  gradient.addColorStop(discEdge * 0.86, 'rgba(255, 241, 194, 1)');
  gradient.addColorStop(discEdge, 'rgba(255, 206, 110, 0.8)');
  gradient.addColorStop(0.44, 'rgba(255, 168, 60, 0.2)');
  gradient.addColorStop(1, 'rgba(255, 140, 30, 0)');

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  return toTexture(canvas);
}

/**
 * Mondscheibe mit Phase. Der beleuchtete Rand liegt in Texturkoordinaten immer
 * rechts; ausgerichtet wird er später über die Sprite-Rotation.
 *
 * Der Terminator ist die Projektion eines Großkreises und damit eine Ellipse:
 * Ihre halbe Breite beträgt `r * (1 - 2k)`. Bei k = 0,5 entartet sie zur
 * Geraden (Halbmond), das Vorzeichen entscheidet über Sichel bzw. gibbös.
 */
function createMoonTexture(illumination: number): CanvasTexture {
  const { canvas, ctx } = createCanvas();
  const c = TEXTURE_SIZE / 2;
  const r = (TEXTURE_SIZE * MOON_DISC_FRACTION) / 2;

  const halo = ctx.createRadialGradient(c, c, r * 0.92, c, c, c);
  halo.addColorStop(0, 'rgba(191, 211, 244, 0.28)');
  halo.addColorStop(1, 'rgba(140, 175, 230, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  // Unbeleuchteter Teil der Scheibe (Erdschein).
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fillStyle = '#141b2d';
  ctx.fill();

  const k = clamp(illumination, 0, 1);
  const terminator = r * (1 - 2 * k);

  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, r, -Math.PI / 2, Math.PI / 2, false);
  ctx.ellipse(c, c, Math.abs(terminator), r, 0, Math.PI / 2, -Math.PI / 2, terminator > 0);
  ctx.closePath();
  ctx.clip();

  ctx.fillStyle = '#e9eefb';
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  ctx.fillStyle = 'rgba(146, 160, 190, 0.5)';
  for (const mare of MARIA) {
    ctx.beginPath();
    ctx.arc(c + mare.x * r, c + mare.y * r, mare.r * r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  return toTexture(canvas);
}

const sunDir = new Vector3();
const moonDir = new Vector3();
const limbDir = new Vector3();
const camRight = new Vector3();
const camUp = new Vector3();
const camForward = new Vector3();

/**
 * Sonne und Mond an ihrer topozentrischen Position. Beide sind Billboards auf
 * einer Schale außerhalb der Satelliten und werden unter dem Horizont
 * ausgeblendet.
 */
export function CelestialBodies(): React.JSX.Element {
  const sun = useAppStore((s) => s.sun);
  const moon = useAppStore((s) => s.moon);
  const camera = useThree((s) => s.camera);
  const moonMaterialRef = useRef<SpriteMaterial>(null);

  const sunTexture = useMemo(createSunTexture, []);
  useEffect(() => () => sunTexture.dispose(), [sunTexture]);

  // Der Beleuchtungsgrad ändert sich um rund 3 %/Tag; quantisiert wird die
  // Textur damit praktisch nur einmal pro Sitzung neu gezeichnet.
  const illuminationStep = Math.round(clamp(moon.illumination, 0, 1) * 64) / 64;
  const moonTexture = useMemo(() => createMoonTexture(illuminationStep), [illuminationStep]);
  useEffect(() => () => moonTexture.dispose(), [moonTexture]);

  const sunPosition = useMemo(
    () => azElToVector(sun.azimuthDeg * DEG, sun.altitudeDeg * DEG, BODY_RADIUS),
    [sun.azimuthDeg, sun.altitudeDeg],
  );
  const moonPosition = useMemo(
    () => azElToVector(moon.azimuthDeg * DEG, moon.altitudeDeg * DEG, BODY_RADIUS),
    [moon.azimuthDeg, moon.altitudeDeg],
  );

  // Der helle Mondrand zeigt immer zur Sonne – auch wenn diese unter dem
  // Horizont steht. Gerechnet wird über den zur Blickrichtung senkrechten
  // Anteil der Sonnenrichtung, damit das Ergebnis auch hinter der Kamera stimmt.
  useFrame(() => {
    const material = moonMaterialRef.current;
    if (!material) return;

    sunDir.copy(sunPosition).normalize();
    moonDir.copy(moonPosition).normalize();
    limbDir.copy(sunDir).addScaledVector(moonDir, -sunDir.dot(moonDir));
    if (limbDir.lengthSq() < 1e-8) return;
    limbDir.normalize();

    camera.matrixWorld.extractBasis(camRight, camUp, camForward);
    material.rotation = Math.atan2(limbDir.dot(camUp), limbDir.dot(camRight));
  });

  return (
    <group>
      <sprite
        position={sunPosition}
        scale={[SUN_SIZE, SUN_SIZE, 1]}
        visible={sun.altitudeDeg > MIN_ALTITUDE_DEG}
        renderOrder={-20}
      >
        <spriteMaterial
          map={sunTexture}
          transparent
          depthWrite={false}
          depthTest={false}
          blending={AdditiveBlending}
          toneMapped={false}
        />
      </sprite>

      <sprite
        position={moonPosition}
        scale={[MOON_SIZE, MOON_SIZE, 1]}
        visible={moon.altitudeDeg > MIN_ALTITUDE_DEG}
        renderOrder={-19}
      >
        <spriteMaterial
          ref={moonMaterialRef}
          map={moonTexture}
          transparent
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
        />
      </sprite>
    </group>
  );
}
