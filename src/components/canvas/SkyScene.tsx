import { Canvas } from '@react-three/fiber';
import { AdaptiveDpr, Preload } from '@react-three/drei';
import { CameraRig } from './CameraRig';
import { HighlightMarkers } from './HighlightMarkers';
import { HorizonGrid } from './HorizonGrid';
import { OrbitTrail } from './OrbitTrail';
import { SatelliteField } from './SatelliteField';
import { SkyDome } from './SkyDome';
import { Starfield } from './Starfield';
import { TapPicker } from './TapPicker';

/**
 * Wurzel der 3D-Szene. Die Kamera sitzt exakt im Ursprung (0, 0, 0) – alles
 * andere liegt auf konzentrischen Schalen der invertierten Himmelskugel.
 */
export function SkyScene(): React.JSX.Element {
  return (
    <Canvas
      className="absolute inset-0"
      dpr={[1, 2]}
      gl={{
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
      }}
      camera={{ fov: 70, near: 0.01, far: 2000, position: [0, 0, 0.0001] }}
      performance={{ min: 0.55 }}
      flat
    >
      <SkyDome />
      <Starfield />
      <HorizonGrid />
      <SatelliteField />
      <HighlightMarkers />
      <OrbitTrail />
      <CameraRig />
      <TapPicker />
      <AdaptiveDpr pixelated />
      <Preload all />
    </Canvas>
  );
}
