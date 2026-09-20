import type { SatelliteGroup } from '../types';

export interface TleSource {
  group: SatelliteGroup;
  label: string;
  url: string;
  /** Obergrenze, um mobile GPUs nicht zu überfahren. */
  limit: number;
  /** Starlink liefert mehrere Megabyte – dafür reicht das Standardfenster nicht. */
  timeoutMs: number;
}

const GP = 'https://celestrak.org/NORAD/elements/gp.php';

export const TLE_SOURCES: Record<SatelliteGroup, TleSource> = {
  stations: {
    group: 'stations',
    label: 'Raumstationen',
    url: `${GP}?GROUP=stations&FORMAT=tle`,
    limit: 120,
    timeoutMs: 15_000,
  },
  brightest: {
    group: 'brightest',
    label: 'Hellste Objekte',
    url: `${GP}?GROUP=visual&FORMAT=tle`,
    limit: 260,
    timeoutMs: 20_000,
  },
  weather: {
    group: 'weather',
    label: 'Wettersatelliten',
    url: `${GP}?GROUP=weather&FORMAT=tle`,
    limit: 200,
    timeoutMs: 20_000,
  },
  starlink: {
    group: 'starlink',
    label: 'Starlink',
    url: `${GP}?GROUP=starlink&FORMAT=tle`,
    limit: 2600,
    timeoutMs: 60_000,
  },
};

/** NORAD-IDs, die ein eigenes Mesh + Label bekommen. */
export const HIGHLIGHT_NORAD_IDS = new Set([
  '25544', // ISS (ZARYA)
  '20580', // Hubble Space Telescope
  '48274', // CSS (Tiangong)
  '25338', // NOAA 15
  '33591', // NOAA 19
]);

/**
 * Minimal-Katalog für den Offline-/Fehlerfall, damit die App auch ohne
 * Netzverbindung etwas Sinnvolles anzeigt. Epoche 2025 – Positionen driften,
 * werden aber beim nächsten erfolgreichen Abruf überschrieben.
 */
export const FALLBACK_TLE = `ISS (ZARYA)
1 25544U 98067A   25060.54791667  .00016717  00000+0  30177-3 0  9993
2 25544  51.6400 208.9163 0002571  75.4322 284.7009 15.50377579    16
CSS (TIANHE)
1 48274U 21035A   25060.51805556  .00019352  00000+0  22001-3 0  9995
2 48274  41.4700 145.0135 0006703  89.4500 270.7100 15.61658430    13
HST
1 20580U 90037B   25060.38472222  .00001876  00000+0  10083-3 0  9991
2 20580  28.4696 288.1456 0002534 174.7539 185.3345 15.11049889    19
NOAA 19
1 33591U 09005A   25060.45000000  .00000155  00000+0  10312-3 0  9990
2 33591  99.0500  50.2000 0013500 220.0000 140.0000 14.12800000    15
`;
