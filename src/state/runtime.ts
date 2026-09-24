import { Quaternion, Vector3 } from 'three';
import type { NoradId, SatelliteMeta } from '../types';
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
  timeMs: number;
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
   * Bahnspur-Nachführung alle 12 s), aber nie je Bild. Es stehen nur Objekte mit
   * gültigem Bahnsatz darin, denn nur für sie meldet der Worker Metadaten.
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
 */
export const trailState: { noradId: NoradId | null; points: Float32Array | null; version: number } = {
  noradId: null,
  points: null,
  version: 0,
};

export function requestFocus(azimuth: number, elevation: number): void {
  viewState.focus = { azimuth, elevation, startedAt: performance.now() };
}

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
  };
}
