import { Quaternion, Vector3 } from 'three';
import { FORECAST_DEFAULT_WINDOW_MIN, FORECAST_MAX_SLOTS } from '../data/forecast';
import type { ForecastEntry, NoradId, SatelliteMeta, WorkerResponse } from '../types';
import {
  TELEMETRY_STRIDE,
  T_ALT,
  T_AZ,
  T_ECLIPSED,
  T_EL,
  T_LAT,
  T_LON,
  T_MAG,
  T_RANGE,
  T_SPEED,
} from '../math/telemetryLayout';

/**
 * Bewusst *außerhalb* von React gehaltener Laufzeit-Zustand.
 *
 * Positionen, Winkel und Quaternionen ändern sich pro Frame. Lägen sie im
 * React-State, würde jeder Tick einen Re-Render des gesamten Baums auslösen.
 * Stattdessen mutieren wir diese Objekte direkt und lesen sie in `useFrame`
 * bzw. in rAF-Schleifen der 2D-Overlays.
 */

export interface TelemetryStore {
  /** Anzahl belegter Telemetrie-Plätze (= Katalogumfang). */
  count: number;
  /** Kapazität des Buffers in Objekten; wächst in Blöcken mit dem Katalog. */
  capacity: number;
  data: Float32Array;
  /**
   * Virtuelle Zeit des jüngsten Ticks im zuletzt freigegebenen Stand. Folgt
   * der Zeitbasis in beide Richtungen – nach einem Sprung zurück ebenso wie im
   * Rückwärtslauf (scripts/verify-timetravel.ts, Abschnitte B und E).
   */
  timeMs: number;
  /**
   * `TimeBase.epoch` der Daten in `data`. Wechselt, sobald jeder Shard einen
   * Tick der neuen Epoche geliefert hat – oder früher, wenn der Wachhund den
   * Übergang erzwingt, weil ein Shard ausbleibt: Dann sind dessen Plätze
   * ausgeblendet (`range` NaN, Höhe −90°), bis er wieder liefert
   * (useSatelliteEngine.ts, `commitEpoch`). Bis zum Wechsel bleibt der alte
   * Stand in `data` unverändert stehen. Spuren und Interpolation erkennen
   * daran einen Sprung.
   */
  epoch: number;
  /**
   * Monoton steigend – Overlays erkennen daran neue Daten. Der Zähler springt
   * erst weiter, wenn *alle* Shards des Worker-Pools geliefert haben, sodass
   * ein Tick immer einen vollständigen Himmel beschreibt.
   */
  revision: number;
  /** Gemessener Abstand zweier vollständiger Ticks – Basis der Interpolation. */
  intervalMs: number;
  /** Summierte Rechenzeit aller Shards im letzten Tick (Diagnose). */
  computeMs: number;
}

export const telemetry: TelemetryStore = {
  count: 0,
  capacity: 0,
  data: new Float32Array(0),
  timeMs: Date.now(),
  epoch: 0,
  revision: 0,
  intervalMs: 100,
  computeMs: 0,
};

/** Blockgröße, in der der Telemetrie-Buffer wächst – hält Reallokationen selten. */
const CAPACITY_CHUNK = 2048;

/**
 * Stellt sicher, dass mindestens `count` Objekte Platz haben. Vorhandene Werte
 * bleiben erhalten, damit ein wachsender Katalog keinen Frame mit leerem
 * Himmel erzeugt.
 */
export function ensureTelemetryCapacity(count: number): void {
  if (count <= telemetry.capacity) return;
  const capacity = Math.ceil(count / CAPACITY_CHUNK) * CAPACITY_CHUNK;
  const next = new Float32Array(capacity * TELEMETRY_STRIDE);
  next.set(telemetry.data);
  // Neue Plätze gelten bis zum ersten Tick als „unter dem Horizont“.
  for (let i = telemetry.capacity; i < capacity; i += 1) {
    next[i * TELEMETRY_STRIDE + T_EL] = -Math.PI / 2;
    next[i * TELEMETRY_STRIDE + T_RANGE] = Number.NaN;
  }
  telemetry.data = next;
  telemetry.capacity = capacity;
}

export interface SatelliteSample {
  azimuth: number;
  elevation: number;
  rangeKm: number;
  altitudeKm: number;
  speedKmS: number;
  eclipsed: boolean;
  latitudeDeg: number;
  longitudeDeg: number;
  magnitude: number;
}

/** Liest einen Telemetrie-Datensatz. Gibt `null` zurück, wenn der Index leer ist. */
export function readSample(index: number, out?: SatelliteSample): SatelliteSample | null {
  if (index < 0 || index >= telemetry.count) return null;
  const d = telemetry.data;
  const base = index * TELEMETRY_STRIDE;
  const range = d[base + T_RANGE];
  if (!Number.isFinite(range)) return null;

  const target = out ?? ({} as SatelliteSample);
  target.azimuth = d[base + T_AZ];
  target.elevation = d[base + T_EL];
  target.rangeKm = range;
  target.altitudeKm = d[base + T_ALT];
  target.speedKmS = d[base + T_SPEED];
  target.eclipsed = d[base + T_ECLIPSED] > 0.5;
  target.latitudeDeg = d[base + T_LAT];
  target.longitudeDeg = d[base + T_LON];
  target.magnitude = d[base + T_MAG];
  return target;
}

/**
 * Gruppenzuordnung als typisiertes Array, einmal je Katalogfassung berechnet.
 *
 * Radar, 3D-Feld, Spuren und Picking brauchen dieselbe Information pro Frame.
 * Sie hier zu halten spart drei identische `useMemo`-Kopien und vor allem die
 * String-Vergleiche (`sat.group === 'starlink'`) in den Schleifen.
 */
export const catalogIndex: {
  groupIds: Uint8Array;
  /** 1 = Starlink; vorberechnet, weil der Starlink-Filter pro Objekt greift. */
  starlink: Uint8Array;
  /** 1 = prominentes Objekt. */
  highlight: Uint8Array;
  /**
   * Metadaten, dünn besetzt nach globalem Index.
   *
   * Ersetzt eine `Map`, die bei jedem Katalog-Update über alle Einträge neu
   * aufgebaut wurde – für eine einzige Abfrage, nämlich die des ausgewählten
   * Objekts in der Telemetriekarte.
   */
  meta: Array<SatelliteMeta | undefined>;
  /**
   * Platz je NORAD-ID – die Umkehrung von `meta`.
   *
   * Entsteht im selben Durchlauf wie die Flags oben (`rebuildCatalogIndex` in
   * useSatelliteEngine.ts), also genau dann, wenn auch der Store die neue
   * Katalogfassung bekommt. Wer die Auswahl in einen Platz übersetzt – Karte,
   * Ring, Radar, Routing an den Shard –, schlägt hier nach: je Auswahl oder
   * Katalogwechsel, beim Routing zusätzlich je Anfrage (auch bei der
   * Bahnspur-Nachführung, alle 12 s virtuelle Zeit, im Zeitraffer höchstens
   * viermal je Sekunde), aber nie je Bild. Es stehen nur Objekte mit gültigem
   * Bahnsatz darin, denn nur für sie meldet der Worker Metadaten.
   *
   * Anders als die frühere Index-Map (siehe `meta`) trägt sie mehr als eine
   * Abfrage: Auflösung der Auswahl, Routing, künftig die Merkliste. Die Map in
   * derselben Schleife mitzubauen kostete im Nachbau mit 12 500 Objekten rund
   * 0,4 ms je Katalogfassung (Node 22, Desktop, 24.09.2026); Fassungen
   * entstehen nur beim Laden, gebündelt im Abstand von 220 ms.
   */
  slotById: Map<NoradId, number>;
  version: number;
} = {
  groupIds: new Uint8Array(0),
  starlink: new Uint8Array(0),
  highlight: new Uint8Array(0),
  meta: [],
  slotById: new Map(),
  version: 0,
};

/**
 * Löst eine gewählte ID gegen den aktuellen Katalog auf.
 *
 * `selectedIndex` ist `null` ohne Auswahl, -1, solange die ID nicht im Katalog
 * steht, sonst der Platz. `selectedMeta` sind die Metadaten an diesem Platz –
 * nur, wenn sie wirklich diese ID tragen; sonst gilt die Auswahl als nicht
 * aufgelöst, statt ein anderes Objekt zu zeigen. Ersetzt der Worker einen
 * Eintrag an Ort und Stelle (Offline-Fallback → echte Bahndaten), ist
 * `selectedMeta` ein neues Objekt bei gleichem Platz.
 */
export function resolveSelection(noradId: NoradId | null): {
  selectedIndex: number | null;
  selectedMeta: SatelliteMeta | null;
} {
  if (noradId === null) return { selectedIndex: null, selectedMeta: null };
  const slot = catalogIndex.slotById.get(noradId);
  const meta = slot === undefined ? undefined : catalogIndex.meta[slot];
  if (slot === undefined || meta?.noradId !== noradId) return { selectedIndex: -1, selectedMeta: null };
  return { selectedIndex: slot, selectedMeta: meta };
}

export interface ViewState {
  /** Aktuelle Kamera-Orientierung (wird vom CameraRig jeden Frame gespiegelt). */
  quaternion: Quaternion;
  forward: Vector3;
  azimuthDeg: number;
  elevationDeg: number;
  fovDeg: number;
  aspect: number;
  /** Ziel für die weiche Kamera-Anfahrt; wird vom Rig konsumiert. */
  focus: { azimuth: number; elevation: number; startedAt: number } | null;
}

export const viewState: ViewState = {
  quaternion: new Quaternion(),
  forward: new Vector3(0, 0, -1),
  azimuthDeg: 0,
  elevationDeg: 0,
  fovDeg: 70,
  aspect: 1,
  focus: null,
};

export interface OrientationState {
  quaternion: Quaternion;
  available: boolean;
  headingDeg: number;
  /** Bildschirmrotation in Radiant. */
  screenAngle: number;
  /** Kompassgenauigkeit in Grad, sofern die Plattform sie meldet (iOS). */
  accuracyDeg: number | null;
}

export const orientationState: OrientationState = {
  quaternion: new Quaternion(),
  available: false,
  headingDeg: 0,
  screenAngle: 0,
  accuracyDeg: null,
};

/**
 * Bahnspur des aktuell selektierten Objekts (Einheitsvektoren, xyz-interleaved).
 *
 * `noradId` nennt das Objekt, zu dem `points` gehört. OrbitTrail zeichnet nur,
 * wenn es die aktuelle Auswahl ist – das ist die Korrelation, die eine
 * verspätete Antwort für ein vorher gewähltes Objekt vom Bild fernhält.
 *
 * `timeMs` ist die virtuelle Zeit, auf die sich das Zeitfenster der Anfrage
 * bezog (−25 … +70 min in OrbitTrail). Bei einem Zeitsprung leert der Pool
 * die Spur sofort, und eine Antwort, die noch mit der alten Zeitbasis
 * gerechnet wurde, landet nicht mehr hier (useSatelliteEngine.ts).
 */
export const trailState: {
  noradId: NoradId | null;
  points: Float32Array | null;
  timeMs: number | null;
  version: number;
} = {
  noradId: null,
  points: null,
  timeMs: null,
  version: 0,
};

export function requestFocus(azimuth: number, elevation: number): void {
  viewState.focus = { azimuth, elevation, startedAt: performance.now() };
}

/* ------------------------------------------------------------------ */
/* Vorhersage „Demnächst sichtbar“                                      */
/* ------------------------------------------------------------------ */

/*
 * Vorhersagestand und abgeleitete Anzeige liegen wie `trailState` außerhalb
 * von React: Der Controller (useVisibilityForecast) prüft alle 250 ms
 * Wanduhr gegen die virtuelle Zeit, Countdowns ändern sich in jedem Takt, die
 * Spurköpfe in jedem Bild. Im Store löste das je Takt ein Rendern aller
 * Abonnenten aus. React rendert nur, wenn sich die Menge der Einträge ändert
 * (`forecastView.membershipVersion` → `forecastRevision` im Store);
 * VisibilityForecast, RadarMap, TapPicker und die Refs der Liste lesen direkt hier.
 */

/** Teilantwort eines Shards. */
export type ForecastPart = Extract<WorkerResponse, { type: 'forecast' }>;

/** Freigegebener Stand des Kurz-Scans (`near`), zusammengeführt aus allen Shards. */
export interface ForecastCommitted {
  requestId: number;
  fromMs: number;
  toMs: number;
  /** Minimum über die Shards: bis hierhin fehlt kein Fenster (mehr als `keep` Treffer kürzen die Liste). */
  completeUntilMs: number;
  /** Sortiert nach (startMs, noradId). */
  entries: ForecastEntry[];
  /** alle Shards haben geliefert */
  complete: boolean;
}

/** Laufende Anfrage einer Art; die Teile sammeln sich je Shard, bis alle geliefert haben. */
export interface ForecastPending {
  requestId: number;
  fromMs: number;
  toMs: number;
  parts: Map<number, ForecastPart>;
  /** performance.now() beim Senden – Grundlage des Wachhunds. */
  sentAt: number;
}

/** Stand des Lang-Scans: frühester Sichtbeginn über alle Shards in [fromMs, toMs], oder null, wenn dort keiner liegt. */
export interface ForecastFarCommitted {
  requestId: number;
  fromMs: number;
  toMs: number;
  entry: ForecastEntry | null;
  /** alle Shards haben geliefert */
  complete: boolean;
}

/**
 * Anfragen und Stände beider Scan-Arten.
 *
 * Der Lang-Scan („Ausblick“, `kind 'far'`) hat einen eigenen Zustand – eigene
 * `pending`-/`committed`-Plätze, eigener Mindestabstand, eigenes Dirty-Flag –,
 * damit er die Kurz-Vorhersage nie blockiert oder verdrängt: Eine laufende
 * Lang-Anfrage hält keine Kurz-Anfrage auf und umgekehrt. Geschrieben wird
 * nur vom Pool (`engine.requestForecast`, Antworten in `handle`) und vom
 * Controller-Hook.
 */
export const forecastState: {
  /** Ein Zähler für beide Arten; die Zuordnung läuft über `kind`, nicht über Nummernkreise. */
  nextRequestId: number;
  pending: ForecastPending | null;
  committed: ForecastCommitted | null;
  /** performance.now(), −Infinity anfangs. */
  lastRequestAt: number;
  /** Vom Controller nach `catalogVersion` (entprellt) gesetzt → erzwingt Neuscan. */
  catalogDirty: boolean;
  // Lang-Scan („Ausblick“, kind 'far') – eigener Zustand, damit er die Kurz-Vorhersage nie blockiert oder verdrängt
  farPending: ForecastPending | null;
  farCommitted: ForecastFarCommitted | null;
  /** performance.now(), −Infinity anfangs. */
  lastFarRequestAt: number;
  /** Wie `catalogDirty`, für den Lang-Scan. */
  farDirty: boolean;
} = {
  nextRequestId: 1,
  pending: null,
  committed: null,
  lastRequestAt: -Infinity,
  catalogDirty: false,
  farPending: null,
  farCommitted: null,
  lastFarRequestAt: -Infinity,
  farDirty: false,
};

/**
 * `off`: Filter nicht „Sichtbar“. `noObserver`: noch kein Standort.
 * `paused`: |Zeitraffer| > FORECAST_MAX_ABS_SCALE. `pending`: kein gültiger
 * Stand für die laufende Zeit. `ready`: Einträge gelten.
 */
export type ForecastStatus = 'off' | 'noObserver' | 'paused' | 'pending' | 'ready';
/** 'idle' = Lang-Scan ruht (Liste nicht leer, Vorhersage nicht 'ready' oder pausiert); sonst wie ForecastStatus. */
export type ForecastFarStatus = 'idle' | 'pending' | 'ready';

/**
 * Ein Eintrag der Anzeige – Texte fertig abgeleitet, Komponenten kopieren nur.
 * Steht für einen Verbund (§13: Objekte mit praktisch derselben Spur, etwa die
 * ISS mit ihren Modulen); ID, Name, Fenster und Spur sind die des Anführers,
 * Antippen wählt ihn.
 */
export interface ForecastSlot {
  /** Anführer des Verbunds */
  noradId: NoradId;
  name: string;
  highlight: boolean;
  /** Fenster und Spur des Anführers */
  entry: ForecastEntry;
  /** Die übrigen Objekte des Verbunds, ohne Anführer; leer für ein einzelnes Objekt. */
  memberIds: readonly NoradId[];
  /** '' | '+5' – Zahl der übrigen Objekte */
  groupText: string;
  /** startMs ≤ now < endMs */
  visibleNow: boolean;
  /** 'in 3:20' | 'noch 4:10' | 'sichtbar' */
  countdownText: string;
  /**
   * `${name} · ${countdownText}`, im Verbund `${name} +5 · ${countdownText}`;
   * Highlight-Objekte ab dem Aufgang (`traceStartMs`) ohne Namen – dann steht
   * ihr Namenslabel (HighlightMarkers) schon am Himmel: `${countdownText}` bzw.
   * `+5 · ${countdownText}`
   */
  labelText: string;
  /** `aus ${compassLabel(startAzimuthDeg)} · max ${Math.round(maxElevationDeg)}°` */
  detailText: string;
}

/** Kandidat der Ausblick-Zeile – nur in der Liste, nie am Himmel oder im Radar. */
export interface ForecastNext {
  noradId: NoradId;
  name: string;
  highlight: boolean;
  entry: ForecastEntry;
  /** `Nächster: ${name}` */
  text: string;
  /** `${formatForecastNext(startMs, now)} · aus ${compassLabel(startAzimuthDeg)}` */
  detailText: string;
}

/**
 * Abgeleitete Anzeige. Entsteht an genau einer Stelle,
 * `deriveForecastView(…, virtualNow(), …)` (src/state/forecastView.ts), im
 * Takt des Controllers. Alle Texte rechnen damit gegen die virtuelle Zeit;
 * keine Komponente formatiert selbst einen Countdown.
 */
export interface ForecastView {
  status: ForecastStatus;
  statusText: string;
  windowMs: number;
  /** Virtuelle Zeit der letzten Ableitung. */
  nowMs: number;
  scale: number;
  /** ≤ FORECAST_MAX_SLOTS Verbünde, sortiert */
  slots: ForecastSlot[];
  farStatus: ForecastFarStatus;
  /** '' | 'Suche bis 90 min …' | 'Auch bis 90 min keiner' | next.text */
  nextText: string;
  /** nur bei farStatus 'ready' mit Kandidat und leerer Liste */
  next: ForecastNext | null;
  /**
   * steigt bei Änderung von status, farStatus, der geordneten ID-Liste, einer
   * Verbundgröße (`groupText`) oder next?.noradId – und des Zustandstexts, den
   * die Liste per React rendert; nie bei bloßem Countdown-Wechsel
   */
  membershipVersion: number;
  /** steigt bei jeder Änderung (auch nur Texte) */
  version: number;
}

export const forecastView: ForecastView = {
  status: 'off',
  statusText: '',
  windowMs: FORECAST_DEFAULT_WINDOW_MIN * 60_000,
  nowMs: 0,
  scale: 1,
  slots: [],
  farStatus: 'idle',
  nextText: '',
  next: null,
  membershipVersion: 0,
  version: 0,
};

/**
 * Was VisibilityForecast im letzten Bild als Label gezeigt hat, je Platz
 * (Index wie `forecastView.slots`): Mitte des Sprites in Weltkoordinaten,
 * halbe Breite und Höhe des bemalten Texts in Szeneneinheiten, und ob es zu
 * sehen war (Kollisionsregel, Status). TapPicker prüft einen Tap gegen genau
 * diese Fläche – nicht gegen den Kopf der Spur: Das Label sitzt 12 Einheiten
 * darüber (Highlight-Objekte 16 darunter), und ein langes Label reicht 5–6°
 * zur Seite. Als Kreis um den Kopf mit 4° · FOV/70 war der Countdown-Teil
 * eines Labels nie antippbar, gezoomt nicht einmal die Mitte (nachgerechnet
 * 08.10.2026). Geschrieben nur von der Bildfunktion, ohne Allokation.
 */
export const forecastLabels: {
  noradIds: NoradId[];
  /** 1 = im letzten Bild gezeigt. */
  visible: Uint8Array;
  /** xyz je Platz. */
  centers: Float32Array;
  halfWidths: Float32Array;
  halfHeights: Float32Array;
} = {
  noradIds: [],
  visible: new Uint8Array(FORECAST_MAX_SLOTS),
  centers: new Float32Array(FORECAST_MAX_SLOTS * 3),
  halfWidths: new Float32Array(FORECAST_MAX_SLOTS),
  halfHeights: new Float32Array(FORECAST_MAX_SLOTS),
};

/**
 * Diagnosefenster für die Entwicklung.
 *
 * Telemetrie und Katalogindex liegen bewusst außerhalb von React und sind
 * damit aus der Konsole (und aus Browser-Tests) sonst nicht erreichbar. Im
 * Produktions-Build fällt der Block weg.
 */
if (import.meta.env?.DEV) {
  (globalThis as unknown as { __orbitalAtlas?: unknown }).__orbitalAtlas = {
    telemetry,
    catalogIndex,
    readSample,
    forecastState,
    forecastView,
    forecastLabels,
  };
}
