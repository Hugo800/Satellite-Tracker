import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Euler,
  Matrix4,
  ShaderMaterial,
  Vector3,
} from 'three';

const STAR_COUNT = 5200;
const STAR_RADIUS = 500;

/** Spektralklassen-Palette (O/B → M) mit relativer Häufigkeit. */
const SPECTRAL_PALETTE: Array<{ color: [number, number, number]; weight: number }> = [
  { color: [0.62, 0.72, 1.0], weight: 0.06 }, // O/B – bläulich
  { color: [0.78, 0.85, 1.0], weight: 0.12 }, // A
  { color: [1.0, 0.98, 0.93], weight: 0.22 }, // F
  { color: [1.0, 0.95, 0.8], weight: 0.28 }, // G – sonnenähnlich
  { color: [1.0, 0.83, 0.62], weight: 0.2 }, // K
  { color: [1.0, 0.68, 0.5], weight: 0.12 }, // M – rötlich
];

function pickColor(random: number): [number, number, number] {
  let acc = 0;
  for (const entry of SPECTRAL_PALETTE) {
    acc += entry.weight;
    if (random <= acc) return entry.color;
  }
  return SPECTRAL_PALETTE[3].color;
}

function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const vertexShader = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  attribute vec3 aColor;

  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uFovScale;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vColor = aColor;

    // Szintillation: horizontnahe Sterne flackern deutlich stärker.
    float altitude = normalize(position).y;
    float horizonBoost = 1.0 - smoothstep(0.0, 0.55, max(altitude, 0.0));
    float twinkle = 1.0 + (0.08 + 0.26 * horizonBoost) * sin(uTime * 2.7 + aPhase * 8.0);

    // Sterne bleiben bewusst Hintergrund – sie dürfen die Satelliten nicht überstrahlen.
    vAlpha = twinkle * 0.5;

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = aSize * uPixelRatio * uFovScale * twinkle;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.0, d);
    float halo = pow(core, 3.0);
    float alpha = clamp(vAlpha, 0.0, 1.0) * (core * 0.28 + halo * 0.55);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(vColor, alpha);
  }
`;

/**
 * Prozeduraler Sternenhimmel als GPU-Punktwolke.
 * Helligkeitsverteilung folgt grob einer Potenzfunktion (viele schwache,
 * wenige sehr helle Sterne); zusätzlich eine verdichtete Milchstraßenbande.
 */
export function Starfield(): React.JSX.Element {
  const materialRef = useRef<ShaderMaterial>(null);

  const geometry = useMemo(() => {
    const positions = new Float32Array(STAR_COUNT * 3);
    const colors = new Float32Array(STAR_COUNT * 3);
    const sizes = new Float32Array(STAR_COUNT);
    const phases = new Float32Array(STAR_COUNT);

    // Feste Ausrichtung der galaktischen Ebene gegenüber dem Horizontsystem.
    const galacticTilt = new Matrix4().makeRotationFromEuler(new Euler(1.1, 0.6, 0.35, 'XYZ'));
    const dir = new Vector3();

    for (let i = 0; i < STAR_COUNT; i += 1) {
      const inMilkyWay = Math.random() < 0.38;

      if (inMilkyWay) {
        const lon = Math.random() * Math.PI * 2;
        const lat = gaussian() * 0.13;
        dir.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
        dir.applyMatrix4(galacticTilt);
      } else {
        const u = Math.random() * 2 - 1;
        const theta = Math.random() * Math.PI * 2;
        const r = Math.sqrt(1 - u * u);
        dir.set(r * Math.cos(theta), u, r * Math.sin(theta));
      }

      positions[i * 3 + 0] = dir.x * STAR_RADIUS;
      positions[i * 3 + 1] = dir.y * STAR_RADIUS;
      positions[i * 3 + 2] = dir.z * STAR_RADIUS;

      // Potenzverteilung -> wenige helle Leitsterne, viele Hintergrundsterne.
      const brightness = Math.pow(Math.random(), 3.4);
      sizes[i] = 0.7 + brightness * 4.3 + (inMilkyWay ? -0.15 : 0);
      phases[i] = Math.random();

      const [r0, g0, b0] = pickColor(Math.random());
      const intensity = 0.45 + brightness * 0.55;
      colors[i * 3 + 0] = r0 * intensity;
      colors[i * 3 + 1] = g0 * intensity;
      colors[i * 3 + 2] = b0 * intensity;
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('aColor', new BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new BufferAttribute(sizes, 1));
    geo.setAttribute('aPhase', new BufferAttribute(phases, 1));
    return geo;
  }, []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uFovScale: { value: 1 },
    }),
    [],
  );

  useFrame((state, delta) => {
    const material = materialRef.current;
    if (!material) return;
    material.uniforms.uTime.value += delta;
    const fov = (state.camera as { fov?: number }).fov ?? 70;
    material.uniforms.uFovScale.value = Math.min(2.4, 70 / fov);
  });

  return (
    <points geometry={geometry} frustumCulled={false} renderOrder={-50}>
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        depthTest={false}
        blending={AdditiveBlending}
      />
    </points>
  );
}
