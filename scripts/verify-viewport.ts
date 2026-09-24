/**
 * Prüft die Erkennung des Streifens, den iOS unter einer installierten
 * Web-App mit `black-translucent` stehen lässt (src/utils/viewportShortfall.ts),
 * ihre Verdrahtung (src/utils/viewportShortfallWatch.ts) und dass index.html
 * den Stil nicht wieder anfordert.
 *
 * Anlass sind drei Gerätebilder (iPhone 17 Pro, installierte App, Hochformat,
 * 1206 × 2622 px bei 3x, 24.09.2026, 06:25 und zweimal 08:55): In allen dreien
 * ist ab Pixelzeile 2436 jede Zeile über die volle Breite reines #000000 –
 * 186 px = 62,0 pt, exakt der obere Safe-Area-Inset. Das Fenster ist also
 * 874 − 62 = 812 pt hoch. Die Hintergründe stehen in
 * src/utils/viewportShortfall.ts.
 *
 * Aufbau ohne Browser:
 *   1. Die reine Funktion gegen eine Tabelle aus Gerät, Zustand und
 *      erwartetem Ergebnis. Die Zahlen stammen, wo es sie gibt, aus
 *      Messungen: das eigene Gerätebild, zwei Fremdberichte mit
 *      Gerätewerten, der WebKit-Quelltext für das Fingerprinting-Raster.
 *   2. Die Verdrahtung mit einem EventTarget als `window` und `document`:
 *      Wert vor dem ersten Rendern gesetzt, Neumessung bei `resize`,
 *      `orientationchange` (auch im Bild danach), `pageshow` und
 *      `visibilitychange`.
 *   3. index.html fordert `black-translucent` nicht wieder an.
 *
 * Aufruf: npm run verify:viewport
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SHORTFALL_TOLERANCE_PX,
  viewportShortfall,
  type ViewportMetrics,
} from '../src/utils/viewportShortfall';
import {
  VIEWPORT_SHORTFALL_VAR,
  watchViewportShortfall,
} from '../src/utils/viewportShortfallWatch';

let checks = 0;
let failures = 0;

function expect(label: string, ok: boolean, detail: string): void {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${label}: ${detail}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}: ${detail}`);
  }
}

/* ------------------------------------------------------------------ */
/* 1. Reine Funktion                                                    */
/* ------------------------------------------------------------------ */

console.log(`1. viewportShortfall(), Toleranz ${SHORTFALL_TOLERANCE_PX} px`);

/** iPhone 17 Pro: 402 × 874 pt, Dynamic Island, oberer Inset 62, unterer 34. */
const IPHONE_17_PRO = { screenWidth: 402, screenHeight: 874 };

interface Case {
  label: string;
  metrics: ViewportMetrics;
  expected: number;
  why: string;
}

const CASES: Case[] = [
  {
    label: 'iPhone 17 Pro, installiert, hoch, mit Fehler',
    metrics: { iosStandalone: true, innerWidth: 402, innerHeight: 812, ...IPHONE_17_PRO, safeAreaTop: 62 },
    expected: 62,
    why: 'das Gerätebild: 186 px = 62 pt reines Schwarz unter 812 pt Seite',
  },
  {
    label: 'dasselbe, Fehler von Apple behoben',
    metrics: { iosStandalone: true, innerWidth: 402, innerHeight: 874, ...IPHONE_17_PRO, safeAreaTop: 62 },
    expected: 0,
    why: 'volle Höhe, keine Lücke – die Korrektur verschwindet von selbst',
  },
  {
    label: 'dasselbe nach der Umstellung auf `black`',
    metrics: { iosStandalone: true, innerWidth: 402, innerHeight: 812, ...IPHONE_17_PRO, safeAreaTop: 0 },
    expected: 0,
    why: 'Seite beginnt unter der Statusleiste, oberer Inset 0: die Lücke ist die Statusleiste selbst',
  },
  {
    label: 'Safari-Tab, hoch',
    metrics: { iosStandalone: false, innerWidth: 402, innerHeight: 750, ...IPHONE_17_PRO, safeAreaTop: 0 },
    expected: 0,
    why: 'kein Standalone; die Lücke sind Safaris Leisten',
  },
  {
    label: 'Safari-Tab, Lücke zufällig so groß wie der Inset',
    metrics: { iosStandalone: false, innerWidth: 402, innerHeight: 812, ...IPHONE_17_PRO, safeAreaTop: 62 },
    expected: 0,
    why: 'außerhalb der installierten App gibt es den Fehler nicht',
  },
  {
    label: 'iPhone 17 Pro, installiert, quer',
    metrics: { iosStandalone: true, innerWidth: 874, innerHeight: 402, ...IPHONE_17_PRO, safeAreaTop: 0 },
    expected: 0,
    why: 'Statusleiste im Querformat ausgeblendet, oberer Inset 0',
  },
  {
    label: 'dasselbe, Browser tauscht screen beim Drehen',
    metrics: { iosStandalone: true, innerWidth: 874, innerHeight: 402, screenWidth: 874, screenHeight: 402, safeAreaTop: 0 },
    expected: 0,
    why: 'Ergebnis hängt nicht davon ab, ob screen getauscht wird',
  },
  {
    // Angenommen, nicht beobachtet: Das iPad zeigt die Statusleiste auch quer
    // (24 pt). Der Fall prüft, dass die Ausrichtung richtig aufgelöst wird –
    // iOS meldet screen weiter hochkant (834 × 1210).
    label: 'iPad Pro 11″, installiert, quer, mit Fehler (angenommen)',
    metrics: { iosStandalone: true, innerWidth: 1210, innerHeight: 810, screenWidth: 834, screenHeight: 1210, safeAreaTop: 24 },
    expected: 24,
    why: 'volle Höhe quer ist die kürzere Seite, 834 − 810 = 24 = Inset',
  },
  {
    label: 'dasselbe, screen getauscht gemeldet',
    metrics: { iosStandalone: true, innerWidth: 1210, innerHeight: 810, screenWidth: 1210, screenHeight: 834, safeAreaTop: 24 },
    expected: 24,
    why: 'gleiches Ergebnis in beiden Konventionen',
  },
  {
    // Ob der Fehler auf dem SE überhaupt auftritt, ist offen: Der Mechanismus
    // (Fenster um die Statusleiste zu kurz) hängt nicht an
    // der Dynamic Island, aber alle Gerätebelege stammen von Face-ID-Geräten
    // (844, 874, 956 pt). Die Funktion meldet, was sie misst. Auswirkung hat
    // es auf dem SE so oder so keine: Ohne Home-Leiste ist der untere Inset 0,
    // und max(0, 0 − 20) bleibt 0.
    label: 'iPhone SE, installiert, hoch, falls der Fehler dort auftritt',
    metrics: { iosStandalone: true, innerWidth: 375, innerHeight: 647, screenWidth: 375, screenHeight: 667, safeAreaTop: 20 },
    expected: 20,
    why: '667 − 647 = 20 = Inset; --safe-bottom bleibt trotzdem 0',
  },
  {
    label: 'iPhone SE, installiert, hoch, ohne Fehler',
    metrics: { iosStandalone: true, innerWidth: 375, innerHeight: 667, screenWidth: 375, screenHeight: 667, safeAreaTop: 20 },
    expected: 0,
    why: 'volle Höhe',
  },
  {
    // github.com/tpdbf5509/busssss/pull/23: innerHeight 797 bei 844 pt und
    // oberem Inset 47, am Gerät gemessen.
    label: 'Fremdbericht, iPhone 390 × 844, iOS 26.6.1',
    metrics: { iosStandalone: true, innerWidth: 390, innerHeight: 797, screenWidth: 390, screenHeight: 844, safeAreaTop: 47 },
    expected: 47,
    why: '844 − 797 = 47 = Inset',
  },
  {
    // github.com/frankely29/Frontend-github-pages-/pull/1142: Fenster 894 bzw.
    // 956 bei 956 pt, zwei Bilder eine Minute auseinander – der Fehler kommt
    // und geht.
    label: 'Fremdbericht, iPhone 440 × 956, schlechter Start',
    metrics: { iosStandalone: true, innerWidth: 440, innerHeight: 894, screenWidth: 440, screenHeight: 956, safeAreaTop: 62 },
    expected: 62,
    why: '956 − 894 = 62 = Inset',
  },
  {
    label: 'Fremdbericht, iPhone 440 × 956, guter Start',
    metrics: { iosStandalone: true, innerWidth: 440, innerHeight: 956, screenWidth: 440, screenHeight: 956, safeAreaTop: 62 },
    expected: 0,
    why: 'volle Höhe – derselbe Aufruf korrigiert sich zwischen zwei Starts',
  },
  {
    label: 'Android-Chrome-PWA, Lücke zufällig so groß wie der Inset',
    metrics: { iosStandalone: false, innerWidth: 412, innerHeight: 891, screenWidth: 412, screenHeight: 915, safeAreaTop: 24 },
    expected: 0,
    why: 'navigator.standalone gibt es nur auf iOS; screen.height enthält dort die Systemleisten',
  },
  {
    label: 'Desktop',
    metrics: { iosStandalone: false, innerWidth: 1920, innerHeight: 969, screenWidth: 1920, screenHeight: 1080, safeAreaTop: 0 },
    expected: 0,
    why: 'kein iOS, kein Inset',
  },
  {
    label: 'Tastatur offen',
    metrics: { iosStandalone: true, innerWidth: 402, innerHeight: 500, ...IPHONE_17_PRO, safeAreaTop: 62 },
    expected: 0,
    why: 'Lücke 374 passt nicht zum Inset 62',
  },
  {
    label: 'Lücke 1 px über dem Inset (Rundung)',
    metrics: { iosStandalone: true, innerWidth: 402, innerHeight: 811, ...IPHONE_17_PRO, safeAreaTop: 62 },
    expected: 63,
    why: 'innerHeight und screen sind ganzzahlig, der Inset nicht zwingend',
  },
  {
    label: 'Lücke 1 px unter dem Inset (Rundung)',
    metrics: { iosStandalone: true, innerWidth: 402, innerHeight: 813, ...IPHONE_17_PRO, safeAreaTop: 62 },
    expected: 61,
    why: 'innerhalb der Toleranz',
  },
  {
    label: 'Lücke 3 px neben dem Inset',
    metrics: { iosStandalone: true, innerWidth: 402, innerHeight: 809, ...IPHONE_17_PRO, safeAreaTop: 62 },
    expected: 0,
    why: 'außerhalb der Toleranz – eine andere Ursache',
  },
  {
    // WebPageIOS.mm, screenSizeForFingerprintingProtections: für 402 pt Breite
    // meldet WebKit das Raster 414 × 896.
    label: 'Fingerprinting-Schutz aktiv, screen als Raster gemeldet',
    metrics: { iosStandalone: true, innerWidth: 402, innerHeight: 812, screenWidth: 414, screenHeight: 896, safeAreaTop: 62 },
    expected: 0,
    why: 'Breite 402 ≠ 414, Lücke 84 ≠ 62 – die Erkennung bleibt aus, harmlos',
  },
  {
    // Konstruiert: ein Fenster, dem zufällig genau der Inset zur vollen Höhe
    // fehlt, das aber nicht bildschirmbreit ist.
    label: 'iPad mit Stage Manager, schmales Fenster',
    metrics: { iosStandalone: true, innerWidth: 700, innerHeight: 1352, screenWidth: 1032, screenHeight: 1376, safeAreaTop: 24 },
    expected: 0,
    why: 'kein Vollbildfenster, Höhe beliebig',
  },
  {
    label: 'Sonde liefert keinen Wert',
    metrics: { iosStandalone: true, innerWidth: 402, innerHeight: 812, ...IPHONE_17_PRO, safeAreaTop: Number.NaN },
    expected: 0,
    why: 'ohne Inset keine Aussage',
  },
  {
    label: 'Fenster höher als der gemeldete Bildschirm',
    metrics: { iosStandalone: true, innerWidth: 402, innerHeight: 900, ...IPHONE_17_PRO, safeAreaTop: 62 },
    expected: 0,
    why: 'negative Lücke',
  },
];

for (const c of CASES) {
  const got = viewportShortfall(c.metrics);
  expect(c.label, got === c.expected, `erwartet ${c.expected}, erhalten ${got} – ${c.why}`);
}

/* ------------------------------------------------------------------ */
/* 2. Verdrahtung                                                       */
/* ------------------------------------------------------------------ */

console.log('2. watchViewportShortfall(): wann gemessen und geschrieben wird');

interface FakeElement {
  style: { cssText: string };
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
}

class FakeWindow extends EventTarget {
  innerWidth = 402;
  innerHeight = 812;
  screen = { width: 402, height: 874 };
  navigator = { standalone: true };
  /** Was `env(safe-area-inset-top)` in der Sonde gerade ergibt. */
  safeAreaTop = 62;
  private frames = new Map<number, () => void>();
  private nextFrame = 1;

  getComputedStyle(el: FakeElement): { paddingTop: string } {
    // Nur eine Sonde, die den Inset wirklich über env() abfragt, sieht ihn.
    const usesEnv = el.style.cssText.replace(/\s/g, '').includes('padding-top:env(safe-area-inset-top');
    return { paddingTop: usesEnv ? `${this.safeAreaTop}px` : '0px' };
  }

  requestAnimationFrame(callback: () => void): number {
    const id = this.nextFrame++;
    this.frames.set(id, callback);
    return id;
  }

  cancelAnimationFrame(id: number): void {
    this.frames.delete(id);
  }

  /** Führt die angemeldeten Bildrückrufe aus, wie der nächste Frame. */
  flushFrames(): void {
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    for (const callback of callbacks) callback();
  }

  set(metrics: { w: number; h: number; top: number; standalone?: boolean }): void {
    this.innerWidth = metrics.w;
    this.innerHeight = metrics.h;
    this.safeAreaTop = metrics.top;
    if (metrics.standalone !== undefined) this.navigator.standalone = metrics.standalone;
  }
}

class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  appended: FakeElement[] = [];
  body = { appendChild: (el: FakeElement) => this.appended.push(el) };
  rootProps = new Map<string, string>();
  rootWrites = 0;
  documentElement = {
    style: {
      setProperty: (name: string, value: string) => {
        this.rootProps.set(name, value);
        this.rootWrites += 1;
      },
    },
  };

  createElement(): FakeElement {
    return {
      style: { cssText: '' },
      attributes: {},
      setAttribute(name: string, value: string) {
        this.attributes[name] = value;
      },
    };
  }
}

const win = new FakeWindow();
const doc = new FakeDocument();
Object.assign(globalThis, { window: win, document: doc });

const shortfall = () => doc.rootProps.get(VIEWPORT_SHORTFALL_VAR);
const BUG = { w: 402, h: 812, top: 62 };
const FIXED = { w: 402, h: 874, top: 62 };
const LANDSCAPE = { w: 874, h: 402, top: 0 };

{
  watchViewportShortfall();
  const probe = doc.appended[0];
  expect(
    'Wert steht vor dem ersten Rendern',
    shortfall() === '62px',
    `direkt nach dem Aufruf, ohne Bild dazwischen: ${VIEWPORT_SHORTFALL_VAR} = ${shortfall()}`,
  );
  expect(
    'Sonde im Dokument, für Hilfstechnik unsichtbar',
    doc.appended.length === 1 && probe?.attributes['aria-hidden'] === 'true',
    `${doc.appended.length} Element(e) an body gehängt, aria-hidden = ${probe?.attributes['aria-hidden']}`,
  );
}

{
  win.set(FIXED);
  win.dispatchEvent(new Event('resize'));
  expect('resize: Apple behebt den Fehler', shortfall() === '0px', `innerHeight 874 → ${shortfall()}`);
}

{
  win.set(BUG);
  win.dispatchEvent(new Event('pageshow'));
  expect('pageshow: Rückkehr aus dem Back/Forward-Cache', shortfall() === '62px', `innerHeight 812 → ${shortfall()}`);
}

{
  // iOS meldet orientationchange, bevor der Viewport gedreht ist: Die
  // sofortige Messung sieht noch das Hochformat, erst das nächste Bild das
  // Querformat.
  win.dispatchEvent(new Event('orientationchange'));
  const immediate = shortfall();
  win.set(LANDSCAPE);
  win.flushFrames();
  expect(
    'orientationchange: Nachmessung im nächsten Bild',
    immediate === '62px' && shortfall() === '0px',
    `sofort ${immediate} (Viewport noch hochkant), im nächsten Bild ${shortfall()} (quer, Inset 0)`,
  );
}

{
  win.set(BUG);
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  const whileHidden = shortfall();
  doc.visibilityState = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  expect(
    'visibilitychange: gemessen beim Sichtbarwerden',
    whileHidden === '0px' && shortfall() === '62px',
    `beim Verstecken ${whileHidden} (unverändert), beim Zurückkommen ${shortfall()}`,
  );
}

{
  win.set({ ...BUG, standalone: false });
  win.dispatchEvent(new Event('resize'));
  expect('außerhalb der installierten App', shortfall() === '0px', `navigator.standalone false → ${shortfall()}`);
}

{
  const before = doc.rootWrites;
  win.dispatchEvent(new Event('resize'));
  win.flushFrames();
  expect(
    'kein Schreiben ohne Änderung',
    doc.rootWrites === before,
    `${doc.rootWrites - before} Schreibzugriffe bei gleichem Wert (jeder löst eine Stilneuberechnung aus)`,
  );
}

/* ------------------------------------------------------------------ */
/* 3. index.html                                                        */
/* ------------------------------------------------------------------ */

console.log('3. index.html: Statusleistenstil');
{
  // Der Stil ist die eigentliche Ursache des Bands: Mit
  // `black-translucent` und `viewport-fit=cover` fehlt unter der Seite ein
  // Streifen in Höhe der Statusleiste, den keine CSS-Höhe erreicht. Wer ihn
  // bewusst zurückholt, nimmt das Band in Kauf und passt diese Prüfung an.
  // npm startet Skripte im Projektverzeichnis; das Bündel selbst liegt in
  // node_modules/.cache, ein Pfad relativ zu import.meta.url träfe daneben.
  const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
  const style = /<meta\s+name="apple-mobile-web-app-status-bar-style"\s+content="([^"]*)"/.exec(html)?.[1];
  expect(
    'kein black-translucent',
    style !== undefined && style !== 'black-translucent',
    `apple-mobile-web-app-status-bar-style = ${style ?? 'fehlt'}`,
  );
}

console.log(`${checks} Prüfungen, ${failures} Fehlschläge`);
if (failures > 0) process.exit(1);
console.log('✓ Erkennung des Streifens unter der installierten App stimmt');
