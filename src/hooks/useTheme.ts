import { useEffect, useState } from 'react';
import { useAppStore } from '../state/store';

/** Was `prefers-color-scheme` gerade meldet. */
function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

/**
 * Hält `<html data-theme>` und die Statusleistenfarbe mit der Nutzerwahl
 * synchron.
 *
 * Das Attribut steuert ausschließlich die Token-Auflösung in `index.css`; die
 * eigentliche Umschaltung passiert also in CSS und nicht über einen
 * React-Baumdurchlauf. Bei `system` bleibt das Attribut absichtlich leer,
 * sodass die Media-Query greift und ein Systemwechsel ohne Re-Render ankommt.
 */
export function useTheme(): void {
  const theme = useAppStore((s) => s.theme);
  const nightMode = useAppStore((s) => s.nightMode);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;

    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && systemPrefersDark());
      // Im Nachtmodus liegt ohnehin ein Rotfilter über allem – dann bleibt die
      // Statusleiste schwarz, damit nichts durchscheint.
      meta.setAttribute('content', nightMode || dark ? '#000000' : '#eef0f5');
    };

    apply();
    if (theme !== 'system') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [theme, nightMode]);
}

/**
 * Das tatsächlich wirksame Farbschema – `system` bereits aufgelöst.
 *
 * Die CSS-Tokens greifen von allein; gebraucht wird das hier nur dort, wo in
 * JavaScript gezeichnet wird (Radar-Canvas) und `var()` deshalb nicht hilft.
 */
export function useResolvedTheme(): 'light' | 'dark' {
  const theme = useAppStore((s) => s.theme);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (theme !== 'system') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [theme]);

  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';
  return systemDark ? 'dark' : 'light';
}
