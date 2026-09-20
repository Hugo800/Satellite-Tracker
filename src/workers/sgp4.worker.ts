/// <reference lib="webworker" />
/**
 * SGP4-Worker.
 *
 * Verantwortlich für: TLE-Abruf, Katalogaufbau, kontinuierliche Propagation
 * tausender Satelliten, Erdschatten-Klassifikation, Bahnspuren und
 * Überflug-Vorhersagen. Der Main-Thread erhält ausschließlich flache
 * Float32Array-Buffer (transferable) – kein Objekt-Churn, kein GC-Stottern.
 */
import { twoline2satrec } from 'satellite.js';
import type { SatRec } from 'satellite.js';
import { FALLBACK_TLE, HIGHLIGHT_NORAD_IDS, TLE_SOURCES } from '../data/tleSources';
import { geoToObserverGd, normalizeAngle } from '../math/coords';
import { observerEciPosition, predictPasses, propagateEphemeris } from '../math/propagation';
import { sunEciUnitVector } from '../math/sun';
import { standardMagnitudeFor } from '../math/visibility';
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
} from '../math/telemetryLayout';
import type {
  GeoCoord,
  ObserverGd,
  SatelliteGroup,
  SatelliteMeta,
  WorkerRequest,
  WorkerResponse,
} from '../types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

interface Entry {
  meta: SatelliteMeta;
  satrec: SatRec;
}

const entries: Entry[] = [];
let observer: ObserverGd | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let timeScale = 1;
let virtualTimeMs = Date.now();
let lastRealMs = Date.now();

/** Gestaffelte Wartezeiten, bis gedrosselte CelesTrak-Gruppen erneut versucht werden. */
const RETRY_DELAYS_MS = [45_000, 3 * 60_000, 10 * 60_000];
let retryStep = 0;
/** Abstand zwischen zwei Gruppenabrufen – hält uns unter dem Rate-Limit. */
const GROUP_GAP_MS = 1500;

function post(message: WorkerResponse, transfer?: Transferable[]): void {
  ctx.postMessage(message, transfer ?? []);
}

/* ------------------------------------------------------------------ */
/* Katalog                                                              */
/* ------------------------------------------------------------------ */

function parseTle(text: string, group: SatelliteGroup, limit: number): void {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  // Mengen-Lookup statt linearer Suche: Starlink allein bringt einige tausend
  // Sätze mit, ein `some()` pro Zeile wäre quadratisch.
  const knownIds = new Set(entries.map((e) => e.meta.noradId));

  let added = 0;
  for (let i = 0; i + 2 < lines.length && added < limit; i += 3) {
    const name = lines[i];
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!name || !l1 || !l2 || !l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;

    const noradId = l1.slice(2, 7).trim();
    if (knownIds.has(noradId)) continue;

    let satrec: SatRec;
    try {
      satrec = twoline2satrec(l1, l2);
    } catch {
      continue;
    }
    if (!satrec || (satrec as unknown as { error?: number }).error) continue;

    const meanMotionRadMin = satrec.no;
    const periodMin = meanMotionRadMin > 0 ? (2 * Math.PI) / meanMotionRadMin : 0;

    knownIds.add(noradId);
    entries.push({
      satrec,
      meta: {
        index: entries.length,
        name: name.trim(),
        noradId,
        group,
        highlight: HIGHLIGHT_NORAD_IDS.has(noradId),
        periodMin,
        inclinationDeg: (satrec.inclo * 180) / Math.PI,
        standardMagnitude: standardMagnitudeFor(noradId, group),
      },
    });
    added += 1;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isTleBody = (text: string) => text.includes('\n1 ') && text.includes('\n2 ');

const TLE_CACHE = 'tle-raw-v1';

async function readCachedTle(url: string): Promise<string> {
  try {
    const cache = await caches.open(TLE_CACHE);
    const hit = await cache.match(url);
    return hit ? await hit.text() : '';
  } catch {
    return '';
  }
}

async function writeCachedTle(url: string, text: string): Promise<void> {
  try {
    const cache = await caches.open(TLE_CACHE);
    await cache.put(url, new Response(text, { headers: { 'content-type': 'text/plain' } }));
  } catch {
    /* CacheStorage nicht verfügbar (z. B. unsicherer Kontext) – kein Problem. */
  }
}

/**
 * CelesTrak beantwortet einen erneuten Abruf innerhalb des 2-Stunden-Update-
 * Intervalls mit HTTP 403 („GP data has not updated…“). Das ist kein Fehler,
 * sondern die Aufforderung, die zuletzt geladene Fassung weiterzuverwenden –
 * deshalb halten wir jede erfolgreiche Antwort selbst in der CacheStorage.
 */
async function fetchTle(source: (typeof TLE_SOURCES)[SatelliteGroup]): Promise<string> {
  let lastError = 'unbekannt';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(1500 * attempt);
    try {
      const res = await fetch(source.url, {
        mode: 'cors',
        cache: 'default',
        signal: AbortSignal.timeout(source.timeoutMs),
      });

      if (res.status === 403 || res.status === 429) {
        const cached = await readCachedTle(source.url);
        if (isTleBody(cached)) return cached;
        lastError = 'Update-Intervall aktiv, keine zwischengespeicherte Fassung';
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!isTleBody(text)) throw new Error('Unerwartetes Format');
      await writeCachedTle(source.url, text);
      return text;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  const cached = await readCachedTle(source.url);
  if (isTleBody(cached)) return cached;
  throw new Error(lastError);
}

/**
 * Lädt Gruppen nach. Ohne `reset` werden vorhandene Einträge beibehalten –
 * die Telemetrie-Indizes (und damit Auswahl und Spuren im Main-Thread)
 * bleiben dabei stabil.
 */
async function loadGroups(groups: SatelliteGroup[], reset: boolean): Promise<void> {
  if (reset) {
    entries.length = 0;
    // Sofort etwas Sichtbares: Kernobjekte aus dem eingebauten Katalog. Sie
    // werden verworfen, sobald die erste echte Gruppe eintrifft.
    parseTle(FALLBACK_TLE, 'stations', 64);
    post({ type: 'catalog', catalog: entries.map((e) => e.meta) });
  }
  post({ type: 'status', message: 'Lade TLE-Kataloge …', loading: true });

  const failed: SatelliteGroup[] = [];
  let seedReplaced = !reset;

  for (const group of groups) {
    const source = TLE_SOURCES[group];
    try {
      const text = await fetchTle(source);
      if (!seedReplaced) {
        entries.length = 0;
        seedReplaced = true;
      }
      parseTle(text, group, source.limit);
      post({
        type: 'status',
        message: `${source.label}: ${entries.length} Objekte`,
        loading: true,
      });
      post({ type: 'catalog', catalog: entries.map((e) => e.meta) });
    } catch (err) {
      failed.push(group);
      post({
        type: 'error',
        message: `${source.label} noch nicht verfügbar – ${(err as Error).message}. Wird automatisch nachgeladen.`,
      });
    }
    // Abstand zwischen den Gruppen hält uns unter dem Rate-Limit.
    await sleep(GROUP_GAP_MS);
  }

  if (entries.length === 0) {
    parseTle(FALLBACK_TLE, 'stations', 64);
    post({ type: 'error', message: 'Offline-Fallback aktiv – nur Kernobjekte verfügbar.' });
  }

  post({ type: 'catalog', catalog: entries.map((e) => e.meta) });
  post({ type: 'status', message: `${entries.length} Objekte im Katalog`, loading: false });

  // CelesTrak gibt Gruppen erst nach Ablauf des Update-Intervalls wieder frei;
  // ein späterer Versuch holt sie nach, ohne den Nutzer zu behelligen.
  if (failed.length > 0) {
    if (retryTimer === null) {
      const delay = RETRY_DELAYS_MS[Math.min(retryStep, RETRY_DELAYS_MS.length - 1)];
      retryStep += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void loadGroups(failed, false);
      }, delay);
    }
  } else {
    retryStep = 0;
  }
}

function loadCatalog(groups: SatelliteGroup[]): Promise<void> {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryStep = 0;
  return loadGroups(groups, true);
}

/* ------------------------------------------------------------------ */
/* Propagations-Schleife                                                */
/* ------------------------------------------------------------------ */

function tick(): void {
  if (!observer || entries.length === 0) return;

  const nowReal = Date.now();
  virtualTimeMs += (nowReal - lastRealMs) * timeScale;
  lastRealMs = nowReal;

  const date = new Date(virtualTimeMs);
  const sunUnit = sunEciUnitVector(date);
  const observerEci = observerEciPosition(observer, date);
  const buffer = new Float32Array(entries.length * TELEMETRY_STRIDE);

  for (let i = 0; i < entries.length; i += 1) {
    const base = i * TELEMETRY_STRIDE;
    const entry = entries[i];
    const eph = propagateEphemeris(entry.satrec, date, observer, sunUnit, {
      observerEci,
      standardMagnitude: entry.meta.standardMagnitude,
    });
    if (!eph) {
      buffer[base + T_EL] = -Math.PI / 2;
      buffer[base + T_RANGE] = Number.NaN;
      continue;
    }
    buffer[base + T_AZ] = eph.azimuth;
    buffer[base + T_EL] = eph.elevation;
    buffer[base + T_RANGE] = eph.rangeKm;
    buffer[base + T_ALT] = eph.altitudeKm;
    buffer[base + T_SPEED] = eph.speedKmS;
    buffer[base + T_ECLIPSED] = eph.eclipsed ? 1 : 0;
    buffer[base + T_LAT] = eph.latitudeDeg;
    buffer[base + T_LON] = eph.longitudeDeg;
    buffer[base + T_MAG] = eph.magnitude;
  }

  post({ type: 'tick', time: virtualTimeMs, count: entries.length, buffer: buffer.buffer }, [
    buffer.buffer,
  ]);
}

/* ------------------------------------------------------------------ */
/* Bahnspur                                                             */
/* ------------------------------------------------------------------ */

function buildTrail(index: number, fromMin: number, toMin: number, samples: number): void {
  const entry = entries[index];
  if (!entry || !observer || samples < 2) return;

  const points = new Float32Array(samples * 3);
  const spanMs = (toMin - fromMin) * 60_000;
  const sunUnit = sunEciUnitVector(new Date(virtualTimeMs));

  for (let i = 0; i < samples; i += 1) {
    const t = virtualTimeMs + fromMin * 60_000 + (spanMs * i) / (samples - 1);
    const eph = propagateEphemeris(entry.satrec, new Date(t), observer, sunUnit);
    if (!eph) continue;
    const az = normalizeAngle(eph.azimuth);
    const cosEl = Math.cos(eph.elevation);
    points[i * 3 + 0] = cosEl * Math.sin(az);
    points[i * 3 + 1] = Math.sin(eph.elevation);
    points[i * 3 + 2] = -cosEl * Math.cos(az);
  }

  post({ type: 'trail', index, points }, [points.buffer]);
}

/* ------------------------------------------------------------------ */
/* Nachrichten                                                          */
/* ------------------------------------------------------------------ */

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'load':
      void loadCatalog(msg.groups);
      break;

    case 'observer':
      observer = geoToObserverGd(msg.observer as GeoCoord);
      break;

    case 'start':
      if (timer !== null) clearInterval(timer);
      lastRealMs = Date.now();
      timer = setInterval(tick, msg.intervalMs);
      tick();
      break;

    case 'stop':
      if (timer !== null) clearInterval(timer);
      timer = null;
      break;

    case 'timeScale':
      // Zurück auf Echtzeit heißt: wieder auf die Wanduhr aufsetzen. Sonst
      // behielte die Szene den Vorlauf, den der Zeitraffer angesammelt hat.
      if (msg.value === 1) virtualTimeMs = Date.now();
      lastRealMs = Date.now();
      timeScale = msg.value;
      break;

    case 'trail':
      buildTrail(msg.index, msg.fromMin, msg.toMin, msg.samples);
      break;

    case 'pass': {
      const entry = entries[msg.index];
      if (!entry || !observer) {
        post({ type: 'pass', index: msg.index, passes: [] });
        break;
      }
      const passes = predictPasses(entry.satrec, observer, {
        fromMs: virtualTimeMs,
        searchHours: msg.searchHours,
        stepSec: 30,
        minElevationDeg: 1,
        standardMagnitude: entry.meta.standardMagnitude,
      });
      post({ type: 'pass', index: msg.index, passes });
      break;
    }
  }
};
