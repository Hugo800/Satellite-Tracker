import { useEffect, useRef, useState } from 'react';
import { RadarMap } from './RadarMap';
import { SatelliteDrawer } from './SatelliteDrawer';
import { TelemetryPanel } from './TelemetryPanel';
import { TopBar } from './TopBar';
import { useAppStore } from '../../state/store';

// Mindesthöhe, die der Container von Radar/Panel behält, selbst wenn die
// gemessene TopBar-Unterkante rechnerisch darüber läge (siehe --hud-top-free
// unten). Entspricht der Kopfzeile von TelemetryPanel: eine Reihe
// Icon-Buttons (var(--tap) = 44px) plus deren vertikales Padding (px-3 py-2,
// 2 × 0.5rem) – 60px = 3.75rem. Ohne diese Untergrenze könnte ein extrem
// hoher TopBar-Hinweisstapel auf einem sehr niedrigen Viewport die Kopfzeile
// des Panels (Zuklappen/Schließen) mit aus dem Bild drücken.
const HUD_MIN_BOTTOM_HEIGHT = '3.75rem';

/** 2D-Overlay über dem WebGL-Canvas. Klicks fallen standardmäßig durch. */
export function Hud(): React.JSX.Element {
  const selectedIndex = useAppStore((s) => s.selectedIndex);

  // Auf Telefonbreite ist neben dem ausgeklappten Panel kein Platz mehr fürs
  // Radar, ohne dass beide sich überlagern oder gemeinsam bis in die TopBar
  // reichen (frühere Lösung: eine gemeinsame Spalte am unteren Rand). Sobald
  // ein Objekt gewählt ist, übernimmt die Telemetriekarte die Aufgabe des
  // Radars ohnehin schon – Fadenkreuz-Knopf sowie Elevation/Azimut zeigen,
  // wo der Satellit steht –, das Radar darf also weichen. Ab `sm` ist
  // nebeneinander genug Platz, dort bleibt die alte Anordnung erhalten.
  const hideRadarOnPhone = selectedIndex !== null;

  // Die TopBar wächst mit jeder zusätzlichen Hinweiszeile (Geo-Fehler,
  // Kompasswarnung, Ladefehler) – wie hoch sie am Ende wird, steht erst zur
  // Laufzeit fest. Radar und Telemetrie-Panel dürfen unten nie höher
  // hinauswachsen als bis knapp unter diese tatsächliche Unterkante, sonst
  // verdecken sie die Hinweise. Gemessen wird direkt am DOM-Knoten der
  // TopBar (per ResizeObserver, der reagiert auch auf Layoutwechsel ohne
  // Fenster-Resize, etwa wenn eine Hinweiszeile hinzukommt), das Ergebnis
  // landet als CSS-Variable `--hud-top-free` auf diesem Container und wird
  // unten von beiden Containern gelesen.
  const topBarRef = useRef<HTMLDivElement | null>(null);
  const [hudTopFree, setHudTopFree] = useState(0);

  useEffect(() => {
    const el = topBarRef.current;
    if (!el) return;

    const measure = () => {
      // getBoundingClientRect().bottom ist bereits der Abstand vom oberen
      // Fensterrand in CSS-Pixeln – genau das, was `top` unten braucht.
      setHudTopFree(el.getBoundingClientRect().bottom);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // Zusätzlich auf Drehung/Resize hören: Die TopBar-Breite (und damit ggf.
    // ihr Zeilenumbruch) ändert sich dabei, ihre eigene Höhe beobachtet der
    // ResizeObserver zwar auch, aber ein expliziter Handler kostet nichts
    // und fängt Sonderfälle ab, in denen der Observer-Callback erst mit der
    // nächsten Layout-Runde feuert.
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10"
      style={{ ['--hud-top-free' as string]: `${hudTopFree}px` }}
    >
      <TopBar ref={topBarRef} />

      {/*
        `top` hält das Radar unterhalb der TopBar, auch im Querformat, wo
        TopBar-Hinweise (viele Zeilen bei kurzem Viewport) sonst bis in die
        radar-typische untere linke Ecke reichen konnten – das war schon vor
        dieser Änderung so und ließ sich mit derselben Messgröße lösen wie
        das Panel. `items-end` hält das Radar dabei unten im (jetzt ggf.
        höheren) Container, statt es zu strecken.

        Anders als beim Panel gibt es hier bewusst KEINE Mindesthöhe: Das
        Radar hat eine feste Pixelgröße (SIZE in RadarMap.tsx) und keine
        eigene Kopfzeile, die bedienbar bleiben müsste – anders als beim
        Panel gibt es also keinen Bedienbarkeits-Grund, der eine Überlappung
        rechtfertigen würde. `overflow-hidden` beschneidet das Radar deshalb
        lieber von oben, wenn selbst mit `items-end` nicht mehr genug Höhe
        für die volle Kreisfläche bliebe (extrem kurzer Viewport mit sehr
        vielen Hinweiszeilen), statt es über `top` hinaus in die TopBar
        wachsen zu lassen. Das kommt auch auf echten Geräten vor, ohne
        Auswahl gemessen (24.09.2026, headless Chrome mit echten Insets):
        iPhone SE hochkant mit verweigerter Ortung und zwei Ladefehlern zeigt
        155 von 166 px, zusätzlich mit Kompasswarnung 98 px; iPhone 17 Pro
        quer mit verweigerter Ortung 160 px, mit allen vier Hinweisen nur noch
        38 px. Ein schmaler Streifen Radar ist wenig nützlich – ausblenden oder
        skalieren, wenn es nicht ganz passt, wäre die bessere Lösung.
      */}
      <div
        className={`absolute left-0 bottom-0 z-20 overflow-hidden ${
          hideRadarOnPhone ? 'hidden sm:flex sm:items-end' : 'flex items-end'
        }`}
        style={{
          top: 'calc(var(--hud-top-free) + 0.75rem)',
          paddingBottom: 'calc(var(--safe-bottom) + 0.75rem)',
          paddingLeft: 'calc(var(--safe-left) + 0.75rem)',
        }}
      >
        <RadarMap />
      </div>

      {/*
        Eigener Container statt einer gemeinsamen Zeile mit dem Radar: Das
        Panel ist damit auf Telefonbreite ein Bottom-Sheet über die volle
        Breite (abzüglich Safe-Area und Seitenabstand), das ausschließlich am
        unteren Rand wächst und seine Höhe selbst begrenzt (siehe
        TelemetryPanel). Ab `sm` steht es rechts unten neben dem Radar, wie
        zuvor.

        `top` ist zusätzlich über `min()` nach oben gedeckelt: Normalerweise
        beginnt der Container knapp unter der TopBar (--hud-top-free), aber
        wenn diese so hoch wird, dass dafür nicht einmal mehr
        HUD_MIN_BOTTOM_HEIGHT übrig bliebe, gewinnt die Untergrenze – der
        Container behält dann seine Mindesthöhe und wandert stattdessen unter
        die TopBar. Damit bleibt wenigstens die Kopfzeile des Panels
        (Zuklappen/Schließen) immer bedienbar. Das greift auch auf echten
        Geräten: iPhone 17 Pro quer mit allen vier Hinweisen lässt nur die
        60 px hohe Kopfzeile übrig, 2 px unter der TopBar (gemessen
        24.09.2026). Mit kürzeren Viewports überdeckt die Kopfzeile die
        TopBar dann teilweise. In diesem
        Grenzfall nimmt die Kopfzeile bewusst den Vorrang vor lückenloser
        Nicht-Überlappung – ein bedienbares, aber teilweise verdecktes Panel
        ist besser als eines, dessen Schließen-Knopf gar nicht erreichbar
        ist. `items-end` verhindert, dass das Panel den (durch `top` und
        `bottom` nun explizit hohen) Container vertikal ausfüllt.
      */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end justify-end"
        style={{
          top: `min(calc(var(--hud-top-free) + 0.75rem), calc(100% - ${HUD_MIN_BOTTOM_HEIGHT} - var(--safe-bottom) - 0.75rem))`,
          paddingBottom: 'calc(var(--safe-bottom) + 0.75rem)',
          paddingLeft: 'calc(var(--safe-left) + 0.75rem)',
          paddingRight: 'calc(var(--safe-right) + 0.75rem)',
        }}
      >
        <TelemetryPanel />
      </div>

      <SatelliteDrawer />
    </div>
  );
}
