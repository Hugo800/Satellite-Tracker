import { useEffect, useState, useSyncExternalStore } from 'react';
import { Ellipsis, EllipsisVertical, Share, SquarePlus, X, type LucideIcon } from 'lucide-react';
import {
  consumeInstallPrompt,
  currentInstallHintVariant,
  getInstallPrompt,
  installHintOpen,
  installHintShown,
  markInstallHintShown,
  sessionStorageOf,
  subscribeInstallPrompt,
  type InstallHintVariant,
} from '../../utils/installHint';

/**
 * Wartezeit nach dem Start. Der Hinweis soll nicht mit dem ersten Bild und
 * der Standortabfrage zugleich aufspringen.
 */
const SHOW_DELAY_MS = 2000;

// `?.` wie in src/state/runtime.ts: Die Node-Prüfskripte bündeln ohne Vite.
const ICON = `${import.meta.env?.BASE_URL ?? './'}icons/apple-touch-icon.png`;

/** Inline-Symbol in einer Anleitungszeile, so groß wie die Schrift. */
function Glyph({ icon: Icon }: { icon: LucideIcon }): React.JSX.Element {
  return <Icon size={15} strokeWidth={2.2} className="inline-block align-[-2px] text-accent" aria-hidden />;
}

function Steps({ variant }: { variant: InstallHintVariant }): React.JSX.Element {
  switch (variant) {
    case 'ios':
      return (
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            Tippe auf <Glyph icon={Share} /> „Teilen“, in Safari ggf. zuerst auf <Glyph icon={Ellipsis} />.
          </li>
          <li>
            Wähle <Glyph icon={SquarePlus} /> „Zum Home-Bildschirm“.
          </li>
        </ol>
      );
    case 'android-manual':
      return (
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            Tippe auf <Glyph icon={EllipsisVertical} /> im Browser.
          </li>
          <li>Wähle „Installieren“ oder „Zum Startbildschirm hinzufügen“.</li>
        </ol>
      );
    case 'ios-in-app':
      return <p>Öffne diese Seite über das Menü der App in Safari. Dort kannst du sie zum Home-Bildschirm hinzufügen.</p>;
    case 'android-in-app':
      return <p>Öffne diese Seite über das Menü der App im Browser, etwa in Chrome. Dort kannst du sie installieren.</p>;
    case 'android':
      return <p>Installiere Orbital Atlas auf deinem Startbildschirm.</p>;
  }
}

/**
 * Hinweis, die Seite als App auf den Home-Bildschirm zu legen. Wann er
 * erscheint, entscheidet src/utils/installHint.ts: nur auf dem Handy, nicht in
 * der installierten App, einmal pro Sitzung. Ohne Scrim: Die Szene bleibt
 * bedienbar, die Karte liegt aber über Radar und Telemetrie, bis sie über das
 * X oder den Installieren-Knopf schließt. Das Menü (SatelliteDrawer) legt
 * sich darüber.
 */
export function InstallHint(): React.JSX.Element | null {
  // Einmal beim Einhängen: Ein Neuladen in derselben Sitzung findet den
  // Merker und zeigt nichts mehr.
  const [variant] = useState(() =>
    installHintShown(sessionStorageOf(window)) ? null : currentInstallHintVariant(window),
  );
  const prompt = useSyncExternalStore(subscribeInstallPrompt, getInstallPrompt, getInstallPrompt);
  const [due, setDue] = useState(false);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (!variant) return;
    const id = window.setTimeout(() => setDue(true), SHOW_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [variant]);

  const open = installHintOpen({ variant, due, closed, hasPrompt: prompt !== null });

  // Erst als gezeigt merken, wenn er wirklich zu sehen ist – wer vor Ablauf
  // der Wartezeit neu lädt, bekommt ihn noch.
  useEffect(() => {
    if (open) markInstallHintShown(sessionStorageOf(window));
  }, [open]);

  if (!open || variant === null) return null;

  const install = () => {
    if (!prompt) return;
    // `prompt()` braucht die Nutzergeste, also vor allem anderen.
    void prompt.prompt().catch(() => undefined);
    consumeInstallPrompt();
    setClosed(true);
  };

  const homeScreen = variant.startsWith('android') ? 'Startbildschirm' : 'Home-Bildschirm';

  return (
    <aside
      aria-labelledby="install-hint-title"
      className="install-hint-in material-strong pointer-events-auto fixed z-[25] mx-auto max-w-[24rem] rounded-[var(--radius-lg)] p-3"
      style={{
        left: 'calc(var(--safe-left) + 0.75rem)',
        right: 'calc(var(--safe-right) + 0.75rem)',
        bottom: 'calc(var(--safe-bottom) + 0.75rem)',
      }}
    >
      <div className="flex items-start gap-3">
        <img src={ICON} alt="" width={44} height={44} className="shrink-0 rounded-[10px]" />
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 id="install-hint-title" className="text-[15px] font-semibold tracking-[-0.01em] text-label">
            Orbital Atlas als App
          </h2>
          <p className="text-[13px] text-label-2">Startet im Vollbild, ohne Browserleisten.</p>
        </div>
        <button
          type="button"
          aria-label="Hinweis schließen"
          className="icon-button -mr-1 -mt-1 shrink-0"
          onClick={() => setClosed(true)}
        >
          <X size={19} strokeWidth={2} aria-hidden />
        </button>
      </div>

      <div className="mt-2 text-[13px] leading-[1.45] text-label">
        <Steps variant={variant} />
      </div>

      {variant === 'android' ? (
        <button
          type="button"
          className="mt-3 min-h-[var(--tap)] w-full rounded-[var(--radius-md)] bg-accent px-4 text-[15px] font-semibold text-white"
          onClick={install}
        >
          Installieren
        </button>
      ) : (
        <p className="mt-2 text-[12px] text-label-3">
          Schon installiert? Dann öffne Orbital Atlas über das Icon auf dem {homeScreen}.
        </p>
      )}
    </aside>
  );
}
