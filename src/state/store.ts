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
  TimeBase,
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
  /**
   * Virtuelle Zeit, ab der `passes` gesucht wurde, oder `null` ohne Liste.
   * useSatelliteEngine fordert neu an, sobald die virtuelle Zeit davor liegt
   * (Rückwärtslauf) oder mehr als 24 h dahinter (Zeitraffer).
   */
  passFromMs: number | null;
  passPending: boolean;

  /**
   * Zeitbasis der ganzen Szene. Einziger Schreiber ist `engine`
   * (useSatelliteEngine.ts), der sie zugleich an alle Shards schickt.
   *
   * Sie wechselt nur bei `setTimeScale`, `jumpTo` und `resetToRealTime` –
   * nie im Takt der Uhr. Komponenten, die `timeBase`, `selectTimeScale`,
   * `selectTimeEpoch` oder `selectRealtime` abonnieren, rendern also nur bei
   * diesen Aufrufen neu. Die laufende virtuelle Zeit liefert `virtualNow()`,
   * gedacht für rAF-Schleifen, Intervalle und `useFrame`.
   */
  timeBase: TimeBase;

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
  /** `epoch` und `fromMs` stammen aus der Antwort des Shards – Grundlage des Zeit-Stale-Guards. */
  setPasses: (noradId: NoradId, passes: PassPrediction[], epoch: number, fromMs: number) => void;
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
  /** Nur für `engine` – er schickt dieselbe Basis an die Shards. */
  setTimeBase: (timeBase: TimeBase) => void;
}

/** Virtuelle Zeit zur Wanduhrzeit `realMs` unter der Basis `base`. */
export function virtualTimeAt(base: TimeBase, realMs: number): number {
  return base.originVirtualMs + (realMs - base.originRealMs) * base.scale;
}

/** Echtzeit heißt: gleiche Geschwindigkeit UND kein Versatz zur Wanduhr. */
export function isRealtime(base: TimeBase): boolean {
  return base.scale === 1 && base.originVirtualMs === base.originRealMs;
}

/**
 * Laufende virtuelle Zeit. Liest die Basis aus dem Store, abonniert nichts
 * und löst deshalb kein Rendern aus – für rAF, Intervalle und `useFrame`.
 */
export function virtualNow(realMs: number = Date.now()): number {
  return virtualTimeAt(useAppStore.getState().timeBase, realMs);
}

/** Selektoren: Rendern nur, wenn sich der jeweilige Wert ändert. */
export const selectTimeScale = (state: AppState): number => state.timeBase.scale;
export const selectTimeEpoch = (state: AppState): number => state.timeBase.epoch;
export const selectRealtime = (state: AppState): boolean => isRealtime(state.timeBase);

/** Ein einziger Aufruf der Uhr – zwei könnten um eine Millisekunde auseinanderliegen und `isRealtime` verfehlen. */
function wallClockBase(): TimeBase {
  const now = Date.now();
  return { originRealMs: now, originVirtualMs: now, scale: 1, epoch: 0 };
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
  passFromMs: null,
  passPending: false,
  timeBase: wallClockBase(),

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
        passFromMs: null,
        passPending: selectedId !== null,
      };
    }),
  // Stale-Guards: Eine Antwort des Pools gilt nur, wenn ihr Objekt noch gewählt
  // ist UND sie mit der aktuellen Zeitepoche gerechnet wurde. Wechselt die
  // Auswahl, während der Shard rechnet, landete sonst die Liste des vorigen
  // Objekts unter dem neuen Namen; springt die Zeit, die Liste der alten Zeit
  // unter der neuen. Beide Prüfungen sind unabhängig: Die ID sagt nichts über
  // die Zeit, die Epoche nichts über das Objekt.
  setPasses: (noradId, passes, epoch, fromMs) =>
    set((state) =>
      state.selectedId === noradId && state.timeBase.epoch === epoch
        ? { passes, passId: noradId, passFromMs: fromMs, passPending: false }
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
  // Ein Sprung macht die Überflugliste im selben Schritt ungültig: Sie wurde
  // ab einer virtuellen Zeit gesucht, die nicht mehr gilt. Nach einem Sprung
  // zurück stünden sonst bis zur neuen Antwort Überflüge als „nächste“ da,
  // die für die neue Zeit Stunden oder Tage in der Zukunft liegen, und die
  // dazwischen fehlten. Neu angefordert wird im Hook, der dafür an der
  // Epoche hängt (useSatelliteEngine.ts). Eine reine Geschwindigkeits-
  // änderung lässt die Liste stehen – sie nennt absolute Zeiten und bleibt
  // gültig.
  setTimeBase: (timeBase) =>
    set((state) =>
      timeBase.epoch === state.timeBase.epoch
        ? { timeBase }
        : {
            timeBase,
            passes: [],
            passId: null,
            passFromMs: null,
            passPending: state.selectedId !== null,
          },
    ),
}));
