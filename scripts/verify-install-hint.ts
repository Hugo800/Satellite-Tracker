/**
 * Prüft, wann der Hinweis „Zum Home-Bildschirm“ erscheint
 * (src/utils/installHint.ts), ohne Browser:
 *   1. Variante je User-Agent: nur Handys, nie in der installierten App.
 *   2. Erkennung der installierten App über `navigator.standalone` und
 *      `(display-mode: …)`.
 *   3. Einmal pro Sitzung, auch wenn `sessionStorage` fehlt oder wirft.
 *   4. `beforeinstallprompt` aufheben, Chromes Infoleiste unterdrücken,
 *      bei `appinstalled` verwerfen.
 *   5. Wann die Karte offen ist (Wartezeit, Schließen, Ereignis).
 *   6. Das Ereignis wird nur aufgehoben, wenn der Hinweis noch fällig ist,
 *      und main.tsx tut das vor dem ersten Rendern.
 *
 * Layout, Animation und die Knöpfe selbst wurden im Browser geprüft.
 *
 * Aufruf: npm run verify:install
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INSTALL_HINT_SHOWN_KEY,
  captureInstallPrompt,
  consumeInstallPrompt,
  getInstallPrompt,
  installHintShown,
  installHintOpen,
  installHintVariant,
  isStandalone,
  markInstallHintShown,
  resetInstallHintForTest,
  sessionStorageOf,
  startInstallPromptCapture,
  subscribeInstallPrompt,
  type InstallHintVariant,
} from '../src/utils/installHint';

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
/* 1. Variante je User-Agent                                            */
/* ------------------------------------------------------------------ */

console.log('1. installHintVariant()');

/** Safari ab iOS 26 friert die Systemversion im User-Agent auf 18_6 ein. */
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';

const CASES: Array<[string, string, InstallHintVariant | null]> = [
  ['iPhone Safari', `${IOS} Version/26.0 Mobile/15E148 Safari/604.1`, 'ios'],
  ['iPhone Chrome', `${IOS} CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1`, 'ios'],
  ['iPhone Firefox', `${IOS} FxiOS/143.0 Mobile/15E148 Safari/605.1.15`, 'ios'],
  ['iPod Safari', 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1', 'ios'],
  ['iPhone Instagram', `${IOS} Mobile/15E148 Instagram 400.0.0.0 (iPhone16,1; iOS 18_6; de_DE; de; scale=3.00; 1179x2556; 0)`, 'ios-in-app'],
  ['iPhone Facebook', `${IOS} Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.0;FBBV/1;FBDV/iPhone16,1;FBMD/iPhone;FBSN/iOS;FBSV/18.6;FBSS/3;FBLC/de_DE]`, 'ios-in-app'],
  ['iPhone Google-App', `${IOS} GSA/380.0.0 Mobile/15E148 Safari/604.1`, 'ios-in-app'],
  ['iPhone LINE', `${IOS} Mobile/15E148 Safari Line/14.10.0`, 'ios-in-app'],
  // Gmail, Slack, Reddit & Co. zeigen Links in einem WKWebView ohne Kennung.
  // Dem fehlt das `Safari/`-Token, das Safari, Chrome, Firefox und Edge tragen.
  ['iPhone WKWebView ohne Kennung', `${IOS} Mobile/15E148`, 'ios-in-app'],
  ['iPad (meldet sich als Mac)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', null],
  ['iPad (alter User-Agent)', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', null],
  ['Android Chrome Handy', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', 'android'],
  ['Android Samsung Internet', 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36', 'android'],
  ['Android Edge', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140.0.0.0', 'android'],
  ['Android Firefox Handy', 'Mozilla/5.0 (Android 14; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0', 'android-manual'],
  ['Android Instagram (WebView)', 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36 Instagram 346.0.0.0 Android', 'android-in-app'],
  ['Android WebView ohne Kennung', 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36', 'android-in-app'],
  ['Android Chrome Tablet', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', null],
  ['Android Samsung Internet Tablet', 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Safari/537.36', null],
  ['Android Firefox Tablet', 'Mozilla/5.0 (Android 14; Tablet; rv:143.0) Gecko/143.0 Firefox/143.0', null],
  ['Mac Chrome', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', null],
  ['Windows Firefox', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0', null],
];

for (const [label, userAgent, want] of CASES) {
  const got = installHintVariant({ userAgent, standalone: false });
  expect(label, got === want, `${got} (erwartet ${want})`);
}
for (const [label, userAgent] of CASES) {
  const got = installHintVariant({ userAgent, standalone: true });
  expect(`${label}, installiert`, got === null, `${got} (erwartet null)`);
}

/* ------------------------------------------------------------------ */
/* 2. Installierte App erkennen                                         */
/* ------------------------------------------------------------------ */

console.log('2. isStandalone()');

function fakeWindow(opts: { standalone?: boolean; displayMode?: string | null; noMatchMedia?: boolean }): Window {
  const matchMedia = (query: string) => ({ matches: opts.displayMode != null && query === `(display-mode: ${opts.displayMode})` });
  return {
    navigator: { standalone: opts.standalone },
    ...(opts.noMatchMedia ? {} : { matchMedia }),
  } as unknown as Window;
}

expect('iOS-App', isStandalone(fakeWindow({ standalone: true })), 'navigator.standalone === true');
expect('iOS Safari-Tab', !isStandalone(fakeWindow({ standalone: false })), 'navigator.standalone === false');
for (const mode of ['standalone', 'fullscreen', 'minimal-ui']) {
  expect(`display-mode ${mode}`, isStandalone(fakeWindow({ displayMode: mode })), 'gilt als App');
}
expect('display-mode browser', !isStandalone(fakeWindow({ displayMode: 'browser' })), 'gilt als Tab');
expect('ohne matchMedia', !isStandalone(fakeWindow({ noMatchMedia: true })), 'gilt als Tab, wirft nicht');

/* ------------------------------------------------------------------ */
/* 3. Einmal pro Sitzung                                                */
/* ------------------------------------------------------------------ */

console.log('3. installHintShown() / markInstallHintShown()');

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

const throwing = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
} as unknown as Storage;

resetInstallHintForTest();
{
  const storage = memoryStorage();
  expect('frische Sitzung', !installHintShown(storage), 'noch nicht gezeigt');
  markInstallHintShown(storage);
  expect('Merker gesetzt', storage.getItem(INSTALL_HINT_SHOWN_KEY) === '1', `${INSTALL_HINT_SHOWN_KEY} = 1`);
  resetInstallHintForTest(); // neue Seite in derselben Sitzung (Neuladen)
  expect('nach Neuladen', installHintShown(storage), 'gilt als gezeigt');
  resetInstallHintForTest();
  expect('neuer Tab', !installHintShown(memoryStorage()), 'leerer Speicher, wieder fällig');
}

resetInstallHintForTest();
expect('Speicher wirft beim Lesen', !installHintShown(throwing), 'gilt als nicht gezeigt, wirft nicht');
markInstallHintShown(throwing);
expect('Speicher wirft beim Schreiben', installHintShown(throwing), 'Merker der Seite greift');

resetInstallHintForTest();
expect('ohne Speicher', !installHintShown(undefined), 'gilt als nicht gezeigt');
markInstallHintShown(undefined);
expect('ohne Speicher, danach', installHintShown(undefined), 'Merker der Seite greift');

const lockedWindow = Object.defineProperty({}, 'sessionStorage', {
  get() {
    throw new Error('SecurityError');
  },
}) as Window;
expect('sessionStorage-Zugriff wirft', sessionStorageOf(lockedWindow) === undefined, 'undefined statt Ausnahme');

/* ------------------------------------------------------------------ */
/* 4. beforeinstallprompt                                               */
/* ------------------------------------------------------------------ */

console.log('4. captureInstallPrompt()');

resetInstallHintForTest();
{
  const target = new EventTarget();
  let notified = 0;
  subscribeInstallPrompt(() => (notified += 1));
  const stop = captureInstallPrompt(target);

  const prompt = new Event('beforeinstallprompt', { cancelable: true });
  target.dispatchEvent(prompt);
  expect('Ereignis aufgehoben', getInstallPrompt() === prompt, 'getInstallPrompt() liefert es');
  expect('Infoleiste unterdrückt', prompt.defaultPrevented, 'preventDefault() gerufen');
  expect('Abonnent benachrichtigt', notified === 1, `${notified}× (erwartet 1)`);

  target.dispatchEvent(new Event('appinstalled'));
  expect('appinstalled verwirft', getInstallPrompt() === null, 'getInstallPrompt() ist null');
  expect('Abonnent erneut benachrichtigt', notified === 2, `${notified}× (erwartet 2)`);

  target.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true }));
  consumeInstallPrompt();
  expect('nach prompt() verbraucht', getInstallPrompt() === null, 'getInstallPrompt() ist null');

  stop();
  target.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true }));
  expect('nach Abmelden', getInstallPrompt() === null, 'kein Zugriff mehr auf neue Ereignisse');
}
resetInstallHintForTest();

/* ------------------------------------------------------------------ */
/* 5. Wann die Karte offen ist                                          */
/* ------------------------------------------------------------------ */

console.log('5. installHintOpen()');

const OPEN_CASES: Array<[string, Parameters<typeof installHintOpen>[0], boolean]> = [
  ['iOS nach Wartezeit', { variant: 'ios', due: true, closed: false, hasPrompt: false }, true],
  ['iOS vor Wartezeit', { variant: 'ios', due: false, closed: false, hasPrompt: false }, false],
  ['iOS geschlossen', { variant: 'ios', due: true, closed: true, hasPrompt: false }, false],
  ['kein Hinweis fällig', { variant: null, due: true, closed: false, hasPrompt: true }, false],
  ['Android ohne Ereignis', { variant: 'android', due: true, closed: false, hasPrompt: false }, false],
  ['Android mit Ereignis', { variant: 'android', due: true, closed: false, hasPrompt: true }, true],
  ['Android, Ereignis vor Wartezeit', { variant: 'android', due: false, closed: false, hasPrompt: true }, false],
  ['Firefox Android ohne Ereignis', { variant: 'android-manual', due: true, closed: false, hasPrompt: false }, true],
];
for (const [label, state, want] of OPEN_CASES) {
  const got = installHintOpen(state);
  expect(label, got === want, `${got} (erwartet ${want})`);
}

/* ------------------------------------------------------------------ */
/* 6. Aufheben nur, wenn fällig; Verdrahtung in main.tsx                */
/* ------------------------------------------------------------------ */

console.log('6. startInstallPromptCapture()');

const ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

function eventWindow(userAgent: string, storage: Storage, displayMode: string | null = null): Window {
  return Object.assign(new EventTarget(), {
    navigator: { userAgent },
    matchMedia: (query: string) => ({ matches: displayMode !== null && query === `(display-mode: ${displayMode})` }),
    sessionStorage: storage,
  }) as unknown as Window;
}

function capturesOn(label: string, win: Window, want: boolean): void {
  resetInstallHintForTest();
  const started = startInstallPromptCapture(win);
  const event = new Event('beforeinstallprompt', { cancelable: true });
  win.dispatchEvent(event);
  const caught = getInstallPrompt() === event && event.defaultPrevented;
  expect(label, started === want && caught === want, `gestartet ${started}, aufgehoben ${caught} (erwartet ${want})`);
}

capturesOn('Android, frische Sitzung', eventWindow(ANDROID, memoryStorage()), true);
{
  const shown = memoryStorage();
  shown.setItem(INSTALL_HINT_SHOWN_KEY, '1');
  // Chrome darf seine Infoleiste dann wieder selbst zeigen.
  capturesOn('Android, schon gezeigt', eventWindow(ANDROID, shown), false);
}
capturesOn('Android, installiert', eventWindow(ANDROID, memoryStorage(), 'standalone'), false);
capturesOn('iPhone', eventWindow(`${IOS} Version/26.0 Mobile/15E148 Safari/604.1`, memoryStorage()), false);
capturesOn('Android-Tablet', eventWindow(ANDROID.replace(' Mobile', ''), memoryStorage()), false);
resetInstallHintForTest();

const main = readFileSync(join(process.cwd(), 'src/main.tsx'), 'utf8');
const captureAt = main.indexOf('startInstallPromptCapture(window);');
const renderAt = main.indexOf('createRoot(');
expect(
  'main.tsx vor dem ersten Rendern',
  captureAt >= 0 && captureAt < renderAt,
  captureAt >= 0 ? `Aufruf bei ${captureAt}, createRoot bei ${renderAt}` : 'Aufruf fehlt',
);

console.log(failures === 0 ? `\nAlle ${checks} Prüfungen bestanden.` : `\n${failures} von ${checks} Prüfungen fehlgeschlagen.`);
process.exit(failures === 0 ? 0 : 1);
