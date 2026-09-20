import { useEffect, useMemo } from 'react';
import { BufferAttribute, BufferGeometry, DoubleSide } from 'three';
import { DEG, azElToVector } from '../../math/coords';
import { createTextTexture, textureAspect } from './textSprite';

const GRID_RADIUS = 470;

/** Elevationsringe (Almukantarate) inkl. Zenit-Markierung. */
const ALTITUDE_RINGS = [0, 30, 60, 85];
const AZIMUTH_MERIDIANS = [0, 45, 90, 135, 180, 225, 270, 315];

const CARDINALS: Array<{ label: string; azimuth: number; major: boolean }> = [
  { label: 'N', azimuth: 0, major: true },
  { label: 'NO', azimuth: 45, major: false },
  { label: 'O', azimuth: 90, major: true },
  { label: 'SO', azimuth: 135, major: false },
  { label: 'S', azimuth: 180, major: true },
  { label: 'SW', azimuth: 225, major: false },
  { label: 'W', azimuth: 270, major: true },
  { label: 'NW', azimuth: 315, major: false },
];

function buildGridGeometry(): BufferGeometry {
  const points: number[] = [];
  const push = (azDeg: number, elDeg: number) => {
    const v = azElToVector(azDeg * DEG, elDeg * DEG, GRID_RADIUS);
    points.push(v.x, v.y, v.z);
  };

  for (const elevation of ALTITUDE_RINGS) {
    const segments = 128;
    for (let i = 0; i < segments; i += 1) {
      push((i / segments) * 360, elevation);
      push(((i + 1) / segments) * 360, elevation);
    }
  }

  for (const azimuth of AZIMUTH_MERIDIANS) {
    const segments = 36;
    for (let i = 0; i < segments; i += 1) {
      push(azimuth, (i / segments) * 90);
      push(azimuth, ((i + 1) / segments) * 90);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
  return geometry;
}

function CardinalLabel({
  label,
  azimuth,
  major,
}: {
  label: string;
  azimuth: number;
  major: boolean;
}): React.JSX.Element {
  const texture = useMemo(
    () =>
      createTextTexture(label, {
        fontSize: major ? 120 : 84,
        color: major ? '#bae6fd' : '#7dd3fc',
        glow: 'rgba(14, 165, 233, 0.85)',
      }),
    [label, major],
  );

  useEffect(() => () => texture.dispose(), [texture]);

  const position = useMemo(
    () => azElToVector(azimuth * DEG, (major ? 5 : 3.5) * DEG, GRID_RADIUS * 0.94),
    [azimuth, major],
  );
  const height = major ? 34 : 22;

  return (
    <sprite position={position} scale={[height * textureAspect(texture), height, 1]}>
      <spriteMaterial
        map={texture}
        transparent
        depthWrite={false}
        depthTest={false}
        opacity={major ? 0.95 : 0.65}
      />
    </sprite>
  );
}

function AltitudeLabel({ elevation }: { elevation: number }): React.JSX.Element {
  const texture = useMemo(
    () =>
      createTextTexture(`${elevation}°`, {
        fontSize: 64,
        color: '#7dd3fc',
        glow: 'rgba(14, 165, 233, 0.5)',
        bold: false,
      }),
    [elevation],
  );
  useEffect(() => () => texture.dispose(), [texture]);

  const position = useMemo(
    () => azElToVector(90 * DEG, elevation * DEG, GRID_RADIUS * 0.96),
    [elevation],
  );

  return (
    <sprite position={position} scale={[14 * textureAspect(texture), 14, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} depthTest={false} opacity={0.5} />
    </sprite>
  );
}

/**
 * Orientierungsgitter im 3D-Raum: Höhenwinkelringe, Azimut-Meridiane,
 * Himmelsrichtungs-Marker und eine halbtransparente Bodenebene, die
 * Bahnspuren unterhalb des Horizonts verdeckt.
 */
export function HorizonGrid(): React.JSX.Element {
  const geometry = useMemo(buildGridGeometry, []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const horizonGeometry = useMemo(() => {
    const points: number[] = [];
    const segments = 180;
    for (let i = 0; i <= segments; i += 1) {
      const v = azElToVector(((i / segments) * 360) * DEG, 0, GRID_RADIUS);
      points.push(v.x, v.y, v.z);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
    return geo;
  }, []);
  useEffect(() => () => horizonGeometry.dispose(), [horizonGeometry]);

  return (
    <group>
      <lineSegments geometry={geometry} renderOrder={-10}>
        <lineBasicMaterial color="#38bdf8" transparent opacity={0.16} depthWrite={false} />
      </lineSegments>

      <lineLoop geometry={horizonGeometry} renderOrder={-9}>
        <lineBasicMaterial color="#67e8f9" transparent opacity={0.55} depthWrite={false} />
      </lineLoop>

      {/* Boden: verdeckt Objekte unter dem Horizont, bleibt aber lesbar dunkel. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.5, 0]} renderOrder={-8}>
        <circleGeometry args={[GRID_RADIUS * 1.02, 96]} />
        <meshBasicMaterial color="#04070d" transparent opacity={0.94} side={DoubleSide} />
      </mesh>

      {CARDINALS.map((c) => (
        <CardinalLabel key={c.label} {...c} />
      ))}
      {[30, 60].map((el) => (
        <AltitudeLabel key={el} elevation={el} />
      ))}
    </group>
  );
}
