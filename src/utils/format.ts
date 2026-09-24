import type { PassPrediction } from '../types';

const TIME_FMT = new Intl.DateTimeFormat('de-DE', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const SHORT_TIME_FMT = new Intl.DateTimeFormat('de-DE', {
  hour: '2-digit',
  minute: '2-digit',
});

const DATE_FMT = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
});

export function formatClock(ms: number): string {
  return TIME_FMT.format(new Date(ms));
}

/** Uhrzeit ohne Sekunden – für Zeitfenster, bei denen Minuten genügen. */
export function formatClockShort(ms: number): string {
  return SHORT_TIME_FMT.format(new Date(ms));
}

export function formatDay(ms: number): string {
  return DATE_FMT.format(new Date(ms));
}

/**
 * Relative Angabe wie „in 2 h 14 min“ bzw. „jetzt“.
 *
 * `nowMs` ist Pflicht: Ein Vorgabewert `Date.now()` rechnete still gegen die
 * Wanduhr, auch wenn die Szene in einer anderen Zeit steht. Aufrufer geben
 * die virtuelle Zeit (`virtualNow()` aus dem Store).
 */
export function formatCountdown(targetMs: number, nowMs: number): string {
  const diff = Math.round((targetMs - nowMs) / 1000);
  if (diff <= 0) return 'jetzt';
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;
  if (hours > 0) return `in ${hours} h ${minutes} min`;
  if (minutes > 0) return `in ${minutes} min ${seconds} s`;
  return `in ${seconds} s`;
}

/**
 * Restzeit bis `endMs` für einen Überflug, der gerade läuft: „noch 45 s“,
 * „noch 7 min“, ab einer Stunde „noch 5:12 h“.
 *
 * Die Angabe steht rechts neben „Überflüge · nächste 48 h“, und der Platz
 * dort ist knapp. Gemessen (headless Chrome 153, Systemschrift, 24.09.2026):
 * Bei 375 pt Bildschirmbreite bleiben 115 px frei. „läuft · noch 10 h 59 min“
 * bräuchte 128 px und bräche die Kopfzeile um, „läuft · noch 10:59 h“ braucht
 * 106 px, „läuft · noch 59 min“ 100 px. Deshalb ohne Sekunden und ab einer
 * Stunde als h:mm. Mehr als 49 h können es nicht werden, so weit reicht die
 * Suche nicht. Minuten aufgerundet: „noch 1 min“ heißt „höchstens eine“.
 */
export function formatRemaining(endMs: number, nowMs: number): string {
  const diff = Math.max(0, Math.round((endMs - nowMs) / 1000));
  if (diff < 60) return `noch ${diff} s`;
  const minutes = Math.ceil(diff / 60);
  if (minutes < 60) return `noch ${minutes} min`;
  return `noch ${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} h`;
}

/**
 * Stand der Überflugliste zur Zeit `nowMs`: der erste Eintrag, der noch nicht
 * vorbei ist, ob er gerade läuft, und die Angabe dafür. Bleibt die Karte über
 * einen Untergang hinaus offen, rückt die Angabe zum nächsten weiter.
 */
export function passCountdown(
  passes: PassPrediction[],
  nowMs: number,
): { runningAos: number | null; text: string } {
  const current = passes.find((p) => p.los > nowMs);
  if (!current) return { runningAos: null, text: '–' };
  if (current.aos <= nowMs) {
    return {
      runningAos: current.aos,
      text: `läuft · ${current.losOpen ? 'Ende offen' : formatRemaining(current.los, nowMs)}`,
    };
  }
  return { runningAos: null, text: formatCountdown(current.sunlitStart ?? current.aos, nowMs) };
}

export function formatDurationSec(seconds: number): string {
  // Erst runden, dann aufteilen – sonst entsteht durch zwei getrennte
  // Rundungen eine Ausgabe wie „1 min 60 s“.
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

export function formatNumber(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '–';
  return value.toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

const COUNT_FMT = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

/** Ganzzahl mit Tausenderpunkt – der Katalog wird fünfstellig. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '–';
  return COUNT_FMT.format(Math.round(value));
}
