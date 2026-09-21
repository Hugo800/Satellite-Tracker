/** Zentrale Typdefinitionen für Geodäsie, Ephemeriden und Satelliten-Telemetrie. */

/** Geodätische Position des Beobachters (WGS84). */
export interface GeoCoord {
  /** Breitengrad in Grad, positiv = Nord. */
  latitudeDeg: number;
  /** Längengrad in Grad, positiv = Ost. */
  longitudeDeg: number;
  /** Höhe über dem Ellipsoid in Kilometern. */
  altitudeKm: number;
}

/** Beobachterposition im Format, das satellite.js erwartet (Radiant / km). */
export interface ObserverGd {
  latitude: number;
  longitude: number;
  height: number;
}

/** Kartesischer Vektor (ECI/ECEF/ENU – je nach Kontext). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Topozentrische Blickrichtung vom Beobachter zum Objekt. */
export interface LookAngles {
  /** Azimut in Radiant, 0 = Nord, im Uhrzeigersinn über Ost. */
  azimuth: number;
  /** Elevation in Radiant über dem mathematischen Horizont. */
  elevation: number;
  /** Schrägentfernung in Kilometern. */
  rangeKm: number;
}

/** Vollständiger Ephemeriden-Satz eines Satelliten zu einem Zeitpunkt. */
export interface Ephemeris extends LookAngles {
  positionEci: Vec3;
  velocityEci: Vec3;
  /** Subsatellitenpunkt. */
  latitudeDeg: number;
  longitudeDeg: number;
  /** Bahnhöhe über dem Ellipsoid in km. */
  altitudeKm: number;
  /** Bahngeschwindigkeit in km/s. */
  speedKmS: number;
  /** true, wenn der Satellit im Erdschatten steht (nicht von der Sonne angestrahlt). */
  eclipsed: boolean;
  /** Scheinbare visuelle Helligkeit; große Werte = unsichtbar. */
  magnitude: number;
}

/**
 * Katalogklassen. `other` ist die Sammelklasse des Gesamtkatalogs
 * (CelesTrak `GROUP=active`) – alles, was nicht schon durch eine der
 * spezifischeren Gruppen abgedeckt ist.
 */
export type SatelliteGroup = 'stations' | 'brightest' | 'weather' | 'starlink' | 'other';

/** Statische Katalogdaten eines Satelliten (React-State-tauglich, ändert sich selten). */
export interface SatelliteMeta {
  /** Stabiler Index in den Telemetrie-Buffern. */
  index: number;
  name: string;
  noradId: string;
  group: SatelliteGroup;
  /** Prominentes Objekt (ISS, Hubble, Tiangong …) – bekommt ein eigenes Mesh + Label. */
  highlight: boolean;
  /** Umlaufzeit in Minuten (aus der mittleren Bewegung des TLE). */
  periodMin: number;
  /** Bahnneigung in Grad. */
  inclinationDeg: number;
  /** Helligkeit bei 1000 km und vollem Phasenwinkel. */
  standardMagnitude: number;
}

/** Vorhersage eines Überflugs. */
export interface PassPrediction {
  /** Acquisition of Signal – Aufgang über 0° Elevation (ms seit Epoch). */
  aos: number;
  /** Time of Closest Approach – Höchststand (ms seit Epoch). */
  tca: number;
  /** Loss of Signal – Untergang (ms seit Epoch). */
  los: number;
  /** Maximale Elevation in Grad. */
  maxElevationDeg: number;
  aosAzimuthDeg: number;
  losAzimuthDeg: number;
  /** Dauer in Sekunden. */
  durationSec: number;
  /** Beginn/Ende des sonnenbeschienenen Abschnitts; `null`, wenn der Überflug ganz im Erdschatten liegt. */
  sunlitStart: number | null;
  sunlitEnd: number | null;
  /** Dauer des sonnenbeschienenen Abschnitts in Sekunden. */
  sunlitSec: number;
  /** Beste (kleinste) scheinbare Helligkeit während des Überflugs. */
  peakMagnitude: number;
  /** Beleuchteter Flächenanteil im Helligkeitsmaximum: 0 = Nachtseite, 1 = voll angestrahlt. */
  illumination: number;
  /** true, wenn der Überflug realistisch mit bloßem Auge zu sehen ist. */
  nakedEye: boolean;
}

/** Topozentrische Position der Sonne am Beobachterstandort. */
export interface SunState {
  altitudeDeg: number;
  azimuthDeg: number;
}

/** Topozentrische Position des Mondes samt Beleuchtungsgrad. */
export interface MoonState {
  altitudeDeg: number;
  azimuthDeg: number;
  /** Beleuchteter Anteil der Mondscheibe: 0 = Neumond, 1 = Vollmond. */
  illumination: number;
}

/**
 * Güte der Kompassquelle:
 * `ok` = erdfest und kalibriert, `calibrating` = iOS meldet schlechte Genauigkeit,
 * `relative` = nur relative Lagedaten ohne Nordbezug.
 */
export type CompassStatus = 'unknown' | 'ok' | 'calibrating' | 'relative';

/**
 * Darstellungsmodus des Himmels:
 * - `all`      – **jedes** Katalogobjekt über dem Horizont, ohne jede Obergrenze
 * - `nakedEye` – nur, was realistisch mit bloßem Auge zu sehen ist
 * - `starlink` – ausschließlich Starlink
 */
export type SkyFilterMode = 'all' | 'nakedEye' | 'starlink';

/** Aktive Filter der Satellitenliste. */
export interface CatalogFilters {
  mode: SkyFilterMode;
  /** In der Liste auch Objekte unter dem Horizont zeigen. */
  includeBelowHorizon: boolean;
  query: string;
}

/** Farbschema der Oberfläche. `system` folgt `prefers-color-scheme`. */
export type ThemePreference = 'system' | 'light' | 'dark';

/* ------------------------------------------------------------------ */
/* Worker-Protokoll                                                     */
/* ------------------------------------------------------------------ */

/**
 * Virtuelle Zeit als reine Funktion der Wanduhr:
 * `virtual(now) = originVirtualMs + (now - originRealMs) * scale`.
 *
 * Damit berechnen alle Worker des Pools garantiert dieselbe Epoche – ohne
 * inkrementelle Akkumulation, die zwischen den Threads auseinanderliefe.
 */
export interface TimeBase {
  originRealMs: number;
  originVirtualMs: number;
  scale: number;
}

export type WorkerRequest =
  | { type: 'init'; shardIndex: number; shardCount: number }
  | { type: 'load'; groups: SatelliteGroup[] }
  | { type: 'observer'; observer: GeoCoord }
  | { type: 'start'; intervalMs: number }
  | { type: 'stop' }
  | { type: 'time'; base: TimeBase }
  | { type: 'recycle'; buffer: ArrayBuffer }
  /** Ausgewähltes Objekt – nur dafür werden Subpunkt und Bahnhöhe gerechnet. */
  | { type: 'select'; index: number | null }
  /** Rohtext einer Gruppe, vom Lader-Shard über den Main-Thread verteilt. */
  | { type: 'tle'; group: SatelliteGroup; text: string }
  | { type: 'trail'; index: number; fromMin: number; toMin: number; samples: number }
  | { type: 'pass'; index: number; searchHours: number };

export type WorkerResponse =
  /** Metadaten des eigenen Shards; `total` ist die Größe des Gesamtkatalogs. */
  | { type: 'catalog'; shardIndex: number; offset: number; total: number; catalog: SatelliteMeta[] }
  /** Telemetrie des eigenen Shards. `offset` ist der globale Startindex. */
  | {
      type: 'tick';
      shardIndex: number;
      offset: number;
      count: number;
      time: number;
      /** Gemessene Rechenzeit des Ticks in ms – speist die adaptive Taktung. */
      durationMs: number;
      buffer: ArrayBuffer;
    }
  | { type: 'trail'; index: number; points: Float32Array }
  | { type: 'pass'; index: number; passes: PassPrediction[] }
  /** Rohtext, den der Lader-Shard an seine Geschwister weiterreichen lässt. */
  | { type: 'tle'; group: SatelliteGroup; text: string }
  | { type: 'status'; message: string; loading: boolean }
  | { type: 'error'; message: string };
