import { SkyScene } from './components/canvas/SkyScene';
import { Hud } from './components/ui/Hud';
import { useCelestialBodies } from './hooks/useCelestialBodies';
import { useGeolocation } from './hooks/useGeolocation';
import { useSatelliteEngine } from './hooks/useSatelliteEngine';
import { useTheme } from './hooks/useTheme';
import { useAppStore } from './state/store';

export default function App(): React.JSX.Element {
  useGeolocation();
  useCelestialBodies();
  useTheme();
  useSatelliteEngine({ intervalMs: 100 });

  const nightMode = useAppStore((s) => s.nightMode);

  return (
    <div
      className={`relative h-full w-full overflow-hidden bg-black ${
        nightMode ? 'night-vision' : ''
      }`}
    >
      <SkyScene />
      <Hud />
    </div>
  );
}
