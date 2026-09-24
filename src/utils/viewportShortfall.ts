/**
 * Erkennt den Streifen, den iOS unter einer installierten Web-App stehen
 * lässt, wenn sie mit `apple-mobile-web-app-status-bar-style:
 * black-translucent` läuft – nur aus Größen, die die Seite selbst messen
 * kann. Reine Funktion ohne Browserzugriff, geprüft in
 * scripts/verify-viewport.ts; eingehängt wird sie in
 * src/utils/viewportShortfallWatch.ts.
 *
 * Befund (iPhone 17 Pro, installierte App, Hochformat, 1206 × 2622 px bei 3x =
 * 402 × 874 pt, drei Bildschirmfotos vom 24.09.2026, 06:25 und 08:55): Ab
 * Pixelzeile 2436 bis zur Unterkante ist jede Zeile über die volle Breite
 * reines #000000 – 186 px = 62,0 pt, exakt der obere Safe-Area-Inset. Direkt
 * darüber endet der Canvas mit dem gewollt fast schwarzen Boden aus
 * HorizonGrid, der nicht durchgehend reines Schwarz ist. Die Seite beginnt
 * also bei y = 0 unter der
 * Statusleiste, ist aber nur 874 − 62 = 812 pt hoch.
 *
 * Einen WebKit-Bug, der genau das beschreibt, haben wir nicht gefunden.
 * WebKit-Bug 301108 ist ähnlich, betrifft aber Safari-Tabs mit durchsichtiger
 * Adressleiste, nicht installierte Apps. Beobachtet ist: Mit
 * `black-translucent` UND `viewport-fit=cover` zeichnet iOS ab der echten
 * Oberkante, rechnet die Fensterhöhe aber, als läge die Seite unter der
 * Statusleiste. Der Streifen darunter liegt AUSSERHALB der Zeichenfläche des
 * WebViews – am Gerät belegt von einem anderen Projekt
 * (github.com/tpdbf5509/busssss/pull/23, iPhone 390 × 844 pt, iOS 26.6.1):
 * innerHeight, visualViewport.height, 100vh und 100dvh maßen dort 797 =
 * 844 − 47; eine Box, die per CSS auf 891 px wuchs, zeichnete trotzdem nur
 * bis 797, und eine Markierung am Ende eines 844 px hohen `body` erschien nie.
 * Die Wurzel zu verlängern füllt das Band also nicht, sondern schiebt nur die
 * unteren Bedienelemente aus dem Bild. Dasselbe Muster mit 62 pt auf einem
 * 956-pt-iPhone: github.com/frankely29/Frontend-github-pages-/pull/1142.
 *
 * Beheben soll das Band deshalb index.html (Statusleistenstil `black` statt
 * `black-translucent`) – am Gerät ungeprüft, belegt ist nur `default` im
 * genannten Projekt. Diese Erkennung deckt ab, was danach noch
 * vorkommen kann – eine vor der Umstellung installierte App, deren
 * Startkonfiguration iOS mit dem Symbol zwischenspeichert (von mehreren
 * Projekten berichtet, hier nicht geprüft), oder ein iOS, das den Stil
 * ignoriert. Dann meldet WebKit weiter `env(safe-area-inset-bottom)` = 34 pt,
 * als reiche die Seite bis zur Home-Leiste; tatsächlich endet sie 62 pt
 * darüber. Das HUD stand dadurch 34 + 12 pt über einer Kante, die selbst schon
 * 62 pt über dem Bildschirmrand liegt (Panel-Unterkante im Bild bei rund
 * 765 pt statt 828 pt). index.css zieht die hier ermittelte Höhe deshalb vom
 * unteren Inset ab.
 *
 * Warum der Inset und nicht die Höhe korrigiert wird: Ob der Streifen
 * bemalbar ist, lässt sich aus der Seite heraus nicht unterscheiden – beide
 * Fälle liefern dieselben Zahlen. Den Inset zu verkleinern ist in beiden
 * richtig: Die Unterkante der Seite liegt um D über dem Bildschirmrand, die
 * Home-Leiste also zum Teil oder ganz im Streifen, und von ihr ragt nur
 * max(0, Inset − D) in die Seite hinein. Eine verlängerte Wurzel wäre nur im
 * bemalbaren Fall richtig und im belegten Fall schädlich.
 */

export interface ViewportMetrics {
  /**
   * `navigator.standalone === true`. Das Feld gibt es nur auf iOS/iPadOS.
   * Bewusst nicht `(display-mode: standalone)`: Das gilt auch für Android- und
   * Desktop-PWAs, und auf Android enthält `screen.height` die Systemleisten –
   * eine Lücke, die dort zufällig so groß wie der obere Inset ist, bedeutet
   * nichts, und ein verkleinerter unterer Inset schöbe Bedienelemente unter
   * die Gestenleiste.
   */
  iosStandalone: boolean;
  /** `window.innerWidth` in CSS-Pixeln. */
  innerWidth: number;
  /** `window.innerHeight` in CSS-Pixeln. */
  innerHeight: number;
  /**
   * `screen.width` / `screen.height`. Auf iOS bleiben das beim Drehen die
   * Hochformatwerte. Quelle: WebKit, Stand main 5e551b0a (24.09.2026) –
   * Source/WebCore/page/Screen.cpp: `Screen::height()` liefert
   * `LocalFrame::screenSize().height()` und vertauscht nur unter dem
   * Site-Quirk `ShouldFlipScreenDimensionsQuirk` (rdar://133423460), den es
   * gar nicht bräuchte, wenn iOS selbst tauschen würde;
   * Source/WebCore/platform/ios/PlatformScreenIOS.mm: `screenRect` ist
   * `UIScreen._referenceBounds`, ohne jede Ausrichtungslogik dazwischen.
   * Die Funktion verlässt sich trotzdem nicht darauf: Sie nimmt im Hochformat
   * die längere, im Querformat die kürzere Seite als volle Höhe – richtig für
   * iOS und für Browser, die beim Drehen tauschen.
   *
   * Mit aktivem Fingerprinting-Schutz meldet WebKit auf dem iPhone statt der
   * echten Größe ein Raster (320 × 568, 375 × 667, 390 × 844, 414 × 896;
   * Source/WebKit/WebProcess/WebPage/ios/WebPageIOS.mm,
   * `screenSizeForFingerprintingProtections`), für 402 pt Breite also
   * 414 × 896. Dann passen weder Breite noch Lücke, und die Erkennung bleibt
   * aus – harmlos, nur ohne Gewinn.
   */
  screenWidth: number;
  screenHeight: number;
  /**
   * `env(safe-area-inset-top)` in CSS-Pixeln, gemessen über ein Probe-Element
   * mit `padding-top: env(safe-area-inset-top)`. NaN, wenn die Messung
   * scheitert – dann ist das Ergebnis 0.
   */
  safeAreaTop: number;
}

/**
 * Erlaubte Abweichung zwischen Lücke und oberem Inset in CSS-Pixeln.
 * `innerHeight` und `screen.height` sind ganzzahlig (`Screen::height()` castet
 * auf `int`), der Inset nicht zwingend; drei Rundungen zu je höchstens
 * 0,5 px ergeben höchstens 1,5 px. Jede andere Ursache für eine Lücke –
 * Tastatur, Split View, Browserleisten – liegt um Dutzende bis Hunderte Pixel
 * daneben.
 */
export const SHORTFALL_TOLERANCE_PX = 2;

/**
 * Höhe des Streifens zwischen der Unterkante der Seite und dem
 * Bildschirmrand in CSS-Pixeln, oder 0.
 *
 * Größer 0 nur, wenn alles zusammenpasst: iOS-Standalone, ein oberer Inset
 * größer 0, ein Fenster über die volle Bildschirmbreite, und eine Lücke
 * zwischen voller Bildschirmhöhe und `innerHeight`, die innerhalb der Toleranz
 * genau dem oberen Inset entspricht. Behebt Apple den Fehler, ist
 * `innerHeight` die volle Höhe, die Lücke 0 – und das Ergebnis von selbst 0.
 */
export function viewportShortfall(m: ViewportMetrics): number {
  if (!m.iosStandalone) return 0;

  const values = [m.innerWidth, m.innerHeight, m.screenWidth, m.screenHeight, m.safeAreaTop];
  if (!values.every((v) => Number.isFinite(v))) return 0;
  // Ohne oberen Inset (Querformat auf dem iPhone, Geräte ohne Statusleiste
  // über der Seite) hat der Fehler nichts, das er abziehen könnte.
  if (m.safeAreaTop <= 0) return 0;

  // Ausrichtung wie die CSS-Mediaabfrage `orientation`: Hochformat, wenn der
  // Viewport mindestens so hoch wie breit ist.
  const portrait = m.innerHeight >= m.innerWidth;
  const longSide = Math.max(m.screenWidth, m.screenHeight);
  const shortSide = Math.min(m.screenWidth, m.screenHeight);
  const fullWidth = portrait ? shortSide : longSide;
  const fullHeight = portrait ? longSide : shortSide;

  // Nur ein Fenster über die volle Bildschirmbreite kann ein Vollbild sein,
  // dem unten etwas fehlt. Schließt Split View und Stage Manager auf dem iPad
  // aus, deren Fenster beliebig hoch sein können, und das Fingerprinting-
  // Raster, das eine falsche Bildschirmgröße meldet.
  if (Math.abs(m.innerWidth - fullWidth) > SHORTFALL_TOLERANCE_PX) return 0;

  const gap = fullHeight - m.innerHeight;
  if (gap <= 0) return 0;
  if (Math.abs(gap - m.safeAreaTop) > SHORTFALL_TOLERANCE_PX) return 0;
  return gap;
}
