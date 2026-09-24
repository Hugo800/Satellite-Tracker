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
  // Hintergrund: react-three-fiber misst seinen Container über
  // react-use-measure (ResizeObserver + `window`-`resize` + `orientation`-
  // `change`, siehe node_modules/react-use-measure/dist/index.js) – aber
  // ohne eigenen Listener auf `visibilitychange` oder `pageshow`. Normalerweise
  // reicht das, weil ResizeObserver jede tatsächliche Größenänderung der Box
  // meldet, unabhängig davon, ob dafür ein Fenster-Event feuert. Bekannt ist
  // aber, dass WebKit in einer länger pausierten Standalone-PWA
  // Layout-/Observer-Callbacks verschleppt, bis wieder etwas anderes einen
  // Reflow anstößt. Ein synthetisches `resize`-Event kostet fast nichts und
  // stößt genau den vorhandenen Messpfad erneut an, falls die Größe beim
  // Aufwachen tatsächlich veraltet war – ob dieser Fall real vorkommt, lässt
  // sich nur am Gerät prüfen (siehe Bilanz der Aufgabe).
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
