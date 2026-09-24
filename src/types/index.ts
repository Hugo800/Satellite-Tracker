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

/**
 * NORAD-Katalognummer in der einen Schreibweise, in der sie als Identität gilt:
 * Dezimalzahl ohne führende Nullen, Alpha-5 aufgelöst (`A0001` → `100001`).
 *
 * Die Marke lässt nur Kennungen durch, die `normalizeNoradId` erzeugt hat
 * (src/data/tleSources.ts). Ein roher TLE-Feldinhalt kann so nicht als
 * Worker-Anfrage verschickt werden – der Compiler meldet die Stelle, statt
 * dass das Objekt still unauffindbar bleibt. Für die Auswahl gilt das NICHT:
 * `select` im Store nimmt `string | null` und normalisiert selbst, dort
 * kompiliert auch ein roher Wert.
 */
export type NoradId = string & { readonly __brand: 'NoradId' };

/** Statische Katalogdaten eines Satelliten (React-State-tauglich, ändert sich selten). */
export interface SatelliteMeta {
  /**
   * Platz in den Telemetrie-Buffern und in `catalogIndex` – keine Identität.
   *
   * Innerhalb eines Worker-Pools bleibt er fest (`knownIds` im Worker), ein
   * neu aufgebauter Pool vergibt die Plätze aber nach Ladereihenfolge und
   * -erfolg neu: Fehlt beim einen Mal Starlink, rückt der Gesamtkatalog nach
   * vorn (scripts/verify-selection.ts, Abschnitt F). Auswahl, Bahnspur und
   * Überflüge hängen deshalb an `noradId`.
   */
  index: number;
  name: string;
  noradId: NoradId;
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
  /**
   * true, wenn der Überflug schon lief und die Rückwärtssuche keinen Aufgang
   * fand (dauerhaft über dem Horizont, etwa geostationär). `aos` ist dann nur
   * der früheste bestätigte Punkt über dem Horizont, kein Aufgang.
   */
  aosOpen: boolean;
  /** Gegenstück für den Untergang: jenseits des Suchfensters, `los` nur der letzte bestätigte Punkt. */
  losOpen: boolean;
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
 *
 * Geschrieben wird sie nur von `engine` (src/hooks/useSatelliteEngine.ts), der
 * sie im Store ablegt und an alle Shards schickt.
 */
export interface TimeBase {
  originRealMs: number;
  originVirtualMs: number;
  /** Zeitraffer: 1 = Echtzeit, 60 = eine Minute je Sekunde, negativ = rückwärts, 0 = Pause. */
  scale: number;
  /**
   * Zählt die Sprünge der virtuellen Zeit: `engine.jumpTo` und die Rückkehr
   * zur Echtzeit aus einem abweichenden Stand.
   *
   * Der Rundruf erreicht die Shards nicht im selben Moment; ein Shard kann
   * noch einen Tick mit der alten Basis rechnen, während ein anderer schon die
   * neue nutzt. Ticks, Bahnspuren und Überflüge tragen deshalb die Epoche, mit
   * der sie gerechnet wurden, und der Main-Thread verwirft alles aus einer
   * anderen (scripts/verify-timetravel.ts, Abschnitte B, G und H).
   *
   * Eine reine Geschwindigkeitsänderung (`setTimeScale`, auch mit Umkehr der
   * Richtung) lässt die Epoche stehen: Die neue Basis ist so gewählt, dass die
   * virtuelle Zeit im Moment des Wechsels stetig bleibt. Ein Tick, der noch
   * mit der alten Geschwindigkeit rechnet, liegt deshalb nur um die Laufzeit
   * der Nachricht mal die Differenz der Geschwindigkeiten daneben – er muss
   * nicht verworfen werden, und ein Regler, der viele Änderungen schickt,
   * hält die Telemetrie nicht an.
   */
  epoch: number;
}

export type WorkerRequest =
  | { type: 'init'; shardIndex: number; shardCount: number }
  | { type: 'load'; groups: SatelliteGroup[] }
  | { type: 'observer'; observer: GeoCoord }
  | { type: 'start'; intervalMs: number }
  | { type: 'stop' }
  | { type: 'time'; base: TimeBase }
  | { type: 'recycle'; buffer: ArrayBuffer }
  /**
   * Ausgewähltes Objekt – nur dafür werden Subpunkt und Bahnhöhe gerechnet.
   *
   * Auswahl, Bahnspur und Überflug tragen die NORAD-ID, nicht den Platz: Den
   * übersetzt jeder Shard selbst über `knownIds`. Das Feld heißt bewusst
   * anders als früher (`index`), damit keine Stelle mit einer Zahl
   * weiterkompiliert.
   */
  | { type: 'select'; noradId: NoradId | null }
  /** Rohtext einer Gruppe, vom Lader-Shard über den Main-Thread verteilt. */
  | { type: 'tle'; group: SatelliteGroup; text: string }
  | { type: 'trail'; noradId: NoradId; fromMin: number; toMin: number; samples: number }
  | { type: 'pass'; noradId: NoradId; searchHours: number };

export type WorkerResponse =
  /** Metadaten des eigenen Shards; `total` ist die Größe des Gesamtkatalogs. */
  | { type: 'catalog'; shardIndex: number; offset: number; total: number; catalog: SatelliteMeta[] }
  /** Telemetrie des eigenen Shards. `offset` ist der globale Startindex. */
  | {
      type: 'tick';
      shardIndex: number;
      offset: number;
      count: number;
      /** Virtuelle Zeit, zu der propagiert wurde. */
      time: number;
      /** `TimeBase.epoch`, mit der `time` entstand. */
      epoch: number;
      /** Gemessene Rechenzeit des Ticks in ms – speist die adaptive Taktung. */
      durationMs: number;
      buffer: ArrayBuffer;
    }
  /**
   * Antworten nennen die ID, für die sie gerechnet wurden, und die Epoche der
   * Zeitbasis – Grundlage der Stale-Guards für Auswahl und Zeit.
   */
  | {
      type: 'trail';
      noradId: NoradId;
      points: Float32Array;
      /** Virtuelle Zeit, auf die sich `fromMin`/`toMin` der Anfrage beziehen. */
      timeMs: number;
      epoch: number;
    }
  | {
      type: 'pass';
      noradId: NoradId;
      passes: PassPrediction[];
      /** Virtuelle Zeit, ab der gesucht wurde. */
      fromMs: number;
      epoch: number;
    }
  /** Rohtext, den der Lader-Shard an seine Geschwister weiterreichen lässt. */
  | { type: 'tle'; group: SatelliteGroup; text: string }
  | { type: 'status'; message: string; loading: boolean }
  | { type: 'error'; message: string };
