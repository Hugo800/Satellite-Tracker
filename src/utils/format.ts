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

/** Nur Tag/Monat, ohne Wochentag – kompakter als `DATE_FMT` für schmale Kacheln. */
const SHORT_DATE_FMT = new Intl.DateTimeFormat('de-DE', {
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

/** Sekunden als „m:ss“ – Minuten ohne Obergrenze („64:05“). */
function minutesSeconds(totalSec: number): string {
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
}

/**
 * Countdown der Vorhersage „Demnächst sichtbar“ bis `targetMs`: „in 3:20“,
 * bei erreichtem Ziel „jetzt“.
 *
 * Sekunden aufgerundet: „in 0:01“ heißt „höchstens noch eine Sekunde“, und
 * „jetzt“ erscheint erst, wenn das Ziel wirklich erreicht ist – im selben
 * Moment, in dem der Eintrag zu „noch …“ wechselt. Feste Form m:ss, weil die
 * Angabe in jedem Takt springt; mit `tabular-nums` wackelt sie so nicht.
 * `nowMs` ist Pflicht (Muster `formatCountdown`): virtuelle Zeit.
 */
export function formatForecastCountdown(targetMs: number, nowMs: number): string {
  const diff = Math.ceil((targetMs - nowMs) / 1000);
  if (diff <= 0) return 'jetzt';
  return `in ${minutesSeconds(diff)}`;
}

/**
 * Restzeit eines gerade sichtbaren Vorhersage-Eintrags: „noch 4:10“, bei
 * offenem Ende (länger als das beschriebene Fenster, MEO/HEO) „sichtbar“.
 * Aufgerundet und nie negativ. `nowMs` ist Pflicht: virtuelle Zeit.
 */
export function formatForecastRemaining(endMs: number, nowMs: number, endOpen: boolean): string {
  if (endOpen) return 'sichtbar';
  return `noch ${minutesSeconds(Math.max(0, Math.ceil((endMs - nowMs) / 1000)))}`;
}

/**
 * Abstand zum Sichtbeginn des Kandidaten in der Ausblick-Zeile („Nächster:
 * …“): „in 47 min“, ab einer Stunde „in 1 h 12 min“, glatt „in 2 h“.
 *
 * Ohne Sekunden – die Karte ist nur 122–197 px breit (320–393 px
 * Bildschirmbreite), und auf eine Minute genau reicht für einen Kandidaten,
 * der bis zu 90 min entfernt ist. Aufgerundet, mindestens 1: Rückt der
 * Sichtbeginn ins Zeitfenster, übernimmt ohnehin die Liste mit
 * sekundengenauem Countdown. `nowMs` ist Pflicht: virtuelle Zeit.
 *
 * Aufgerundet statt gerundet (Abweichung von der Spezifikation 08.10.2026,
 * §5): Die Zeile steht nur, solange der Sichtbeginn mehr als W Minuten
 * entfernt ist. Gerundet hieße der Kandidat 30 s lang „in 10 min“, während
 * der Zustandstext darüber „Keine in den nächsten 10 min“ sagt; aufgerundet
 * zeigt alles hinter now + W mindestens W + 1 Minuten.
 */
export function formatForecastNext(startMs: number, nowMs: number): string {
  const minutes = Math.max(1, Math.ceil((startMs - nowMs) / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
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

/**
 * Dauer als „45 s“, „5 min 3 s“, „1 h 40 min“ oder „2 d 3 h“.
 *
 * Ein geostationärer Überflug dauert unbegrenzt (`losOpen`, s. propagation.ts)
 * und zeigte bisher „≥ 4193 min 30 s“ – ohne Stunden/Tage unlesbar und in der
 * schmalen Zeile (PassRow, TelemetryPanel.tsx) ohnehin zu breit. Ab einer
 * Stunde deshalb Stunden, ab einem Tag Tage; jeweils nur die zwei bis drei
 * gröbsten NICHT-NULLEN Einheiten – eine glatte Stunde zeigt „1 h“ statt
 * „1 h 0 min 0 s“, ein Tageswert lässt die Sekunden ganz weg (auf Tagesskala
 * ohnehin nicht mehr sinnvoll). Bei Minuten bleiben die Sekunden wie bisher
 * immer stehen, auch wenn 0 – Downlink-Fenster werden auf die Sekunde geplant.
 */
export function formatDurationSec(seconds: number): string {
  // Erst runden, dann aufteilen – sonst entsteht durch zwei getrennte
  // Rundungen eine Ausgabe wie „1 min 60 s“.
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (days > 0) {
    const parts = [`${days} d`];
    if (hours > 0) parts.push(`${hours} h`);
    if (minutes > 0) parts.push(`${minutes} min`);
    return parts.join(' ');
  }
  if (hours > 0) {
    const parts = [`${hours} h`];
    if (minutes > 0) parts.push(`${minutes} min`);
    if (secs > 0) parts.push(`${secs} s`);
    return parts.join(' ');
  }
  if (minutes > 0) return `${minutes} min ${secs} s`;
  return `${secs} s`;
}

/**
 * Schwellen für die Alterswarnung der Bahndaten (TelemetryPanel).
 *
 * SGP4 rechnet aus mittleren Bahnelementen zu einer Epoche; je weiter die
 * Rechenzeit davon entfernt ist, desto größer der Positionsfehler. Als
 * Faustregel gilt für LEO ~1–3 km/Tag, mit rund 1 km Fehler schon bei der
 * Epoche selbst (Vallado, Crawford, Hujsak, Kelso, „Revisiting Spacetrack
 * Report #3“, AIAA 2006-6753 – vielzitierte Größenordnung, siehe z. B.
 * https://www.researchgate.net/publication/228684641). Eine neuere
 * empirische Auswertung an Starlink-TLEs gegen hochpräzise Referenzbahnen
 * misst einen Median von rund 38 km SGP4-Fehler nach 7 Tagen
 * (arXiv:2605.19850, „How long can you trust a Starlink TLE?“). Beides sind
 * GROBE Größenordnungen für einen Katalog gemischter Bahnhöhen, keine exakte
 * Vorhersage für ein einzelnes Objekt – der tatsächliche Fehler hängt stark
 * von Bahnhöhe, Exzentrizität und Sonnenaktivität (Atmosphärendichte für die
 * Luftwiderstands-Näherung) ab. Zwei Stufen genügen deshalb:
 *
 * - WARN ab 3 Tagen: ~3–9 km nach der Faustregel, gegenüber der angezeigten
 *   Bahnhöhe (oft < 1000 km) schon spürbar.
 * - CRITICAL ab 7 Tagen: Größenordnung des gemessenen Starlink-Medians
 *   (~38 km) – die angezeigte Position ist dann mit Vorsicht zu genießen.
 *
 * Gilt symmetrisch für negatives Alter (Rechenzeit vor der Epoche, Sprung in
 * die Vergangenheit): Der Fehler wächst mit dem Betrag des Zeitabstands, die
 * Richtung spielt dafür keine Rolle.
 */
export const TLE_AGE_WARN_HOURS = 72;
export const TLE_AGE_CRITICAL_HOURS = 168;

export type TleAgeSeverity = 'ok' | 'warn' | 'critical';

/** Warnstufe für ein Alter in Stunden (Betrag – s. `TLE_AGE_WARN_HOURS`). */
export function tleAgeSeverity(ageHours: number): TleAgeSeverity {
  const abs = Math.abs(ageHours);
  if (abs >= TLE_AGE_CRITICAL_HOURS) return 'critical';
  if (abs >= TLE_AGE_WARN_HOURS) return 'warn';
  return 'ok';
}

/**
 * Ab dieser Stundenzahl zeigt `formatTleAge` das Epochendatum statt einer
 * Tageszahl. Gemessen (headless Chrome 153, Systemschrift, ECHTE 375-pt-
 * CSS-Breite – `Emulation.setDeviceMetricsOverride`, EINE durchgehende CDP-
 * Sitzung, App im Dev-Server, 24.09.2026): Die Kachel „Bahndaten“ im
 * Telemetrie-Grid ist bei 375 pt 104,3 px breit, davon 84,3 px Inhalt
 * (Padding 10 px beidseitig, `px-2.5`); bei 402 pt 113,3/93,3 px. Gemessen
 * am natürlichen Text (Klon `position:absolute; white-space:nowrap`
 * außerhalb des Layouts – NICHT am eingebauten Flex-Kind, das sich sonst laut
 * ~/Git/agent/docs/headless-chrome-layout-messung.md quetscht und eine
 * falsche, zu kleine Breite zurückgibt).
 *
 * „9,9 Tage alt“ – die längste Zahl kurz vor dem Wechsel – braucht bei
 * 375 pt 82,7 px: passt, aber mit nur rund 1,6 px Rand (bei 402 pt 10,6 px).
 * So knapp, weil „Bahndaten 2,1 Tage alt“ als Beispieltext vorgegeben war und
 * die Kachel mit 104 px die schmalste im Grid ist. „vom 22.09.“ (alle
 * Monate/Tage durchprobiert, max. 81,4 px) hat bei 375 pt mit 2,9 px etwas
 * mehr Luft. Der Wechsel bei zehn Tagen ist trotzdem in erster Linie eine
 * Lesbarkeits-, nicht nur eine Platzentscheidung: Ab da sagt ein Datum mehr
 * als eine abstrakte Tageszahl. OFFEN: 1,6 px Rand ist knapp für eine andere
 * Schriftmetrik als die des Dev-Servers (z. B. echtes iOS/WebKit statt
 * Chrome) – im headless-Chrome-Teil der Abnahme deshalb nicht nur auf
 * Umbruch der Kopfzeile prüfen, sondern die Kachel selbst zoomen.
 */
export const TLE_AGE_DATE_SWITCH_HOURS = 240;

/**
 * Alter der Bahndaten gegenüber `nowMs` (virtuelle Zeit, s. `virtualNow()`
 * im Store) als kompakter Text fürs Telemetrie-Panel: „vor 3 min“,
 * „2,1 h alt“, „4,6 Tage alt“ oder ab `TLE_AGE_DATE_SWITCH_HOURS` das Datum
 * „vom 22.09.“. Negatives Alter (Rechenzeit vor der Epoche – Sprung in die
 * Vergangenheit über die Zeitmaschine) symmetrisch, aber mit „d“ statt
 * „Tagen“: „in 2,1 d“ statt „in 2,1 Tagen“ – Letzteres maß (375 pt, s.
 * `TLE_AGE_DATE_SWITCH_HOURS`) 86,5 px gegen 84,3 px Kacheninhalt, passte
 * also GAR NICHT (naturalWidth > contentWidth); „in 2,1 d“ misst nur
 * 52,8 px. Das Epochendatum („vom …“) bleibt bei beiden Richtungen gleich,
 * weil es die Epoche selbst benennt, nicht die Richtung zu ihr.
 *
 * Minuten runden absichtlich nie auf 60: Bei `absHours` knapp unter 1 rundete
 * `Math.round(absHours * 60)` sonst auf 60 auf („vor 60 min“ statt „vor 1 h“).
 */
export function formatTleAge(epochMs: number, nowMs: number): string {
  if (!Number.isFinite(epochMs)) return '–';
  const diffMs = nowMs - epochMs;
  const absHours = Math.abs(diffMs) / 3_600_000;

  if (absHours >= TLE_AGE_DATE_SWITCH_HOURS) return `vom ${SHORT_DATE_FMT.format(new Date(epochMs))}`;

  const future = diffMs < 0; // Rechenzeit liegt vor der Epoche.
  const minutes = Math.round(absHours * 60);
  if (minutes < 60) {
    const m = Math.max(1, minutes);
    return future ? `in ${m} min` : `vor ${m} min`;
  }
  if (absHours < 24) {
    return future ? `in ${formatNumber(absHours, 1)} h` : `${formatNumber(absHours, 1)} h alt`;
  }
  const days = absHours / 24;
  return future ? `in ${formatNumber(days, 1)} d` : `${formatNumber(days, 1)} Tage alt`;
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
