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

export type SatelliteGroup = 'stations' | 'brightest' | 'starlink' | 'weather';

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
  /** true, wenn der Satellit während des Höchststands sonnenbeschienen und der Himmel dunkel ist. */
  visible: boolean;
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
 * - `all`      – jedes Katalogobjekt über dem Horizont
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

/* ------------------------------------------------------------------ */
/* Worker-Protokoll                                                     */
/* ------------------------------------------------------------------ */

export type WorkerRequest =
  | { type: 'load'; groups: SatelliteGroup[] }
  | { type: 'observer'; observer: GeoCoord }
  | { type: 'start'; intervalMs: number }
  | { type: 'stop' }
  | { type: 'timeScale'; value: number }
  | { type: 'trail'; index: number; fromMin: number; toMin: number; samples: number }
  | { type: 'pass'; index: number; searchHours: number };

export type WorkerResponse =
  | { type: 'catalog'; catalog: SatelliteMeta[] }
  | { type: 'tick'; time: number; count: number; buffer: ArrayBuffer }
  | { type: 'trail'; index: number; points: Float32Array }
  | { type: 'pass'; index: number; pass: PassPrediction | null }
  | { type: 'status'; message: string; loading: boolean }
  | { type: 'error'; message: string };
