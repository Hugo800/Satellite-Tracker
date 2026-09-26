/**
 * Prüft die Zeitmaschine (TimeMachine.tsx, dazu Uhr-Knopf und
 * Echtzeit-Hinweis in TopBar.tsx) in echtem, headless Chrome über das
 * DevTools-Protokoll:
 *
 *   a) Layout: Telefon hochkant (375×667, 402×874 mit Insets 62/34), quer
 *      (874×402 mit Inset unten 21, einmal zusätzlich 62 links/rechts;
 *      844×390 mit 47 links/rechts; 667×375, 640×360, 740×360, 568×320) und
 *      1280×800 – jeweils ohne und mit allen vier Hinweiszeilen, ohne und mit
 *      gewähltem Satelliten, Blatt zu und offen, auf allen Telefon-Viewports
 *      zusätzlich im Zeitraffer. Geprüft:
 *      - „Jetzt“ und „Schließen“ sind bei offenem Blatt ohne Scrollen an
 *        allen 15 Rasterpunkten antippbar (im Bild, von nichts verdeckt), das
 *        Blatt überlappt das Telemetrie-Panel nicht, die TopBar endet im Bild;
 *      - quer ohne Hinweise zusätzlich alle acht Stufen und der Regler;
 *      - wird bei offenem Blatt ein Satellit gewählt, weicht das Blatt dem
 *        Panel, ohne neu geöffnet zu werden;
 *      - auf den Viewports, die schon vor der Zeitmaschine geprüft wurden,
 *        überlappt kein Teil der TopBar Panel oder Radar.
 *   b) Funktion – ausgelöst wie von Hand, über Maus-, Touch- und
 *      Tastaturereignisse auf die Knöpfe, nicht über `engine`-Aufrufe:
 *      Stufen, Echtzeit-Hinweis, „Jetzt“, Fokus nach dem Schließen, Regler
 *      per Tastatur, Maus, Touch (waagerecht und als senkrechte Wischgeste)
 *      und als AT-Inkrement (`input` + `change` ohne Zeiger oder Taste),
 *      sofortiger Abgleich von Regler, Uhr und Hinweis bei neuer Zeitbasis,
 *      Trefferflächen, Kontrast von „Jetzt“, aktive Stufe im Nachtmodus,
 *      Haarlinien nur unten.
 *   c) Screenshots (375 und 402 pt: Blatt zu und offen, Zeitraffer,
 *      Nachtmodus; 874×402 offen; 667×375 offen mit Hinweisen und Auswahl).
 *
 * Läuft NICHT in `npm test`: Es braucht einen laufenden Vite-Dev-Server und
 * einen headless Chrome mit Remote-Debugging-Port – beides muss vorher
 * gestartet sein. Vorgehen und Fallen: ~/Git/agent/docs/headless-chrome-layout-messung.md.
 *
 *   1. `npx vite --port 5189 --strictPort` (oder VITE_PORT setzen)
 *   2. Chrome headless mit `--remote-debugging-port=9333` (oder CDP_PORT) und
 *      `--host-resolver-rules="MAP celestrak.org ~NOTFOUND"`, CacheStorage
 *      `tle-raw-v1` für diesen Origin mit einigen TLE-Sätzen je Gruppe
 *      vorbelegt. Ohne Vorbelegung versucht der Worker fehlgeschlagene
 *      Gruppen später erneut (`RETRY_DELAYS_MS`, sgp4.worker.ts), und jede
 *      neue Hinweiszeile verschiebt mitten in der Messung die Klickpunkte
 *      (siehe Notiz oben).
 *
 * Bündeln und starten wie die übrigen `verify:*`-Skripte:
 *   esbuild scripts/verify-timemachine-layout.ts --bundle --platform=node \
 *     --format=esm --outfile=node_modules/.cache/verify-timemachine-layout.mjs \
 *     --log-level=warning && node node_modules/.cache/verify-timemachine-layout.mjs
 *
 * Umgebungsvariablen: CDP_PORT, VITE_PORT, TIMEMACHINE_OUT_DIR (Ergebnis-JSON
 * und Screenshots), TIMEMACHINE_SHOT_PREFIX (Dateinamen, Vorgabe
 * `zeitmaschine`).
 */
import { writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const CDP_PORT = process.env.CDP_PORT ?? '9333';
const VITE_PORT = process.env.VITE_PORT ?? '5189';
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
// localhost statt 127.0.0.1: `vite --port` bindet ohne `--host` nur IPv6.
const APP = `http://localhost:${VITE_PORT}/`;
const OUT_DIR = process.env.TIMEMACHINE_OUT_DIR ?? '.';
const SHOT_PREFIX = process.env.TIMEMACHINE_SHOT_PREFIX ?? 'zeitmaschine';

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
  // Frist je Befehl: Ein hängender Befehl soll als Fehlschlag enden, nicht
  // den Lauf anhalten. Gesehen bei einer senkrechten Touch-Wischgeste über
  // einem Blattkörper, der scrollen konnte (Ursache offen). Großzügig, weil
  // der erste `Runtime.evaluate` nach dem Seitenaufbau auf einem ausgelasteten
  // Rechner lange auf sich warten lassen kann.
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

/** Relative Leuchtdichte nach WCAG aus 0–255-Kanälen. */
function luminance([r, g, b]: number[]): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** `rgb(…)`/`rgba(…)` oder `color(srgb r g b)` (Kanäle 0–1) → 0–255. */
function parseCssColor(s: string): number[] {
  const nums = (s.match(/[\d.]+/g) ?? []).map(Number);
  if (s.startsWith('color(srgb')) return nums.slice(0, 3).map((v) => v * 255);
  return nums.slice(0, 3);
}

/**
 * Leuchtdichte jedes Pixels eines PNG (8 Bit RGB/RGBA, ohne Interlacing – so
 * liefert `Page.captureScreenshot` sie). Kein Bildpaket nötig: IDAT
 * entpacken, Zeilenfilter rückgängig machen.
 */
function pngLuminances(png: Buffer): number[] {
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat: Buffer[] = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : 3;
      if (data[8] !== 8 || data[12] !== 0) throw new Error('PNG: nur 8 Bit ohne Interlacing');
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  const out: number[] = [];
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = cur[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const o = x * channels;
      out.push(luminance([cur[o], cur[o + 1], cur[o + 2]]));
    }
    cur.copy(prev);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Seitenseitige Hilfen (einmal pro Seite installiert)                  */
/* ------------------------------------------------------------------ */

// Store, engine und Formatierer derselben Modulinstanz wie die App: Vite
// hängt `?v=<hash>` an, ein Import ohne liefert eine zweite, leere Instanz
// (Falle laut headless-chrome-layout-messung.md). `jumpTo` wird gezählt,
// Regler- und Zeigerereignisse protokolliert. `clipped` schneidet das
// Rechteck mit jedem Vorfahren, dessen `overflow` beschneidet –
// `getBoundingClientRect()` allein meldet auch Teile, die ein Vorfahr
// verdeckt. `grid` zählt, an wie vielen von 5 × 3 Punkten über dem Element
// dieses im Bild liegt und zuoberst getroffen wird.
const PAGE_SETUP = `(async () => {
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  const find = (path) => names.find((n) => n.includes(path + '?')) || path;
  const store = await import(find('/src/state/store.ts'));
  const eng = await import(find('/src/hooks/useSatelliteEngine.ts'));
  const fmt = await import(find('/src/utils/format.ts'));
  const T = (window.__tm = { store, fmt, engine: eng.engine, jumps: 0, events: [] });
  const orig = T.engine.jumpTo;
  T.engine.jumpTo = (...args) => { T.jumps += 1; return orig.apply(T.engine, args); };
  for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'input', 'change']) {
    document.addEventListener(t, (e) => {
      if (e.target?.classList?.contains('time-slider') || t.startsWith('pointer')) T.events.push(t);
    }, true);
  }
  T.st = () => store.useAppStore.getState();
  T.offsetH = () => (store.virtualNow() - Date.now()) / 3600000;
  T.realtime = () => store.isRealtime(T.st().timeBase);
  T.clipped = (el) => {
    const r = el.getBoundingClientRect();
    let t = r.top, b = r.bottom, l = r.left, rr = r.right;
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const c = (v) => ['hidden', 'clip', 'scroll', 'auto'].includes(v);
      if (c(cs.overflow) || c(cs.overflowX) || c(cs.overflowY)) {
        const nr = n.getBoundingClientRect();
        t = Math.max(t, nr.top); b = Math.min(b, nr.bottom); l = Math.max(l, nr.left); rr = Math.min(rr, nr.right);
      }
    }
    b = Math.max(b, t); rr = Math.max(rr, l);
    const R = (v) => Math.round(v * 10) / 10;
    return { t: R(t), b: R(b), l: R(l), r: R(rr), h: R(b - t), w: R(rr - l), rawT: R(r.top), rawB: R(r.bottom), rawH: R(r.height), rawW: R(r.width) };
  };
  // Mittelpunkt des sichtbaren Teils, sofern dort wirklich das Element (oder
  // ein Kind) liegt – sonst null. Grundlage jedes Klicks per CDP.
  T.hitPoint = (el) => {
    if (!el) return null;
    const c = T.clipped(el);
    if (c.h < 1 || c.w < 1) return null;
    const x = (c.l + c.r) / 2, y = (c.t + c.b) / 2;
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === el || el.contains(hit)) ? { x, y } : null;
  };
  T.grid = (el) => {
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    let ok = 0;
    for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const fy of [0.15, 0.5, 0.85]) {
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) ok += 1;
    }
    return ok;
  };
  return true;
})()`;

const SEL = {
  toggle: 'button[aria-label^="Zeitmaschine "]',
  sheet: '[data-hud="time-sheet"]',
  close: '[data-hud="time-sheet"] [aria-label="Zeitmaschine schließen"]',
  now: '[aria-label="Zur Echtzeit springen"]',
  notice: '[data-hud="topbar"] button[aria-describedby="time-notice-text"]',
  slider: '.time-slider',
  body: '[data-hud="time-sheet"] .overflow-y-auto',
};
const js = (s: string) => JSON.stringify(s);
const stageExpr = (label: string) =>
  `[...document.querySelectorAll('[aria-label="Zeitraffer"] button')].find((b) => b.textContent.trim() === ${js(label)})`;

const ERR1 = 'Hellste Objekte noch nicht verfügbar – Failed to fetch. Wird automatisch nachgeladen.';
const ERR2 = 'Wettersatelliten noch nicht verfügbar – Failed to fetch. Wird automatisch nachgeladen.';
const GEO = 'Ortung fehlgeschlagen (User denied Geolocation) – Standardstandort aktiv';

interface Viewport {
  name: string;
  w: number;
  h: number;
  ins: { top?: number; bottom?: number; left?: number; right?: number };
  /** Telefon: zusätzlich im Zeitraffer, also mit Echtzeit-Hinweis. */
  phone: boolean;
  /** Schon vor der Zeitmaschine geprüft: kein Teil der TopBar über Panel oder Radar. */
  classic: boolean;
  /** Niedriges Querformat: Stufen und Regler ohne Hinweise ohne Scrollen bedienbar. */
  landscape: boolean;
}
const VIEWPORTS: Viewport[] = [
  { name: '375x667', w: 375, h: 667, ins: {}, phone: true, classic: true, landscape: false },
  { name: '402x874', w: 402, h: 874, ins: { top: 62, bottom: 34 }, phone: true, classic: true, landscape: false },
  { name: '874x402', w: 874, h: 402, ins: { bottom: 21 }, phone: true, classic: true, landscape: true },
  { name: '874x402+LR62', w: 874, h: 402, ins: { bottom: 21, left: 62, right: 62 }, phone: false, classic: true, landscape: true },
  { name: '1280x800', w: 1280, h: 800, ins: {}, phone: false, classic: true, landscape: false },
  { name: '844x390+LR47', w: 844, h: 390, ins: { bottom: 21, left: 47, right: 47 }, phone: true, classic: false, landscape: true },
  { name: '667x375', w: 667, h: 375, ins: {}, phone: true, classic: false, landscape: true },
  { name: '640x360', w: 640, h: 360, ins: {}, phone: true, classic: false, landscape: true },
  { name: '740x360', w: 740, h: 360, ins: {}, phone: true, classic: false, landscape: true },
  { name: '568x320', w: 568, h: 320, ins: {}, phone: true, classic: false, landscape: true },
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
  // Aktivieren und nach vorn holen: Die Notiz oben beschreibt einen Fall, in
  // dem ein nur per `createTarget` angelegter Tab weder ResizeObserver noch
  // requestAnimationFrame bediente – `--hud-top-free` (Hud.tsx) blieb dann
  // auf dem ersten Wert stehen. Eine Gegenprobe mit frischem Chrome zeigte
  // den Effekt nicht; die Bedingung ist offen, die zwei Aufrufe schaden nicht.
  await cdp.send('Target.activateTarget', { targetId });
  const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as {
    sessionId: string;
  };
  const S = (method: string, params: Json = {}) => cdp.send(method, params, sessionId);
  await S('Page.enable');
  await S('Runtime.enable');
  await S('Page.bringToFront');
  // Gilt nur für diese CDP-Sitzung – deshalb hier und nicht vorab von außen.
  await S('Browser.grantPermissions', { origin: APP.replace(/\/$/, ''), permissions: ['geolocation'] });
  await S('Emulation.setGeolocationOverride', { latitude: 51.3397, longitude: 12.3731, accuracy: 10 });

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
  async function viewport(vp: Pick<Viewport, 'w' | 'h' | 'ins'>): Promise<void> {
    const { top = 0, bottom = 0, left = 0, right = 0 } = vp.ins;
    const short = Math.min(vp.w, vp.h) < 500;
    await S('Emulation.setDeviceMetricsOverride', {
      width: vp.w,
      height: vp.h,
      deviceScaleFactor: 2,
      mobile: vp.w < 1000,
      screenWidth: short ? Math.min(vp.w, vp.h) : vp.w,
      screenHeight: short ? Math.max(vp.w, vp.h) : vp.h,
    });
    await S('Emulation.setSafeAreaInsetsOverride', {
      insets: { top, topMax: top, bottom, bottomMax: bottom, left, leftMax: left, right, rightMax: right },
    });
    await sleep(300);
  }
  async function mouseClick(x: number, y: number): Promise<void> {
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(200);
  }
  /** Klick wie von Hand; schlägt fehl, wenn das Element nicht sichtbar oder verdeckt ist. */
  async function click(expr: string, label: string): Promise<boolean> {
    const pt = await ev<{ x: number; y: number } | null>(`window.__tm.hitPoint(${expr})`);
    if (!pt) {
      expect(`klickbar: ${label}`, false, 'nicht sichtbar oder verdeckt');
      return false;
    }
    await mouseClick(pt.x, pt.y);
    return true;
  }
  /** Wie `click`, aber ohne Pause danach – für Messungen unmittelbar nach dem Klick. */
  async function fastClick(expr: string, label: string): Promise<boolean> {
    const pt = await ev<{ x: number; y: number } | null>(`window.__tm.hitPoint(${expr})`);
    if (!pt) {
      expect(`klickbar: ${label}`, false, 'nicht sichtbar oder verdeckt');
      return false;
    }
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    return true;
  }
  const q = (sel: string) => `document.querySelector(${js(sel)})`;
  async function key(k: string, code: string, keyCode: number, type: 'both' | 'down' | 'up' = 'both', repeat = false) {
    if (type !== 'up') await S('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: keyCode, autoRepeat: repeat });
    if (type !== 'down') await S('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode });
  }
  const sheetOpen = () => ev<boolean>(`!!${q(SEL.sheet)}`);
  async function setSheet(open: boolean): Promise<void> {
    if ((await sheetOpen()) !== open) {
      await ev(`${q(SEL.toggle)}.click()`);
      await sleep(300);
    }
  }
  async function setNotices(all: boolean): Promise<void> {
    await ev(
      all
        ? `window.__tm.store.useAppStore.setState({ errors: [${js(ERR1)}, ${js(ERR2)}], geoError: ${js(GEO)}, arSupported: false, arEnabled: false })`
        : `window.__tm.store.useAppStore.setState({ errors: [], geoError: null, arSupported: true, arEnabled: false })`,
    );
    await sleep(200);
  }
  async function select(on: boolean): Promise<void> {
    if (on) {
      await ev(`(() => { const s = window.__tm.st(); const iss = s.catalog.find((m) => /ISS/.test(m.name)) ?? s.catalog[0]; s.select(iss.noradId); })()`);
      await sleep(250);
      // TelemetryPanel behält `expanded` über Auswahlen hinweg – ausgeklappt messen.
      await ev(`(() => { const b = document.querySelector('[aria-label="Ausklappen"]'); if (b) b.click(); })()`);
    } else {
      await ev('window.__tm.st().select(null)');
    }
    await sleep(250);
  }
  /** Wartet, bis Hud.tsx `--hud-top-free` auf die aktuelle TopBar-Unterkante gesetzt hat. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 30; i += 1) {
      const ok = await ev<boolean>(`(() => { const r = document.querySelector('[data-hud="topbar"]'); return Math.abs(parseFloat(r.parentElement.style.getPropertyValue('--hud-top-free')) - r.getBoundingClientRect().bottom) < 0.5; })()`);
      if (ok) return;
      await sleep(100);
    }
  }
  /** Leuchtdichten eines Bildschirmausschnitts: Rechteck des Elements, um `inset` px verkleinert. */
  async function clipLuminances(expr: string, inset = 0): Promise<number[]> {
    const r = await ev<{ x: number; y: number; w: number; h: number }>(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.left + ${inset}, y: r.top + ${inset}, w: r.width - ${2 * inset}, h: r.height - ${2 * inset} }; })()`);
    const shot = (await S('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } })) as { data: string };
    return pngLuminances(Buffer.from(shot.data, 'base64'));
  }
  async function screenshot(name: string): Promise<void> {
    const res = (await S('Page.captureScreenshot', { format: 'png' })) as { data: string };
    const path = `${OUT_DIR}/${SHOT_PREFIX}-${name}.png`;
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    note('Screenshot', path);
  }

  console.log('--- Seite laden ---');
  await viewport(VIEWPORTS[1]);
  await S('Page.navigate', { url: APP });
  await sleep(2500);
  await ev(PAGE_SETUP);

  // Erst messen, wenn der Katalog fertig geladen ist: Solange `loading` gilt,
  // ändert sich die Statuszeile der Infokarte, und Ladefehler können als
  // neue Hinweiszeilen auftauchen – beides verschiebt die Rechtecke.
  let loading = true;
  let catalogSize = 0;
  for (let i = 0; i < 90; i += 1) {
    ({ loading, catalogSize } = await ev<{ loading: boolean; catalogSize: number }>(
      '({ loading: window.__tm.st().loading, catalogSize: window.__tm.st().catalog.length })',
    ));
    if (!loading && catalogSize > 0) break;
    await sleep(1000);
  }
  expect('Katalog fertig geladen', !loading && catalogSize > 0, `${catalogSize} Objekte, loading=${loading}`);
  note('Ladefehler vor Messbeginn', JSON.stringify(await ev('window.__tm.st().errors')));

  /* ---------------------------------------------------------------- */
  console.log('\n=== a) Layout ===');
  const layoutReport: unknown[] = [];
  type Rect = { t: number; b: number; l: number; r: number; h: number; w: number };

  async function measureLayout(label: string, vp: Viewport, open: boolean, notices: boolean): Promise<void> {
    await settle();
    const m = await ev<{
      vh: number;
      rootB: number;
      parts: Array<{ name: string; rect: Rect }>;
      panel: Rect | null;
      radar: Rect | null;
      sheet: Rect | null;
      now: number;
      close: number;
      slider: number;
      stages: number[];
      body: { client: number; scroll: number } | null;
    }>(`(() => {
      const T = window.__tm;
      const root = document.querySelector('[data-hud="topbar"]');
      const sheet = ${q(SEL.sheet)};
      const body = ${q(SEL.body)};
      if (body) body.scrollTop = 0;
      const panelClose = document.querySelector('[aria-label="Auswahl aufheben"]');
      const radarSvg = document.querySelector('[aria-label="Polar-Radar der sichtbaren Satelliten"]');
      return {
        vh: innerHeight,
        rootB: root.getBoundingClientRect().bottom,
        parts: [...root.querySelectorAll('.material')].map((m, i) => ({ name: m === sheet ? 'Blatt' : (m.getAttribute('aria-label') ?? m.getAttribute('role') ?? ('Teil ' + i)), rect: T.clipped(m) })),
        panel: panelClose ? T.clipped(panelClose.closest('.material')) : null,
        radar: radarSvg ? T.clipped(radarSvg.closest('.material')) : null,
        sheet: sheet ? T.clipped(sheet) : null,
        now: sheet ? T.grid(${q(SEL.now)}) : 0,
        close: sheet ? T.grid(${q(SEL.close)}) : 0,
        slider: sheet ? T.grid(${q(SEL.slider)}) : 0,
        stages: sheet ? [...sheet.querySelectorAll('[aria-label="Zeitraffer"] button')].map((b) => T.grid(b)) : [],
        body: body ? { client: body.clientHeight, scroll: body.scrollHeight } : null,
      };
    })()`);
    const inter = (a: Rect | null, b: Rect | null) => {
      if (!a || !b || a.h <= 0 || b.h <= 0) return 0;
      const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      return h > 0 && w > 0 ? Math.round(h * 10) / 10 : 0;
    };
    layoutReport.push({ label, ...m });
    const inView = m.rootB <= m.vh + 0.5;
    if (vp.classic) {
      const overlaps: string[] = [];
      for (const part of m.parts) {
        const op = inter(part.rect, m.panel);
        const orr = inter(part.rect, m.radar);
        if (op) overlaps.push(`${part.name}×Panel ${op} px`);
        if (orr) overlaps.push(`${part.name}×Radar ${orr} px`);
      }
      expect(`${label}: keine Überlappung`, overlaps.length === 0, overlaps.join(', ') || `TopBar bis ${m.rootB.toFixed(1)} px`);
      expect(`${label}: TopBar im Viewport`, inView, `Unterkante ${m.rootB.toFixed(1)} px bei ${m.vh} px`);
    }
    if (!open) return;
    if (!vp.classic) {
      // Kleine Querformate: Hinweiszeilen überlappen das Panel dort schon bei
      // zugeklapptem Blatt (die Abwägung in Hud.tsx), geprüft wird das Blatt.
      const op = inter(m.sheet, m.panel);
      expect(`${label}: Blatt überlappt das Panel nicht`, op === 0, op ? `${op} px` : `Blatt ${m.sheet?.t}–${m.sheet?.b}`);
      expect(`${label}: TopBar im Viewport`, inView, `Unterkante ${m.rootB.toFixed(1)} px bei ${m.vh} px`);
    }
    expect(`${label}: „Jetzt“ ohne Scrollen voll antippbar`, m.now === 15, `${m.now}/15 Rasterpunkte`);
    expect(`${label}: „Schließen“ ohne Scrollen voll antippbar`, m.close === 15, `${m.close}/15 Rasterpunkte`);
    if (vp.landscape && !notices) {
      const stagesOk = m.stages.length === 8 && m.stages.every((n) => n === 15);
      expect(`${label}: Stufen und Regler ohne Scrollen antippbar`, stagesOk && m.slider === 15, `Stufen ${m.stages.join('/')}, Regler ${m.slider}/15, Körper ${m.body?.client}/${m.body?.scroll} px`);
    }
    note(`${label}`, `Blatt ${m.sheet?.t}–${m.sheet?.b}, Körper ${m.body?.client}/${m.body?.scroll} px, Regler ${m.slider}/15`);
  }

  for (const vp of VIEWPORTS) {
    await viewport(vp);
    for (const lapse of vp.phone ? [false, true] : [false]) {
      if (lapse) {
        // Zeitraffer über den Stufenknopf, also mit Echtzeit-Hinweis bei
        // zugeklapptem Blatt. Geklickt wird ohne Hinweiszeilen und ohne
        // Auswahl, damit die Stufe sicher im Bild liegt.
        await setNotices(false);
        await select(false);
        await setSheet(true);
        await settle();
        await click(stageExpr('×600'), '×600');
      }
      for (const notices of [false, true]) {
        for (const sel of [false, true]) {
          await select(sel);
          for (const open of [false, true]) {
            await setSheet(open);
            await setNotices(notices);
            await measureLayout(
              `${vp.name} Hinweise=${notices ? 4 : 0} Auswahl=${sel ? 'ja' : 'nein'} Blatt=${open ? 'offen' : 'zu'}${lapse ? ' Zeitraffer' : ''}`,
              vp,
              open,
              notices,
            );
          }
        }
      }
      if (lapse) await ev('window.__tm.engine.resetToRealTime()');
    }
  }
  // Erst das Blatt offen, dann ein Satellit gewählt: Das Blatt muss dem
  // hinzukommenden Panel ausweichen, ohne neu geöffnet zu werden.
  for (const vp of [VIEWPORTS[0], VIEWPORTS[2]]) {
    await viewport(vp);
    await setSheet(false);
    await select(false);
    await setNotices(true);
    await setSheet(true);
    await settle();
    await select(true);
    await settle();
    const late = await ev<{ sheet: Rect; panel: Rect | null; close: number }>(`(() => {
      const T = window.__tm;
      const panelClose = document.querySelector('[aria-label="Auswahl aufheben"]');
      return { sheet: T.clipped(${q(SEL.sheet)}), panel: panelClose ? T.clipped(panelClose.closest('.material')) : null, close: T.grid(${q(SEL.close)}) };
    })()`);
    const lateOverlap = late.panel ? Math.max(0, Math.min(late.sheet.b, late.panel.b) - Math.max(late.sheet.t, late.panel.t)) * (Math.min(late.sheet.r, late.panel.r) > Math.max(late.sheet.l, late.panel.l) ? 1 : 0) : -1;
    expect(`${vp.name} Hinweise=4: Auswahl bei offenem Blatt – Blatt weicht dem Panel`, lateOverlap === 0 && late.close === 15, `Blatt ${late.sheet.t}–${late.sheet.b}, Panel ${late.panel ? late.panel.t + '–' + late.panel.b : 'fehlt'}, Schließen ${late.close}/15`);
  }
  await setSheet(false);
  await select(false);
  await setNotices(false);
  writeFileSync(`${OUT_DIR}/zeitmaschine-layout.json`, JSON.stringify(layoutReport, null, 1));

  /* ---------------------------------------------------------------- */
  console.log('\n=== b) Funktion ===');
  await viewport(VIEWPORTS[1]);
  await settle();

  // Uhr-Knopf per Tastatur: Enter öffnet, ein zweites Enter schließt.
  await ev(`${q(SEL.toggle)}.focus()`);
  const enter = async () => {
    await key('Enter', 'Enter', 13, 'down');
    await S('Input.dispatchKeyEvent', { type: 'char', text: '\r' });
    await key('Enter', 'Enter', 13, 'up');
    await sleep(300);
  };
  await enter();
  const openedByKey = await sheetOpen();
  await enter();
  const closedByKey = !(await sheetOpen());
  expect('Uhr-Knopf: Enter öffnet, zweites Enter schließt', openedByKey && closedByKey, `offen=${openedByKey}, danach zu=${closedByKey}`);

  // ×600 per Klick, drei Sekunden laufen lassen.
  await click(q(SEL.toggle), 'Uhr-Knopf');
  await click(stageExpr('×600'), '×600');
  const pressed = await ev<string[]>(`[...document.querySelectorAll('[aria-label="Zeitraffer"] button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent.trim())`);
  expect('Klick ×600: Geschwindigkeit 600, genau diese Stufe gedrückt', (await ev<number>('window.__tm.st().timeBase.scale')) === 600 && pressed.join() === '×600', `gedrückt ${JSON.stringify(pressed)}`);
  expect('Echtzeit-Hinweis bei offenem Blatt ausgeblendet', !(await ev<boolean>(`!!${q(SEL.notice)}`)), `Hinweis da=${await ev(`!!${q(SEL.notice)}`)}`);
  const clockExpr = `document.querySelector('[data-hud="time-sheet"] .text-\\\\[22px\\\\] span')?.textContent`;
  const v0 = await ev<number>('window.__tm.store.virtualNow()');
  const w0 = Date.now();
  const clock0 = await ev<string>(clockExpr);
  await sleep(700);
  const clock1 = await ev<string>(clockExpr);
  expect('Uhr im Blatt läuft bei ×600 sichtbar', !!clock0 && clock0 !== clock1, `${clock0} → ${clock1} nach 0,7 s`);
  await sleep(2300);
  const dv = ((await ev<number>('window.__tm.store.virtualNow()')) - v0) / 1000;
  const dw = (Date.now() - w0) / 1000;
  expect('×600: virtuelle Zeit ≈ 600 × Wanduhr', Math.abs(dv - 600 * dw) < 0.02 * 600 * dw, `+${dv.toFixed(1)} s in ${dw.toFixed(2)} s (Soll ${(600 * dw).toFixed(1)})`);

  // Schließen über „×“: Fokus zurück auf den Uhr-Knopf.
  await click(q(SEL.close), 'Schließen im Blatt');
  const focusBack = await ev<boolean>(`document.activeElement === ${q(SEL.toggle)}`);
  expect('„×“ schließt das Blatt, Fokus zurück auf dem Uhr-Knopf', !(await sheetOpen()) && focusBack, `offen=${await sheetOpen()}, Fokus auf ${await ev('document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName')}`);

  // Echtzeit-Hinweis bei zugeklapptem Blatt.
  const noticeText = () => ev<string>(`${q(SEL.notice)}?.querySelector('#time-notice-text')?.textContent ?? ''`);
  const notice = await ev<{ text: string; label: string; desc: string; h: number; w: number } | null>(`(() => {
    const b = ${q(SEL.notice)};
    if (!b) return null;
    const c = window.__tm.clipped(b);
    return { text: b.querySelector('#time-notice-text')?.textContent ?? '', label: b.getAttribute('aria-label'), desc: document.getElementById(b.getAttribute('aria-describedby'))?.textContent ?? '', h: c.h, w: c.w };
  })()`);
  expect('Hinweis bei zugeklapptem Blatt sichtbar, ≥ 44 px hoch', !!notice && notice.h >= 44, JSON.stringify(notice));
  expect('Hinweis nennt Stufe, Wochentag und Uhrzeit', !!notice && /^×600 · \w\w\., \d\d\.\d\d\. \d\d:\d\d$/.test(notice.text), notice?.text ?? '–');
  expect('Hinweis: Name „Zeitraffer aktiv – …“, Beschreibung = sichtbare Zeit', notice?.label === 'Zeitraffer aktiv – zur Echtzeit zurückkehren' && notice.desc === notice.text && notice.desc.length > 0, `${notice?.label} / ${notice?.desc}`);
  await sleep(1200);
  const noticeLater = await noticeText();
  expect('Hinweistext läuft mit', !!noticeLater && noticeLater !== notice?.text, `${notice?.text} → ${noticeLater}`);

  // Name und Text des Hinweises je Zustand – Stufe im Blatt gesetzt, gelesen
  // bei zugeklapptem Blatt.
  const byStage: Array<{ label: string; text: string }> = [];
  for (const stage of ['Pause', '×-600']) {
    await click(q(SEL.toggle), 'Uhr-Knopf');
    await click(stageExpr(stage), stage);
    await click(q(SEL.close), 'Schließen im Blatt');
    byStage.push({ label: await ev<string>(`${q(SEL.notice)}?.getAttribute('aria-label') ?? ''`), text: await noticeText() });
  }
  expect(
    'Hinweis-Name bei Pause und rückwärts',
    byStage[0].label === 'Zeit angehalten – zur Echtzeit zurückkehren' && byStage[1].label === 'Zeitraffer rückwärts aktiv – zur Echtzeit zurückkehren',
    JSON.stringify(byStage.map((s) => s.label)),
  );
  expect('Hinweistext mit Vorzeichen: „Pause · …“ und „×-600 · …“', byStage[0].text.startsWith('Pause · ') && byStage[1].text.startsWith('×-600 · '), JSON.stringify(byStage.map((s) => s.text)));

  // Hinweis antippen → Echtzeit.
  await click(q(SEL.notice), 'Echtzeit-Hinweis');
  await sleep(200);
  expect('Hinweis-Klick → Echtzeit, Hinweis weg', (await ev<boolean>('window.__tm.realtime()')) && !(await ev<boolean>(`!!${q(SEL.notice)}`)), `realtime=${await ev('window.__tm.realtime()')}`);

  // Sprung bei gleicher Geschwindigkeit, zugeklapptes Blatt: Der Hinweis
  // nennt die neue Zeit sofort, nicht erst beim nächsten Sekundentakt.
  // Zweimal, damit ein zufällig gerade fälliger Sekundentakt nicht mitzählt.
  await ev('window.__tm.engine.jumpTo(Date.now() + 2 * 3600000)');
  await sleep(300);
  const jumpNotices: string[] = [];
  for (const hours of [5, 8]) {
    const [shown, want] = await ev<[string, string]>(`(() => {
      window.__tm.engine.jumpTo(Date.now() + ${hours} * 3600000);
      return new Promise((done) => setTimeout(() => {
        const v = window.__tm.store.virtualNow();
        done([${q(SEL.notice)}?.querySelector('#time-notice-text')?.textContent ?? '', '×1 · ' + window.__tm.fmt.formatDay(v) + ' ' + window.__tm.fmt.formatClockShort(v)]);
      }, 50));
    })()`);
    jumpNotices.push(shown === want ? 'ok' : `„${shown}“ statt „${want}“`);
  }
  expect('Hinweis folgt einem Sprung sofort', jumpNotices.every((x) => x === 'ok'), JSON.stringify(jumpNotices));
  await ev('window.__tm.engine.resetToRealTime()');
  await sleep(200);

  // „Jetzt“ im Kopf des Blatts, ohne vorher zu scrollen.
  await click(q(SEL.toggle), 'Uhr-Knopf');
  await click(stageExpr('×60'), '×60');
  await sleep(1200);
  await ev(`${q(SEL.body)}.scrollTop = 0`);
  await click(q(SEL.now), '„Jetzt“');
  expect('„Jetzt“ → Echtzeit', await ev<boolean>('window.__tm.realtime()'), `realtime=${await ev('window.__tm.realtime()')}`);

  // Escape im Blatt schließt ebenfalls und gibt den Fokus zurück.
  await ev(`${q(SEL.slider)}.focus()`);
  await key('Escape', 'Escape', 27);
  await sleep(300);
  expect('Escape im Blatt schließt, Fokus auf dem Uhr-Knopf', !(await sheetOpen()) && (await ev<boolean>(`document.activeElement === ${q(SEL.toggle)}`)), `offen=${await sheetOpen()}`);
  await click(q(SEL.toggle), 'Uhr-Knopf');

  const offsetText = () => ev<string>(`${q(SEL.slider)}.parentElement.querySelector('.tabular-nums').textContent`);
  const resetCounters = () => ev('(window.__tm.jumps = 0, window.__tm.events.length = 0, true)');
  const jumps = () => ev<number>('window.__tm.jumps');
  const sliderGeo = () =>
    ev<{ l: number; w: number; y: number }>(`(() => { const el = ${q(SEL.slider)}; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { l: r.left, w: r.width, y: r.top + r.height / 2 }; })()`);
  // Daumen 26 px (index.css): Wert −48 h liegt 13 px innerhalb des linken Rands.
  const xFor = (g: { l: number; w: number }, hours: number) => g.l + 13 + (g.w - 26) * ((hours + 48) / 96);
  async function mouseDrag(fromH: number, toH: number, releaseDy = 0): Promise<{ during: number; text: string }> {
    const g = await sliderGeo();
    const x0 = xFor(g, fromH);
    const x1 = xFor(g, toH);
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: g.y });
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: g.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 12; i += 1) {
      await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / 12, y: g.y + (releaseDy * i) / 12, button: 'left', buttons: 1 });
      await sleep(20);
    }
    const during = await jumps();
    const text = await offsetText();
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: g.y + releaseDy, button: 'left', clickCount: 1 });
    await sleep(300);
    return { during, text };
  }
  async function toRealtime(): Promise<void> {
    if (!(await ev<boolean>('window.__tm.realtime()'))) await click(q(SEL.now), '„Jetzt“');
    await sleep(300);
  }
  /** Anzeige gegen Szene: formatierter Versatz der Szene und Reglerwert. */
  const sceneVsDisplay = () =>
    ev<{ text: string; scene: number; value: number }>(`({ text: ${q(SEL.slider)}.parentElement.querySelector('.tabular-nums').textContent, scene: window.__tm.offsetH(), value: ${q(SEL.slider)}.valueAsNumber })`);

  // Neue Zeitbasis → Regler, Anzeige und Uhr sofort abgeglichen. ×600 zwei
  // Sekunden, dann „Jetzt“: Unmittelbar danach steht der Regler auf 0, und
  // ein Pfeil-links-Schritt 100 ms später landet bei −5 min, nicht bei dem
  // Versatz, den der Zeitraffer bis dahin aufgebaut hatte. Zweimal, damit ein
  // zufällig gerade fälliger Sekundentakt nicht mitzählt.
  const afterNowRuns: string[] = [];
  const stepRuns: string[] = [];
  for (let run = 0; run < 2; run += 1) {
    await click(stageExpr('×600'), '×600');
    await sleep(2000);
    await fastClick(q(SEL.now), '„Jetzt“');
    const imm = await ev<{ value: number; text: string; clock: string; wall: string[] }>(`({ value: ${q(SEL.slider)}.valueAsNumber, text: ${q(SEL.slider)}.parentElement.querySelector('.tabular-nums').textContent, clock: ${clockExpr}, wall: [window.__tm.fmt.formatClock(Date.now()), window.__tm.fmt.formatClock(Date.now() - 1000)] })`);
    afterNowRuns.push(imm.value === 0 && imm.text === '± 0' && imm.wall.includes(imm.clock) ? 'ok' : JSON.stringify(imm));
    await sleep(100);
    await resetCounters();
    await ev(`${q(SEL.slider)}.focus()`);
    await key('ArrowLeft', 'ArrowLeft', 37);
    await sleep(300);
    const minutes = (await ev<number>('window.__tm.offsetH()')) * 60;
    stepRuns.push((await jumps()) === 1 && Math.abs(minutes + 5) < 0.2 ? 'ok' : `Sprünge ${await jumps()}, Szene ${minutes.toFixed(2)} min`);
    await toRealtime();
  }
  expect('„Jetzt“: Regler, Anzeige und Uhr sofort auf Echtzeit', afterNowRuns.every((x) => x === 'ok'), JSON.stringify(afterNowRuns));
  expect('×600, „Jetzt“, 100 ms später Pfeil links → −5 min', stepRuns.every((x) => x === 'ok'), JSON.stringify(stepRuns));

  // Sprung von außen (hier per `jumpTo`, wie ihn der Regler selbst auslöst):
  // Anzeige folgt sofort.
  const afterJump = await ev<{ text: string; value: number }>(`(() => {
    window.__tm.engine.jumpTo(Date.now() + 2 * 3600000);
    return new Promise((done) => setTimeout(() => done({ text: ${q(SEL.slider)}.parentElement.querySelector('.tabular-nums').textContent, value: ${q(SEL.slider)}.valueAsNumber }), 50));
  })()`);
  expect('Sprung auf +2 h: Anzeige und Regler sofort nachgeführt', afterJump.text === '+2 h' && afterJump.value === 2 * 3600000, `Anzeige „${afterJump.text}“, Wert ${afterJump.value}`);
  await toRealtime();

  // Tab auf den Regler ändert nichts: `keyup` von Tab landet auf dem Regler.
  await ev(`document.querySelector('[aria-label="Zeitraffer"] button:last-child').focus()`);
  await resetCounters();
  await key('Tab', 'Tab', 9);
  await sleep(200);
  expect('Tab auf den Regler: kein Sprung', (await ev<boolean>(`document.activeElement === ${q(SEL.slider)}`)) && (await jumps()) === 0, `Sprünge ${await jumps()}`);

  // 72 × Pfeil links gehalten (Wiederholungen) = −6 h, ein Sprung beim Loslassen.
  await resetCounters();
  for (let i = 0; i < 72; i += 1) await key('ArrowLeft', 'ArrowLeft', 37, 'down', i > 0);
  await sleep(100);
  const heldJumps = await jumps();
  const heldText = await offsetText();
  await key('ArrowLeft', 'ArrowLeft', 37, 'up');
  await sleep(300);
  expect('Pfeiltaste gehalten: kein Sprung, Anzeige folgt', heldJumps === 0 && heldText === '-6 h', `Sprünge ${heldJumps}, Anzeige „${heldText}“`);
  expect('Pfeiltaste losgelassen: genau ein Sprung auf -6 h', (await jumps()) === 1 && Math.abs((await ev<number>('window.__tm.offsetH()')) + 6) < 0.02, `Sprünge ${await jumps()}, Versatz ${(await ev<number>('window.__tm.offsetH()')).toFixed(3)} h`);
  await toRealtime();

  // Fokuswechsel mitten im Tastenschritt: Das `keyup` landet woanders,
  // `onBlur` schreibt den Schritt fest.
  await ev(`${q(SEL.slider)}.focus()`);
  await resetCounters();
  await key('ArrowLeft', 'ArrowLeft', 37, 'down');
  await sleep(100);
  await ev(`${q(SEL.close)}.focus()`);
  await sleep(200);
  await key('ArrowLeft', 'ArrowLeft', 37, 'up');
  await sleep(200);
  const blurScene = (await ev<number>('window.__tm.offsetH()')) * 60;
  expect('Fokuswechsel bei gedrückter Taste: ein Sprung auf −5 min', (await jumps()) === 1 && Math.abs(blurScene + 5) < 0.2 && (await offsetText()) === '-5 min', `Sprünge ${await jumps()}, Szene ${blurScene.toFixed(2)} min, Anzeige „${await offsetText()}“`);
  await toRealtime();

  // Maus: −6 h ziehen – während des Ziehens kein Sprung, beim Loslassen einer.
  await resetCounters();
  const drag = await mouseDrag(0, -6);
  expect('Maus-Zug: kein Sprung während des Ziehens, Anzeige „-6 h“', drag.during === 0 && drag.text === '-6 h', `Sprünge ${drag.during}, Anzeige „${drag.text}“`);
  expect('Maus-Zug losgelassen: genau ein Sprung auf -6 h', (await jumps()) === 1 && Math.abs((await ev<number>('window.__tm.offsetH()')) + 6) < 0.1, `Sprünge ${await jumps()}, Ereignisse ${JSON.stringify([...new Set(await ev<string[]>('window.__tm.events'))])}`);

  // Aus der verschobenen Basis weiterziehen: Der Regler zielt absolut auf
  // die Wanduhr, nicht relativ zur virtuellen Zeit.
  await sleep(300);
  await resetCounters();
  await mouseDrag(-6, -10);
  expect('Zug aus -6 h auf -10 h landet absolut bei -10 h', (await jumps()) === 1 && Math.abs((await ev<number>('window.__tm.offsetH()')) + 10) < 0.1, `Versatz ${(await ev<number>('window.__tm.offsetH()')).toFixed(3)} h`);

  // „Jetzt“ von außen: Der Regler folgt.
  await click(q(SEL.now), '„Jetzt“');
  await sleep(300);
  const afterNow = await offsetText();
  const sliderAfterNow = await ev<number>(`${q(SEL.slider)}.valueAsNumber`);
  expect('Regler folgt der Zeitbasis nach „Jetzt“', afterNow === '± 0' && sliderAfterNow === 0, `Anzeige „${afterNow}“, Wert ${sliderAfterNow}`);

  // Loslassen unterhalb des Reglers: Anzeige und Szene stimmen überein.
  await resetCounters();
  await mouseDrag(0, 10, 120);
  const t10 = await offsetText();
  const o10 = await ev<number>('window.__tm.offsetH()');
  expect('Loslassen außerhalb des Reglers: Anzeige = Szene', ((await jumps()) === 1 && Math.abs(o10 - 10) < 0.1 && t10 === '+10 h') || ((await jumps()) === 0 && t10 === '± 0'), `Sprünge ${await jumps()}, Versatz ${o10.toFixed(3)} h, Anzeige „${t10}“`);
  await toRealtime();

  // Touch: waagerecht ziehen → ein Sprung.
  await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(200);
  async function touchPath(points: Array<{ x: number; y: number }>): Promise<void> {
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[0]] });
    for (const pt of points.slice(1)) {
      await S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt] });
      await sleep(20);
    }
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(300);
  }
  let g = await sliderGeo();
  await resetCounters();
  await touchPath(Array.from({ length: 11 }, (_, i) => ({ x: xFor(g, 0) + ((xFor(g, -20) - xFor(g, 0)) * i) / 10, y: g.y })));
  const o11 = await ev<number>('window.__tm.offsetH()');
  expect('Touch waagerecht auf -20 h: genau ein Sprung', (await jumps()) === 1 && Math.abs(o11 + 20) < 0.3, `Sprünge ${await jumps()}, Versatz ${o11.toFixed(3)} h, Ereignisse ${JSON.stringify([...new Set(await ev<string[]>('window.__tm.events'))])}`);
  await S('Emulation.setTouchEmulationEnabled', { enabled: false });
  await toRealtime();
  await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(200);

  // Senkrechte Wischgeste auf der Spur (bei +20 h angesetzt): Chrome setzt
  // den Wert schon beim Berühren, meldet dann `pointercancel` statt
  // `pointerup`. Danach muss die Anzeige wieder die Szene zeigen. Nur ohne
  // Hinweiszeilen auf 402×874, wo der Körper des Blatts nicht scrollt – siehe
  // die Frist in `send` oben.
  const scrollable = await ev<boolean>(`(() => { const b = ${q(SEL.body)}; return b.scrollHeight > b.clientHeight; })()`);
  g = await sliderGeo();
  await resetCounters();
  try {
    await touchPath(Array.from({ length: 11 }, (_, i) => ({ x: xFor(g, 20), y: g.y - 8 * i })));
    await sleep(1500);
    const t12 = await offsetText();
    const o12 = await ev<number>('window.__tm.offsetH()');
    const ev12 = [...new Set(await ev<string[]>('window.__tm.events'))];
    expect(
      'Senkrechte Wischgeste auf dem Regler: kein Sprung, Anzeige = Szene',
      (await jumps()) === 0 && t12 === '± 0' && Math.abs(o12) < 0.01,
      `Körper scrollbar=${scrollable}, Sprünge ${await jumps()}, Anzeige „${t12}“, Versatz ${o12.toFixed(3)} h, Ereignisse ${JSON.stringify(ev12)}`,
    );
  } catch (err) {
    expect('Senkrechte Wischgeste auf dem Regler', false, `${(err as Error).message} (Körper scrollbar=${scrollable})`);
  }
  await S('Emulation.setTouchEmulationEnabled', { enabled: false });
  // Folgeschritt, bei dem die Szene von der Echtzeit wegläuft: Nach der
  // Wischgeste muss der Abgleich wieder greifen. Bliebe der Zugzustand
  // hängen, stünde die Anzeige auf dem Wert von vorher, und das Verlassen
  // des Reglers spränge auf den nur berührten Wert.
  // Die Anzeige gleicht im Sekundentakt ab, darf also bis zu einer Sekunde
  // Zeitraffer (×600: zehn Minuten) hinter der Szene liegen.
  await resetCounters();
  await click(stageExpr('×600'), '×600');
  await sleep(2500);
  const follow = await sceneVsDisplay();
  const shownMin = follow.text === '± 0' ? 0 : Number((/^\+(\d+) min$/.exec(follow.text) ?? [])[1] ?? NaN);
  const sceneMin = follow.scene * 60;
  expect('Nach der Wischgeste: Anzeige folgt dem Zeitraffer, kein Sprung', (await jumps()) === 0 && shownMin <= sceneMin + 0.5 && shownMin >= sceneMin - 10.5 && sceneMin > 15, `Sprünge ${await jumps()}, Szene ${sceneMin.toFixed(1)} min, Anzeige „${follow.text}“`);
  await toRealtime();

  // AT-Inkrement nachgestellt: `input` + `change` ohne Zeiger oder Taste,
  // so wie VoiceOver den Wert eines Reglers ändert.
  await resetCounters();
  await ev(`(() => { const el = ${q(SEL.slider)}; el.value = String(-3 * 3600000); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(1500);
  const o13 = await ev<number>('window.__tm.offsetH()');
  const valuetext = await ev<string>(`${q(SEL.slider)}.getAttribute('aria-valuetext')`);
  expect('AT-Inkrement: ein Sprung, Anzeige = Szene', (await jumps()) === 1 && Math.abs(o13 + 3) < 0.02 && (await offsetText()) === '-3 h', `Sprünge ${await jumps()}, Versatz ${o13.toFixed(3)} h, Anzeige „${await offsetText()}“`);
  // Chrome zeigt `aria-valuetext` im CDP-Barrierefreiheitsbaum nicht an,
  // auch nicht an einem <div role="slider"> – geprüft wird deshalb das
  // Attribut.
  expect('Regler: aria-valuetext lesbar', valuetext === '3 Stunden zurück', `„${valuetext}“`);
  await toRealtime();

  // Versatz jenseits des Reglerbereichs. Zustand per `jumpTo` hergestellt:
  // Über die Oberfläche bräuchte es 100 s bei ×3600.
  await ev('window.__tm.engine.jumpTo(Date.now() + 100 * 3600000)');
  await sleep(300);
  const far = await offsetText();
  const farValue = await ev<number>(`${q(SEL.slider)}.valueAsNumber`);
  expect('Versatz +100 h: Anzeige ungekappt, Regler am Anschlag', far === '+4 d 4 h' && farValue === 48 * 3600000, `Anzeige „${far}“, Wert ${farValue}`);
  await toRealtime();

  // `touch-action: pan-y` am Regler (index.css). In Chrome nicht über eine
  // Geste prüfbar: Chromium gibt dem inneren Container des Reglers selbst
  // `pan-y` (per CSS.getComputedStyleForNode gesehen) – ein waagerechter Zug
  // verlief ohne die Regel ereignisgleich. Ob WebKit dasselbe tut, lässt
  // sich hier nicht prüfen; deshalb bleibt die Regel und wird als
  // berechneter Stil geprüft.
  const touchAction = await ev<string>(`getComputedStyle(${q(SEL.slider)}).touchAction`);
  expect('Regler: touch-action pan-y', touchAction === 'pan-y', touchAction);

  // Trefferflächen (HIG: 44 × 44 pt).
  const taps = await ev<Array<{ name: string; w: number; h: number }>>(`(() => {
    const out = [];
    const add = (name, el) => { if (!el) return out.push({ name, w: 0, h: 0 }); const r = el.getBoundingClientRect(); out.push({ name, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }); };
    add('Uhr-Knopf', ${q(SEL.toggle)});
    add('Schließen', ${q(SEL.close)});
    add('Jetzt', ${q(SEL.now)});
    document.querySelectorAll('[aria-label="Zeitraffer"] button').forEach((b) => add('Stufe ' + b.textContent.trim(), b));
    return out;
  })()`);
  const sliderH = await ev<number>(`${q(SEL.slider)}.getBoundingClientRect().height`);
  const small = taps.filter((t) => t.w < 44 || t.h < 44);
  expect('Trefferflächen ≥ 44 × 44 px, Regler ≥ 44 px hoch', small.length === 0 && sliderH >= 44, small.map((t) => `${t.name} ${t.w}×${t.h}`).join(', ') || `alle ≥ 44, Regler ${sliderH} px`);

  // Kontrast von „Jetzt“ in Hell und Dunkel.
  for (const theme of ['light', 'dark']) {
    await ev(`window.__tm.st().setTheme(${js(theme)})`);
    await sleep(200);
    const [fg, bg] = await ev<string[]>(`(() => { const cs = getComputedStyle(${q(SEL.now)}); return [cs.color, cs.backgroundColor]; })()`);
    const ratio = contrast(parseCssColor(fg), parseCssColor(bg));
    expect(`„Jetzt“ Kontrast ${theme} ≥ 4,5 : 1`, ratio >= 4.5, `${fg} auf ${bg}: ${ratio.toFixed(2)} : 1`);
  }

  // Nachtmodus: Die gewählte Stufe muss sich in der Helligkeit deutlich
  // abheben – der Rotlichtfilter lässt von Farbtönen nichts übrig. Gemessen
  // am Bildschirmfoto. Die Schwelle trennt die helle Daumenfläche von einer
  // bloßen Akzenttönung der gewählten Stufe, die sich nur schwach abhebt.
  await ev(`(() => { const s = window.__tm.st(); s.setTheme('dark'); if (!s.nightMode) s.toggleNightMode(); })()`);
  await click(stageExpr('×600'), '×600');
  await sleep(400);
  const segLum = async (label: string) => {
    const lums = await clipLuminances(`(${stageExpr(label)})`, 4);
    return lums.reduce((a, b) => a + b, 0) / lums.length;
  };
  const lumActive = await segLum('×600');
  const lumIdle = await segLum('×60');
  const nightRatio = (Math.max(lumActive, lumIdle) + 0.05) / (Math.min(lumActive, lumIdle) + 0.05);
  expect('Nachtmodus: aktive Stufe hebt sich ab (≥ 2 : 1)', lumActive > lumIdle && nightRatio >= 2, `mittlere Leuchtdichte ×600 ${lumActive.toFixed(3)}, ×60 ${lumIdle.toFixed(3)}, ${nightRatio.toFixed(2)} : 1`);
  await ev(`(() => { const s = window.__tm.st(); if (s.nightMode) s.toggleNightMode(); s.setTheme('system'); })()`);

  // Schrift des Echtzeit-Hinweises gegen seine Fläche. Die Fläche ist
  // durchscheinend über dem Himmel, ein berechneter Stil sagt darüber nichts
  // – gemessen wird am Bildschirmfoto: hellstes gegen dunkelstes Pixel (2.
  // und 98. Perzentil, damit Kantenglättung nicht zählt). Der Hinweis steht
  // nur bei zugeklapptem Blatt.
  await click(q(SEL.close), 'Schließen im Blatt');
  for (const theme of ['light', 'dark']) {
    await ev(`window.__tm.st().setTheme(${js(theme)})`);
    await sleep(300);
    for (const [name, expr] of [
      ['Zeit', `document.getElementById('time-notice-text')`],
      ['„Jetzt“', `document.getElementById('time-notice-text').nextElementSibling`],
    ]) {
      const lums = (await clipLuminances(expr)).sort((a, b) => a - b);
      const lo = lums[Math.floor(lums.length * 0.02)];
      const hi = lums[Math.floor(lums.length * 0.98)];
      const ratio = (hi + 0.05) / (lo + 0.05);
      expect(`Hinweis ${name} Kontrast ${theme} ≥ 4,5 : 1`, ratio >= 4.5, `${ratio.toFixed(2)} : 1 (Bildschirmfoto)`);
    }
  }
  await ev(`window.__tm.st().setTheme('system')`);
  await ev('window.__tm.engine.resetToRealTime()');

  // Haarlinien (`.hairline-b`, index.css): nur die untere Kante. Die
  // Tailwind-Preflight gibt jedem Element einen Rahmen in Schriftfarbe mit
  // Breite 0 – eine Regel, die `border-width` für alle Seiten setzt, macht
  // daraus einen Rahmen rundum. Geprüft an Blatt, Telemetrie-Panel und Liste.
  await select(true);
  await click(q(SEL.toggle), 'Uhr-Knopf');
  await ev('window.__tm.st().setDrawerOpen(true)');
  await sleep(700);
  const hairlines = await ev<Array<{ where: string; t: number; r: number; b: number; l: number }>>(`[...document.querySelectorAll('.hairline-b')].filter((e) => e.getClientRects().length).map((e) => { const cs = getComputedStyle(e); return { where: e.closest('[data-hud]')?.getAttribute('data-hud') ?? e.closest('aside, [role="dialog"]')?.tagName ?? e.tagName, t: parseFloat(cs.borderTopWidth), r: parseFloat(cs.borderRightWidth), b: parseFloat(cs.borderBottomWidth), l: parseFloat(cs.borderLeftWidth) }; })`);
  const badHair = hairlines.filter((x) => x.t !== 0 || x.r !== 0 || x.l !== 0 || !(x.b > 0));
  expect('Haarlinien nur unten (Blatt, Panel, Liste)', hairlines.length >= 4 && badHair.length === 0 && hairlines.some((x) => x.where === 'time-sheet'), `${hairlines.length} Elemente, abweichend: ${JSON.stringify(badHair.slice(0, 3))}`);
  await ev('window.__tm.st().setDrawerOpen(false)');
  await sleep(500);
  await setSheet(false);
  await select(false);

  /* ---------------------------------------------------------------- */
  console.log('\n=== c) Screenshots ===');
  await setSheet(false);
  await ev(`window.__tm.st().setTheme('light')`);
  for (const vp of [VIEWPORTS[0], VIEWPORTS[1]]) {
    await viewport(vp);
    await setSheet(false);
    await settle();
    await screenshot(`${vp.w}-zu`);
    await setSheet(true);
    await settle();
    await screenshot(`${vp.w}-offen`);
    await click(stageExpr('×600'), '×600');
    await sleep(600);
    await settle();
    await screenshot(`${vp.w}-zeitraffer-offen`);
    await setSheet(false);
    await settle();
    await screenshot(`${vp.w}-zeitraffer-zu`);
    await setSheet(true);
    await ev(`(() => { const s = window.__tm.st(); s.setTheme('dark'); if (!s.nightMode) s.toggleNightMode(); })()`);
    await sleep(600);
    await screenshot(`${vp.w}-nacht`);
    await ev(`(() => { const s = window.__tm.st(); if (s.nightMode) s.toggleNightMode(); s.setTheme('light'); })()`);
    await toRealtime();
  }
  await viewport(VIEWPORTS[2]);
  await setSheet(true);
  await settle();
  await screenshot('874x402-offen');
  await viewport(VIEWPORTS[6]);
  await select(true);
  await setNotices(true);
  await settle();
  await sleep(300);
  await screenshot('667x375-offen-hinweise-auswahl');
  await setNotices(false);
  await select(false);
  await setSheet(false);
  await ev(`window.__tm.st().setTheme('system')`);

  writeFileSync(`${OUT_DIR}/zeitmaschine-ergebnis.json`, JSON.stringify({ checks, failures, results }, null, 1));
  console.log(`\n${checks} Prüfungen, ${failures} Fehlschläge`);
  // Nur den eigenen Tab schließen. War er der letzte dieser Chrome-Instanz,
  // endet mit ihm der ganze Prozess – deshalb erst prüfen, ob noch ein
  // anderer Tab offen ist.
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
