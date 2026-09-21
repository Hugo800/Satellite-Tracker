import type { SatelliteGroup } from '../types';

export interface TleSource {
  group: SatelliteGroup;
  label: string;
  url: string;
  /** Starlink und der Gesamtkatalog liefern mehrere Megabyte – dafür reicht das Standardfenster nicht. */
  timeoutMs: number;
}

const GP = 'https://celestrak.org/NORAD/elements/gp.php';

/**
 * Reihenfolge ist bedeutungstragend: Der Parser übernimmt jede NORAD-ID nur
 * einmal, und zwar mit der Gruppe, in der sie **zuerst** auftaucht. Die
 * spezifischen Gruppen stehen deshalb vorn (sie liefern Farbe und Filter),
 * `active` steht hinten und füllt den Rest des Katalogs auf.
 *
 * Bewusst **ohne** jede Mengenbegrenzung: Im Modus „Alle“ soll ausnahmslos
 * jedes trackbare Objekt propagiert und dargestellt werden. Was der Nutzer
 * am Himmel sieht, entscheidet allein der Horizont – nicht ein Hardcode.
 */
export const TLE_SOURCES: Record<SatelliteGroup, TleSource> = {
  stations: {
    group: 'stations',
    label: 'Raumstationen',
    url: `${GP}?GROUP=stations&FORMAT=tle`,
    timeoutMs: 20_000,
  },
  brightest: {
    group: 'brightest',
    label: 'Hellste Objekte',
    url: `${GP}?GROUP=visual&FORMAT=tle`,
    timeoutMs: 25_000,
  },
  weather: {
    group: 'weather',
    label: 'Wettersatelliten',
    url: `${GP}?GROUP=weather&FORMAT=tle`,
    timeoutMs: 25_000,
  },
  starlink: {
    group: 'starlink',
    label: 'Starlink',
    url: `${GP}?GROUP=starlink&FORMAT=tle`,
    timeoutMs: 90_000,
  },
  other: {
    group: 'other',
    label: 'Gesamtkatalog',
    // `active` ist der vollständige Satz aktiver Objekte (≈ 12 000 TLE-Sätze,
    // ~2,5 MB). Alles, was die Gruppen davor nicht schon erfasst haben,
    // landet hier – damit ist der Katalog lückenlos.
    url: `${GP}?GROUP=active&FORMAT=tle`,
    timeoutMs: 120_000,
  },
};

/** Ladereihenfolge: spezifisch → allgemein (siehe Kommentar oben). */
export const GROUP_LOAD_ORDER: SatelliteGroup[] = [
  'stations',
  'brightest',
  'weather',
  'starlink',
  'other',
];

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

/**
 * Dekodiert eine Alpha-5-Katalognummer.
 *
 * Das TLE-Format hat für die Katalognummer nur fünf Zeichen. Seit die
 * Nummern 99999 überschritten haben, kodiert CelesTrak die Hunderttausender
 * als Buchstaben: `A0001` ist 100001. Die Buchstaben `I` und `O` bleiben
 * ausgespart, weil sie mit Eins und Null verwechselbar wären.
 *
 * Ohne diese Umrechnung trügen die neuesten Starts eine Kennung, die sich
 * weder suchen noch mit einem Katalog abgleichen ließe.
 */
const ALPHA5_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function decodeAlpha5(field: string): string {
  const raw = field.trim();
  if (!raw) return raw;
  const head = raw[0].toUpperCase();
  if (head >= '0' && head <= '9') return String(Number(raw));

  const offset = ALPHA5_LETTERS.indexOf(head);
  if (offset < 0) return raw;
  const rest = Number(raw.slice(1));
  if (!Number.isFinite(rest)) return raw;
  return String((offset + 10) * 10000 + rest);
}
