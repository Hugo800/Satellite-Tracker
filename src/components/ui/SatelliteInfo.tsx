import { useEffect, useState } from 'react';
import { ChevronLeft, ExternalLink, RotateCw } from 'lucide-react';
import { GROUP_LABEL } from '../../data/groups';
import { fetchWikiInfo } from '../../data/wikiInfo';
import type { WikiInfo } from '../../data/wikiInfo';
import { orbitSummary } from '../../math/orbit';
import { formatNumber } from '../../utils/format';
import type { SatelliteMeta } from '../../types';

type WikiState =
  | { status: 'loading' }
  | { status: 'done'; info: WikiInfo | null }
  | { status: 'error' };

function useWikiInfo(noradId: string, cosparId: string | null, attempt: number): WikiState {
  const key = `${noradId}|${attempt}`;
  const [result, setResult] = useState<{ key: string; state: WikiState } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWikiInfo(noradId, cosparId).then(
      (info) => {
        if (!cancelled) setResult({ key, state: { status: 'done', info } });
      },
      () => {
        if (!cancelled) setResult({ key, state: { status: 'error' } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [noradId, cosparId, key]);

  // Ergebnis eines anderen Objekts oder Versuchs zählt nicht – bis das neue
  // da ist, gilt „lädt“.
  return result?.key === key ? result.state : { status: 'loading' };
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="rounded-[var(--radius-sm)] px-2.5 py-2" style={{ background: 'var(--fill)' }}>
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-label-3">
        {title}
      </h3>
      {children}
    </section>
  );
}

function FactList({ facts }: { facts: { label: string; value: string }[] }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12.5px]">
      {facts.map((f) => (
        <div key={f.label} className="contents">
          <dt className="text-label-2">{f.label}</dt>
          <dd className="min-w-0 break-words text-right font-semibold text-label">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Allgemeine Angaben zum gewählten Objekt – ersetzt in der Telemetriekarte
 * vorübergehend die Live-Werte.
 *
 * Bahn- und Katalogdaten stammen aus dem TLE und stehen sofort und offline
 * bereit. Beschreibung, Start, Betreiber und Bild kommen aus Wikidata und
 * Wikipedia (src/data/wikiInfo.ts) und nur, soweit es einen Eintrag gibt –
 * für die meisten Starlink-Satelliten etwa nicht.
 */
export function SatelliteInfo({
  noradId,
  meta,
  onBack,
}: {
  noradId: string;
  meta: SatelliteMeta | null;
  onBack: () => void;
}): React.JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const cosparId = meta?.cosparId ?? null;
  const wiki = useWikiInfo(noradId, cosparId, attempt);
  const orbit = meta ? orbitSummary(meta.periodMin, meta.eccentricity, meta.inclinationDeg) : null;

  const catalogFacts = [
    { label: 'NORAD-Nr.', value: noradId },
    ...(cosparId ? [{ label: 'COSPAR-ID', value: cosparId }] : []),
    ...(cosparId ? [{ label: 'Startjahr', value: cosparId.slice(0, 4) }] : []),
    ...(meta ? [{ label: 'Gruppe', value: GROUP_LABEL[meta.group] }] : []),
  ];

  const orbitFacts =
    meta && orbit
      ? [
          { label: 'Bahntyp', value: orbit.label },
          { label: 'Perigäum', value: `${formatNumber(orbit.perigeeKm, 0)} km` },
          { label: 'Apogäum', value: `${formatNumber(orbit.apogeeKm, 0)} km` },
          { label: 'Umlaufzeit', value: `${formatNumber(meta.periodMin, 1)} min` },
          { label: 'Inklination', value: `${formatNumber(meta.inclinationDeg, 1)}°` },
          { label: 'Exzentrizität', value: formatNumber(meta.eccentricity, 4) },
        ]
      : [];

  return (
    <div className="no-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-3 py-2.5">
      <button
        type="button"
        onClick={onBack}
        className="-my-1 -ml-1 inline-flex min-h-[var(--tap)] items-center gap-0.5 pr-2 text-[13px] font-semibold text-accent"
      >
        <ChevronLeft size={16} strokeWidth={2.4} aria-hidden /> Live-Daten
      </button>

      <Section title="Wikipedia">
        {wiki.status === 'loading' && (
          <div className="text-[12.5px] text-label-2">Suche Eintrag …</div>
        )}
        {wiki.status === 'error' && (
          <div className="flex items-center gap-2 text-[12.5px] text-label-2">
            <span className="flex-1">Wikipedia/Wikidata nicht erreichbar.</span>
            <button
              type="button"
              className="inline-flex min-h-[var(--tap)] items-center gap-1 font-semibold text-accent"
              onClick={() => setAttempt((n) => n + 1)}
            >
              <RotateCw size={13} strokeWidth={2.4} aria-hidden /> Erneut
            </button>
          </div>
        )}
        {wiki.status === 'done' && !wiki.info && (
          <div className="text-[12.5px] text-label-2">Kein Eintrag zu diesem Objekt gefunden.</div>
        )}
        {wiki.status === 'done' && wiki.info && (
          <div className="space-y-2">
            {(wiki.info.label || wiki.info.description) && (
              <div className="flex items-start gap-2.5">
                {wiki.info.article?.thumbnailUrl && (
                  <img
                    src={wiki.info.article.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    className="h-14 w-14 shrink-0 rounded-[var(--radius-sm)] object-cover"
                  />
                )}
                <div className="min-w-0">
                  {wiki.info.label && (
                    <div className="text-[13.5px] font-semibold text-label">{wiki.info.label}</div>
                  )}
                  {wiki.info.description && (
                    <div className="text-[12px] text-label-2">{wiki.info.description}</div>
                  )}
                </div>
              </div>
            )}
            {wiki.info.article && (
              <p className="text-[12.5px] leading-[1.45] text-label">
                {wiki.info.article.extract}
                {wiki.info.article.lang === 'en' && (
                  <span className="text-label-2"> (englischer Artikel)</span>
                )}
              </p>
            )}
            {wiki.info.facts.length > 0 && <FactList facts={wiki.info.facts} />}
            <div className="flex flex-wrap items-center gap-x-3 text-[11px] text-label-2">
              {wiki.info.article && (
                <a
                  href={wiki.info.article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[var(--tap)] items-center gap-1 text-[12.5px] font-semibold text-accent"
                >
                  Weiterlesen <ExternalLink size={12} strokeWidth={2.4} aria-hidden />
                </a>
              )}
              <span>
                Quelle: {wiki.info.article ? 'Wikipedia (CC BY-SA), ' : ''}
                <a
                  href={`https://www.wikidata.org/wiki/${wiki.info.wikidataId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Wikidata
                </a>
              </span>
            </div>
          </div>
        )}
      </Section>

      {orbitFacts.length > 0 && (
        <Section title="Bahn">
          <FactList facts={orbitFacts} />
        </Section>
      )}

      <Section title="Katalog">
        <FactList facts={catalogFacts} />
      </Section>
    </div>
  );
}
