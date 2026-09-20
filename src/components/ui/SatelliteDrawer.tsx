import { useEffect, useMemo, useState } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { RAD, compassLabel } from '../../math/coords';
import { INVISIBLE_MAGNITUDE, passesSkyFilter } from '../../math/visibility';
import { engine } from '../../hooks/useSatelliteEngine';
import { readSample, requestFocus } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import { formatNumber } from '../../utils/format';
import { ModeSwitch, SKY_MODES } from './ModeSwitch';
import type { SatelliteGroup, SatelliteMeta } from '../../types';

const GROUP_LABEL: Record<SatelliteGroup, string> = {
  stations: 'ISS & Stationen',
  brightest: 'Hellste',
  weather: 'Wetter',
  starlink: 'Starlink',
};

const GROUP_DOT: Record<SatelliteGroup, string> = {
  stations: 'bg-amber-400',
  brightest: 'bg-slate-200',
  weather: 'bg-emerald-400',
  starlink: 'bg-sky-400',
};

interface Row {
  meta: SatelliteMeta;
  elevationDeg: number;
  azimuthDeg: number;
  rangeKm: number;
  magnitude: number;
  eclipsed: boolean;
  matchesSky: boolean;
}

/** Durchsuchbare Satellitenliste mit Modusumschaltung und weicher Kamera-Anfahrt. */
export function SatelliteDrawer(): React.JSX.Element {
  const drawerOpen = useAppStore((s) => s.drawerOpen);
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen);
  const catalog = useAppStore((s) => s.catalog);
  const filters = useAppStore((s) => s.filters);
  const setFilters = useAppStore((s) => s.setFilters);
  const select = useAppStore((s) => s.select);
  const selectedIndex = useAppStore((s) => s.selectedIndex);

  // Bewusst nur 0,5 Hz: die Liste muss nicht mit der Renderloop mithalten.
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (!drawerOpen) return;
    const id = window.setInterval(() => setRefreshTick((t) => t + 1), 2000);
    return () => window.clearInterval(id);
  }, [drawerOpen]);

  const rows = useMemo<Row[]>(() => {
    void refreshTick;
    const query = filters.query.trim().toLowerCase();

    const result: Row[] = [];
    for (const meta of catalog) {
      if (query && !meta.name.toLowerCase().includes(query) && !meta.noradId.includes(query)) {
        continue;
      }

      const sample = readSample(meta.index);
      const elevationRad = sample ? sample.elevation : -Math.PI / 2;
      const magnitude = sample ? sample.magnitude : INVISIBLE_MAGNITUDE;
      const eclipsed = sample ? sample.eclipsed : true;
      const matchesSky = passesSkyFilter(
        filters.mode,
        meta.group === 'starlink',
        elevationRad,
        eclipsed,
        magnitude,
      );

      if (!matchesSky && !filters.includeBelowHorizon) continue;
      // Auch im erweiterten Modus bleibt die Liste auf die Moduskategorie beschränkt.
      if (!matchesSky && filters.mode === 'starlink' && meta.group !== 'starlink') continue;

      result.push({
        meta,
        elevationDeg: elevationRad * RAD,
        azimuthDeg: sample ? sample.azimuth * RAD : 0,
        rangeKm: sample ? sample.rangeKm : Number.NaN,
        magnitude,
        eclipsed,
        matchesSky,
      });
    }

    result.sort((a, b) => {
      if (a.matchesSky !== b.matchesSky) return a.matchesSky ? -1 : 1;
      if (filters.mode === 'nakedEye') return a.magnitude - b.magnitude;
      return b.elevationDeg - a.elevationDeg;
    });
    return result.slice(0, 400);
  }, [catalog, filters, refreshTick]);

  const activeMode = SKY_MODES.find((m) => m.value === filters.mode) ?? SKY_MODES[0];
  const visibleCount = rows.filter((r) => r.matchesSky).length;

  return (
    <>
      {drawerOpen && (
        <button
          type="button"
          aria-label="Menü schließen"
          className="pointer-events-auto fixed inset-0 z-30 bg-black/50"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <aside
        className={`pointer-events-auto fixed inset-y-0 right-0 z-40 flex w-[min(86vw,23rem)] flex-col border-l border-sky-400/20 bg-[#04080f]/95 backdrop-blur-xl transition-transform duration-300 ${
          drawerOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}
        aria-hidden={!drawerOpen}
      >
        <header className="flex items-center gap-2 border-b border-sky-400/20 px-3 py-3">
          <SlidersHorizontal size={16} className="text-sky-300" />
          <h2 className="flex-1 text-sm font-semibold tracking-wide text-sky-100">
            {visibleCount} am Himmel
          </h2>
          <button
            type="button"
            aria-label="Schließen"
            className="rounded p-1 text-sky-300 hover:bg-sky-400/15"
            onClick={() => setDrawerOpen(false)}
          >
            <X size={18} />
          </button>
        </header>

        <div className="space-y-2 border-b border-sky-400/10 px-3 py-2.5">
          <ModeSwitch />

          <p className="text-[10px] leading-snug text-slate-500">{activeMode.hint}</p>

          <label className="flex items-center gap-2 rounded-lg border border-sky-400/20 bg-sky-950/40 px-2.5 py-1.5">
            <Search size={14} className="text-sky-300/70" />
            <input
              value={filters.query}
              onChange={(e) => setFilters({ query: e.target.value })}
              placeholder="Name oder NORAD-ID …"
              className="w-full bg-transparent text-sm text-sky-100 outline-none placeholder:text-sky-300/40"
              type="search"
            />
          </label>

          <button
            type="button"
            aria-pressed={filters.includeBelowHorizon}
            onClick={() => setFilters({ includeBelowHorizon: !filters.includeBelowHorizon })}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
              filters.includeBelowHorizon
                ? 'border-sky-400/60 bg-sky-400/20 text-sky-100'
                : 'border-slate-600/50 bg-slate-800/40 text-slate-400'
            }`}
          >
            Auch nicht sichtbare listen
          </button>
        </div>

        <ul className="no-scrollbar flex-1 overflow-y-auto overscroll-contain">
          {rows.length === 0 && (
            <li className="px-4 py-8 text-center text-xs text-slate-500">
              Aktuell entspricht kein Objekt diesem Filter.
            </li>
          )}
          {rows.map((row) => (
            <li key={row.meta.noradId}>
              <button
                type="button"
                onClick={() => {
                  select(row.meta.index);
                  engine.requestPass(row.meta.index);
                  const sample = readSample(row.meta.index);
                  if (sample) requestFocus(sample.azimuth, sample.elevation);
                  setDrawerOpen(false);
                }}
                className={`flex w-full items-center gap-2.5 border-b border-slate-800/60 px-3 py-2.5 text-left transition ${
                  selectedIndex === row.meta.index ? 'bg-sky-400/10' : 'hover:bg-sky-400/5'
                } ${row.matchesSky ? '' : 'opacity-45'}`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${GROUP_DOT[row.meta.group]} ${
                    row.eclipsed ? 'opacity-30' : ''
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-sky-50">
                    {row.meta.name}
                  </span>
                  <span className="block text-[10px] text-slate-400">
                    {GROUP_LABEL[row.meta.group]}
                    {row.magnitude < INVISIBLE_MAGNITUDE
                      ? ` · ${formatNumber(row.magnitude, 1)} mag`
                      : ' · Erdschatten'}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span
                    className={`block text-[13px] tabular-nums ${
                      row.elevationDeg > 0 ? 'text-emerald-300' : 'text-slate-500'
                    }`}
                  >
                    {formatNumber(row.elevationDeg, 1)}°
                  </span>
                  <span className="block text-[10px] tabular-nums text-slate-400">
                    {compassLabel(row.azimuthDeg)} · {formatNumber(row.rangeKm, 0)} km
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
}
