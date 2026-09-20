import { RadarMap } from './RadarMap';
import { SatelliteDrawer } from './SatelliteDrawer';
import { TelemetryPanel } from './TelemetryPanel';
import { TopBar } from './TopBar';

/** 2D-Overlay über dem WebGL-Canvas. Klicks fallen standardmäßig durch. */
export function Hud(): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <TopBar />

      <div
        className="absolute bottom-0 left-0 z-20 p-3"
        style={{ paddingBottom: 'calc(var(--safe-bottom) + 0.75rem)' }}
      >
        <RadarMap />
      </div>

      <div
        className="absolute bottom-0 right-0 z-20 flex justify-end p-3"
        style={{ paddingBottom: 'calc(var(--safe-bottom) + 0.75rem)' }}
      >
        <TelemetryPanel />
      </div>

      <SatelliteDrawer />
    </div>
  );
}
