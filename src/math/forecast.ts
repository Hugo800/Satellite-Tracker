/**
 * Scan-Mathematik der Vorhersage „Demnächst sichtbar“: Welche Objekte des
 * eigenen Shards werden im Bereich `[fromMs, toMs]` mit bloßem Auge sichtbar,
 * wann genau, und welche Bahn ziehen sie bis dahin über den Himmel?
 *
 * Rein und ohne Zustand außerhalb des `ScanContext` – läuft im Worker
 * (src/workers/sgp4.worker.ts, in Zeitscheiben) ebenso wie in Node-Prüfskripten.
 * Die Bedingung ist exakt die des Himmelsfilters: `propagateInto` wie der Tick,
 * dann `passesSkyFilter('nakedEye', …)`. Ein Eintrag beginnt deshalb im selben
 * Moment, in dem das Objekt im Filter „Sichtbar“ erscheint.
 *
 * Gemessen (Node 22, ein Thread, 16 075 Objekte vom TLE-Spiegel, Leipzig,
 * sechs Startzeiten 08./09.10.2026; Depot-Notiz satellite-tracker-sichtbarkeit.md):
 * 5-s-Raster mit Entfernungsschranke 40 ms je 10 min (1,7 Proben je Objekt),
 * 72 ms je 20 min (3,2); gegen eine 1-s-Referenz 0 verpasste Fenster, 0
 * Fehlalarme. Ohne Schranke kostet derselbe Scan 2,0 s bzw. 4,0 s.
 */
import type { SatRec } from 'satellite.js';
import type { ForecastEntry, NoradId, ObserverGd } from '../types';
import { RAD } from './coords';
import { FORECAST_RANGE_RATE_KM_S, buildTickFrame, forecastRangeLimitKm, propagateInto } from './propagation';
import type { ObserverFrame, TickFrame } from './propagation';
import { INVISIBLE_MAGNITUDE, passesSkyFilter } from './visibility';
import {
  TELEMETRY_STRIDE,
  T_ALT,
  T_AZ,
  T_ECLIPSED,
  T_EL,
  T_LAT,
  T_LON,
  T_MAG,
  T_RANGE,
  T_SPEED,
} from './telemetryLayout';

/**
 * Die Entfernungsschranke des Scans (`scanWindows`) – definiert in
 * propagation.ts, weil auch die Überflugliste sie braucht (Sichtfenster im
 * Panel, `analyseBrightness`) und diese Datei propagation.ts importiert.
 */
export { FORECAST_MAG_MARGIN, FORECAST_RANGE_RATE_KM_S, forecastRangeLimitKm } from './propagation';

/**
 * Rasterabstand des Scans.
 *
 * Echte Sichtfenster sind teils nur 8–13 s lang (SL-3 R/B; Starlink DTC auf
 * ~350 km, die nur kurz im Zenit die Grenzhelligkeit schaffen). Jedes
 * Intervall ≥ 5 s enthält einen Rasterpunkt, ein 5-s-Raster verpasst also
 * kein solches Fenster. Ein 30-s-Raster verpasste in der Messung vom
 * 08.10.2026 6 von 65 Fenstern. Ein kürzeres Fenster findet der Scan nur,
 * wenn ein Rasterpunkt hineinfällt – dann aber in jedem Scan, weil alle auf
 * demselben absoluten Raster liegen (`forecastGridFloor`).
 */
export const FORECAST_STEP_MS = 5000;

/**
 * Rasterpunkt bei oder vor `ms`: ein ganzzahliges Vielfaches von
 * `FORECAST_STEP_MS` seit 1970.
 *
 * Jede Anfrage legt ihr Raster auf diese absoluten Punkte (`coverageFor`,
 * `farCoverageFor` in src/state/forecastView.ts). So tasten alle Kurz- und
 * Lang-Scans dieselben Zeitpunkte ab, auch die Rückwärtssuche eines schon
 * laufenden Fensters in `describeWindow`. Ein Fenster unter 5 s ist dann
 * entweder in jedem Scan drin oder in keinem. Mit dem Beginn der Anfrage als
 * Rasterbeginn hatte jeder Scan eine neue Phase, denn `virtualNow()` läuft
 * stetig: ENVISAT (Frankfurt, 08.10.2026 02:34:10,6–02:34:13,7Z, 3,1 s)
 * erschien und verschwand bei jedem Neuscan (×1 alle ≈ 93 s) in der Liste.
 * Der Lang-Scan nannte es 81 s lang als „Nächster: ENVISAT · in 5 min“,
 * während die Liste darüber „Keine in den nächsten 10 min“ sagte
 * (nachgerechnet 09.10.2026 mit den Schritten des Controllers).
 */
export function forecastGridFloor(ms: number): number {
  return Math.floor(ms / FORECAST_STEP_MS) * FORECAST_STEP_MS;
}

/** Gegenstück zu `forecastGridFloor`: Rasterpunkt bei oder nach `ms`. */
export function forecastGridCeil(ms: number): number {
  return Math.ceil(ms / FORECAST_STEP_MS) * FORECAST_STEP_MS;
}

/** Auflösung, auf die Sichtbeginn, Sichtende und Aufgang nachgeschärft werden. */
export const FORECAST_REFINE_MS = 250;
/** Längstes beschriebenes Sichtfenster; längere (MEO/HEO) enden offen (`endOpen`). */
export const FORECAST_MAX_VISIBLE_MS = 20 * 60_000;
/** Höchstzahl der Fenster je Objekt und Scan – mehr als eines nur bei Erdschatten mitten im Bogen. */
export const FORECAST_MAX_WINDOWS_PER_OBJECT = 3;
/** Höchstzahl der Spurpunkte je Eintrag – VisibilityForecast hält so viele Plätze je Linie vor. */
export const FORECAST_TRACE_MAX_POINTS = 128;
/** Kleinster Abstand der Spurpunkte. */
export const FORECAST_TRACE_MIN_STEP_MS = 5000;
/** Beschriebene Fenster je Shard im Kurz-Scan (`near`). */
export const FORECAST_KEEP_PER_SHARD = 20;
/**
 * Obergrenze, bis zu der der Controller `keep` verdoppelt, wenn ein Shard
 * mehr Treffer hat, als er beschreibt, und der Stand deshalb nie gilt
 * (useVisibilityForecast). Bei höchstens drei Fenstern je Objekt stehen
 * hinter so vielen Treffern immer genug verschiedene Objekte, um die Liste
 * zu füllen.
 */
export const FORECAST_KEEP_MAX_PER_SHARD = 160;
/** Lang-Scan (`far`): je Shard nur das früheste Fenster beschreiben. */
export const FORECAST_FAR_KEEP = 1;

/** Feldreihenfolge des Scratch wie im Telemetrie-Buffer (Offsets 0 … 8, telemetryLayout.ts). */
const SCRATCH_OFFSETS = {
  az: T_AZ,
  el: T_EL,
  range: T_RANGE,
  alt: T_ALT,
  speed: T_SPEED,
  eclipsed: T_ECLIPSED,
  lat: T_LAT,
  lon: T_LON,
  mag: T_MAG,
} as const;

/**
 * Gemeinsamer Zustand eines Scans über viele Objekte: Standort, Zeitraster,
 * die zeitabhängigen Größen je Rasterpunkt und ein Scratch für eine Probe.
 *
 * Jeder Job im Worker hat seinen eigenen Kontext (eigenes Raster, eigener
 * Cache) – nur so lassen sich Kurz- und Lang-Scan verschränken.
 */
export interface ScanContext {
  observer: ObserverGd;
  frame: ObserverFrame;
  fromMs: number;
  toMs: number;
  /**
   * Rasterpunkte `t_g = fromMs + g · FORECAST_STEP_MS`, `g = 0 … gridCount − 1`:
   * der letzte liegt ≤ toMs, der nächste dahinter > toMs. Die Phase hängt an
   * `fromMs`; der Controller legt es aufs absolute Raster
   * (`forecastGridFloor`), damit alle Scans dieselben Punkte sehen.
   */
  gridCount: number;
  /**
   * TickFrame je Rasterpunkt, erst bei Bedarf gebaut. Die Schranke in
   * `scanWindows` überspringt für die meisten Objekte fast alle Punkte; was
   * ein Objekt braucht, haben die vorigen meist schon gebaut.
   */
  frames: Array<TickFrame | undefined>;
  /** Eine Probe im Layout des Telemetrie-Buffers (`TELEMETRY_STRIDE`). */
  scratch: Float32Array;
}

export function createScanContext(
  observer: ObserverGd,
  frame: ObserverFrame,
  fromMs: number,
  toMs: number,
): ScanContext {
  const gridCount = Math.max(0, Math.floor((toMs - fromMs) / FORECAST_STEP_MS) + 1);
  return {
    observer,
    frame,
    fromMs,
    toMs,
    gridCount,
    frames: new Array<TickFrame | undefined>(gridCount).fill(undefined),
    scratch: new Float32Array(TELEMETRY_STRIDE),
  };
}

/**
 * TickFrame des Rasterpunkts `g`, gecacht. `g ≥ gridCount` ist erlaubt – so
 * verfolgt `describeWindow` ein bei `toMs` noch offenes Fenster im selben
 * Raster weiter. Gecacht wird nur fortlaufend, damit das Feld keine Löcher
 * bekommt.
 */
export function tickFrameAt(ctx: ScanContext, g: number): TickFrame {
  const cached = ctx.frames[g];
  if (cached !== undefined) return cached;
  const tick = buildTickFrame(new Date(ctx.fromMs + g * FORECAST_STEP_MS), ctx.observer);
  if (g <= ctx.frames.length) ctx.frames[g] = tick;
  return tick;
}

/**
 * Schreibt wie der Tick (OFFSETS az 0 … mag 8) in `scratch` und prüft
 * passesSkyFilter('nakedEye', false, el, eclipsed > 0.5, mag).
 * −1 = Propagation fehlgeschlagen.
 *
 * Bewusst dieselben Float32-Werte wie im Telemetrie-Buffer: Der Filter in der
 * Szene sieht genau diese, ein Eintrag kippt also im selben Moment.
 */
export function nakedEyeAt(
  satrec: SatRec,
  standardMagnitude: number,
  frame: ObserverFrame,
  tick: TickFrame,
  scratch: Float32Array,
): -1 | 0 | 1 {
  if (!propagateInto(satrec, frame, tick, standardMagnitude, scratch, 0, false, SCRATCH_OFFSETS)) {
    return -1;
  }
  return passesSkyFilter('nakedEye', false, scratch[T_EL], scratch[T_ECLIPSED] > 0.5, scratch[T_MAG])
    ? 1
    : 0;
}

/** Fenster im Raster eines Scans, vor dem Nachschärfen. */
export interface RawWindow {
  /** Erster sichtbarer Rasterpunkt. */
  startIndex: number;
  /** erster unsichtbarer Rasterpunkt danach, −1 = bis toMs sichtbar */
  endIndex: number;
  /** Schon bei `fromMs` sichtbar (`startIndex === 0`). */
  startOpen: boolean;
}

/**
 * Sucht die Sichtfenster eines Objekts im Raster des Kontexts und legt sie in
 * `out` ab (wird zu Beginn geleert, höchstens `FORECAST_MAX_WINDOWS_PER_OBJECT`).
 * Gibt die Zahl der Propagationen zurück.
 *
 * Sicherer Sprung: Ist das Objekt unsichtbar und weiter entfernt als
 * `forecastRangeLimitKm`, kann es frühestens nach `(range − limit) / 11,7` s
 * hell genug werden – die Entfernung ändert sich für jede gebundene Bahn
 * höchstens mit Fluchtgeschwindigkeit plus Erddrehung. Alle Rasterpunkte davor
 * sind beweisbar unsichtbar und werden übersprungen. Die Helligkeitsschranke
 * über `satrec.altp` (Bahnhöhe als Mindestentfernung) brachte zusätzlich nur
 * 15 % und entfiel – dort lauert zudem die Erdradien-Falle (`altp` ist in
 * Erdradien, nicht in km).
 */
export function scanWindows(
  ctx: ScanContext,
  satrec: SatRec,
  standardMagnitude: number,
  out: RawWindow[],
): number {
  out.length = 0;
  const { frame, gridCount, scratch } = ctx;
  const limitKm = forecastRangeLimitKm(standardMagnitude);
  const stepSec = FORECAST_STEP_MS / 1000;
  let samples = 0;
  let inside = false;
  let start = 0;
  let startOpen = false;
  let g = 0;

  while (g < gridCount) {
    const r = nakedEyeAt(satrec, standardMagnitude, frame, tickFrameAt(ctx, g), scratch);
    samples += 1;

    if (r === 1) {
      if (!inside) {
        inside = true;
        start = g;
        startOpen = g === 0;
      }
      g += 1;
      continue;
    }

    if (inside) {
      out.push({ startIndex: start, endIndex: g, startOpen });
      inside = false;
      if (out.length >= FORECAST_MAX_WINDOWS_PER_OBJECT) return samples;
    }

    if (r === 0) {
      // `propagateInto` hat bei Erfolg eine endliche, positive Entfernung geschrieben.
      const rangeKm = scratch[T_RANGE];
      g +=
        rangeKm > limitKm
          ? 1 + Math.floor((rangeKm - limitKm) / FORECAST_RANGE_RATE_KM_S / stepSec)
          : 1;
    } else {
      g += 1;
    }
  }

  if (inside) out.push({ startIndex: start, endIndex: -1, startOpen });
  return samples;
}

/** Zeit des Rasterpunkts `g`. */
function gridTime(ctx: ScanContext, g: number): number {
  return ctx.fromMs + g * FORECAST_STEP_MS;
}

/** TickFrame zu einer beliebigen Zeit – aus dem Cache, wenn sie auf einem Rasterpunkt liegt. */
function tickFrameAtMs(ctx: ScanContext, tMs: number): TickFrame {
  const g = (tMs - ctx.fromMs) / FORECAST_STEP_MS;
  return Number.isInteger(g) && g >= 0 ? tickFrameAt(ctx, g) : buildTickFrame(new Date(tMs), ctx.observer);
}

/**
 * Bisektion zwischen einem Zeitpunkt, an dem die Bedingung gilt (`insideMs`),
 * und einem, an dem sie nicht gilt (`outsideMs`), bis der Abstand ≤
 * `FORECAST_REFINE_MS` ist. Liefert die Seite, an der sie gilt – wie
 * `refineNakedEyeEdge` in propagation.ts, nur feiner. `horizon`: Bedingung
 * „über dem Horizont“ statt „sichtbar“.
 *
 * Je Probe ein eigener TickFrame (≈ 3 µs); bei 5 s Startabstand sind es fünf
 * Proben. Die Mitte wird auf ganze ms gerundet, damit die gelieferte Zeit
 * genau die ist, die geprüft wurde (`Date` schneidet Bruchteile ab).
 */
function refineEdge(
  ctx: ScanContext,
  satrec: SatRec,
  standardMagnitude: number,
  insideMs: number,
  outsideMs: number,
  horizon: boolean,
): number {
  let inside = insideMs;
  let outside = outsideMs;
  while (Math.abs(outside - inside) > FORECAST_REFINE_MS) {
    const mid = Math.round((inside + outside) / 2);
    const r = nakedEyeAt(
      satrec,
      standardMagnitude,
      ctx.frame,
      buildTickFrame(new Date(mid), ctx.observer),
      ctx.scratch,
    );
    const holds = horizon ? r !== -1 && ctx.scratch[T_EL] > 0 : r === 1;
    if (holds) inside = mid;
    else outside = mid;
  }
  return inside;
}

/**
 * Macht aus einem Rasterfenster einen Eintrag: Ränder auf 250 ms, Beginn der
 * Spur, Spurpunkte, Höchststand und Helligkeit. `null`, wenn der Propagator
 * am Anfang der Spur versagt.
 *
 * Teuer im Vergleich zum Scan (rund 100–300 Proben je Fenster, gemessen
 * 1 481 Proben für 8 Fenster samt Aufgang und 96 Spurpunkten, 11 ms), läuft
 * deshalb nur für die `keep` frühesten Fenster eines Shards.
 */
export function describeWindow(
  ctx: ScanContext,
  satrec: SatRec,
  standardMagnitude: number,
  noradId: NoradId,
  raw: RawWindow,
): ForecastEntry | null {
  const { fromMs, frame, scratch } = ctx;
  const std = standardMagnitude;

  /* --- Sichtbeginn --- */
  let startMs: number;
  let startOpen = false;
  // Proben vor `fromMs`, die zu einem schon laufenden Fenster gehören.
  let earlyPeakMagnitude = Number.POSITIVE_INFINITY;
  let earlyMaxElevation = Number.NEGATIVE_INFINITY;
  if (raw.startOpen) {
    // Schon bei fromMs sichtbar: Der echte Beginn liegt davor. Im Raster
    // rückwärts bis zum ersten unsichtbaren Punkt, höchstens
    // `FORECAST_MAX_VISIBLE_MS` weit, dann nachschärfen. Mit `fromMs` als
    // Beginn sprang bei jedem Neuscan während des Überflugs (×1 alle ≈ 90 s)
    // die Unterzeile – „aus“ nannte die aktuelle Richtung, „max“ nur den Rest
    // des Fensters (Frankfurt 07.10.2026 abends, voller Katalog: bei 45 von
    // 59 Einträgen, die einen Neuscan überdauerten) –, und alle laufenden
    // Einträge sortierten sich mit demselben künstlichen Beginn nach NORAD-ID
    // statt nach Sichtbeginn. Offen bleibt der Beginn nur, wenn die Suche am
    // Deckel endet.
    startMs = fromMs;
    startOpen = true;
    for (let t = fromMs - FORECAST_STEP_MS; fromMs - t <= FORECAST_MAX_VISIBLE_MS; t -= FORECAST_STEP_MS) {
      if (nakedEyeAt(satrec, std, frame, buildTickFrame(new Date(t), ctx.observer), scratch) !== 1) {
        startMs = refineEdge(ctx, satrec, std, t + FORECAST_STEP_MS, t, false);
        startOpen = false;
        break;
      }
      if (scratch[T_MAG] < earlyPeakMagnitude) earlyPeakMagnitude = scratch[T_MAG];
      if (scratch[T_EL] > earlyMaxElevation) earlyMaxElevation = scratch[T_EL];
    }
  } else {
    startMs = refineEdge(ctx, satrec, std, gridTime(ctx, raw.startIndex), gridTime(ctx, raw.startIndex - 1), false);
  }

  // Die Probe am Sichtbeginn liefert die Richtung für „aus NW“.
  if (nakedEyeAt(satrec, std, frame, tickFrameAtMs(ctx, startMs), scratch) === -1) return null;
  const startAzimuthDeg = scratch[T_AZ] * RAD;
  let peakMagnitude = scratch[T_MAG];
  let maxElevation = scratch[T_EL];
  // Am Deckel offen: Beginn ist `fromMs`, die Proben davor zählen nicht.
  if (!startOpen) {
    if (earlyPeakMagnitude < peakMagnitude) peakMagnitude = earlyPeakMagnitude;
    if (earlyMaxElevation > maxElevation) maxElevation = earlyMaxElevation;
  }

  /* --- Sichtende --- */
  // Der Deckel zählt ab dem beschriebenen Teil: ab dem Sichtbeginn, bei einem
  // schon laufenden Fenster ab `fromMs` – wie zuvor, als dessen Beginn noch
  // `fromMs` hieß.
  const capFromMs = Math.max(startMs, fromMs);
  let endMs = capFromMs + FORECAST_MAX_VISIBLE_MS;
  let endOpen = false;
  if (raw.endIndex >= 0) {
    endMs = refineEdge(ctx, satrec, std, gridTime(ctx, raw.endIndex - 1), gridTime(ctx, raw.endIndex), false);
  } else {
    // Bis toMs sichtbar: im selben Raster weiter, bis es endet oder der
    // Deckel erreicht ist. Ohne Deckel verfolgte ein geostationäres oder
    // MEO-Objekt seinen Bogen über Stunden; der nächste Scan liefert den Rest.
    for (let g = ctx.gridCount; ; g += 1) {
      const t = gridTime(ctx, g);
      if (t - capFromMs > FORECAST_MAX_VISIBLE_MS) {
        endOpen = true;
        break;
      }
      if (nakedEyeAt(satrec, std, frame, tickFrameAt(ctx, g), scratch) !== 1) {
        endMs = refineEdge(ctx, satrec, std, t - FORECAST_STEP_MS, t, false);
        break;
      }
    }
  }
  if (endMs - capFromMs > FORECAST_MAX_VISIBLE_MS) {
    endMs = capFromMs + FORECAST_MAX_VISIBLE_MS;
    endOpen = true;
  }

  // Rasterproben des Fensters für Höchststand und Helligkeit. Sie liegen alle
  // in [startIndex, endIndex − 1] (das Ende liegt auf der sichtbaren Seite,
  // also ≥ t_{end−1} und < t_end) und sind fast alle schon im Cache.
  for (let g = raw.startIndex; gridTime(ctx, g) <= endMs; g += 1) {
    if (nakedEyeAt(satrec, std, frame, tickFrameAt(ctx, g), scratch) !== 1) continue;
    if (scratch[T_MAG] < peakMagnitude) peakMagnitude = scratch[T_MAG];
    if (scratch[T_EL] > maxElevation) maxElevation = scratch[T_EL];
  }

  /* --- Beginn der Spur --- */
  // Vom Sichtbeginn rückwärts bis zum letzten Rasterpunkt unter dem Horizont –
  // das findet den Aufgang genau des Bogens, zu dem das Fenster gehört, und
  // braucht meist nur 10–40 Proben statt aller Punkte ab fromMs. Immer, auch
  // wenn das Objekt bei fromMs schon über dem Horizont steht: Der Lang-Scan
  // reicht über einen ganzen Umlauf, Punkt 0 kann zum vorigen Bogen gehören.
  // Die Spur begann sonst dort, und das Antippen des Kandidaten richtete die
  // Kamera auf den vorigen Überflug statt auf den Aufgangspunkt (Frankfurt
  // 08.10.2026 03:30Z, SL-3 R/B: Spur ab Az 64°/El 19°, Sichtbeginn 90 min
  // später aus Az 211°). Erst wenn alle Punkte bis g = 0 über dem Horizont
  // liegen, beginnt die Spur bei fromMs.
  let g = raw.startIndex;
  while (g > 0) {
    const r = nakedEyeAt(satrec, std, frame, tickFrameAt(ctx, g - 1), scratch);
    if (r === -1 || scratch[T_EL] <= 0) break;
    g -= 1;
  }
  let traceStartMs = fromMs;
  if (g > 0) {
    traceStartMs = refineEdge(ctx, satrec, std, gridTime(ctx, g), gridTime(ctx, g - 1), true);
    // Beide Ränder sind auf 250 ms genau; liegen Aufgang und Sichtbeginn im
    // selben Rasterintervall, könnte die Reihenfolge sonst kippen.
    if (traceStartMs > startMs) traceStartMs = startMs;
  }

  /* --- Spurpunkte --- */
  const spanMs = endMs - traceStartMs;
  let stepMs = Math.max(
    FORECAST_TRACE_MIN_STEP_MS,
    Math.ceil(spanMs / (FORECAST_TRACE_MAX_POINTS - 1) / 1000) * 1000,
  );
  let count = Math.floor(spanMs / stepMs) + 2;
  // Grenzfall: Ist die Spanne genau ein Vielfaches von 127 s, ergäbe die
  // Formel 129 Punkte – einen mehr, als VisibilityForecast Plätze hat.
  if (count > FORECAST_TRACE_MAX_POINTS) {
    stepMs += 1000;
    count = Math.floor(spanMs / stepMs) + 2;
  }

  const points = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const t = traceStartMs + i * stepMs;
    const base = i * 3;
    if (nakedEyeAt(satrec, std, frame, tickFrameAtMs(ctx, t), scratch) === -1) {
      // Ohne Anfang keine Spur; mitten in der Spur hält der vorige Punkt die Linie zusammen.
      if (i === 0) return null;
      points[base] = points[base - 3];
      points[base + 1] = points[base - 2];
      points[base + 2] = points[base - 1];
      continue;
    }
    // Konvention wie buildTrail im Worker: x Ost, y Zenit, −z Nord.
    const az = scratch[T_AZ];
    const el = scratch[T_EL];
    const cosEl = Math.cos(el);
    points[base] = cosEl * Math.sin(az);
    points[base + 1] = Math.sin(el);
    points[base + 2] = -cosEl * Math.cos(az);
    if (t >= startMs && t <= endMs) {
      if (scratch[T_MAG] < peakMagnitude) peakMagnitude = scratch[T_MAG];
      if (el > maxElevation) maxElevation = el;
    }
  }

  return {
    noradId,
    traceStartMs,
    startMs,
    startOpen,
    endMs,
    endOpen,
    stepMs,
    points,
    peakMagnitude: Number.isFinite(peakMagnitude) ? peakMagnitude : INVISIBLE_MAGNITUDE,
    maxElevationDeg: maxElevation * RAD,
    startAzimuthDeg,
  };
}
