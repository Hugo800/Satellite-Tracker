import { useEffect, useMemo, useRef } from 'react';
import { BackSide, ShaderMaterial, Vector3 } from 'three';
import { DEG } from '../../math/coords';
import { azElToVector } from '../../math/coords';
import { useAppStore } from '../../state/store';

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform vec3 uSunDir;
  uniform float uSunAltDeg;
  uniform float uDaylight;

  varying vec3 vDir;

  // Ordered-Dither gegen Banding in den weichen Dämmerungsverläufen.
  float dither(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = clamp(dir.y, -1.0, 1.0);
    float horizonWeight = pow(clamp(1.0 - h, 0.0, 1.0), 2.2);

    vec3 dayZenith   = vec3(0.075, 0.275, 0.700);
    vec3 dayHorizon  = vec3(0.540, 0.720, 0.930);
    vec3 nightZenith = vec3(0.0035, 0.0070, 0.0230);
    vec3 nightHorizon= vec3(0.0220, 0.0380, 0.0820);

    vec3 dayColor   = mix(dayZenith, dayHorizon, horizonWeight);
    vec3 nightColor = mix(nightZenith, nightHorizon, horizonWeight);
    vec3 color = mix(nightColor, dayColor, uDaylight);

    // Dämmerungsglühen: maximal wenn die Sonne 4° unter dem Horizont steht.
    float twilight = exp(-pow((uSunAltDeg + 4.0) / 9.0, 2.0));
    float sunProximity = max(dot(dir, normalize(uSunDir)), 0.0);
    vec3 glow = mix(vec3(0.98, 0.36, 0.11), vec3(1.0, 0.74, 0.38), uDaylight);

    color += glow * pow(sunProximity, 4.0) * twilight * 1.1;
    color += glow * pow(max(0.0, 1.0 - abs(h) * 7.0), 3.0) * twilight * 0.28;

    // Schwaches Airglow-Band knapp über dem Horizont in der Nacht.
    color += vec3(0.02, 0.05, 0.04) * (1.0 - uDaylight) * pow(max(0.0, 1.0 - abs(h) * 10.0), 2.0);

    color += (dither(gl_FragCoord.xy) - 0.5) / 255.0;
    gl_FragColor = vec4(color, 1.0);
  }
`;

/** Invertierte Himmelskugel mit dynamischem Tag-/Dämmerungs-/Nachtverlauf. */
export function SkyDome({ radius = 520 }: { radius?: number }): React.JSX.Element {
  const materialRef = useRef<ShaderMaterial>(null);
  const sun = useAppStore((s) => s.sun);

  const uniforms = useMemo(
    () => ({
      uSunDir: { value: new Vector3(0, -1, 0) },
      uSunAltDeg: { value: -18 },
      uDaylight: { value: 0 },
    }),
    [],
  );

  useEffect(() => {
    const material = materialRef.current;
    if (!material) return;
    azElToVector(sun.azimuthDeg * DEG, sun.altitudeDeg * DEG, 1, material.uniforms.uSunDir.value);
    material.uniforms.uSunAltDeg.value = sun.altitudeDeg;
    material.uniforms.uDaylight.value = sun.daylight;
  }, [sun]);

  return (
    <mesh renderOrder={-100} frustumCulled={false}>
      <sphereGeometry args={[radius, 48, 32]} />
      <shaderMaterial
        ref={materialRef}
        side={BackSide}
        depthWrite={false}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
      />
    </mesh>
  );
}
