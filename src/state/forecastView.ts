/**
 * Reine Funktionen der Vorhersage „Demnächst sichtbar“ im Main-Thread:
 * Abdeckung und Gültigkeit eines Stands, Zusammenführen der Shard-Antworten,
 * Auswahl der Einträge, Ableitung aller Texte und Geometrie entlang der Spur.
 *
 * Keine Store-, DOM- oder three-Zugriffe; Namen kommen per Callback, die Zeit
 * als Argument. Der Controller-Hook (useVisibilityForecast) ruft das alle
 * `FORECAST_CHECK_MS` mit `virtualNow()` auf – Node-Prüfskripte mit jeder
 * beliebigen Zeit.
 *
 * Gültigkeit ist eine Regel über absolute Zeiten, keine Epoche: Ein Stand
 * gilt, solange er die laufende virtuelle Zeit samt Fenster abdeckt. Das fängt
 * Sprung, Zeitraffer, Rückwärtslauf und iOS-Hintergrund mit einer einzigen
 * Prüfung. Eine Prüfung gegen Wanduhr-Intervalle (wie `PASS_REFRESH_AFTER_MS`)
 * reichte bei 10-min-Fenstern nicht (Depot-Notiz virtuelle-zeit-worker-pool.md).
 */
import { FORECAST_FAR_HORIZON_MIN, FORECAST_MAX_SLOTS } from '../data/forecast';
import { DEG, compassLabel } from '../math/coords';
import { forecastGridCeil, forecastGridFloor } from '../math/forecast';
import type { ForecastEntry, NoradId, Vec3 } from '../types';
import {
  formatForecastCountdown,
  formatForecastNext,
  formatForecastRemaining,
} from '../utils/format';
import type {
  ForecastCommitted,
  ForecastFarCommitted,
  ForecastFarStatus,
  ForecastNext,
  ForecastPart,
  ForecastSlot,
  ForecastStatus,
  ForecastView,
} from './runtime';

/** Takt des Controllers (Wanduhr): Abdeckung prüfen, Texte ableiten. */
export const FORECAST_CHECK_MS = 250;
/** Mindestabstand zweier Kurz-Anfragen (Wanduhr). */
export const FORECAST_MIN_REQUEST_GAP_MS = 500;
/** Ohne alle Antworten nach dieser Zeit: Teilstand übernehmen (`complete = false`) und neu fragen. */
export const FORECAST_WATCHDOG_MS = 4000;
/** Entprellung nach `catalogVersion` – der Katalog wächst beim Laden stufenweise. */
export const FORECAST_CATALOG_DEBOUNCE_MS = 1500;

/**
 * Abdeckung des Kurz-Scans (alles virtuelle Zeit): Vorlauf hinter dem
 * Fenster, Rücklauf vor `now`, beide wachsen mit dem Zeitraffer in seiner
 * Richtung. Margen: Unterschreitet der verbleibende Vorlauf bzw. Rücklauf
 * diese Werte, wird neu gescannt – rechtzeitig, bevor die Abdeckung reißt.
 */
export const FORECAST_LEAD_BASE_MS = 120_000;
export const FORECAST_LEAD_PER_SCALE_MS = 4000;
export const FORECAST_BACK_BASE_MS = 10_000;
export const FORECAST_BACK_PER_SCALE_MS = 4000;
export const FORECAST_FWD_MARGIN_BASE_MS = 30_000;
export const FORECAST_FWD_MARGIN_PER_SCALE_MS = 1500;
export const FORECAST_BACK_MARGIN_BASE_MS = 5000;
export const FORECAST_BACK_MARGIN_PER_SCALE_MS = 1500;

/** Reichweite des Lang-Scans („Ausblick“) in ms. */
export const FORECAST_FAR_HORIZON_MS = FORECAST_FAR_HORIZON_MIN * 60_000;
/** Mindestabstand zweier Lang-Anfragen (Wanduhr). */
export const FORECAST_FAR_MIN_REQUEST_GAP_MS = 2000;
/** Wachhund des Lang-Scans – er läuft im Worker mit Nachrang und darf länger brauchen. */
export const FORECAST_FAR_WATCHDOG_MS = 8000;
/** Abdeckung und Margen des Lang-Scans, gleiche Form wie beim Kurz-Scan. */
export const FORECAST_FAR_LEAD_BASE_MS = 600_000;
export const FORECAST_FAR_LEAD_PER_SCALE_MS = 20_000;
export const FORECAST_FAR_BACK_BASE_MS = 30_000;
export const FORECAST_FAR_BACK_PER_SCALE_MS = 10_000;
export const FORECAST_FAR_FWD_MARGIN_BASE_MS = 60_000;
export const FORECAST_FAR_FWD_MARGIN_PER_SCALE_MS = 2000;
export const FORECAST_FAR_BACK_MARGIN_BASE_MS = 5000;
export const FORECAST_FAR_BACK_MARGIN_PER_SCALE_MS = 2000;

/**
 * Verbünde (Nutzerentscheidung 08.10.2026, Spezifikation §13): Fenster, deren
 * Spuren praktisch gleich sind, belegen einen Platz. Zwei Fenster gehören
 * zusammen, wenn sich ihre Sichtfenster überlappen, ihr Aufgang höchstens
 * `FORECAST_GROUP_RISE_TOLERANCE_MS` auseinanderliegt und ihre Richtungen über
 * das ganze gemeinsame Stück (späterer Aufgang bis früheres Sichtende) höchstens
 * `FORECAST_GROUP_MAX_SEPARATION_DEG` auseinanderliegen.
 *
 * Gemessen 08.10.2026, Frankfurt, 48 h, 16 080 Objekte vom TLE-Spiegel: Die
 * Module der ISS und der CSS liegen bei 0,000° (CelesTrak gibt angedockten
 * Objekten die Elemente der Station), unabhängige Objekte mit überlappenden
 * Sichtfenstern nie näher als 8,7° über ihr gemeinsames Stück. 0,5° (ein
 * Monddurchmesser) lässt eigenständig angepasste Bahnsätze desselben Verbunds
 * zu – 4 km Versatz bei 500 km Entfernung – und bleibt weit unter dem
 * Abstand unabhängiger Objekte.
 *
 * Nicht der Sichtbeginn: Er hängt an der Standardhelligkeit und lag bei der
 * ISS (−1,8) und ihren Modulen (1,0) bis 245 s auseinander, das Sichtende bis
 * 54 s. Der Aufgang ist eine reine Frage der Position: Zwei Objekte, die
 * 0,5° auseinanderliegen, gehen höchstens so viel später auf, wie ein LEO am
 * Horizont für 0,5° Höhe braucht – gemessen 7–10 s bei ISS-Überflügen mit
 * ≥ 10° Höchststand, dazu zweimal 250 ms Bisektion; 15 s lassen Luft für
 * höhere, langsamere Bahnen.
 */
export const FORECAST_GROUP_MAX_SEPARATION_DEG = 0.5;
export const FORECAST_GROUP_RISE_TOLERANCE_MS = 15_000;
/** Abstand der Vergleichspunkte – der der Spurpunkte (≥ 5 s, `FORECAST_TRACE_MIN_STEP_MS`). */
const FORECAST_GROUP_SAMPLE_MS = 5000;
const GROUP_MIN_COS = Math.cos(FORECAST_GROUP_MAX_SEPARATION_DEG * DEG);

/** Name und Highlight-Flag je NORAD-ID – in der App über `catalogIndex.slotById`/`meta`; `null`, wenn unbekannt. */
export type ForecastLookup = (id: NoradId) => { name: string; highlight: boolean } | null;

/** Ohne Katalog: kein Name, kein Highlight – der Anführer eines Verbunds folgt dann allein der Helligkeit. */
const NO_LOOKUP: ForecastLookup = () => null;

/* ------------------------------------------------------------------ */
/* Kurz-Scan: Abdeckung und Gültigkeit                                  */
/* ------------------------------------------------------------------ */

/**
 * Zeitbereich einer neuen Kurz-Anfrage.
 *
 * Der Beginn liegt auf dem absoluten 5-s-Raster (`forecastGridFloor`):
 * abgerundet, der Rücklauf wird also um weniger als 5 s länger, nie kürzer.
 * Alle Kurz- und Lang-Scans sehen so dieselben Rasterpunkte. Mit `now − 10 s`
 * als Rasterbeginn tauchte ein Fenster unter 5 s bei jedem Neuscan mal auf und
 * mal nicht (Begründung und Beispiel bei `forecastGridFloor`).
 */
export function coverageFor(
  nowMs: number,
  windowMs: number,
  scale: number,
): { fromMs: number; toMs: number } {
  return {
    fromMs: forecastGridFloor(nowMs - (FORECAST_BACK_BASE_MS + Math.max(0, -scale) * FORECAST_BACK_PER_SCALE_MS)),
    toMs:
      nowMs + windowMs + FORECAST_LEAD_BASE_MS + Math.max(0, scale) * FORECAST_LEAD_PER_SCALE_MS,
  };
}

/**
 * Soll neu gescannt werden? Ja ohne Stand, bei einem Teilstand und wenn der
 * verbleibende Vorlauf oder Rücklauf unter die Marge fällt.
 *
 * Takt daraus: ×1 alle ≈ 90 s, ×60 alle ≈ 4 s Wanduhr (240 s virtuell),
 * ×−60 alle ≈ 2,6 s, Pause nie.
 *
 * Die Rücklauf-Marge wächst nur mit Rückwärtslauf (`max(0, −scale)`), wie der
 * Rücklauf in `coverageFor`. Die Spezifikation (08.10.2026, §5) schrieb
 * `|scale|`; damit wäre ab ×4 vorwärts die Marge größer als der Rücklauf von
 * 10 s, und es würde nach jeder Antwort sofort wieder gefragt – im
 * Widerspruch zum Takt oben (×60 alle ≈ 4 s). Beim Wechsel von vorwärts auf
 * rückwärts greift die Marge sofort und holt den längeren Rücklauf nach.
 */
export function needsRescan(
  committed: ForecastCommitted | null,
  nowMs: number,
  windowMs: number,
  scale: number,
): boolean {
  if (committed === null || !committed.complete) return true;
  const fwdMargin = FORECAST_FWD_MARGIN_BASE_MS + Math.max(0, scale) * FORECAST_FWD_MARGIN_PER_SCALE_MS;
  if (committed.toMs - (nowMs + windowMs) < fwdMargin) return true;
  const backMargin = FORECAST_BACK_MARGIN_BASE_MS + Math.max(0, -scale) * FORECAST_BACK_MARGIN_PER_SCALE_MS;
  return nowMs - committed.fromMs < backMargin;
}

/**
 * Darf der Stand für `[now, now + W]` angezeigt werden?
 *
 * Er muss `now` und das ganze Fenster abdecken. Hat ein Shard mehr als `keep`
 * Treffer, fehlen hinter `completeUntilMs` Fenster; dann gilt der Stand nur,
 * wenn das Fenster davor endet – oder wenn schon davor genug Einträge bekannt
 * sind, um alle Plätze der Liste zu füllen: Ein fehlendes Fenster beginnt
 * später und fiele hinter Platz `FORECAST_MAX_SLOTS`. Gezählt wird wie in der
 * Liste (`selectForecastGroups`): Verbünde, je Objekt einmal – zehn
 * NORAD-IDs, von denen fünf denselben Verbund bilden, füllen nur sechs Plätze.
 * `lookup` entscheidet dabei nur den Anführer (Highlight zuerst).
 */
export function isCoverageValid(
  committed: ForecastCommitted | null,
  nowMs: number,
  windowMs: number,
  lookup: ForecastLookup = NO_LOOKUP,
): boolean {
  if (committed === null) return false;
  const horizonMs = nowMs + windowMs;
  if (committed.fromMs > nowMs || horizonMs > committed.toMs) return false;
  if (horizonMs <= committed.completeUntilMs) return true;

  const known = selectForecastGroups(committed.entries, nowMs, committed.completeUntilMs - nowMs, lookup);
  return known.length >= FORECAST_MAX_SLOTS;
}

/** NORAD-IDs numerisch, ohne zu parsen: Normalisierte IDs haben keine führenden Nullen, die kürzere ist also die kleinere Zahl. */
function compareIds(a: NoradId, b: NoradId): number {
  const lengthDiff = a.length - b.length;
  if (lengthDiff !== 0) return lengthDiff;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Reihenfolge der Einträge: Sichtbeginn, dann NORAD-ID. */
function compareEntries(a: ForecastEntry, b: ForecastEntry): number {
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  return compareIds(a.noradId, b.noradId);
}

/**
 * Antworten aller Shards zu einem Stand: Einträge zusammen, sortiert nach
 * (startMs, noradId); `completeUntilMs` ist das Minimum über die Teile, denn
 * jenseits davon kann in einem Shard etwas fehlen.
 */
export function mergeForecastParts(
  parts: ForecastPart[],
  shardCount: number,
  requestId: number,
  fromMs: number,
  toMs: number,
): ForecastCommitted {
  const entries: ForecastEntry[] = [];
  let completeUntilMs = toMs;
  for (const part of parts) {
    for (const entry of part.entries) entries.push(entry);
    if (part.completeUntilMs < completeUntilMs) completeUntilMs = part.completeUntilMs;
  }
  entries.sort(compareEntries);
  return {
    requestId,
    fromMs,
    toMs,
    completeUntilMs,
    entries,
    complete: parts.length === shardCount,
  };
}

/* ------------------------------------------------------------------ */
/* Verbünde und Auswahl                                                 */
/* ------------------------------------------------------------------ */

/** Richtungen beider Spuren beim Vergleich – wiederverwendet. */
const trackA: Vec3 = { x: 0, y: 0, z: 0 };
const trackB: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Fliegen zwei Fenster verschiedener Objekte praktisch dieselbe Spur?
 * Schwellen und ihre Begründung bei `FORECAST_GROUP_MAX_SEPARATION_DEG`.
 *
 * Verglichen wird zur selben Zeit, alle 5 s vom späteren Aufgang bis zum
 * früheren Sichtende und an diesem Ende selbst – also über den ganzen
 * sichtbaren Teil des kürzeren Fensters samt Anflug. Das Überlappen der
 * Sichtfenster trennt zwei Fenster desselben Bogens (Erdschatten) und zwei
 * Überflüge; der Aufgang ist der billige Vorfilter, der fast alle Paare ohne
 * einen einzigen Spurpunkt verwirft.
 */
export function sameForecastTrack(a: ForecastEntry, b: ForecastEntry): boolean {
  if (a.noradId === b.noradId) return false;
  if (a.startMs > b.endMs || b.startMs > a.endMs) return false;
  if (Math.abs(a.traceStartMs - b.traceStartMs) > FORECAST_GROUP_RISE_TOLERANCE_MS) return false;
  // Überlappen die Sichtfenster, liegt der spätere Aufgang (≤ Sichtbeginn)
  // nie hinter dem früheren Sichtende – die Schleife endet.
  const fromMs = Math.max(a.traceStartMs, b.traceStartMs);
  const toMs = Math.min(a.endMs, b.endMs);
  for (let t = fromMs; ; t += FORECAST_GROUP_SAMPLE_MS) {
    const at = t < toMs ? t : toMs;
    forecastPointAt(a, at, trackA);
    forecastPointAt(b, at, trackB);
    if (trackA.x * trackB.x + trackA.y * trackB.y + trackA.z * trackB.z < GROUP_MIN_COS) return false;
    if (at >= toMs) return true;
  }
}

/**
 * Ein Verbund: Fenster verschiedener Objekte mit praktisch derselben Spur
 * (`sameForecastTrack`), etwa die ISS mit ihren angedockten Modulen. Er
 * belegt einen Platz; Spur, Zeiten, Name und Antippen gehören dem Anführer.
 */
export interface ForecastGroup {
  /** Highlight zuerst, dann kleinste `peakMagnitude`, dann NORAD-ID. */
  leader: ForecastEntry;
  /** Die übrigen Objekte (ohne den Anführer), je NORAD-ID einmal, in Rangfolge – ihre Zahl steht hinter „+“. */
  memberIds: NoradId[];
}

/**
 * Fasst Fenster mit praktisch derselben Spur zu Verbünden zusammen.
 *
 * In Rangfolge (Highlight-Objekte zuerst, dann die hellsten nach
 * `peakMagnitude` – bei gleicher Spur unterscheidet sich die nur um die
 * Standardhelligkeit –, dann NORAD-ID, dann Sichtbeginn) tritt jedes Fenster
 * dem ersten Verbund bei, dessen Anführer es gleicht, sonst gründet es einen
 * eigenen. Jedes Mitglied liegt damit höchstens 0,5° neben seinem Anführer –
 * keine Kette, die sich über einen ganzen Starlink-Zug zieht. Der Anführer
 * ist der hellste, also der mit dem längsten Sichtfenster: Bei gleicher Spur
 * enthält es die Fenster der Mitglieder.
 *
 * Unabhängig von der Zeit: Ein Stand wird einmal gruppiert (`groupsOf`), die
 * Auswahl filtert je Takt nur noch die Anführer.
 */
export function groupForecastEntries(entries: readonly ForecastEntry[], lookup: ForecastLookup): ForecastGroup[] {
  const highlight = new Map<NoradId, boolean>();
  for (const entry of entries) {
    if (!highlight.has(entry.noradId)) highlight.set(entry.noradId, lookup(entry.noradId)?.highlight ?? false);
  }
  const ranked = entries.slice().sort((a, b) => {
    const rankA = highlight.get(a.noradId) ? 0 : 1;
    const rankB = highlight.get(b.noradId) ? 0 : 1;
    if (rankA !== rankB) return rankA - rankB;
    if (a.peakMagnitude !== b.peakMagnitude) return a.peakMagnitude - b.peakMagnitude;
    return compareIds(a.noradId, b.noradId) || a.startMs - b.startMs;
  });

  const groups: ForecastGroup[] = [];
  for (const entry of ranked) {
    let home: ForecastGroup | null = null;
    for (const group of groups) {
      if (sameForecastTrack(group.leader, entry)) {
        home = group;
        break;
      }
    }
    if (home === null) groups.push({ leader: entry, memberIds: [] });
    else if (!home.memberIds.includes(entry.noradId)) home.memberIds.push(entry.noradId);
  }
  return groups;
}

/**
 * Verbünde des zuletzt gefragten Stands. Ein Stand (`committed.entries`) ist
 * nach dem Zusammenführen unveränderlich, `lookup` in der App eine feste
 * Funktion – der Controller fragt im 250-ms-Takt bis zu dreimal und gruppiert
 * so nur einmal je Stand.
 */
let groupCache: { entries: readonly ForecastEntry[]; lookup: ForecastLookup; groups: ForecastGroup[] } | null = null;

function groupsOf(entries: readonly ForecastEntry[], lookup: ForecastLookup): ForecastGroup[] {
  if (groupCache === null || groupCache.entries !== entries || groupCache.lookup !== lookup) {
    groupCache = { entries, lookup, groups: groupForecastEntries(entries, lookup) };
  }
  return groupCache.groups;
}

/**
 * Die Plätze der Anzeige: Verbünde (`groupForecastEntries`), deren Anführer
 * noch nicht beendet ist und spätestens am Ende des Fensters beginnt,
 * sortiert nach (startMs, noradId) des Anführers, höchstens `max`. Gerade
 * sichtbare stehen damit vorn, ihr Beginn liegt ≤ now.
 *
 * Je Objekt ein Platz: Ein Verbund entfällt, wenn sein Anführer schon in einem
 * früheren steht (als Anführer oder Mitglied) – so zeigt auch ein Objekt mit
 * mehreren Fenstern (Erdschatten mitten im Bogen, bis zu drei) nur das
 * früheste noch nicht beendete. Gedeckelt wird erst danach: Die Mitglieder
 * eines Verbunds verdrängen keine anderen Satelliten.
 */
export function selectForecastGroups(
  entries: readonly ForecastEntry[],
  nowMs: number,
  windowMs: number,
  lookup: ForecastLookup = NO_LOOKUP,
  max: number = FORECAST_MAX_SLOTS,
): ForecastGroup[] {
  const horizonMs = nowMs + windowMs;
  const candidates = groupsOf(entries, lookup).filter(
    (group) => group.leader.endMs > nowMs && group.leader.startMs <= horizonMs,
  );
  candidates.sort((a, b) => compareEntries(a.leader, b.leader));

  const shown = new Set<NoradId>();
  const picked: ForecastGroup[] = [];
  for (const group of candidates) {
    if (picked.length >= max) break;
    if (shown.has(group.leader.noradId)) continue;
    shown.add(group.leader.noradId);
    for (const id of group.memberIds) shown.add(id);
    picked.push(group);
  }
  return picked;
}

/* ------------------------------------------------------------------ */
/* Lang-Scan („Ausblick“): Abdeckung und Gültigkeit                     */
/* ------------------------------------------------------------------ */

/**
 * Zeitbereich einer neuen Lang-Anfrage: ab kurz vor dem Ende des Fensters bis
 * `FORECAST_FAR_HORIZON_MIN` plus Vorlauf. Die Überlappung mit der
 * Kurz-Abdeckung um Rücklauf + Vorlauf ist gewollt: kein Loch zwischen now+W
 * und dem Lang-Bereich.
 *
 * Nie vor `now`: Rückwärts reichte der Rücklauf sonst in die Vergangenheit
 * (×−60: W 5 → now − 5,5 min, W 10 → now − 30 s). Mit `FORECAST_FAR_KEEP` = 1
 * beschriebe ein Shard dann ein schon vergangenes Fenster, `isFarValid`
 * verwürfe es, und der nächste Scan fände dasselbe – „Suche bis 90 min …“ im
 * 2-s-Takt, bis der Rücklauf das Fenster erreicht, und der echte nächste
 * Kandidat ginge verloren (Frankfurt 07.10.2026 19:40Z: COSMOS 2219 vergangen
 * statt ARIANE 40 R/B in 21 min, nachgerechnet 08.10.2026). Ein Fenster, das
 * vor `now` beginnt, braucht der Lang-Scan ohnehin nie: Es ist vorbei oder
 * läuft und stünde dann in der Liste. Die Gnade beim Rückwärtslauf bleibt –
 * der Stand gilt, solange `fromMs ≤ now + W` (`isFarValid`).
 *
 * Der Beginn liegt wie bei `coverageFor` auf dem absoluten 5-s-Raster: der
 * Rücklauf abgerundet (Überlappung um < 5 s länger), die Grenze `now`
 * aufgerundet – abgerundet läge sie bis zu 5 s vor `now`. Beides bleibt
 * ≤ now + W. So sieht der Lang-Scan dieselben Rasterpunkte wie die Liste und
 * nennt kein Fenster unter 5 s als „Nächster“, das die Liste verfehlt
 * (Beispiel bei `forecastGridFloor`).
 */
export function farCoverageFor(
  nowMs: number,
  windowMs: number,
  scale: number,
): { fromMs: number; toMs: number } {
  return {
    fromMs: Math.max(
      forecastGridCeil(nowMs),
      forecastGridFloor(
        nowMs + windowMs - (FORECAST_FAR_BACK_BASE_MS + Math.max(0, -scale) * FORECAST_FAR_BACK_PER_SCALE_MS),
      ),
    ),
    toMs:
      nowMs +
      FORECAST_FAR_HORIZON_MS +
      FORECAST_FAR_LEAD_BASE_MS +
      Math.max(0, scale) * FORECAST_FAR_LEAD_PER_SCALE_MS,
  };
}

/**
 * Darf der Stand des Lang-Scans angezeigt werden?
 *
 * Der Stand sagt „frühester Sichtbeginn in [fromMs, toMs]“. Beginnt der
 * Bereich spätestens bei now+W, ist ein gefundener Kandidat der früheste ab
 * now+W, solange er noch bevorsteht (liegt er in [now, now+W], zeigt ihn die
 * Kurz-Liste, und die ist dann nicht leer – beide Scans tasten dieselben
 * absoluten Rasterpunkte ab, siehe `farCoverageFor`); ein „keiner“ gilt nur,
 * solange der Bereich die vollen 90 min abdeckt.
 */
export function isFarValid(
  far: ForecastFarCommitted | null,
  nowMs: number,
  windowMs: number,
): boolean {
  if (far === null || far.fromMs > nowMs + windowMs) return false;
  return far.entry === null ? far.toMs >= nowMs + FORECAST_FAR_HORIZON_MS : far.entry.startMs > nowMs;
}

/**
 * Soll der Lang-Scan neu laufen? Ja ohne Stand, bei einem Teilstand, ohne
 * Kandidat, wenn der Vorlauf über die 90 min hinaus unter die Marge fällt,
 * und wenn now+W dem Beginn des Bereichs zu nahe kommt (Rückwärtslauf).
 *
 * Takt daraus (nur solange die Liste leer ist): ohne Kandidat ×1 alle ≈ 9 min
 * virtuell, ×60 alle ≈ 28 min virtuell (≈ 28 s Wanduhr); rückwärts ×−60 bei
 * W 20 alle ≈ 8,4 s, W 10 ≈ 7,9 s, W 5 ≈ 2,9 s Wanduhr – dort beginnt der
 * Bereich bei `now` (`farCoverageFor`), der Rücklauf ist nur W lang. Mit
 * Kandidat gar nicht, bis er bevorsteht (dann ist die Liste nicht leer) bzw.
 * vorbei ist (dann `isFarValid` false → ein Neuscan).
 *
 * Rücklauf-Marge mit `max(0, −scale)` statt `|scale|` – Begründung wie bei
 * `needsRescan`: Vorwärts ab ×13 läge sie sonst über dem Rücklauf von 30 s.
 */
export function needsFarRescan(
  far: ForecastFarCommitted | null,
  nowMs: number,
  windowMs: number,
  scale: number,
): boolean {
  if (far === null || !far.complete) return true;
  const fwdMargin =
    FORECAST_FAR_FWD_MARGIN_BASE_MS + Math.max(0, scale) * FORECAST_FAR_FWD_MARGIN_PER_SCALE_MS;
  if (far.entry === null && far.toMs - (nowMs + FORECAST_FAR_HORIZON_MS) < fwdMargin) return true;
  const backMargin =
    FORECAST_FAR_BACK_MARGIN_BASE_MS + Math.max(0, -scale) * FORECAST_FAR_BACK_MARGIN_PER_SCALE_MS;
  return nowMs + windowMs - far.fromMs < backMargin;
}

/** Antworten aller Shards zum Lang-Scan: sortiert wie `mergeForecastParts`, das erste Element oder null. */
export function mergeFarParts(
  parts: ForecastPart[],
  shardCount: number,
  requestId: number,
  fromMs: number,
  toMs: number,
): ForecastFarCommitted {
  let entry: ForecastEntry | null = null;
  for (const part of parts) {
    for (const candidate of part.entries) {
      if (entry === null || compareEntries(candidate, entry) < 0) entry = candidate;
    }
  }
  return { requestId, fromMs, toMs, entry, complete: parts.length === shardCount };
}

/* ------------------------------------------------------------------ */
/* Ableitung der Anzeige                                                */
/* ------------------------------------------------------------------ */

const NO_GROUPS: readonly ForecastGroup[] = [];

/** Zustandstext der Liste (§1); bei `ready` mit Einträgen leer. */
function statusTextFor(status: ForecastStatus, slotCount: number, windowMs: number, scale: number): string {
  switch (status) {
    case 'off':
      return '';
    case 'noObserver':
      return 'Warte auf Standort';
    case 'paused':
      return `Vorhersage ruht bei ×${Math.round(Math.abs(scale))}`;
    case 'pending':
      return 'Berechne …';
    case 'ready':
      return slotCount === 0 ? `Keine in den nächsten ${Math.round(windowMs / 60_000)} min` : '';
  }
}

function buildSlot(group: ForecastGroup, nowMs: number, lookup: ForecastLookup): ForecastSlot {
  const entry = group.leader;
  const info = lookup(entry.noradId);
  const name = info?.name ?? `NORAD ${entry.noradId}`;
  const highlight = info?.highlight ?? false;
  const visibleNow = entry.startMs <= nowMs && nowMs < entry.endMs;
  const countdownText = visibleNow
    ? formatForecastRemaining(entry.endMs, nowMs, entry.endOpen)
    : formatForecastCountdown(entry.startMs, nowMs);
  const groupText = group.memberIds.length > 0 ? `+${group.memberIds.length}` : '';
  // Highlight-Objekte tragen am Himmel schon ein Namenslabel (HighlightMarkers);
  // ihr Label nennt nur den Verbund: „+5 · in 3:20“. Aber erst ab dem Aufgang:
  // Darunter blendet HighlightMarkers Marker samt Namen aus, und am
  // Aufgangspunkt stünde nur „in 3:20“ – ohne Hinweis, wer gemeint ist.
  // Dieselbe Bedingung wie der Versatz des Labels in VisibilityForecast.
  const nameless = highlight && nowMs >= entry.traceStartMs;
  const labelHead = nameless ? groupText : groupText ? `${name} ${groupText}` : name;
  return {
    noradId: entry.noradId,
    name,
    highlight,
    entry,
    memberIds: group.memberIds,
    groupText,
    visibleNow,
    countdownText,
    labelText: labelHead ? `${labelHead} · ${countdownText}` : countdownText,
    detailText: `aus ${compassLabel(entry.startAzimuthDeg)} · max ${Math.round(entry.maxElevationDeg)}°`,
  };
}

/**
 * Vorsatz der Ausblick-Zeile. ForecastList setzt ihn als eigenes Element vor
 * den Namen, damit die Zeile auf schmalen Karten zwischen beiden umbricht,
 * statt den Namen abzuschneiden; `ForecastNext.text` ist die Zeile am Stück.
 */
export const FORECAST_NEXT_PREFIX = 'Nächster:';

function buildNext(entry: ForecastEntry, nowMs: number, lookup: ForecastLookup): ForecastNext {
  const info = lookup(entry.noradId);
  // Mit Namen auch für Highlight-Objekte: Die Zeile hat keinen anderen Anker.
  const name = info?.name ?? `NORAD ${entry.noradId}`;
  return {
    noradId: entry.noradId,
    name,
    highlight: info?.highlight ?? false,
    entry,
    text: `${FORECAST_NEXT_PREFIX} ${name}`,
    detailText: `${formatForecastNext(entry.startMs, nowMs)} · aus ${compassLabel(entry.startAzimuthDeg)}`,
  };
}

/** Gleiche Plätze für React: dieselben Anführer in derselben Reihenfolge, dieselbe Verbundgröße. */
function sameMembership(a: readonly ForecastSlot[], b: readonly ForecastSlot[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].noradId !== b[i].noradId || a[i].groupText !== b[i].groupText) return false;
  }
  return true;
}

function sameIdList(a: readonly NoradId[], b: readonly NoradId[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function sameSlots(a: readonly ForecastSlot[], b: readonly ForecastSlot[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.noradId !== y.noradId ||
      x.entry !== y.entry ||
      x.name !== y.name ||
      x.highlight !== y.highlight ||
      !sameIdList(x.memberIds, y.memberIds) ||
      x.groupText !== y.groupText ||
      x.visibleNow !== y.visibleNow ||
      x.countdownText !== y.countdownText ||
      x.labelText !== y.labelText ||
      x.detailText !== y.detailText
    ) {
      return false;
    }
  }
  return true;
}

function sameNext(a: ForecastNext | null, b: ForecastNext | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.noradId === b.noradId &&
    a.entry === b.entry &&
    a.name === b.name &&
    a.highlight === b.highlight &&
    a.text === b.text &&
    a.detailText === b.detailText
  );
}

/**
 * Leitet die Anzeige für die virtuelle Zeit `nowMs` ab und schreibt sie nach
 * `target` (in der App `forecastView`). Die einzige Stelle, an der Countdowns
 * und Zustandstexte entstehen – Komponenten kopieren nur.
 *
 * Einträge nur bei `ready`, ein Platz je Verbund (`selectForecastGroups`).
 * Ausblick (`next`/`nextText`) nur bei `ready` und leerer Liste: `farStatus` 'pending' → „Suche bis 90 min …“, 'ready' ohne
 * Kandidat → „Auch bis 90 min keiner“, mit Kandidat „Nächster: NAME“ und
 * „in 47 min · aus NW“; 'idle' → nichts. `farStatus` selbst übernimmt immer
 * den übergebenen Wert.
 *
 * Zähler: `membershipVersion` steigt bei Wechsel von Status, Lang-Status, der
 * geordneten ID-Liste, einer Verbundgröße („+5“ rendert die Liste per React),
 * des Kandidaten – und des Zustandstexts, weil den die
 * Liste per React rendert (Fensterwechsel bei leerer Liste, ×600 → ×3600 in
 * der Pause); nie bei bloßem Countdown- oder Minutenwechsel. `version` steigt
 * bei jeder Änderung, auch nur von Texten, Fenster oder Zeitraffer. Bleibt
 * alles gleich, bleiben auch `slots` und `next` dieselben Objekte.
 */
export function deriveForecastView(
  status: ForecastStatus,
  committed: ForecastCommitted | null,
  farStatus: ForecastFarStatus,
  farCommitted: ForecastFarCommitted | null,
  nowMs: number,
  windowMs: number,
  scale: number,
  lookup: ForecastLookup,
  target: ForecastView,
): void {
  const groups =
    status === 'ready' && committed !== null
      ? selectForecastGroups(committed.entries, nowMs, windowMs, lookup)
      : NO_GROUPS;
  const slots = groups.map((group) => buildSlot(group, nowMs, lookup));
  const statusText = statusTextFor(status, slots.length, windowMs, scale);

  let next: ForecastNext | null = null;
  let nextText = '';
  if (status === 'ready' && slots.length === 0) {
    if (farStatus === 'pending') {
      nextText = `Suche bis ${FORECAST_FAR_HORIZON_MIN} min …`;
    } else if (farStatus === 'ready') {
      const candidate = farCommitted?.entry ?? null;
      if (candidate === null) {
        nextText = `Auch bis ${FORECAST_FAR_HORIZON_MIN} min keiner`;
      } else {
        next = buildNext(candidate, nowMs, lookup);
        nextText = next.text;
      }
    }
  }

  const membershipChanged =
    target.status !== status ||
    target.farStatus !== farStatus ||
    target.statusText !== statusText ||
    !sameMembership(target.slots, slots) ||
    (target.next?.noradId ?? null) !== (next?.noradId ?? null);
  const slotsChanged = !sameSlots(target.slots, slots);
  const nextChanged = !sameNext(target.next, next);
  const changed =
    membershipChanged ||
    slotsChanged ||
    nextChanged ||
    target.nextText !== nextText ||
    target.windowMs !== windowMs ||
    target.scale !== scale;

  target.status = status;
  target.statusText = statusText;
  target.windowMs = windowMs;
  target.nowMs = nowMs;
  target.scale = scale;
  if (slotsChanged) target.slots = slots;
  target.farStatus = farStatus;
  target.nextText = nextText;
  if (nextChanged) target.next = next;
  if (membershipChanged) target.membershipVersion += 1;
  if (changed) target.version += 1;
}

/* ------------------------------------------------------------------ */
/* Geometrie entlang der Spur                                           */
/* ------------------------------------------------------------------ */

/**
 * Richtung (Einheitsvektor) eines Eintrags zur Zeit `tMs`: auf die Spur
 * geklemmt, linear zwischen den beiden Nachbarpunkten, danach normiert. Vor
 * `traceStartMs` ist das der erste Spurpunkt – der Aufgangspunkt, solange das
 * Objekt noch unter dem Horizont steht. Feste Schrittweite: Index-Rechnung
 * statt Suche, billig genug für jedes Bild.
 */
export function forecastPointAt(entry: ForecastEntry, tMs: number, out: Vec3): void {
  const p = entry.points;
  const count = Math.floor(p.length / 3);
  if (count < 2) {
    out.x = count === 1 ? p[0] : 0;
    out.y = count === 1 ? p[1] : 1;
    out.z = count === 1 ? p[2] : 0;
    return;
  }
  const last = count - 1;
  let u = (tMs - entry.traceStartMs) / entry.stepMs;
  if (!(u > 0)) u = 0;
  if (u > last) u = last;
  const i = Math.min(Math.floor(u), last - 1);
  const f = u - i;
  const a = i * 3;
  const x = p[a] + (p[a + 3] - p[a]) * f;
  const y = p[a + 1] + (p[a + 4] - p[a + 1]) * f;
  const z = p[a + 2] + (p[a + 5] - p[a + 2]) * f;
  const length = Math.sqrt(x * x + y * y + z * z) || 1;
  out.x = x / length;
  out.y = y / length;
  out.z = z / length;
}

/** Kopf der Spur, wiederverwendet – `pickForecastTrace` läuft je Tap über alle Plätze. */
const head: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Winkel zwischen der Richtung (rx, ry, rz) und dem Segment A→B auf der
 * Kugel: nächster Punkt auf der Sehne (Lerp-Parameter geklemmt), normiert –
 * Näherung des Großkreisbogens, für Spurpunkte im Abstand weniger Grad genau
 * genug.
 */
function segmentAngle(
  rx: number,
  ry: number,
  rz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  let t = lengthSq > 0 ? ((rx - ax) * dx + (ry - ay) * dy + (rz - az) * dz) / lengthSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t;
  const py = ay + dy * t;
  const pz = az + dz * t;
  const length = Math.sqrt(px * px + py * py + pz * pz) || 1;
  const cos = (px * rx + py * ry + pz * rz) / length;
  return Math.acos(cos > 1 ? 1 : cos < -1 ? -1 : cos);
}

/**
 * Welche Spur trifft ein Tap in Richtung `ray`? Je Platz die Polylinie vom
 * Kopf (`forecastPointAt(now)`) bis zum letzten Spurpunkt, kleinster Winkel
 * zwischen Strahl und Segment; der beste Platz mit Winkel ≤ `maxAngleRad`.
 * Bei Gleichstand gewinnt der frühere Eintrag.
 */
export function pickForecastTrace(
  ray: Vec3,
  slots: readonly ForecastSlot[],
  nowMs: number,
  maxAngleRad: number,
): { noradId: NoradId; angleRad: number } | null {
  const rayLength = Math.sqrt(ray.x * ray.x + ray.y * ray.y + ray.z * ray.z);
  if (!(rayLength > 0)) return null;
  const rx = ray.x / rayLength;
  const ry = ray.y / rayLength;
  const rz = ray.z / rayLength;

  let bestId: NoradId | null = null;
  let bestAngle = Infinity;
  for (const slot of slots) {
    const entry = slot.entry;
    const p = entry.points;
    const count = Math.floor(p.length / 3);
    if (count < 2) continue;

    forecastPointAt(entry, nowMs, head);
    // Segment, in dem der Kopf liegt – dieselbe Klemmung wie in forecastPointAt.
    let u = (nowMs - entry.traceStartMs) / entry.stepMs;
    if (!(u > 0)) u = 0;
    const segment = Math.min(Math.floor(u), count - 2);

    let ax = head.x;
    let ay = head.y;
    let az = head.z;
    for (let k = segment + 1; k < count; k += 1) {
      const bx = p[k * 3];
      const by = p[k * 3 + 1];
      const bz = p[k * 3 + 2];
      const angle = segmentAngle(rx, ry, rz, ax, ay, az, bx, by, bz);
      if (angle <= maxAngleRad && angle < bestAngle) {
        bestAngle = angle;
        bestId = slot.noradId;
      }
      ax = bx;
      ay = by;
      az = bz;
    }
  }
  return bestId === null ? null : { noradId: bestId, angleRad: bestAngle };
}
