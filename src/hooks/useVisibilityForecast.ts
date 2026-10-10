import { useEffect, useRef } from 'react';
import { FORECAST_MAX_ABS_SCALE } from '../data/forecast';
import { FORECAST_KEEP_MAX_PER_SHARD, FORECAST_KEEP_PER_SHARD } from '../math/forecast';
import {
  FORECAST_CATALOG_DEBOUNCE_MS,
  FORECAST_CHECK_MS,
  FORECAST_FAR_MIN_REQUEST_GAP_MS,
  FORECAST_FAR_WATCHDOG_MS,
  FORECAST_MIN_REQUEST_GAP_MS,
  FORECAST_WATCHDOG_MS,
  coverageFor,
  deriveForecastView,
  farCoverageFor,
  isCoverageValid,
  isFarValid,
  mergeFarParts,
  mergeForecastParts,
  needsFarRescan,
  needsRescan,
  selectForecastGroups,
} from '../state/forecastView';
import { catalogIndex, forecastState, forecastView } from '../state/runtime';
import type { ForecastFarStatus, ForecastStatus } from '../state/runtime';
import { selectTimeEpoch, selectTimeScale, useAppStore, virtualNow } from '../state/store';
import type { ForecastKind, GeoCoord, NoradId } from '../types';
import { engine } from './useSatelliteEngine';

/**
 * Controller der Vorhersage „Demnächst sichtbar“ im Filter „Sichtbar“.
 *
 * Hält `forecastState` (Anfragen und Stände beider Scan-Arten) mit der
 * laufenden virtuellen Zeit in Deckung und leitet daraus `forecastView` ab –
 * beides außerhalb von React (src/state/runtime.ts). Gerendert wird nur, wenn
 * sich die Menge der Einträge ändert (`bumpForecastRevision`); Countdowns,
 * Spurköpfe und Labels lesen Liste, Szene und Radar selbst aus `forecastView`.
 *
 * Gültigkeit ist eine Regel über absolute Zeiten, keine Epoche: Alle 250 ms
 * Wanduhr prüft `tickController` den Stand gegen `virtualNow()`. Das fängt
 * Sprung, Zeitraffer, Rückwärtslauf und iOS-Hintergrund mit derselben
 * Prüfung. Ein Nachführen nach Wanduhr-Intervallen (wie bei der
 * Überflugliste) reichte bei 10-min-Fenstern nicht – bei ×60 wären sie nach
 * 10 s Wanduhr vorbei. `performance.now()` dient nur Wachhund und
 * Mindestabstand der Anfragen.
 *
 * Zwei Arten (src/types, `ForecastKind`): Der Kurz-Scan (`near`) liefert die
 * Liste; der Lang-Scan (`far`, „Ausblick“ bis 90 min) läuft nur, solange die
 * Liste leer ist, und nennt dann den nächsten Kandidaten. Beide haben
 * getrennte Plätze, Mindestabstände und Wachhunde – der Lang-Scan verzögert
 * den Kurz-Scan nie, im Worker hat `near` ohnehin Vorrang.
 *
 * Verifiziert 08.10.2026 – im Reconciler mit 2 Node-Shards und im Browser
 * (Vite-Dev-Server, 1 Shard), beide mit 16 081 Objekten vom TLE-Spiegel,
 * Frankfurt, 07.10.2026: „Sichtbar“ an → `ready` nach 0,3 s (Node) bzw. 1,1 s
 * (Browser); Sprung +30 d → kurz `pending`, dann `ready`, Countdown aus der
 * virtuellen Zeit; ×60 → Neuanfragen alle 4,0–4,9 s Wanduhr; ×600 → `paused`
 * mit Abbruch beider Arten; Pause → keine Anfrage in 3 s; leere Liste (19:38Z,
 * W 10) → „Suche bis 90 min …“, dann „Nächster: ARIANE 40 R/B“ / „in 22 min ·
 * aus NNW“ (Browser 3,5 s nach der Leere); Liste mit Einträgen → 10 s lang
 * keine `far`-Anfrage; wird die Liste voll, während ein Lang-Scan läuft, geht
 * `forecastCancel {kind: 'far'}` hinaus.
 */

/**
 * Beschriebene Fenster je Shard der nächsten Kurz-Anfrage. Normalerweise
 * `FORECAST_KEEP_PER_SHARD`; verdoppelt, wenn ein Stand die Zeit zwar
 * abdeckt, aber hinter `completeUntilMs` Fenster fehlen und davor zu wenige
 * Verbünde für die Liste stehen (`isCoverageValid`). Dieselbe Anfrage brächte
 * sonst dieselbe Antwort – „Berechne …“ ohne Ende, alle 500 ms ein Scan. In
 * echten Daten nicht beobachtet (höchstens 10 Fenster je Shard und 22 min),
 * denkbar bei einem frischen Starlink-Zug. Zurück auf den Normalwert, sobald
 * die Vorhersage ruht oder der Standort wechselt.
 */
let nearKeep = FORECAST_KEEP_PER_SHARD;

/**
 * Anfrage je Art, die beim Senden `catalogDirty` bzw. `farDirty` verbraucht
 * hat (`requestId`, sonst −1). Wird sie aufgegeben, bevor ihr Stand
 * vollständig ankommt – Wachhund, Sprung, Abbruch des Lang-Scans –, setzt
 * `keepDirty` das Flag wieder. Sonst wäre der Anlass verloren: Der alte Stand
 * gilt weiter, `needsRescan` sieht keinen Grund, und neu geladene Objekte
 * kämen erst mit der nächsten Nachführung über die Margen in die Liste (×1
 * nach bis zu ≈ 90 s, in der Pause nie, im Ausblick erst zum Sichtbeginn des
 * Kandidaten, bis zu 90 min). Nachgestellt 08.10.2026: alle drei Shards 5 s
 * angehalten, Wachhund ohne Teilantwort, danach 8,4 s lang keine Anfrage.
 */
const dirtyRequest: Record<ForecastKind, number> = { near: -1, far: -1 };

/** Erhält den Anlass einer aufgegebenen Anfrage (siehe `dirtyRequest`). */
function keepDirty(kind: ForecastKind, requestId: number): void {
  if (dirtyRequest[kind] !== requestId) return;
  dirtyRequest[kind] = -1;
  if (kind === 'near') forecastState.catalogDirty = true;
  else forecastState.farDirty = true;
}

/**
 * Name und Highlight-Flag für die Ableitung – die Metadaten tragen beides, nur
 * die ID muss passen. Eine feste Funktion für alle Aufrufe eines Takts: Die
 * Verbünde eines Stands (Anführer: Highlight zuerst) werden damit nur einmal
 * gebildet (`groupsOf` in src/state/forecastView.ts).
 */
function lookupForecastMeta(noradId: NoradId): { name: string; highlight: boolean } | null {
  const slot = catalogIndex.slotById.get(noradId);
  const meta = slot === undefined ? undefined : catalogIndex.meta[slot];
  return meta?.noradId === noradId ? meta : null;
}

/** Leitet `forecastView` ab und meldet React, wenn sich die Menge der Einträge geändert hat. */
function publish(
  status: ForecastStatus,
  farStatus: ForecastFarStatus,
  nowMs: number,
  windowMs: number,
  scale: number,
): void {
  const membership = forecastView.membershipVersion;
  deriveForecastView(
    status,
    forecastState.committed,
    farStatus,
    forecastState.farCommitted,
    nowMs,
    windowMs,
    scale,
    lookupForecastMeta,
    forecastView,
  );
  if (forecastView.membershipVersion !== membership) useAppStore.getState().bumpForecastRevision();
}

/**
 * Ein Takt des Controllers, Schritte (1)–(8) der Spezifikation (08.10.2026, §7).
 * Läuft nur, solange die Vorhersage aktiv ist; Zeitfenster und Zeitraffer
 * frisch aus dem Store.
 */
function tickController(): void {
  const now = virtualNow();
  const { forecastWindowMin, timeBase } = useAppStore.getState();
  const windowMs = forecastWindowMin * 60_000;
  const scale = timeBase.scale;
  const wallNow = performance.now();

  // (1) Ein Stand, der die laufende Zeit samt Fenster nicht mehr abdeckt, ist
  // weg – nach einem Sprung, aber auch, wenn die Nachführung nicht mitkam.
  const invalid = forecastState.committed;
  if (invalid && !isCoverageValid(invalid, now, windowMs, lookupForecastMeta)) {
    // Deckt er die Zeit ab, fehlen nur Fenster hinter `completeUntilMs`:
    // ein Shard hatte mehr Treffer als `keep`. Die nächste Anfrage
    // beschreibt mehr, sonst drehte sie sich im Kreis (siehe `nearKeep`).
    if (invalid.complete && invalid.fromMs <= now && now + windowMs <= invalid.toMs) {
      nearKeep = Math.min(nearKeep * 2, FORECAST_KEEP_MAX_PER_SHARD);
    }
    forecastState.committed = null;
  }

  // Eine laufende Anfrage, deren Bereich die laufende Zeit nicht einmal
  // enthält, kann keinen gültigen Stand mehr liefern (Sprung). Aufgeben statt
  // abwarten – sonst hielte sie die neue Anfrage bis zu ihrem Ende bzw. bis
  // zum Wachhund auf. Ihre Antworten fallen an der `requestId`, und die neue
  // Anfrage ersetzt den Job im Worker.
  const stale = forecastState.pending;
  if (stale && (stale.fromMs > now || now + windowMs > stale.toMs)) {
    keepDirty('near', stale.requestId);
    forecastState.pending = null;
  }

  // (2) Wachhund: Ein Shard hängt, die Anfrage wird aufgegeben. Gibt es
  // keinen Stand (nach (1) ist jeder verbliebene gültig) oder nur einen
  // Teilstand, wird übernommen, was da ist (`complete = false`,
  // Spezifikation §10); `needsRescan` fragt sofort neu an. Ein vollständiger
  // Stand bleibt dagegen stehen: Der Teilstand ersetzte ihn durch weniger,
  // die Einträge des hängenden Shards fehlten (nachgestellt 08.10.2026:
  // Shard mit der ISS 5 s angehalten → Liste leer, „Keine in den nächsten
  // 10 min“, der Lang-Scan startete). Der Anlass der Anfrage bleibt (Margen
  // ohnehin, `catalogDirty` über `keepDirty`), dieser Takt fragt also neu –
  // bis der Shard antwortet oder der alte Stand nicht mehr gilt. Geprüft in
  // scripts/verify-forecast.ts, Abschnitt C und H (09.10.2026).
  const pending = forecastState.pending;
  if (pending && wallNow - pending.sentAt > FORECAST_WATCHDOG_MS) {
    const current = forecastState.committed;
    if (pending.parts.size > 0 && (current === null || !current.complete)) {
      forecastState.committed = mergeForecastParts(
        [...pending.parts.values()],
        engine.shardCount,
        pending.requestId,
        pending.fromMs,
        pending.toMs,
      );
    }
    keepDirty('near', pending.requestId);
    forecastState.pending = null;
  }

  // (3) Neu anfragen: ohne Stand, wenn Vor- oder Rücklauf zu knapp werden,
  // nach einem Teilstand oder wenn der Katalog gewachsen ist.
  if (
    (!forecastState.committed ||
      needsRescan(forecastState.committed, now, windowMs, scale) ||
      forecastState.catalogDirty) &&
    !forecastState.pending &&
    wallNow - forecastState.lastRequestAt >= FORECAST_MIN_REQUEST_GAP_MS
  ) {
    const { fromMs, toMs } = coverageFor(now, windowMs, scale);
    const dirty = forecastState.catalogDirty;
    const requestId = engine.requestForecast('near', fromMs, toMs, nearKeep);
    if (requestId >= 0) {
      forecastState.catalogDirty = false;
      dirtyRequest.near = dirty ? requestId : -1;
    }
  }

  // (4) Stand der Liste. Dieselbe Auswahl, die die Ableitung gleich trifft –
  // höchstens ein paar Dutzend Einträge, die Verbünde des Stands sind schon
  // gebildet, billig.
  const committed = forecastState.committed;
  const nearReady = committed !== null && isCoverageValid(committed, now, windowMs, lookupForecastMeta);
  const listEmpty =
    nearReady && selectForecastGroups(committed.entries, now, windowMs, lookupForecastMeta).length === 0;

  let farStatus: ForecastFarStatus = 'idle';
  if (listEmpty) {
    // (5) Kandidat vorbei oder Bereich zu kurz geworden.
    if (forecastState.farCommitted && !isFarValid(forecastState.farCommitted, now, windowMs)) {
      forecastState.farCommitted = null;
    }

    // (6) Wachhund des Lang-Scans, Regel wie (2): Ohne Stand oder mit nur
    // einem Teilstand zeigen, was da ist – den Rest holt `needsFarRescan`
    // (Teilstand → neu fragen); ein vollständiger Stand bleibt, der Anlass
    // der Anfrage auch.
    const farPending = forecastState.farPending;
    if (farPending && wallNow - farPending.sentAt > FORECAST_FAR_WATCHDOG_MS) {
      const current = forecastState.farCommitted;
      if (farPending.parts.size > 0 && (current === null || !current.complete)) {
        forecastState.farCommitted = mergeFarParts(
          [...farPending.parts.values()],
          engine.shardCount,
          farPending.requestId,
          farPending.fromMs,
          farPending.toMs,
        );
      }
      keepDirty('far', farPending.requestId);
      forecastState.farPending = null;
    }

    // (7) Lang-Scan anfragen – eigener Platz, eigener Mindestabstand.
    if (
      (!forecastState.farCommitted ||
        needsFarRescan(forecastState.farCommitted, now, windowMs, scale) ||
        forecastState.farDirty) &&
      !forecastState.farPending &&
      wallNow - forecastState.lastFarRequestAt >= FORECAST_FAR_MIN_REQUEST_GAP_MS
    ) {
      const { fromMs, toMs } = farCoverageFor(now, windowMs, scale);
      const dirty = forecastState.farDirty;
      const requestId = engine.requestForecast('far', fromMs, toMs);
      if (requestId >= 0) {
        forecastState.farDirty = false;
        dirtyRequest.far = dirty ? requestId : -1;
      }
    }

    const far = forecastState.farCommitted;
    farStatus = far !== null && isFarValid(far, now, windowMs) ? 'ready' : 'pending';
  } else if (forecastState.farPending) {
    // Die Liste hat Einträge oder rechnet noch: Den Kandidaten braucht
    // niemand, der Worker gibt die Scheiben frei. `farCommitted` bleibt und
    // gilt über `isFarValid` weiter, sobald die Liste wieder leer ist – mit
    // dem Anlass der abgebrochenen Anfrage, sonst nennte er dann womöglich
    // einen Kandidaten aus dem Katalog von vor dem Nachladen.
    keepDirty('far', forecastState.farPending.requestId);
    engine.cancelForecast('far');
  }

  // (8) Anzeige ableiten.
  publish(nearReady ? 'ready' : 'pending', farStatus, now, windowMs, scale);
}

/**
 * Startet und führt die Vorhersage. Gehört in `App` direkt hinter
 * `useSatelliteEngine` – dessen Effekte (Pool, Standort an die Shards) laufen
 * damit vor den Anfragen von hier.
 */
export function useVisibilityForecast(): void {
  const mode = useAppStore((s) => s.filters.mode);
  const observer = useAppStore((s) => s.observer);
  const timeEpoch = useAppStore(selectTimeEpoch);
  const scale = useAppStore(selectTimeScale);
  const windowMin = useAppStore((s) => s.forecastWindowMin);
  const catalogVersion = useAppStore((s) => s.catalogVersion);
  const windowMs = windowMin * 60_000;

  /** Werte des vorigen Laufs von Effekt A – daran erkennt er Standort-, Zeit- und Fensterwechsel. */
  const previous = useRef<{
    active: boolean;
    observer: GeoCoord | null;
    timeEpoch: number;
    windowMs: number;
  } | null>(null);

  // Effekt A: aktiv oder nicht, und bei Aktivität der Takt.
  useEffect(() => {
    const prev = previous.current;
    const inactiveStatus: ForecastStatus | null =
      mode !== 'nakedEye'
        ? 'off'
        : observer === null
          ? 'noObserver'
          : Math.abs(scale) > FORECAST_MAX_ABS_SCALE
            ? 'paused'
            : null;
    previous.current = { active: inactiveStatus === null, observer, timeEpoch, windowMs };

    if (inactiveStatus !== null) {
      // Beide Arten ruhen (×600 heißt auch: kein Ausblick). Abgebrochen wird
      // nur, was laufen kann – ein Wechsel zwischen zwei inaktiven Zuständen
      // (Filter „Alle“ → „Starlink“, Sprung bei „Alle“) schickt nichts.
      if (prev?.active || forecastState.pending || forecastState.farPending) engine.cancelForecast();
      forecastState.committed = null;
      forecastState.farCommitted = null;
      nearKeep = FORECAST_KEEP_PER_SHARD;
      publish(inactiveStatus, 'idle', virtualNow(), windowMs, scale);
      return;
    }

    const observerChanged = prev !== null && prev.observer !== observer;
    if (observerChanged) {
      // Die Fenster gehören zum alten Ort. Die Shards haben ihre Jobs mit der
      // `observer`-Nachricht verworfen (useSatelliteEngine schickt sie in
      // einem früheren Effekt desselben Commits); ohne freien Platz käme
      // eine neue Anfrage erst nach dem Wachhund.
      forecastState.committed = null;
      nearKeep = FORECAST_KEEP_PER_SHARD;
      engine.cancelForecast();
    }
    if (prev !== null && (observerChanged || prev.timeEpoch !== timeEpoch || prev.windowMs !== windowMs)) {
      // Lang-Scan ohne Abdeckungs-Gnade: Der Stand ist selten und billig neu
      // zu holen, die Regel soll einfach bleiben (Nutzerentscheidung
      // 08.10.2026). Er läuft danach erst wieder, wenn die Liste `ready` und
      // leer ist. Eine reine Geschwindigkeitsänderung lässt ihn stehen.
      forecastState.farCommitted = null;
      if (!observerChanged) engine.cancelForecast('far');
    }

    tickController();
    const id = window.setInterval(tickController, FORECAST_CHECK_MS);
    return () => window.clearInterval(id);
  }, [mode, observer, timeEpoch, windowMs, scale]);

  // Effekt B: Der Katalog ist gewachsen (stufenweises Laden, neuer Pool).
  // Entprellt, dann fragt der nächste Takt beide Arten neu an – falsch ist
  // kein Eintrag, es fehlen nur Objekte, auch in der Ausblick-Zeile.
  useEffect(() => {
    const id = window.setTimeout(() => {
      forecastState.catalogDirty = true;
      forecastState.farDirty = true;
    }, FORECAST_CATALOG_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [catalogVersion]);
}
