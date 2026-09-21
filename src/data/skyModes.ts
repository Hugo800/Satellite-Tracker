import { Eye, Globe2, Satellite } from 'lucide-react';
import type { SkyFilterMode } from '../types';

/** Die drei Himmelsfilter samt Beschriftung und Erklärtext. */
export const SKY_MODES: Array<{
  value: SkyFilterMode;
  label: string;
  hint: string;
  icon: typeof Eye;
}> = [
  {
    value: 'all',
    label: 'Alle',
    hint: 'Ausnahmslos jedes Katalogobjekt über dem Horizont – ohne Mengenbegrenzung.',
    icon: Globe2,
  },
  {
    value: 'nakedEye',
    label: 'Sichtbar',
    hint: 'Nur sonnenbeschienene Objekte heller als 4 mag bei dunklem Himmel über 10° Höhe.',
    icon: Eye,
  },
  {
    value: 'starlink',
    label: 'Starlink',
    hint: 'Ausschließlich Starlink-Satelliten über dem Horizont.',
    icon: Satellite,
  },
];
