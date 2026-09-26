/**
 * Allgemeine Angaben zu einem Satelliten aus Wikidata und Wikipedia.
 *
 * Der Abgleich läuft über die Kennungen, nicht über den Namen: TLE-Namen wie
 * `ISS (ZARYA)` oder `CSS (TIANHE)` treffen selten einen Artikeltitel. Wikidata
 * führt die NORAD-Katalognummer (P377) und die COSPAR-Kennung (P247); die
 * Volltextsuche der Wikidata-API findet beide über `haswbstatement` in einem
 * Aufruf. Der SPARQL-Endpunkt wäre bequemer, drosselt aber schnell (HTTP 429)
 * und braucht für dieselbe Abfrage mit mehreren OPTIONAL-Blöcken bis zum
 * Timeout.
 *
 * Abgerufen wird erst, wenn die Info-Ansicht aufgeht – nicht für den ganzen
 * Katalog. Beide Dienste senden `Access-Control-Allow-Origin: *`.
 */

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const REQUEST_TIMEOUT_MS = 12_000;

export interface WikiFact {
  label: string;
  value: string;
}

export interface WikiArticle {
  lang: 'de' | 'en';
  title: string;
  /** Einleitung als reiner Text. */
  extract: string;
  url: string;
  thumbnailUrl: string | null;
}

export interface WikiInfo {
  wikidataId: string;
  label: string | null;
  description: string | null;
  facts: WikiFact[];
  /** `null`, wenn es weder einen deutschen noch einen englischen Artikel gibt oder er nicht lädt. */
  article: WikiArticle | null;
}

/* ------------------------------------------------------------------ */
/* Wikidata-Rohformat (nur die genutzten Felder)                        */
/* ------------------------------------------------------------------ */

interface Snak {
  datavalue?: { value: unknown };
}
interface Claim {
  mainsnak: Snak;
  rank: 'preferred' | 'normal' | 'deprecated';
}
interface Entity {
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  claims?: Record<string, Claim[]>;
  sitelinks?: Record<string, { title: string }>;
}
interface TimeValue {
  time: string;
  precision: number;
}
interface QuantityValue {
  amount: string;
  unit: string;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

function wikidataUrl(params: Record<string, string>): string {
  const url = new URL(WIKIDATA_API);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('format', 'json');
  // Ohne `origin=*` antwortet die Action-API ohne CORS-Kopfzeilen.
  url.searchParams.set('origin', '*');
  return url.toString();
}

/**
 * Wikidata führt die NORAD-Nummer fünfstellig mit führenden Nullen (`00005`),
 * der Katalog der App ohne. Gesucht wird deshalb nach beiden Schreibweisen.
 */
function searchExpression(noradId: string, cosparId: string | null): string {
  const terms = new Set([`P377=${noradId}`, `P377=${noradId.padStart(5, '0')}`]);
  if (cosparId) terms.add(`P247=${cosparId}`);
  return `haswbstatement:${[...terms].join('|')}`;
}

/** Gültige Aussagen einer Eigenschaft, bevorzugte zuerst. */
function claimsOf(entity: Entity, property: string): Claim[] {
  const all = (entity.claims?.[property] ?? []).filter((c) => c.rank !== 'deprecated');
  const preferred = all.filter((c) => c.rank === 'preferred');
  return preferred.length > 0 ? preferred : all;
}

function itemIds(entity: Entity, property: string, limit = 3): string[] {
  return claimsOf(entity, property)
    .map((c) => (c.mainsnak.datavalue?.value as { id?: string } | undefined)?.id)
    .filter((id): id is string => typeof id === 'string')
    .slice(0, limit);
}

const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/** Wikidata-Zeitwert in der Genauigkeit, in der er vorliegt (Tag, Monat, Jahr). */
export function formatWikidataTime(value: TimeValue): string | null {
  const match = /^\+?(\d{4,})-(\d{2})-(\d{2})/.exec(value.time);
  if (!match) return null;
  const year = String(Number(match[1]));
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (value.precision >= 11 && month > 0 && day > 0) return `${day}. ${MONTHS[month - 1]} ${year}`;
  if (value.precision >= 10 && month > 0) return `${MONTHS[month - 1]} ${year}`;
  return year;
}

const KILOGRAM = 'http://www.wikidata.org/entity/Q11570';
const TONNE = 'http://www.wikidata.org/entity/Q191118';
const MASS_FMT = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
// Kleinsatelliten wiegen oft nur wenige Kilogramm (Vanguard 1: 1,47 kg).
const SMALL_MASS_FMT = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

function formatMass(value: QuantityValue): string | null {
  const amount = Number(value.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const kg = value.unit === KILOGRAM ? amount : value.unit === TONNE ? amount * 1000 : null;
  if (kg === null) return null;
  if (kg >= 10_000) return `${MASS_FMT.format(kg / 1000)} t`;
  return `${(kg < 100 ? SMALL_MASS_FMT : MASS_FMT).format(kg)} kg`;
}

function firstValue<T>(entity: Entity, property: string): T | null {
  const value = claimsOf(entity, property)[0]?.mainsnak.datavalue?.value;
  return (value as T | undefined) ?? null;
}

async function fetchArticle(lang: 'de' | 'en', title: string): Promise<WikiArticle | null> {
  const path = encodeURIComponent(title.replace(/ /g, '_'));
  const summary = await getJson<{
    type?: string;
    title: string;
    extract?: string;
    thumbnail?: { source: string };
    content_urls?: { mobile?: { page: string }; desktop?: { page: string } };
  }>(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${path}`);
  if (summary.type === 'disambiguation' || !summary.extract) return null;
  return {
    lang,
    title: summary.title,
    extract: summary.extract,
    url:
      summary.content_urls?.mobile?.page ??
      summary.content_urls?.desktop?.page ??
      `https://${lang}.wikipedia.org/wiki/${path}`,
    thumbnailUrl: summary.thumbnail?.source ?? null,
  };
}

async function loadWikiInfo(noradId: string, cosparId: string | null): Promise<WikiInfo | null> {
  const search = await getJson<{ query?: { search?: { title: string }[] } }>(
    wikidataUrl({
      action: 'query',
      list: 'search',
      srsearch: searchExpression(noradId, cosparId),
      srprop: '',
      // Beim ISS-Eintrag trägt auch das Modul Sarja dieselben Kennungen;
      // die Relevanzsortierung stellt die Station voran.
      srlimit: '1',
    }),
  );
  const wikidataId = search.query?.search?.[0]?.title;
  if (!wikidataId) return null;

  const { entities } = await getJson<{ entities: Record<string, Entity> }>(
    wikidataUrl({
      action: 'wbgetentities',
      ids: wikidataId,
      props: 'labels|descriptions|claims|sitelinks',
      languages: 'de',
      languagefallback: '1',
      sitefilter: 'dewiki|enwiki',
    }),
  );
  const entity = entities[wikidataId];
  if (!entity) return null;

  const operators = itemIds(entity, 'P137');
  const manufacturers = itemIds(entity, 'P176');
  const vehicles = itemIds(entity, 'P375', 1);
  const referenced = [...new Set([...operators, ...manufacturers, ...vehicles])];

  const dewiki = entity.sitelinks?.dewiki?.title;
  const enwiki = entity.sitelinks?.enwiki?.title;

  const [labels, article] = await Promise.all([
    referenced.length === 0
      ? Promise.resolve<Record<string, Entity>>({})
      : getJson<{ entities: Record<string, Entity> }>(
          wikidataUrl({
            action: 'wbgetentities',
            ids: referenced.join('|'),
            props: 'labels',
            languages: 'de',
            languagefallback: '1',
          }),
        )
          .then((r) => r.entities)
          // Ohne Namen entfallen nur Betreiber, Hersteller und Rakete.
          .catch((): Record<string, Entity> => ({})),
    // Ein fehlender Artikel soll die Wikidata-Angaben nicht mitreißen.
    (dewiki
      ? fetchArticle('de', dewiki)
      : enwiki
        ? fetchArticle('en', enwiki)
        : Promise.resolve(null)
    ).catch(() => null),
  ]);

  const names = (ids: string[]) =>
    ids.map((id) => labels[id]?.labels?.de?.value).filter((v): v is string => !!v).join(', ');

  const facts: WikiFact[] = [];
  const launch = firstValue<TimeValue>(entity, 'P619');
  const launchText = launch ? formatWikidataTime(launch) : null;
  if (launchText) facts.push({ label: 'Start', value: launchText });
  const vehicleText = names(vehicles);
  if (vehicleText) facts.push({ label: 'Trägerrakete', value: vehicleText });
  const operatorText = names(operators);
  if (operatorText) facts.push({ label: 'Betreiber', value: operatorText });
  const manufacturerText = names(manufacturers);
  if (manufacturerText) facts.push({ label: 'Hersteller', value: manufacturerText });
  const mass = firstValue<QuantityValue>(entity, 'P2067');
  const massText = mass ? formatMass(mass) : null;
  if (massText) facts.push({ label: 'Masse', value: massText });

  return {
    wikidataId,
    label: entity.labels?.de?.value ?? null,
    description: entity.descriptions?.de?.value ?? null,
    facts,
    article,
  };
}

/**
 * Je NORAD-ID nur ein Abruf pro Sitzung. Ein fehlgeschlagener fliegt wieder
 * heraus, damit „Erneut versuchen“ tatsächlich neu lädt.
 */
const cache = new Map<string, Promise<WikiInfo | null>>();

export function fetchWikiInfo(noradId: string, cosparId: string | null): Promise<WikiInfo | null> {
  const cached = cache.get(noradId);
  if (cached) return cached;
  const pending = loadWikiInfo(noradId, cosparId);
  cache.set(noradId, pending);
  pending.catch(() => {
    if (cache.get(noradId) === pending) cache.delete(noradId);
  });
  return pending;
}
