/**
 * Hinweis „Zum Home-Bildschirm hinzufügen“: Wann er erscheint und in welcher
 * Form. Die Komponente dazu ist src/components/ui/InstallHint.tsx, geprüft
 * wird beides in scripts/verify-install-hint.ts.
 *
 * Regeln (Wunsch 10.10.2026): nur auf dem Handy, nie in der installierten
 * App, einmal pro Sitzung, kein „Nicht mehr anzeigen“.
 *
 * Erkennen lässt sich die installierte App nur von innen: Über das Icon
 * gestartet gilt `(display-mode: standalone)`, auf iOS zusätzlich
 * `navigator.standalone`. Ob jemand die App schon installiert hat, sie aber
 * im Browser-Tab öffnet, sieht die Seite auf iOS nicht – dafür steht der Satz
 * „Schon installiert?“ im Hinweis. Chromium auf Android verrät es indirekt:
 * Dort feuert `beforeinstallprompt` nicht, solange die App installiert ist
 * (dokumentiertes Verhalten, web.dev „Installation prompt“). Der Hinweis
 * wartet dort deshalb auf das Ereignis und erscheint ohne es gar nicht.
 */

/**
 * - `ios`: iPhone in Safari oder einem anderen Browser (Chrome, Firefox, Edge
 *   können seit iOS 16.4 über das Teilen-Menü hinzufügen).
 * - `ios-in-app`: iPhone im Browser einer anderen App (Instagram, Gmail …),
 *   dort fehlt „Zum Home-Bildschirm“.
 * - `android`: Chromium-Browser auf einem Android-Handy, Installation über
 *   `beforeinstallprompt`.
 * - `android-manual`: Firefox auf einem Android-Handy, kennt das Ereignis
 *   nicht, Installation über das Browsermenü.
 * - `android-in-app`: WebView einer anderen App.
 */
export type InstallHintVariant =
  | 'ios'
  | 'ios-in-app'
  | 'android'
  | 'android-manual'
  | 'android-in-app';

export interface InstallEnvironment {
  userAgent: string;
  /** Läuft als installierte App (siehe {@link isStandalone}). */
  standalone: boolean;
}

/**
 * Browser in fremden Apps, gekennzeichnet im User-Agent. `GSA/` ist die
 * Google-App. Auf iOS fängt zusätzlich das fehlende `Safari/`-Token jeden
 * WKWebView ohne Kennung (Gmail, Slack, Reddit …); Safari, Chrome, Firefox
 * und Edge tragen es. WhatsApp und Telegram öffnen Links in einem
 * SFSafariViewController, dessen User-Agent sich von Safari nicht
 * unterscheidet – die fallen durch.
 */
const IN_APP_BROWSER = /FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|MicroMessenger|Snapchat|musical_ly|BytedanceWebview|\bLine\/|GSA\//;

/**
 * Welcher Hinweis passt, oder `null` für keinen.
 *
 * „Handy“ heißt hier: iPhone/iPod oder Android mit `Mobile` im User-Agent.
 * Android-Tablets lassen `Mobile` weg (Chrome) bzw. schreiben `Tablet`
 * (Firefox). Das iPad meldet sich seit iPadOS 13 als Mac und fällt damit
 * ebenso heraus wie ein iPhone mit „Desktop-Website anfordern“.
 */
export function installHintVariant(env: InstallEnvironment): InstallHintVariant | null {
  if (env.standalone) return null;
  const ua = env.userAgent;

  if (/iPhone|iPod/.test(ua)) {
    return IN_APP_BROWSER.test(ua) || !/Safari\//.test(ua) ? 'ios-in-app' : 'ios';
  }

  if (/Android/.test(ua) && /Mobile/.test(ua)) {
    if (IN_APP_BROWSER.test(ua) || /; wv\)/.test(ua)) return 'android-in-app';
    return /Firefox\//.test(ua) ? 'android-manual' : 'android';
  }

  return null;
}

/** Ob die Seite als installierte App läuft. */
export function isStandalone(win: Window): boolean {
  if ((win.navigator as (Navigator & { standalone?: boolean }) | undefined)?.standalone === true) return true;
  return ['standalone', 'fullscreen', 'minimal-ui'].some(
    (mode) => win.matchMedia?.(`(display-mode: ${mode})`).matches === true,
  );
}

/**
 * {@link installHintVariant} für das laufende Fenster. `?.`, weil die
 * Node-Prüfskripte das HUD mit einem Fenster ohne `navigator` rendern.
 */
export function currentInstallHintVariant(win: Window): InstallHintVariant | null {
  return installHintVariant({ userAgent: win.navigator?.userAgent ?? '', standalone: isStandalone(win) });
}

/** Schon der Zugriff auf `sessionStorage` kann werfen (gesperrte Website-Daten). */
export function sessionStorageOf(win: Window): Storage | undefined {
  try {
    return win.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Ob die Karte zu sehen ist: Variante fällig, Wartezeit um, nicht
 * geschlossen. Auf Chromium zusätzlich erst mit `beforeinstallprompt` – ohne
 * das Ereignis ist die App installiert oder nicht installierbar, ein Hinweis
 * liefe ins Leere.
 */
export function installHintOpen(state: {
  variant: InstallHintVariant | null;
  due: boolean;
  closed: boolean;
  hasPrompt: boolean;
}): boolean {
  if (state.variant === null || !state.due || state.closed) return false;
  return state.variant !== 'android' || state.hasPrompt;
}

/* ------------------------------------------------------------------ */
/* Einmal pro Sitzung                                                   */
/* ------------------------------------------------------------------ */

export const INSTALL_HINT_SHOWN_KEY = 'orbital-atlas:install-hint-shown';

/**
 * Ersatz, wenn `sessionStorage` fehlt oder wirft (privates Fenster, gesperrte
 * Website-Daten): Dann gilt die Sitzung nur bis zum Neuladen.
 */
let shownInThisPage = false;

/**
 * Ob der Hinweis in dieser Sitzung schon zu sehen war. Sitzung im Sinne von
 * `sessionStorage`: Sie überlebt Neuladen und Rückkehr aus dem Hintergrund
 * und endet mit dem Tab.
 */
export function installHintShown(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  if (shownInThisPage) return true;
  try {
    return storage?.getItem(INSTALL_HINT_SHOWN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markInstallHintShown(storage: Pick<Storage, 'setItem'> | undefined): void {
  shownInThisPage = true;
  try {
    storage?.setItem(INSTALL_HINT_SHOWN_KEY, '1');
  } catch {
    // Ohne Speicher bleibt es beim Merker für diese Seite.
  }
}

/** Nur für scripts/verify-install-hint.ts. */
export function resetInstallHintForTest(): void {
  shownInThisPage = false;
  deferredPrompt = null;
  listeners.clear();
}

/* ------------------------------------------------------------------ */
/* beforeinstallprompt (Chromium)                                       */
/* ------------------------------------------------------------------ */

/** Nicht in lib.dom.d.ts, weil es nur Chromium kennt. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function setDeferredPrompt(event: BeforeInstallPromptEvent | null): void {
  deferredPrompt = event;
  for (const listener of listeners) listener();
}

/** Für `useSyncExternalStore`: das aufgehobene Ereignis oder `null`. */
export function getInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Nach `prompt()`: Das Ereignis lässt sich nur einmal verwenden. */
export function consumeInstallPrompt(): void {
  setDeferredPrompt(null);
}

/**
 * Hebt `beforeinstallprompt` auf und unterdrückt dabei Chromes eigene
 * Mini-Infoleiste, damit nicht zwei Hinweise erscheinen. `appinstalled`
 * verwirft das Ereignis wieder, der Hinweis verschwindet dann.
 *
 * Aufgerufen über {@link startInstallPromptCapture}.
 */
export function captureInstallPrompt(target: EventTarget): () => void {
  const onPrompt = (event: Event) => {
    event.preventDefault();
    setDeferredPrompt(event as BeforeInstallPromptEvent);
  };
  const onInstalled = () => setDeferredPrompt(null);
  target.addEventListener('beforeinstallprompt', onPrompt);
  target.addEventListener('appinstalled', onInstalled);
  return () => {
    target.removeEventListener('beforeinstallprompt', onPrompt);
    target.removeEventListener('appinstalled', onInstalled);
  };
}

/**
 * Aus main.tsx vor dem ersten Rendern, nicht aus der Komponente: Das
 * Ereignis kann vor dem ersten Commit kommen und käme dann nie wieder.
 * Nur wenn der Hinweis noch fällig ist (Variante `android`, in dieser
 * Sitzung nicht gezeigt). Sonst bliebe Tablets, Desktop und jedem Neuladen
 * Chromes eigene Infoleiste verwehrt, ohne dass ein eigener Hinweis sie
 * ersetzt. Liefert, ob aufgehoben wird.
 */
export function startInstallPromptCapture(win: Window): boolean {
  if (currentInstallHintVariant(win) !== 'android') return false;
  if (installHintShown(sessionStorageOf(win))) return false;
  captureInstallPrompt(win);
  return true;
}
