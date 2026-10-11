/**
 * Himmel unter Safaris Statusleiste und Toolbar (iOS 26+, Safari-Tab).
 *
 * Safari zeigt Seiteninhalt unter seinen Leisten nur, solange das Dokument
 * gescrollt ist. Bei Scrollposition 0 – und erst recht auf einer Seite, die
 * gar nicht scrollen kann – füllt es beide Leisten deckend mit einer
 * gemessenen Farbe, hier dem `#000` der Wurzel: oben und unten je ein
 * schwarzer Balken mit harter Kante zum Himmel. Fest positionierte Elemente
 * schneidet Safari zudem am inneren Viewport ab, ein `position: fixed`
 * verlängerter Himmel reicht also nicht unter die Leisten.
 *
 * Deshalb liegt die App in diesem Modus im Fluss: `body` bekommt oben und
 * unten einen Rand (`--bleed-top`/`--bleed-bottom`), der Himmel ragt in beide
 * hinein (index.css, `html.sky-bleed`), und die Seite parkt auf
 * Scrollposition `--bleed-top`. Dann gilt das Dokument als gescrollt, und der
 * Himmel läuft unter beiden Leisten weiter. Die Bedienoberfläche bleibt im
 * sichtbaren Bereich, weil #root genau diesen Bereich abdeckt.
 *
 * Zieht man auf der Bedienoberfläche, kann die Seite um den Rand verrutschen
 * (der Himmel selbst sperrt das per `touch-action: none`); nach kurzer Ruhe
 * kehrt sie in die Parkposition zurück.
 *
 * Die installierte App betrifft das nicht: Dort gibt es keine Safari-Leisten,
 * die Statusleiste regelt `apple-mobile-web-app-status-bar-style`.
 */
export function startSkyBleed(): void {
  const iosSafariTab =
    CSS.supports('-webkit-touch-callout', 'none') &&
    (window.navigator as Navigator & { standalone?: boolean }).standalone !== true &&
    !window.matchMedia('(display-mode: standalone)').matches;
  if (!iosSafariTab) return;

  // Statusleiste bis 62 pt (Dynamic Island); unten Toolbar bis zur
  // Unterkante, am iPhone 17 Pro 98 pt unter dem Layout-Viewport, mit Reserve
  // für die eingeklappte Leiste. Zu viel Rand kostet nur unsichtbare Pixel.
  const top = 62;
  const bottom = 136;

  const root = document.documentElement;
  root.style.setProperty('--bleed-top', `${top}px`);
  root.style.setProperty('--bleed-bottom', `${bottom}px`);
  root.classList.add('sky-bleed');
  window.history.scrollRestoration = 'manual';

  const park = (behavior: ScrollBehavior) => {
    if (Math.abs(window.scrollY - top) > 0.5) window.scrollTo({ top, behavior });
  };

  let timer = 0;
  window.addEventListener(
    'scroll',
    () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => park('smooth'), 250);
    },
    { passive: true },
  );
  window.addEventListener('resize', () => park('instant'));
  window.addEventListener('pageshow', () => park('instant'));
  park('instant');
}
