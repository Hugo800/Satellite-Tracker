const TIME_FMT = new Intl.DateTimeFormat('de-DE', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const DATE_FMT = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
});

export function formatClock(ms: number): string {
  return TIME_FMT.format(new Date(ms));
}

export function formatDay(ms: number): string {
  return DATE_FMT.format(new Date(ms));
}

/** Relative Angabe wie „in 2 h 14 min“ bzw. „jetzt“. */
export function formatCountdown(targetMs: number, nowMs: number = Date.now()): string {
  const diff = Math.round((targetMs - nowMs) / 1000);
  if (diff <= 0) return 'jetzt';
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;
  if (hours > 0) return `in ${hours} h ${minutes} min`;
  if (minutes > 0) return `in ${minutes} min ${seconds} s`;
  return `in ${seconds} s`;
}

export function formatDurationSec(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

export function formatNumber(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '–';
  return value.toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
