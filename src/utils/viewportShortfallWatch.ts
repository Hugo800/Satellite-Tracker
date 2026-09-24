import { viewportShortfall } from './viewportShortfall';

/**
 * CSS-Variable mit der Höhe des Streifens unter der Seite (siehe
 * src/utils/viewportShortfall.ts). index.css zieht sie vom unteren
 * Safe-Area-Inset ab; ohne Befund ist sie `0px`.
 */
export const VIEWPORT_SHORTFALL_VAR = '--viewport-shortfall';

/**
 * Misst den Streifen sofort und danach bei jeder Gelegenheit, bei der er
 * entstehen oder verschwinden kann, und schreibt das Ergebnis als
 * `--viewport-shortfall` auf `<html>`.
 *
 * Aufgerufen in main.tsx vor dem ersten Rendern, damit das HUD nicht erst mit
 * dem falschen Abstand erscheint. Einmal pro Seite; ein Abmelden braucht es
 * nicht, weil die Messung so lange gilt wie das Dokument.
 */
export function watchViewportShortfall(): void {
  // `env()` lässt sich nicht direkt aus JavaScript lesen, wohl aber als
  // berechneter Wert einer Eigenschaft, die es verwendet. Fest positioniert
  // und ohne Ausmaße beeinflusst die Sonde kein Layout.
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;visibility:hidden;' +
    'pointer-events:none;padding-top:env(safe-area-inset-top,0px)';
  document.body.appendChild(probe);

  const root = document.documentElement;
  let applied = '';

  const measure = () => {
    const shortfall = viewportShortfall({
      iosStandalone: (window.navigator as Navigator & { standalone?: boolean }).standalone === true,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      safeAreaTop: Number.parseFloat(window.getComputedStyle(probe).paddingTop),
    });
    const value = `${shortfall}px`;
    if (value === applied) return;
    applied = value;
    root.style.setProperty(VIEWPORT_SHORTFALL_VAR, value);
  };

  // Sofort und noch einmal im nächsten Bild: iOS meldet `orientationchange`,
  // bevor Viewport und Insets die neue Ausrichtung haben; `resize` kommt erst
  // danach, aber nicht in jedem Fall (etwa beim Wechsel aus dem Hintergrund).
  let frame = 0;
  const schedule = () => {
    measure();
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(measure);
  };

  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  // Beim Aufwachen aus dem Hintergrund und bei der Rückkehr aus dem
  // Back/Forward-Cache kann die App gedreht worden sein, ohne dass die Seite
  // davon ein `resize` bekam.
  window.addEventListener('pageshow', schedule);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule();
  });

  measure();
}
