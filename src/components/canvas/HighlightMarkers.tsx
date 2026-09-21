import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, Group } from 'three';
import { azElToVector } from '../../math/coords';
import { TELEMETRY_STRIDE, T_AZ, T_ECLIPSED, T_EL } from '../../math/telemetryLayout';
import { telemetry } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import { SKY_RADIUS } from '../../data/groups';
import { createTextTexture, textureAspect } from './textSprite';

function HighlightLabel({ name }: { name: string }): React.JSX.Element {
  const texture = useMemo(
    () =>
      createTextTexture(name, {
        fontSize: 72,
        color: '#ffd60a',
        glow: 'rgba(255, 159, 10, 0.75)',
        bold: false,
      }),
    [name],
  );
  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <sprite position={[0, 16, 0]} scale={[13 * textureAspect(texture), 13, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} depthTest={false} />
    </sprite>
  );
}

/**
 * Prominente Objekte (ISS, Hubble, Tiangong …) erhalten eigene Meshes,
 * einen pulsierenden Halo und ein Klartext-Label.
 */
export function HighlightMarkers(): React.JSX.Element | null {
  const catalog = useAppStore((s) => s.catalog);
  const highlights = useMemo(() => catalog.filter((s) => s.highlight), [catalog]);
  const groupRefs = useRef<Array<Group | null>>([]);

  useFrame((state) => {
    const data = telemetry.data;
    const time = state.clock.elapsedTime;

    highlights.forEach((sat, i) => {
      const group = groupRefs.current[i];
      if (!group) return;
      if (sat.index >= telemetry.count) {
        group.visible = false;
        return;
      }

      const base = sat.index * TELEMETRY_STRIDE;
      const elevation = data[base + T_EL];
      group.visible = elevation > -0.02;
      if (!group.visible) return;

      azElToVector(data[base + T_AZ], elevation, SKY_RADIUS * 0.985, group.position);
      const eclipsed = data[base + T_ECLIPSED] > 0.5;
      const pulse = 1 + 0.12 * Math.sin(time * 3.1 + i);
      group.scale.setScalar(pulse * (eclipsed ? 0.72 : 1));
      group.lookAt(0, 0, 0);
    });
  });

  if (highlights.length === 0) return null;

  return (
    <group renderOrder={8}>
      {highlights.map((sat, i) => (
        <group
          key={sat.noradId}
          ref={(node) => {
            groupRefs.current[i] = node;
          }}
          visible={false}
        >
          <mesh>
            <octahedronGeometry args={[4.4, 0]} />
            <meshBasicMaterial color="#ffd60a" toneMapped={false} />
          </mesh>
          <mesh>
            <ringGeometry args={[7.5, 9.2, 48]} />
            <meshBasicMaterial
              color="#ff9f0a"
              transparent
              opacity={0.75}
              blending={AdditiveBlending}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
          <HighlightLabel name={sat.name} />
        </group>
      ))}
    </group>
  );
}
