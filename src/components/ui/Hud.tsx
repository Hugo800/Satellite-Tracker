import { RadarMap } from './RadarMap';
import { SatelliteDrawer } from './SatelliteDrawer';
import { TelemetryPanel } from './TelemetryPanel';
import { TopBar } from './TopBar';

/** 2D-Overlay über dem WebGL-Canvas. Klicks fallen standardmäßig durch. */
export function Hud(): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <TopBar />

      {/*
        Radar und Telemetrie teilen sich eine umbrechende Zeile am unteren Rand.
        Getrennt positioniert (links unten / rechts unten) überlagerten sie sich
        auf schmalen Geräten, sobald beide sichtbar waren – hier rückt die
        Telemetriekarte stattdessen über das Radar.
      */}
      <div
        className="absolute inset-x-0 bottom-0 z-20 flex flex-wrap items-end justify-end gap-2 p-3"
        style={{
          paddingBottom: 'calc(var(--safe-bottom) + 0.75rem)',
          paddingLeft: 'calc(var(--safe-left) + 0.75rem)',
          paddingRight: 'calc(var(--safe-right) + 0.75rem)',
        }}
      >
        <div className="order-2 mr-auto shrink-0">
          <RadarMap />
        </div>
        <div className="order-1 flex w-full justify-end sm:order-3 sm:w-auto">
          <TelemetryPanel />
        </div>
      </div>

      <SatelliteDrawer />
    </div>
  );
}
