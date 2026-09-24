import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { RAD, compassLabel } from '../../math/coords';
import { INVISIBLE_MAGNITUDE, passesSkyFilter } from '../../math/visibility';
import { readSample, requestFocus } from '../../state/runtime';
import type { SatelliteSample } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import { formatCount, formatNumber } from '../../utils/format';
import { ModeSwitch } from './ModeSwitch';
import { GROUP_COLORS, GROUP_LABEL } from '../../data/groups';
import { SKY_MODES } from '../../data/skyModes';
import type { SatelliteMeta } from '../../types';

/** Feste Zeilenhöhe – Voraussetzung für die Fensterung ohne Messung je Zeile. */
const ROW_HEIGHT = 58;
/** Zusätzlich gerenderte Zeilen ober- und unterhalb des Sichtfensters. */
const OVERSCAN = 6;

interface Row {
  meta: SatelliteMeta;
  elevationDeg: number;
  azimuthDeg: number;
  rangeKm: number;
  magnitude: number;
  eclipsed: boolean;
  matchesSky: boolean;
}

/** Ein wiederverwendetes Ziel für `readSample` – der Katalog ist fünfstellig. */
const scratch = {} as SatelliteSample;

/**
 * Durchsuchbare Satellitenliste mit Modusumschaltung und weicher Kamera-Anfahrt.
 *
 * Die Liste ist **nicht** gekappt: Sie führt jedes Objekt, das dem Filter
 * entspricht. Damit das auch bei mehreren tausend Treffern flüssig bleibt,
 * hängen nur die tatsächlich sichtbaren Zeilen im DOM – der Rest wird über die
 * Gesamthöhe des Scrollbereichs dargestellt.
 */
export function SatelliteDrawer(): React.JSX.Element {
  const drawerOpen = useAppStore((s) => s.drawerOpen);
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen);
  const catalog = useAppStore((s) => s.catalog);
  const filters = useAppStore((s) => s.filters);
  const setFilters = useAppStore((s) => s.setFilters);
  const select = useAppStore((s) => s.select);
  const selectedId = useAppStore((s) => s.selectedId);

  /*
   * Die Sucheingabe hängt an lokalem State und wird kurz verzögert in den
   * Store übernommen. Damit hängt die Eingabe nicht mehr am Listendurchlauf:
   * Ein Tastendruck ginge sonst über den Store und löste einen vollständigen
   * Durchlauf über den Katalog samt Sortierung und einen Re-Render des
   * Drawers aus.
   *
   * Gemessen kostet so ein Durchlauf bei 12.500 Objekten allerdings nur rund
   * 1,3 ms auf einem Desktop-Kern – deutlich weniger, als die Bauform
   * vermuten lässt. Die Verzögerung bleibt deshalb bewusst kurz: Sie soll
   * eine Tippfolge zusammenfassen, nicht die Trefferliste spürbar nachhinken
   * lassen.
   */
  const [draftQuery, setDraftQuery] = useState(filters.query);

  useEffect(() => {
    if (draftQuery === filters.query) return;
    const id = window.setTimeout(() => setFilters({ query: draftQuery }), 110);
    return () => window.clearTimeout(id);
  }, [draftQuery, filters.query, setFilters]);

  // Beim Öffnen den Entwurf mit dem Store abgleichen.
  useEffect(() => {
    if (drawerOpen) setDraftQuery(useAppStore.getState().filters.query);
  }, [drawerOpen]);

  // Bewusst nur 0,5 Hz: die Liste muss nicht mit der Renderloop mithalten.
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (!drawerOpen) return;
    const id = window.setInterval(() => setRefreshTick((t) => t + 1), 2000);
    return () => window.clearInterval(id);
  }, [drawerOpen]);

  const rows = useMemo<Row[]>(() => {
    void refreshTick;
    if (!drawerOpen) return [];
    const query = filters.query.trim().toLowerCase();

    const result: Row[] = [];
    for (const meta of catalog) {
      if (query && !meta.name.toLowerCase().includes(query) && !meta.noradId.includes(query)) {
        continue;
      }

      const sample = readSample(meta.index, scratch);
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
    return result;
  }, [catalog, filters, refreshTick, drawerOpen]);

  const activeMode = SKY_MODES.find((m) => m.value === filters.mode) ?? SKY_MODES[0];
  const visibleCount = useMemo(() => rows.reduce((n, r) => n + (r.matchesSky ? 1 : 0), 0), [rows]);

  /* --- Fensterung --- */
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(640);
  const scrollFrame = useRef(0);

  const onScroll = useCallback(() => {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      if (listRef.current) setScrollTop(listRef.current.scrollTop);
    });
  }, []);

  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);

  useEffect(() => {
    const node = listRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setViewport(node.clientHeight));
    observer.observe(node);
    setViewport(node.clientHeight);
    return () => observer.disconnect();
  }, []);

  // Beim Filter-/Suchwechsel wieder nach oben – sonst zeigt das Fenster in
  // eine Liste, die es nicht mehr gibt.
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [filters.mode, filters.query, filters.includeBelowHorizon]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const windowSize = Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN * 2;
  const window_ = rows.slice(first, first + windowSize);

  const pick = useCallback(
    (row: Row) => {
      // Gewählt wird die Identität; die Überflugliste fordert
      // useSatelliteEngine an, sobald die Auswahl steht. Der Platz dient nur
      // noch dem Kameraschwenk auf die aktuelle Position.
      select(row.meta.noradId);
      const sample = readSample(row.meta.index);
      if (sample) requestFocus(sample.azimuth, sample.elevation);
      setDrawerOpen(false);
    },
    [select, setDrawerOpen],
  );

  return (
    <>
      {drawerOpen && (
        <button
          type="button"
          aria-label="Menü schließen"
          className="pointer-events-auto fixed inset-0 z-30 transition-opacity"
          style={{ background: 'var(--scrim)', transitionDuration: 'var(--t-base)' }}
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <aside
        className="material-strong pointer-events-auto fixed inset-y-0 right-0 z-40 flex w-[min(88vw,24rem)] flex-col border-y-0 border-r-0"
        style={{
          paddingTop: 'var(--safe-top)',
          paddingBottom: 'var(--safe-bottom)',
          transform: drawerOpen ? 'translateX(0)' : 'translateX(100%)',
          transition: `transform var(--t-slow) var(--ease-out)`,
        }}
        inert={!drawerOpen}
      >
        <header className="hairline-b flex items-center gap-2 px-3 py-2.5">
          <SlidersHorizontal size={16} strokeWidth={2.2} className="text-accent" aria-hidden />
          <h2 className="flex-1 text-[17px] font-semibold tracking-[-0.01em] text-label">
            {formatCount(visibleCount)} am Himmel
          </h2>
          <button
            type="button"
            aria-label="Schließen"
            className="icon-button"
            onClick={() => setDrawerOpen(false)}
          >
            <X size={19} strokeWidth={2} aria-hidden />
          </button>
        </header>

        <div className="hairline-b space-y-2.5 px-3 py-3">
          <ModeSwitch />

          <p className="text-[12px] leading-snug text-label-2">{activeMode.hint}</p>

          <label className="field">
            <Search size={15} strokeWidth={2.2} className="text-label-3" aria-hidden />
            <input
              value={draftQuery}
              onChange={(e) => setDraftQuery(e.target.value)}
              placeholder="Name oder NORAD-ID …"
              type="search"
              aria-label="Satelliten suchen"
            />
          </label>

          <button
            type="button"
            aria-pressed={filters.includeBelowHorizon}
            onClick={() => setFilters({ includeBelowHorizon: !filters.includeBelowHorizon })}
            className="pill"
          >
            Auch nicht sichtbare listen
          </button>
        </div>

        <div
          ref={listRef}
          onScroll={onScroll}
          className="no-scrollbar flex-1 overflow-y-auto overscroll-contain"
        >
          {rows.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-label-2">
              Aktuell entspricht kein Objekt diesem Filter.
            </p>
          ) : (
            <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
              {window_.map((row, i) => (
                <ListRow
                  key={row.meta.noradId}
                  row={row}
                  top={(first + i) * ROW_HEIGHT}
                  selected={selectedId === row.meta.noradId}
                  onSelect={pick}
                />
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function ListRow({
  row,
  top,
  selected,
  onSelect,
}: {
  row: Row;
  top: number;
  selected: boolean;
  onSelect: (row: Row) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onSelect(row)}
      className="row hairline-b absolute inset-x-0"
      style={{
        top,
        height: ROW_HEIGHT,
        background: selected ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : undefined,
        opacity: row.matchesSky ? 1 : 0.45,
      }}
    >
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full"
        style={{
          background: GROUP_COLORS[row.meta.group],
          opacity: row.eclipsed ? 0.35 : 1,
        }}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium tracking-[-0.01em] text-label">
          {row.meta.name}
        </span>
        <span className="block truncate text-[11.5px] text-label-2">
          {GROUP_LABEL[row.meta.group]}
          {row.magnitude < INVISIBLE_MAGNITUDE
            ? ` · ${formatNumber(row.magnitude, 1)} mag`
            : ' · Erdschatten'}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span
          className="block text-[15px] font-medium"
          style={{ color: row.elevationDeg > 0 ? 'var(--positive)' : 'var(--label-3)' }}
        >
          {formatNumber(row.elevationDeg, 1)}°
        </span>
        <span className="block text-[11.5px] text-label-2">
          {compassLabel(row.azimuthDeg)} · {formatNumber(row.rangeKm, 0)} km
        </span>
      </span>
    </button>
  );
}
