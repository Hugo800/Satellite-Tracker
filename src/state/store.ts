import { create } from 'zustand';
import type {
  CatalogFilters,
  CompassStatus,
  GeoCoord,
  MoonState,
  PassPrediction,
  SatelliteGroup,
  SatelliteMeta,
  SkyFilterMode,
  SunState,
} from '../types';

export interface AppState {
  observer: GeoCoord | null;
  geoError: string | null;
  catalog: SatelliteMeta[];
  catalogByIndex: Map<number, SatelliteMeta>;
  activeGroups: SatelliteGroup[];
  status: string;
  loading: boolean;
  errors: string[];

  selectedIndex: number | null;
  passes: PassPrediction[];
  /** Satellit, zu dem `passes` gehört – verhindert, dass eine verzögerte Antwort die neue Auswahl überschreibt. */
  passIndex: number | null;
  passPending: boolean;

  filters: CatalogFilters;
  drawerOpen: boolean;
  arEnabled: boolean;
  arSupported: boolean;
  compassStatus: CompassStatus;
  nightMode: boolean;
  showTrails: boolean;
  sun: SunState;
  moon: MoonState;

  setObserver: (observer: GeoCoord) => void;
  setGeoError: (message: string | null) => void;
  setCatalog: (catalog: SatelliteMeta[]) => void;
  setStatus: (status: string, loading: boolean) => void;
  pushError: (message: string) => void;
  select: (index: number | null) => void;
  setPasses: (index: number, passes: PassPrediction[]) => void;
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
  setSun: (sun: SunState) => void;
  setMoon: (moon: MoonState) => void;
}

const DEFAULT_FILTERS: CatalogFilters = {
  mode: 'all',
  includeBelowHorizon: false,
  query: '',
};

export const useAppStore = create<AppState>((set) => ({
  observer: null,
  geoError: null,
  catalog: [],
  catalogByIndex: new Map(),
  activeGroups: ['stations', 'brightest', 'weather', 'starlink'],
  status: 'Initialisiere …',
  loading: true,
  errors: [],

  selectedIndex: null,
  passes: [],
  passIndex: null,
  passPending: false,

  filters: DEFAULT_FILTERS,
  drawerOpen: false,
  arEnabled: false,
  arSupported: false,
  compassStatus: 'unknown',
  nightMode: false,
  showTrails: true,
  sun: { altitudeDeg: -18, azimuthDeg: 0 },
  moon: { altitudeDeg: -18, azimuthDeg: 0, illumination: 0.5 },

  setObserver: (observer) => set({ observer, geoError: null }),
  setGeoError: (geoError) => set({ geoError }),
  setCatalog: (catalog) =>
    set({ catalog, catalogByIndex: new Map(catalog.map((s) => [s.index, s])) }),
  setStatus: (status, loading) => set({ status, loading }),
  pushError: (message) =>
    set((state) => ({ errors: [...state.errors.slice(-3), message] })),
  select: (selectedIndex) =>
    set({ selectedIndex, passes: [], passIndex: null, passPending: selectedIndex !== null }),
  setPasses: (index, passes) =>
    set((state) =>
      state.selectedIndex === index
        ? { passes, passIndex: index, passPending: false }
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
  setSun: (sun) => set({ sun }),
  setMoon: (moon) => set({ moon }),
}));
