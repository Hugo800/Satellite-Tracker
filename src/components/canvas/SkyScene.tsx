import { useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { AdaptiveDpr, Preload } from '@react-three/drei';
import { CameraRig } from './CameraRig';
import { CelestialBodies } from './CelestialBodies';
import { HighlightMarkers } from './HighlightMarkers';
import { HorizonGrid } from './HorizonGrid';
import { OrbitTrail } from './OrbitTrail';
import { SatelliteField } from './SatelliteField';
import { SatelliteTrails } from './SatelliteTrails';
import { SkyDome } from './SkyDome';
import { Starfield } from './Starfield';
import { TapPicker } from './TapPicker';

/**
 * Wurzel der 3D-Szene. Die Kamera sitzt exakt im Ursprung (0, 0, 0) – alles
 * andere liegt auf konzentrischen Schalen der invertierten Himmelskugel.
 */
export function SkyScene(): React.JSX.Element {
  // Absicherung gegen eine veraltete Canvas-Größe nach langer Zeit im
  // Hintergrund – NICHT die Ursache des schwarzen Bands am unteren Rand.
  // beb0f5a hielt das für eine der beiden möglichen Erklärungen; die
  // Bildschirmfotos widerlegen es: Auch das Bild von 06:25, nach 6 h im
  // Hintergrund, zeigt den Canvas bis exakt Pixelzeile 2435 (812 pt), also
  // genau bis zur Unterkante des zu kurzen Fensters, und keinen Pixel kürzer.
  // Die Größe war aktuell, nur das Fenster zu klein (siehe index.css und
  // src/utils/viewportShortfall.ts).
  //
  // Die Absicherung bleibt als billige Versicherung für einen Fall, der am
  // Gerät bisher nicht beobachtet wurde: react-three-fiber misst seinen
  // Container über react-use-measure (ResizeObserver + `window`-`resize` +
  // `orientationchange`, siehe node_modules/react-use-measure/dist/index.js),
  // hört aber weder auf `visibilitychange` noch auf `pageshow`. Verschleppt
  // WebKit nach langer Pause den Observer-Callback, stößt ein synthetisches
  // `resize` genau diesen Messpfad erneut an (in Chrome mit erzwungener
  // veralteter Größe belegt, siehe beb0f5a). Zeigt sich der Fall nie, kann sie
  // ersatzlos entfallen.
  useEffect(() => {
    const kick = () => window.dispatchEvent(new Event('resize'));
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') kick();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', kick);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', kick);
    };
  }, []);

  return (
    <Canvas
      className="sky-canvas absolute inset-0"
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
      <CelestialBodies />
      <HorizonGrid />
      <SatelliteTrails />
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
