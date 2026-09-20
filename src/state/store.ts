import { create } from 'zustand';
import type {
  CatalogFilters,
  GeoCoord,
  PassPrediction,
  SatelliteGroup,
  SatelliteMeta,
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
  pass: PassPrediction | null;
  passPending: boolean;

  filters: CatalogFilters;
  drawerOpen: boolean;
  arEnabled: boolean;
  arSupported: boolean;
  nightMode: boolean;
  showTrails: boolean;
  sun: SunState;

  setObserver: (observer: GeoCoord) => void;
  setGeoError: (message: string | null) => void;
  setCatalog: (catalog: SatelliteMeta[]) => void;
  setStatus: (status: string, loading: boolean) => void;
  pushError: (message: string) => void;
  select: (index: number | null) => void;
  setPass: (pass: PassPrediction | null) => void;
  setPassPending: (pending: boolean) => void;
  setFilters: (patch: Partial<CatalogFilters>) => void;
  toggleGroup: (group: SatelliteGroup) => void;
  setDrawerOpen: (open: boolean) => void;
  setAr: (enabled: boolean) => void;
  setArSupported: (supported: boolean) => void;
  toggleNightMode: () => void;
  toggleTrails: () => void;
  setSun: (sun: SunState) => void;
}

const DEFAULT_FILTERS: CatalogFilters = {
  visibleOnly: true,
  stations: true,
  brightest: true,
  starlink: true,
  weather: true,
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
  pass: null,
  passPending: false,

  filters: DEFAULT_FILTERS,
  drawerOpen: false,
  arEnabled: false,
  arSupported: false,
  nightMode: false,
  showTrails: true,
  sun: { altitudeDeg: -18, azimuthDeg: 0, phase: 'night', daylight: 0 },

  setObserver: (observer) => set({ observer, geoError: null }),
  setGeoError: (geoError) => set({ geoError }),
  setCatalog: (catalog) =>
    set({ catalog, catalogByIndex: new Map(catalog.map((s) => [s.index, s])) }),
  setStatus: (status, loading) => set({ status, loading }),
  pushError: (message) =>
    set((state) => ({ errors: [...state.errors.slice(-3), message] })),
  select: (selectedIndex) => set({ selectedIndex, pass: null, passPending: selectedIndex !== null }),
  setPass: (pass) => set({ pass, passPending: false }),
  setPassPending: (passPending) => set({ passPending }),
  setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
  toggleGroup: (group) =>
    set((state) => ({
      activeGroups: state.activeGroups.includes(group)
        ? state.activeGroups.filter((g) => g !== group)
        : [...state.activeGroups, group],
    })),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  setAr: (arEnabled) => set({ arEnabled }),
  setArSupported: (arSupported) => set({ arSupported }),
  toggleNightMode: () => set((state) => ({ nightMode: !state.nightMode })),
  toggleTrails: () => set((state) => ({ showTrails: !state.showTrails })),
  setSun: (sun) => set({ sun }),
}));
