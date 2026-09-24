import { create } from 'zustand';
import { normalizeNoradId } from '../data/tleSources';
import { resolveSelection } from './runtime';
import type {
  CatalogFilters,
  CompassStatus,
  GeoCoord,
  MoonState,
  NoradId,
  PassPrediction,
  SatelliteGroup,
  SatelliteMeta,
  SkyFilterMode,
  SunState,
  ThemePreference,
} from '../types';

export interface AppState {
  observer: GeoCoord | null;
  geoError: string | null;
  catalog: SatelliteMeta[];
  /** Steigt bei jedem Katalog-Update; Abnehmer von `catalogIndex.meta` hängen daran. */
  catalogVersion: number;
  activeGroups: SatelliteGroup[];
  status: string;
  loading: boolean;
  errors: string[];

  /**
   * Das gewählte Objekt, als normalisierte NORAD-ID. Sie ist die Identität der
   * Auswahl: Sie überlebt einen neu aufgebauten Katalog, in dem dasselbe Objekt
   * auf einem anderen Platz steht, und taugt als Schlüssel über einen Neustart
   * hinaus.
   */
  selectedId: NoradId | null;
  /**
   * Platz der Auswahl im aktuellen Katalog – aus `selectedId` abgeleitet, nie
   * selbst eine Identität.
   *
   * `null`: nichts gewählt. `-1`: gewählt, aber die ID steht gerade nicht im
   * Katalog (Gruppe noch nicht geladen oder fehlgeschlagen, Pool neu
   * aufgebaut, Objekt nicht mehr im Datensatz). Sonst der Platz in
   * `telemetry.data` und `catalogIndex`.
   *
   * Das Radar vergleicht damit in seiner Schleife eine Zahl je Objekt statt
   * einer Zeichenkette; der Ring in SatelliteField liest einmal je Bild eine
   * Zahl, seine Objektschleife liest die Auswahl gar nicht. Geschrieben wird es nur hier, von `select` und
   * `setCatalog` – also genau dann, wenn sich Auswahl oder Katalog ändern.
   * Hud.tsx liest nur `!== null`: Auch mit -1 bleibt die Karte samt Hinweis
   * stehen, und das Radar weicht auf Telefonbreite wie bei jeder Auswahl.
   */
  selectedIndex: number | null;
  /**
   * Metadaten der Auswahl im aktuellen Katalog, oder `null`, solange sie
   * nicht aufgelöst ist. Ebenfalls abgeleitet und mit `selectedIndex`
   * zusammen geschrieben. Ein neues Objekt heißt: neue Bahndaten für dieselbe
   * ID – etwa wenn echte Daten den Offline-Fallback ersetzen. Überflugliste
   * und Bahnspur werden dann neu angefordert (useSatelliteEngine, OrbitTrail);
   * sonst blieben sie aus dem veralteten Satz gerechnet.
   */
  selectedMeta: SatelliteMeta | null;
  passes: PassPrediction[];
  /** Objekt, zu dem `passes` gehört – verhindert, dass eine verzögerte Antwort die neue Auswahl überschreibt. */
  passId: NoradId | null;
  passPending: boolean;

  filters: CatalogFilters;
  drawerOpen: boolean;
  arEnabled: boolean;
  arSupported: boolean;
  compassStatus: CompassStatus;
  nightMode: boolean;
  showTrails: boolean;
  theme: ThemePreference;
  sun: SunState;
  moon: MoonState;

  setObserver: (observer: GeoCoord) => void;
  setGeoError: (message: string | null) => void;
  setCatalog: (catalog: SatelliteMeta[]) => void;
  setStatus: (status: string, loading: boolean) => void;
  pushError: (message: string) => void;
  /** Nimmt jede Schreibweise einer NORAD-ID an (`A0001`, `00005`) und normalisiert sie. */
  select: (noradId: string | null) => void;
  setPasses: (noradId: NoradId, passes: PassPrediction[]) => void;
  setPassPending: (pending: boolean) => void;
  setFilters: (patch: Partial<CatalogFilters>) => void;
  setMode: (mode: SkyFilterMode) => void;
  toggleGroup: (group: SatelliteGroup) => void;
  setDrawerOpen: (open: boolean) => void;
  setAr: (enabled: boolean) => void;
  setArSupported: (supported: boolean) => void;
  setCompassStatus: (status: CompassStatus) => void;
  toggleNightMode: () => void;
  toggleTrails: () => void;
  setTheme: (theme: ThemePreference) => void;
  setSun: (sun: SunState) => void;
  setMoon: (moon: MoonState) => void;
}

const DEFAULT_FILTERS: CatalogFilters = {
  mode: 'all',
  includeBelowHorizon: false,
  query: '',
};

const THEME_KEY = 'orbital-atlas:theme';

function readStoredTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    /* Privater Modus o. Ä. – dann gilt schlicht die Systemeinstellung. */
  }
  return 'system';
}

export const useAppStore = create<AppState>((set) => ({
  observer: null,
  geoError: null,
  catalog: [],
  catalogVersion: 0,
  // `other` ist der Gesamtkatalog – er ist von Anfang an aktiv, damit der
  // Modus „Alle“ wirklich alles zeigt und nicht nur vier Teilgruppen.
  activeGroups: ['stations', 'brightest', 'weather', 'starlink', 'other'],
  status: 'Initialisiere …',
  loading: true,
  errors: [],

  selectedId: null,
  selectedIndex: null,
  selectedMeta: null,
  passes: [],
  passId: null,
  passPending: false,

  filters: DEFAULT_FILTERS,
  drawerOpen: false,
  arEnabled: false,
  arSupported: false,
  compassStatus: 'unknown',
  nightMode: false,
  showTrails: true,
  theme: readStoredTheme(),
  sun: { altitudeDeg: -18, azimuthDeg: 0 },
  moon: { altitudeDeg: -18, azimuthDeg: 0, illumination: 0.5 },

  setObserver: (observer) => set({ observer, geoError: null }),
  setGeoError: (geoError) => set({ geoError }),
  // Bewusst ohne Index-Map: Die lag früher hier und wurde bei jedem Update
  // über alle Einträge neu gebaut – für genau eine Abfrage. Der Zugriff nach
  // Index läuft jetzt über `catalogIndex.meta` im Laufzeitzustand, der nach
  // ID über `catalogIndex.slotById`. Die beiden entstehen NICHT gleichzeitig:
  // `meta` schreibt der Hook sofort bei jeder `catalog`-Nachricht, `slotById`
  // und die Flags erst gebündelt in `flushCatalog` (useSatelliteEngine.ts)
  // unmittelbar vor diesem Aufruf. Genau diesen Versatz fängt der Abgleich
  // `meta.noradId` in `resolveSelection` ab. Hier wird nur
  // nachgeschlagen: Die Auswahl hängt an der ID, ihr Platz folgt der neuen
  // Katalogfassung – und löst sich von selbst auf, sobald ein zuvor fehlendes
  // Objekt eintrifft.
  setCatalog: (catalog) =>
    set((state) => ({
      catalog,
      catalogVersion: state.catalogVersion + 1,
      ...resolveSelection(state.selectedId),
    })),
  setStatus: (status, loading) => set({ status, loading }),
  pushError: (message) =>
    set((state) =>
      // Dieselbe Meldung kann aus mehreren Shards auflaufen – einmal reicht.
      state.errors.includes(message) ? state : { errors: [...state.errors.slice(-3), message] },
    ),
  select: (noradId) =>
    set((state) => {
      const selectedId = noradId === null ? null : normalizeNoradId(noradId);
      // Dasselbe Objekt noch einmal gewählt (Liste, Tap): nichts zurücksetzen.
      // useSatelliteEngine fordert die Überflugliste nur an, wenn sich
      // `selectedMeta` ändert – eine hier geleerte Liste käme nie wieder.
      if (selectedId === state.selectedId) return state;
      return {
        selectedId,
        ...resolveSelection(selectedId),
        passes: [],
        passId: null,
        passPending: selectedId !== null,
      };
    }),
  // Stale-Guard: Eine Antwort des Pools gilt nur, wenn ihr Objekt noch gewählt
  // ist. Wechselt die Auswahl, während der Shard rechnet, landet sonst die
  // Liste des vorigen Objekts unter dem neuen Namen.
  setPasses: (noradId, passes) =>
    set((state) =>
      state.selectedId === noradId
        ? { passes, passId: noradId, passPending: false }
        : state,
    ),
  setPassPending: (passPending) => set({ passPending }),
  setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
  setMode: (mode) => set((state) => ({ filters: { ...state.filters, mode } })),
  toggleGroup: (group) =>
    set((state) => ({
      activeGroups: state.activeGroups.includes(group)
        ? state.activeGroups.filter((g) => g !== group)
        : [...state.activeGroups, group],
    })),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  setAr: (arEnabled) => set({ arEnabled }),
  setArSupported: (arSupported) => set({ arSupported }),
  setCompassStatus: (compassStatus) => set({ compassStatus }),
  toggleNightMode: () => set((state) => ({ nightMode: !state.nightMode })),
  toggleTrails: () => set((state) => ({ showTrails: !state.showTrails })),
  setTheme: (theme) => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* Ohne Persistenz gilt die Wahl nur für diese Sitzung. */
    }
    set({ theme });
  },
  setSun: (sun) => set({ sun }),
  setMoon: (moon) => set({ moon }),
}));
