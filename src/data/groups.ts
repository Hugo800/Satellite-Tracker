import type { SatelliteGroup } from '../types';
import { GROUP_LOAD_ORDER } from './tleSources';

/** Radius der Himmelskugel in Szeneneinheiten – die Kamera sitzt im Mittelpunkt. */
export const SKY_RADIUS = 430;

/**
 * Kanonische Reihenfolge der Gruppen.
 *
 * Sie bestimmt zugleich die numerische Gruppen-ID in `catalogIndex.groupIds`
 * und damit den Paletten-Index in Szene, Spuren und Radar. Sie ist identisch
 * mit der Ladereihenfolge, damit ID und Herkunft nicht auseinanderlaufen.
 */
export const GROUP_ORDER = GROUP_LOAD_ORDER;

/**
 * Farbcodierung der Gruppen – aus den iOS-Systemfarben, damit sie in Hell und
 * Dunkel gleichermaßen tragen. `other` ist der Gesamtkatalog und bleibt
 * bewusst neutral, damit die besonderen Gruppen sichtbar bleiben.
 */
export const GROUP_COLORS: Record<SatelliteGroup, string> = {
  stations: '#ffd60a',
  brightest: '#f5f5f7',
  weather: '#30d158',
  starlink: '#0a84ff',
  other: '#9aa3b2',
};

/** Klartextbezeichnung für Liste und Legende. */
export const GROUP_LABEL: Record<SatelliteGroup, string> = {
  stations: 'ISS & Stationen',
  brightest: 'Hellste',
  weather: 'Wetter',
  starlink: 'Starlink',
  other: 'Katalog',
};
