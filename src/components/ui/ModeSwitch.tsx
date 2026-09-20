import { Eye, Globe2, Satellite } from 'lucide-react';
import { useAppStore } from '../../state/store';
import type { SkyFilterMode } from '../../types';

export const SKY_MODES: Array<{
  value: SkyFilterMode;
  label: string;
  hint: string;
  icon: typeof Eye;
}> = [
  {
    value: 'all',
    label: 'Alle',
    hint: 'Jedes Katalogobjekt über dem Horizont – unabhängig von Größe und Helligkeit.',
    icon: Globe2,
  },
  {
    value: 'nakedEye',
    label: 'Sichtbar',
    hint: 'Nur sonnenbeschienene Objekte heller als 4 mag bei dunklem Himmel über 10° Höhe.',
    icon: Eye,
  },
  {
    value: 'starlink',
    label: 'Starlink',
    hint: 'Ausschließlich Starlink-Satelliten über dem Horizont.',
    icon: Satellite,
  },
];

/** Segmentierter Umschalter zwischen den drei Himmelsfiltern. */
export function ModeSwitch({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const mode = useAppStore((s) => s.filters.mode);
  const setMode = useAppStore((s) => s.setMode);

  return (
    <div
      role="group"
      aria-label="Darstellungsmodus"
      className="grid grid-cols-3 gap-1 rounded-lg border border-sky-400/20 bg-slate-900/70 p-1"
    >
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
            className={`flex items-center justify-center gap-1.5 rounded-md transition ${
              compact ? 'px-2 py-1 text-[10px]' : 'px-2 py-1.5 text-[11px]'
            } font-medium ${
              active
                ? 'bg-sky-400/25 text-sky-100 shadow-[inset_0_0_0_1px_rgb(56_189_248/0.5)]'
                : 'text-slate-400 hover:bg-sky-400/10'
            }`}
          >
            <Icon size={compact ? 12 : 13} />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
