/**
 * Misst die Layout-Zusagen der Karte „Demnächst sichtbar“ (ForecastList.tsx,
 * Hud.tsx) in echtem, headless Chrome über das DevTools-Protokoll – das, was
 * `npm run verify:forecast` (Abschnitt T6) im Mini-DOM nur an den Klassen
 * ablesen kann. Telefon hochkant 393×852 und 320×568 (die schmalste Breite,
 * bei der der Karte neben dem Radar nur 122 px bleiben):
 *
 *   a) Kopfzeile: einzeilig (der Zeitfenster-Knopf bricht nicht um), drei
 *      Zeilen der Liste passen ganz in die 164 px hohe Karte.
 *   b) Trefferfläche des Zeitfenster-Knopfs: kein Punkt über oder neben der
 *      Karte gehört dem Knopf oder der Karte (elementFromPoint-Raster im
 *      0,5-px-Schritt), die Fläche liegt ganz in der Kopfzeile und füllt deren
 *      Höhe, die erste Zeile der Liste bleibt frei; ein Tap 6 px über der
 *      Karte erreicht das Canvas (pointerdown dort, Fenster unverändert), ein
 *      Tap in die Ecke rechts oben der Karte schaltet das Fenster.
 *   c) Ausblick-Zeile „Nächster: NAME“: jeder Name bis 15 Zeichen ist ganz zu
 *      lesen (je Zeichen per Range.getBoundingClientRect gegen das kürzende
 *      Element gemessen), die Zeile bricht zwischen Vorsatz und Name um statt
 *      zu kürzen; bei 393 px bleiben kurze Namen einzeilig; nichts ragt oben
 *      aus dem Listenkörper, ein Überlauf geht nur nach unten und ist dort
 *      scrollbar.
 *   d) Screenshots der Karte (Ausschnitt) mit drei Zeilen und mit Kandidat.
 *
 * Der Stand der Vorhersage wird nicht gerechnet, sondern gesetzt: Bei ×600
 * ruht der Controller (useVisibilityForecast, kein Intervall), danach bleibt
 * ein per `deriveForecastView` geschriebener Stand samt `bumpForecastRevision()`
 * stehen (Rezept aus der Review-Runde 2, 09.10.2026). Ein Tap auf den
 * Zeitfenster-Knopf lässt den Effekt des Controllers neu laufen, der den Stand
 * mit „Vorhersage ruht“ überschreibt – danach wird neu gesetzt.
 *
 * Läuft NICHT in `npm test`: Es braucht einen laufenden Vite-Dev-Server und
 * einen headless Chrome mit Remote-Debugging-Port, wie
 * scripts/verify-timemachine-layout.ts (Vorgehen und Fallen:
 * ~/Git/agent/docs/headless-chrome-layout-messung.md):
 *
 *   1. `npx vite --port 5189 --strictPort` (oder VITE_PORT setzen)
 *   2. Chrome headless mit `--remote-debugging-port=9333` (oder CDP_PORT),
 *      `--use-angle=swiftshader --enable-unsafe-swiftshader` und
 *      `--host-resolver-rules="MAP celestrak.org ~NOTFOUND"` – der Katalog ist
 *      hier egal (die vier Offline-Platzhalter reichen, Namen kommen aus dem
 *      gesetzten Stand), aber ohne die Regel wartet der Lauf auf das Netz.
 *
 * Bündeln und starten wie die übrigen `verify:*`-Skripte:
 *   esbuild scripts/verify-forecast-layout.ts --bundle --platform=node \
 *     --format=esm --outfile=node_modules/.cache/verify-forecast-layout.mjs \
 *     --log-level=warning && node node_modules/.cache/verify-forecast-layout.mjs
 *
 * Umgebungsvariablen: CDP_PORT, VITE_PORT, FORECAST_LAYOUT_OUT_DIR (Ergebnis-JSON
 * und Screenshots, Vorgabe `.`).
 */
import { writeFileSync } from 'node:fs';

const CDP_PORT = process.env.CDP_PORT ?? '9333';
const VITE_PORT = process.env.VITE_PORT ?? '5189';
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
// localhost statt 127.0.0.1: `vite --port` bindet ohne `--host` nur IPv6.
const APP = `http://localhost:${VITE_PORT}/`;
const OUT_DIR = process.env.FORECAST_LAYOUT_OUT_DIR ?? '.';

/** Namen bis 15 Zeichen – die Ausblick-Zeile muss jeden ganz zeigen (§8.5 der Spezifikation). */
const NEXT_NAMES = ['ISS (ZARYA)', 'HST', 'SL-16 R/B', 'NORAD 49271', 'ARIANE 40 R/B', 'STARLINK-31234', 'COSMOS 2219 DEB'];
/** Kurze Namen, die bei 393 px neben „Nächster:“ in eine Zeile passen. */
const SHORT_NAMES = ['ISS (ZARYA)', 'HST'];

/* ------------------------------------------------------------------ */
/* Minimaler CDP-Client über WebSocket (node 22 global)                 */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

async function connectCdp(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP-WebSocket-Fehler')), { once: true });
  });
  let id = 0;
  const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  ws.addEventListener('message', (ev: MessageEvent) => {
    const msg = JSON.parse(ev.data as string) as { id?: number; result?: Json; error?: unknown };
    if (msg.id === undefined || !pending.has(msg.id)) return;
    const entry = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) entry?.reject(new Error(JSON.stringify(msg.error)));
    else entry?.resolve(msg.result ?? {});
  });
  function send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    const myId = ++id;
    const payload: Json = { id: myId, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(myId);
        reject(new Error(`CDP ${method}: keine Antwort nach 60 s`));
      }, 60_000);
      pending.set(myId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify(payload));
    });
  }
  return { send };
}

/* ------------------------------------------------------------------ */
/* Kleine Testinfrastruktur, wie in den übrigen verify:*-Skripten       */
/* ------------------------------------------------------------------ */

let checks = 0;
let failures = 0;
const results: Array<{ label: string; ok: boolean; detail: string }> = [];
function expect(label: string, ok: boolean, detail: string): void {
  checks += 1;
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${detail}`);
  if (!ok) failures += 1;
}
function note(label: string, detail: string): void {
  console.log(`  · ${label}: ${detail}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const f = (v: number, digits = 1): string => v.toFixed(digits).replace('.', ',');
const js = (s: string) => JSON.stringify(s);

/* ------------------------------------------------------------------ */
/* Seitenseitige Hilfen (einmal pro Seite installiert)                  */
/* ------------------------------------------------------------------ */

// Store, Engine, forecastView und deriveForecastView derselben Modulinstanz
// wie die App: Vite hängt `?v=<hash>` an, ein Import ohne liefert eine
// zweite, leere Instanz (Falle laut headless-chrome-layout-messung.md).
// `setView` schreibt einen Stand mit `rows` Einträgen und – wenn `nextName`
// gesetzt ist – leerer Liste samt Kandidat; `geometry` tastet die Umgebung
// der Karte ab; `visibleChars` zählt die lesbaren Zeichen des Namens in der
// Ausblick-Zeile.
const PAGE_SETUP = `(async () => {
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  const find = (path) => names.find((n) => n.includes(path + '?')) || path;
  const store = await import(find('/src/state/store.ts'));
  const eng = await import(find('/src/hooks/useSatelliteEngine.ts'));
  const runtime = await import(find('/src/state/runtime.ts'));
  const view = await import(find('/src/state/forecastView.ts'));
  const T = (window.__fl = { store, engine: eng.engine, runtime, view, events: [] });
  T.st = () => store.useAppStore.getState();
  for (const t of ['pointerdown', 'pointerup', 'click']) {
    window.addEventListener(t, (e) => T.events.push(t + ':' + e.target.tagName), true);
  }
  T.card = () => document.querySelector('[aria-label^="Zeitfenster"]')?.closest('.material') ?? null;
  T.windowButton = () => document.querySelector('[aria-label^="Zeitfenster"]');
  T.nextButton = () => document.querySelector('button[aria-label^="Nächster"]');
  T.entry = (id, startS, endS, az) => ({
    noradId: id, traceStartMs: 0, startMs: 0, startOpen: false, endMs: 0, endOpen: false, stepMs: 60000,
    points: new Float32Array([0, 0.5, -0.8, 0, 0.6, -0.7]), peakMagnitude: 2, maxElevationDeg: 40, startAzimuthDeg: az,
    _s: startS, _e: endS,
  });
  T.setView = (rows, nextName) => {
    const now = store.virtualNow();
    const W = 600000;
    const fix = (e) => ({ ...e, traceStartMs: now + e._s * 1000 - 120000, startMs: now + e._s * 1000, endMs: now + e._e * 1000 });
    const entries = nextName ? [] : rows.map((r, i) => fix(T.entry(r.id, 60 + i * 150, 400 + i * 150, 45 * (i + 1))));
    const committed = { requestId: 1, fromMs: now - 10000, toMs: now + W + 120000, completeUntilMs: now + W + 120000, entries, complete: true };
    const far = nextName
      ? { requestId: 2, fromMs: now + W, toMs: now + 6000000, entry: fix(T.entry('49271', 76 * 60, 80 * 60, 225)), complete: true }
      : null;
    const lookup = (id) => {
      if (nextName) return { name: nextName, highlight: false };
      const r = rows.find((x) => x.id === id);
      return r ? { name: r.name, highlight: !!r.highlight } : null;
    };
    view.deriveForecastView('ready', committed, nextName ? 'ready' : 'idle', far, now, W, 1, lookup, runtime.forecastView);
    store.useAppStore.getState().bumpForecastRevision();
    return runtime.forecastView.slots.map((s) => s.name);
  };
  T.geometry = () => {
    const btn = T.windowButton();
    const card = T.card();
    if (!btn || !card) return null;
    const cr = card.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const hr = btn.parentElement.getBoundingClientRect();
    const rows = [...card.querySelectorAll('button.h-11')].map((b) => b.getBoundingClientRect());
    const belongs = (el) => el !== null && (el === btn || card.contains(el));
    let skyProbes = 0;
    const skyHits = [];
    // Ab 1 px über der Kante: Bei 0,5 px trifft die Rundung auf Gerätepixel
    // noch den Rand der Karte selbst.
    for (let y = cr.top - 25; y <= cr.top - 1; y += 0.5) {
      for (let x = cr.left - 10; x <= cr.right + 10; x += 1) {
        skyProbes += 1;
        const el = document.elementFromPoint(x, y);
        if (belongs(el)) skyHits.push([x, +(cr.top - y).toFixed(1), el === btn ? 'BUTTON' : el.tagName]);
      }
    }
    for (let y = cr.top; y <= hr.bottom; y += 0.5) {
      for (let x = cr.right + 0.5; x <= cr.right + 10; x += 1) {
        skyProbes += 1;
        if (document.elementFromPoint(x, y) === btn) skyHits.push([x, +(cr.top - y).toFixed(1), 'BUTTON rechts']);
      }
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let y = cr.top - 30; y <= hr.bottom + 10; y += 0.5) {
      for (let x = cr.left - 5; x <= cr.right + 15; x += 0.5) {
        if (document.elementFromPoint(x, y) === btn) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    let rowStolen = 0;
    for (let x = cr.left + 2; x <= cr.right - 2; x += 1) if (document.elementFromPoint(x, hr.bottom + 0.5) === btn) rowStolen += 1;
    // Liegt die Kopfzeile wirklich frei im Bild? Der Hud-Container beschneidet
    // (overflow-hidden), was über seine Oberkante ragt – dann träfe kein Tap.
    const headerHit = document.elementFromPoint((cr.left + cr.right) / 2, cr.top + 5);
    return {
      card: { left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom, width: cr.width, height: cr.height },
      header: { top: hr.top, bottom: hr.bottom, height: hr.height },
      headerVisible: headerHit !== null && card.contains(headerHit),
      btn: { left: br.left, top: br.top, width: br.width, height: br.height, cx: br.left + br.width / 2 },
      // null, wenn kein Rasterpunkt den Knopf trifft (JSON kennt kein Infinity).
      hitBox: maxX < minX ? null : { left: minX, right: maxX, top: minY, bottom: maxY, width: maxX - minX + 0.5, height: maxY - minY + 0.5 },
      rows: rows.map((r) => ({ top: r.top, bottom: r.bottom, height: r.height })),
      skyProbes, skyHits: skyHits.length, skySample: skyHits.slice(0, 4), rowStolen,
    };
  };
  T.visibleChars = (name) => {
    const btn = T.nextButton();
    if (!btn) return { error: 'kein Nächster-Knopf' };
    const card = btn.closest('.material');
    const line = btn.firstElementChild;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node = null;
    let offset = -1;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent.indexOf(name);
      if (i >= 0) { node = n; offset = i; break; }
    }
    if (!node) return { error: 'Name nicht im Text: ' + line.textContent };
    const clipEl = node.parentElement;
    const clip = clipEl.getBoundingClientRect();
    const overflowing = clipEl.scrollWidth > clipEl.clientWidth + 0.5;
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
    probe.style.font = getComputedStyle(clipEl).font;
    probe.textContent = '…';
    document.body.appendChild(probe);
    const ellipsisW = probe.getBoundingClientRect().width;
    probe.remove();
    const limit = overflowing ? clip.right - ellipsisW + 0.5 : clip.right + 0.5;
    const range = document.createRange();
    let visible = 0;
    for (let i = 0; i < name.length; i += 1) {
      range.setStart(node, offset + i);
      range.setEnd(node, offset + i + 1);
      const r = range.getBoundingClientRect();
      // Leerzeichen am Zeilenende haben keine Breite – zählen mit.
      const inside = r.left >= clip.left - 0.5 && r.right <= limit && r.top >= clip.top - 0.5 && r.bottom <= clip.bottom + 0.5;
      if (inside || (name[i] === ' ' && r.width === 0)) visible += 1;
      else break;
    }
    const lineHeight = parseFloat(getComputedStyle(line).lineHeight) || 16;
    const br = btn.getBoundingClientRect();
    const body = btn.parentElement.parentElement; // Spalte → scrollender Körper
    const bodyRect = body.getBoundingClientRect();
    const detail = btn.lastElementChild.getBoundingClientRect();
    return {
      visible, length: name.length,
      lines: Math.round(line.getBoundingClientRect().height / lineHeight),
      cardWidth: card.getBoundingClientRect().width,
      topInside: br.top >= bodyRect.top - 0.5,
      detailBottom: detail.bottom, bodyBottom: bodyRect.bottom,
      scrollable: body.scrollHeight > body.clientHeight + 0.5,
      // Toleranz 1 px: scrollHeight ist ganzzahlig, der Überlauf nicht (gemessen
      // 7,8 px Überlauf, 7 px Scrollweg – der Rest ist Rundung, kein Inhalt).
      scrolledToDetail: (() => { body.scrollTop = body.scrollHeight; const d = btn.lastElementChild.getBoundingClientRect(); const ok = d.bottom <= body.getBoundingClientRect().bottom + 1; body.scrollTop = 0; return ok; })(),
    };
  };
  return true;
})()`;

const ROWS = [
  { id: '25544', name: 'ISS (ZARYA)', highlight: true },
  { id: '22285', name: 'SL-16 R/B' },
  { id: '20443', name: 'ARIANE 40 R/B' },
];

async function main(): Promise<void> {
  let version: { webSocketDebuggerUrl: string };
  try {
    version = (await fetch(`${CDP_BASE}/json/version`).then((r) => r.json())) as { webSocketDebuggerUrl: string };
  } catch (err) {
    console.error(
      `Kein headless Chrome unter ${CDP_BASE} erreichbar (${(err as Error).message}). ` +
        'Erst starten, siehe Kopfkommentar dieser Datei.',
    );
    process.exit(1);
  }
  const cdp = await connectCdp(version.webSocketDebuggerUrl);
  const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
  await cdp.send('Target.activateTarget', { targetId });
  const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
  const S = (method: string, params: Json = {}) => cdp.send(method, params, sessionId);
  await S('Page.enable');
  await S('Runtime.enable');
  await S('Page.bringToFront');
  await S('Browser.grantPermissions', { origin: APP.replace(/\/$/, ''), permissions: ['geolocation'] });
  await S('Emulation.setGeolocationOverride', { latitude: 50.11, longitude: 8.68, accuracy: 10 });

  async function ev<T>(expression: string): Promise<T> {
    const res = (await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
      exceptionDetails?: { exception?: { description?: string } };
      result: { value: T };
    };
    if (res.exceptionDetails) {
      throw new Error(`JS-Fehler: ${res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result.value;
  }
  async function viewport(w: number, h: number): Promise<void> {
    await S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await S('Emulation.setTouchEmulationEnabled', { enabled: true });
    await sleep(400);
  }
  async function tap(x: number, y: number): Promise<void> {
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(400);
  }
  async function screenshotCard(name: string): Promise<void> {
    const r = await ev<{ x: number; y: number; w: number; h: number } | null>(
      `(() => { const c = window.__fl.card(); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left - 4, y: r.top - 4, w: r.width + 8, h: r.height + 8 }; })()`,
    );
    if (!r) {
      note('Screenshot', `${name}: keine Karte`);
      return;
    }
    const res = (await S('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 2 } })) as { data: string };
    const path = `${OUT_DIR}/vorhersage-karte-${name}.png`;
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    note('Screenshot', path);
  }
  /** Stand setzen: Zeilen, oder leere Liste mit Kandidat `nextName`. */
  async function setView(nextName: string | null): Promise<string[]> {
    const names = await ev<string[]>(`window.__fl.setView(${JSON.stringify(ROWS)}, ${nextName === null ? 'null' : js(nextName)})`);
    await sleep(400);
    return names;
  }

  console.log('--- Seite laden ---');
  await viewport(393, 852);
  await S('Page.navigate', { url: APP });
  await sleep(2500);
  await ev(PAGE_SETUP);
  let loading = true;
  let catalogSize = 0;
  for (let i = 0; i < 90; i += 1) {
    ({ loading, catalogSize } = await ev<{ loading: boolean; catalogSize: number }>(
      '({ loading: window.__fl.st().loading, catalogSize: window.__fl.st().catalog.length })',
    ));
    if (!loading && catalogSize > 0) break;
    await sleep(1000);
  }
  expect('Katalog fertig geladen (Platzhalter reichen)', !loading && catalogSize > 0, `${catalogSize} Objekte, loading=${loading}`);
  // Ladehinweise („… noch nicht verfügbar“) aus der TopBar nehmen: Jede
  // Hinweiszeile schiebt den Hud-Container nach unten, der die Karte bei
  // 320 × 568 px sonst oben beschneidet (overflow-hidden) – gemessen würde
  // dann eine Karte, die kein Tap erreicht. Filter „Sichtbar“, nichts
  // gewählt, ×600: Der Controller ruht und lässt den gleich gesetzten Stand
  // stehen.
  await ev(`(() => { const s = window.__fl.st(); window.__fl.store.useAppStore.setState({ errors: [], geoError: null }); s.setMode('nakedEye'); s.select(null); s.setForecastWindow(10); window.__fl.engine.setTimeScale(600); })()`);
  await sleep(800);
  expect('Karte „Demnächst sichtbar“ im Bild', await ev<boolean>('!!window.__fl.card()'), `Modus ${await ev<string>('window.__fl.st().filters.mode')}`);

  const report: Record<string, unknown> = {};
  for (const [w, h] of [
    [393, 852],
    [320, 568],
  ] as const) {
    const k = `${w} px`;
    console.log(`\n=== ${k} ===`);
    await viewport(w, h);
    await sleep(600);
    const rows = await setView(null);
    note('Zeilen gesetzt', rows.join(', '));

    /* a) Kopfzeile und Zeilen */
    const geo = await ev<{
      card: { left: number; top: number; right: number; bottom: number; width: number; height: number };
      header: { top: number; bottom: number; height: number };
      headerVisible: boolean;
      btn: { left: number; top: number; width: number; height: number; cx: number };
      hitBox: { left: number; right: number; top: number; bottom: number; width: number; height: number } | null;
      rows: Array<{ top: number; bottom: number; height: number }>;
      skyProbes: number;
      skyHits: number;
      skySample: unknown[];
      rowStolen: number;
    } | null>('window.__fl.geometry()');
    if (!geo) throw new Error('Karte oder Zeitfenster-Knopf nicht gefunden');
    const headerH = geo.header.bottom - geo.card.top;
    expect(
      `${k}: Kopfzeile einzeilig und frei im Bild, drei Zeilen ganz in der Karte`,
      geo.headerVisible && headerH <= 30 && geo.rows.length === 3 && geo.rows.every((r) => r.bottom <= geo.card.bottom + 0.5 && r.height >= 43.5),
      `Karte ${f(geo.card.width)} × ${f(geo.card.height)} px bei y ${f(geo.card.top)}–${f(geo.card.bottom)} px, Kopfzeile ${f(headerH)} px${geo.headerVisible ? '' : ' (VERDECKT oder beschnitten)'}, ` +
        `Zeilen ${geo.rows.map((r) => `${f(r.top - geo.card.top)}–${f(r.bottom - geo.card.top)}`).join(', ')} px unter der Oberkante`,
    );

    /* b) Trefferfläche */
    expect(
      `${k}: kein Punkt über oder neben der Karte gehört Knopf oder Karte`,
      geo.skyHits === 0,
      `${geo.skyHits} von ${geo.skyProbes} Proben im Himmel treffen Karte oder Knopf${geo.skyHits ? ` (z. B. ${JSON.stringify(geo.skySample)})` : ''}`,
    );
    const hit = geo.hitBox;
    expect(
      `${k}: Trefferfläche liegt ganz in der Kopfzeile, füllt deren Höhe, erste Zeile bleibt frei`,
      hit !== null && hit.top >= geo.card.top - 0.25 && hit.bottom <= geo.header.bottom + 0.25 && hit.right <= geo.card.right + 0.25 &&
        hit.height >= headerH - 2 && geo.rowStolen === 0,
      hit === null
        ? `Knopf ${f(geo.btn.width)} × ${f(geo.btn.height)} px, aber kein Rasterpunkt trifft ihn`
        : `Knopf ${f(geo.btn.width)} × ${f(geo.btn.height)} px, Trefferfläche ${f(hit.width)} × ${f(hit.height)} px ` +
          `ab ${f(hit.top - geo.card.top)} px unter der Kartenoberkante (Kopfzeile bis ${f(headerH)} px); erste Zeile ${geo.rowStolen} Proben vom Knopf`,
    );
    const winBefore = await ev<number>('window.__fl.st().forecastWindowMin');
    await ev('window.__fl.events.length = 0');
    await tap(geo.btn.cx, geo.card.top - 6);
    const above = await ev<{ win: number; log: string[] }>('({ win: window.__fl.st().forecastWindowMin, log: window.__fl.events.slice() })');
    await ev('window.__fl.events.length = 0');
    // Rechts oben in der Kopfzeile, außerhalb der runden Ecke (Radius 14 px).
    await tap(geo.card.right - 6, geo.card.top + 8);
    const corner = await ev<{ win: number; log: string[] }>('({ win: window.__fl.st().forecastWindowMin, log: window.__fl.events.slice() })');
    expect(
      `${k}: Tap 6 px über der Karte erreicht das Canvas, Tap in die Kartenecke schaltet das Fenster`,
      above.log[0] === 'pointerdown:CANVAS' && above.win === winBefore && corner.win !== winBefore && corner.log.includes('click:BUTTON'),
      `über der Karte: ${above.log.join(', ') || '–'}, Fenster ${winBefore} → ${above.win}; Ecke rechts oben: ${corner.log.join(', ') || '–'}, Fenster → ${corner.win}`,
    );
    await ev(`window.__fl.st().setForecastWindow(10)`);
    await sleep(400);
    await setView(null);
    await screenshotCard(`${w}-zeilen`);

    /* c) Ausblick-Zeile */
    const perName: Record<string, { error?: string; visible: number; length: number; lines: number; cardWidth: number; topInside: boolean; detailBottom: number; bodyBottom: number; scrollable: boolean; scrolledToDetail: boolean }> = {};
    for (const name of NEXT_NAMES) {
      await setView(name);
      perName[name] = await ev(`window.__fl.visibleChars(${js(name)})`);
      if (name === 'COSMOS 2219 DEB') await screenshotCard(`${w}-naechster`);
    }
    const rowsText = Object.entries(perName).map(([n, r]) =>
      r.error ? `${n}: ${r.error}` : `„${n.slice(0, r.visible)}${r.visible < r.length ? '…' : ''}“ (${r.visible}/${r.length}, ${r.lines} Z.${r.scrollable ? ', scrollt' : ''})`,
    );
    const allVisible = Object.values(perName).every((r) => !r.error && r.visible === r.length && r.topInside);
    const overflowOnlyDown = Object.values(perName).every((r) => !r.error && (r.detailBottom <= r.bodyBottom + 0.5 || (r.scrollable && r.scrolledToDetail)));
    const shortOneLine = w < 393 || SHORT_NAMES.every((n) => perName[n]?.lines === 1);
    expect(
      `${k}: Ausblick-Zeile zeigt jeden Namen bis 15 Zeichen ganz${w >= 393 ? ', kurze Namen einzeilig' : ''}; Überlauf nur nach unten und scrollbar`,
      allVisible && overflowOnlyDown && shortOneLine,
      `Karte ${f(perName[NEXT_NAMES[0]]?.cardWidth ?? 0, 0)} px: ${rowsText.join('; ')}`,
    );
    report[k] = { geo, above, corner, perName };
  }

  await ev(`(() => { const s = window.__fl.st(); s.setForecastWindow(10); s.setMode('all'); window.__fl.engine.resetToRealTime(); })()`);
  writeFileSync(`${OUT_DIR}/vorhersage-layout-ergebnis.json`, JSON.stringify({ checks, failures, results, report }, null, 1));
  console.log(`\n${checks} Prüfungen, ${failures} Fehlschläge`);
  // Nur den eigenen Tab schließen, wenn noch ein anderer offen ist – sonst
  // endet mit ihm der ganze Chrome-Prozess.
  const pages = (await fetch(`${CDP_BASE}/json/list`).then((r) => r.json())) as Array<{ type: string; id: string }>;
  if (pages.filter((t) => t.type === 'page' && t.id !== targetId).length > 0) {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
  }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('FEHLER:', err);
  process.exit(1);
});
