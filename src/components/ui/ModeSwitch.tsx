import { SKY_MODES } from '../../data/skyModes';
import { useAppStore } from '../../state/store';

const GAP_PX = 2;

/**
 * Segmentierter Umschalter im iOS-Stil.
 *
 * Der ausgewählte Zustand ist ein eigener, gleitender „Daumen“ hinter den
 * Beschriftungen – er wird per `transform` bewegt, läuft also auf dem
 * Compositor und nicht über Layout. Breite und Versatz kommen aus `calc()`
 * statt aus einer Messung, damit beim Ein-/Ausblenden nichts springt.
 */
export function ModeSwitch({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const mode = useAppStore((s) => s.filters.mode);
  const setMode = useAppStore((s) => s.setMode);

  const count = SKY_MODES.length;
  const activeIndex = Math.max(
    0,
    SKY_MODES.findIndex((m) => m.value === mode),
  );

  return (
    <div
      role="group"
      aria-label="Darstellungsmodus"
      className="segmented w-full"
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="segmented-thumb"
        style={{
          width: `calc((100% - ${GAP_PX * 2 + GAP_PX * (count - 1)}px) / ${count})`,
          left: `${GAP_PX}px`,
          transform: `translateX(calc(${activeIndex} * (100% + ${GAP_PX}px)))`,
        }}
      />

      {SKY_MODES.map((m) => {
        const Icon = m.icon;
        const active = mode === m.value;
        return (
          <button
            key={m.value}
            type="button"
            aria-pressed={active}
            title={m.hint}
            onClick={() => setMode(m.value)}
            className="segment"
            style={compact ? { minHeight: 30, fontSize: 12.5 } : undefined}
          >
            <Icon size={compact ? 13 : 14} strokeWidth={2.1} aria-hidden />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
