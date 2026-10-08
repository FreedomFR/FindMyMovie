'use strict';

const { findTemplates, toPlainText } = require('./wikitext');

const WIKI_HOST = 'https://fr.wikiquote.org';
const API_URL = `${WIKI_HOST}/w/api.php`;
const DEFAULT_USER_AGENT =
  'FindMyMovie/1.0 (+https://github.com/FreedomFR/FindMyMovie; jeu de devinettes de repliques de films)';

// Catégories parcourues en alternance, des plus larges aux plus ciblées.
// Une catégorie inexistante ne renvoie simplement aucune page.
const CATEGORIES = [
  'Film américain',
  'Film français',
  "Film d'animation",
  'Film de science-fiction',
  'Film britannique',
  "Film d'action",
  'Film italien',
  'Comédie (cinéma)',
  'Drame',
  'Film fantastique',
  "Film d'horreur",
  'Film de fantasy',
  'Film de super-héros',
  "Film d'aventure",
  'Comédie dramatique',
  'Comédie romantique',
  "Film d'animation Disney",
  "Film d'animation Pixar",
  'Film de gangsters',
  'Film de guerre',
  "Film d'espionnage",
  'Film musical',
  'Film historique',
  'Film allemand',
  'Film japonais',
  'Film canadien',
  'Film australien',
  'Film belge',
  'Film espagnol',
];

const MIN_QUOTE = 12;
const MAX_QUOTE = 220;

const COUNTRIES = {
  américain: 'États-Unis', américaine: 'États-Unis',
  britannique: 'Royaume-Uni', anglais: 'Royaume-Uni',
  français: 'France', française: 'France',
  italien: 'Italie', italienne: 'Italie',
  allemand: 'Allemagne', allemande: 'Allemagne',
  japonais: 'Japon', japonaise: 'Japon',
  canadien: 'Canada', canadienne: 'Canada', québécois: 'Canada',
  australien: 'Australie', australienne: 'Australie',
  belge: 'Belgique',
  espagnol: 'Espagne', espagnole: 'Espagne',
  danois: 'Danemark', danoise: 'Danemark',
  suédois: 'Suède', suédoise: 'Suède',
  norvégien: 'Norvège', norvégienne: 'Norvège',
  islandais: 'Islande', islandaise: 'Islande',
  irlandais: 'Irlande', irlandaise: 'Irlande',
  'néo-zélandais': 'Nouvelle-Zélande',
  suisse: 'Suisse',
  chinois: 'Chine', chinoise: 'Chine',
  hongkongais: 'Hong Kong', hongkongaise: 'Hong Kong',
  indien: 'Inde', indienne: 'Inde',
  russe: 'Russie', soviétique: 'URSS',
  mexicain: 'Mexique', mexicaine: 'Mexique',
  argentin: 'Argentine', argentine: 'Argentine',
  brésilien: 'Brésil', brésilienne: 'Brésil',
  néerlandais: 'Pays-Bas', néerlandaise: 'Pays-Bas',
  polonais: 'Pologne', polonaise: 'Pologne',
  autrichien: 'Autriche', autrichienne: 'Autriche',
  coréen: 'Corée du Sud', coréenne: 'Corée du Sud',
  iranien: 'Iran', iranienne: 'Iran',
  israélien: 'Israël', israélienne: 'Israël',
};

// Seules les catégories reconnues comme des genres sont utilisées pour l'indice « Genre ».
const GENRES = [
  [/^film d['’]action$/i, 'Action'],
  [/^film d['’]animation(?: (?:disney|pixar|américain|français))?$/i, 'Animation'],
  [/^film d['’]aventure$/i, 'Aventure'],
  [/^film d['’]horreur$/i, 'Horreur'],
  [/^film d['’]espionnage$/i, 'Espionnage'],
  [/^film de science-fiction$/i, 'Science-fiction'],
  [/^film fantastique$/i, 'Fantastique'],
  [/^film de fantasy$/i, 'Fantasy'],
  [/^film de guerre$/i, 'Guerre'],
  [/^film de gangsters?$/i, 'Gangsters'],
  [/^film historique$/i, 'Historique'],
  [/^film musical$/i, 'Musical'],
  [/^film de super-héros$/i, 'Super-héros'],
  [/^film policier$/i, 'Policier'],
  [/^film noir$/i, 'Film noir'],
  [/^drame$/i, 'Drame'],
  [/^comédie dramatique$/i, 'Comédie dramatique'],
  [/^comédie romantique$/i, 'Comédie romantique'],
  [/^comédie(?: \(cinéma\))?$/i, 'Comédie'],
  [/^thriller(?: \(cinéma\))?$/i, 'Thriller'],
  [/^western$/i, 'Western'],
  [/^péplum$/i, 'Péplum'],
  [/^romance(?: \(cinéma\))?$/i, 'Romance'],
];

const fold = (s) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const unique = (list) => [...new Set(list)];

/** Vrai si le texte contient le titre du film (en mots entiers) : ce serait une réponse offerte. */
function mentionsTitle(text, titles) {
  const haystack = ` ${fold(text)} `;
  return titles.filter(Boolean).some((title) => {
    const full = fold(title);
    const noArticle = full.replace(/^(?:l|le|la|les|un|une|des|the) /, '');
    return [full, noArticle].some((t) => t && haystack.includes(` ${t} `));
  });
}

function extractCategories(wikitext) {
  const re = /\[\[\s*cat[ée]gorie\s*:\s*([^\]|]+?)\s*(?:\|[^\]]*)?\]\]/gi;
  return unique([...wikitext.matchAll(re)].map((m) => m[1].replace(/\s+/g, ' ').trim()));
}

function leadText(wikitext) {
  const beforeFirstHeading = wikitext.split(/\n={2,}/)[0];
  for (const line of beforeFirstHeading.split('\n')) {
    if (!line.trim() || /^\{\{[^{}]*\}\}$/.test(line.trim())) continue;
    const text = toPlainText(line, { lenient: true });
    if (text && text.length > 20) return text.slice(0, 700);
  }
  return '';
}

function validYear(year) {
  const y = Number(year);
  return Number.isInteger(y) && y >= 1888 && y <= new Date().getFullYear() + 1 ? y : null;
}

function extractDirector(categories, lead) {
  const fromCategories = categories
    .map((c) => /^film réalisé par\s+(.+)$/i.exec(c)?.[1])
    .filter(Boolean);
  if (fromCategories.length) return fromCategories.slice(0, 3).join(' et ');

  const m = /r[ée]alis[ée]e?s? par\s+(.+?)(?=\s*(?:,|;|\.|\(|\s+en\s|\s+sorti|\s+d['’]après|\s+dont|\s+avec|$))/i.exec(lead);
  // « Taylor Hackford et adapté du roman… », « Nicholas Stoller et produit par… » : on coupe la suite de la phrase.
  const name = m?.[1]
    .replace(/\s+(?:et\s+)?(?:produit|adapt[ée]|[ée]crit|scénaris[ée]|inspir[ée]|interpr[ée]t[ée]|distribu[ée])(?=\s|[,.;]|$).*$/i, '')
    .trim();
  return name && name.length <= 90 ? name : null;
}

function extractFilmMeta(pageTitle, wikitext) {
  const categories = extractCategories(wikitext);
  const lead = leadText(wikitext);

  const countries = unique(
    categories
      .map((c) => /^film (?:d['’]animation )?(.+)$/i.exec(c)?.[1])
      .map((demonym) => demonym && COUNTRIES[demonym.toLowerCase()])
      .filter(Boolean),
  );
  const genres = unique(
    categories.map((c) => GENRES.find(([re]) => re.test(c))?.[1]).filter(Boolean),
  );
  const yearFromCategory = categories.map((c) => /^œuvre de (\d{4})$/i.exec(c)?.[1]).find(Boolean);
  const year = validYear(yearFromCategory ?? /sortie?\D{0,20}(\d{4})/i.exec(lead)?.[1]);

  return {
    title: pageTitle.replace(/\s*\([^)]*\)\s*$/, '').trim(),
    year,
    country: countries.slice(0, 3).join(' / ') || null,
    genre: genres.slice(0, 2).join(' / ') || null,
    director: extractDirector(categories, lead),
  };
}

/** Le premier acteur crédité dans `{{Réf Film|acteur=…}}` (sans les voix françaises). */
function firstActor(value) {
  const text = value ? toPlainText(value, { lenient: true }) : null;
  if (!text) return null;
  const first = text.replace(/\([^)]*\)/g, '').split(/\s*(?:,|;|\/|\bet\b)\s*/i)[0].trim();
  if (!first || first.length > 60 || /crédit|inconnu|anonyme|voix|narrat/i.test(first)) return null;
  return first;
}

/**
 * Extrait la réplique d'un `{{citation}}`. On ne garde que les répliques d'une seule
 * voix, sur une ligne : les dialogues et les poèmes sont écartés.
 */
function extractQuote(rawCitation) {
  if (!rawCitation) return null;
  let source = rawCitation.trim();
  const speakers = findTemplates(source).filter((t) => t.name === 'personnage');
  if (speakers.length > 1) return null;

  let character = null;
  if (speakers.length === 1 && source.slice(0, speakers[0].start).replace(/<poem>/i, '').trim() === '') {
    // « James Gordon (à propos de Gotham City) », « Wolf Jackson, officier de police » : on ne garde que le nom.
    character =
      toPlainText(speakers[0].positional[0], { lenient: true })
        ?.replace(/\s*\([^)]*\)/g, '')
        .split(/,\s/)[0]
        .trim() || null;
    source = source.slice(speakers[0].end);
    // Didascalie éventuelle puis « : » : « {{Personnage|X}} (en voix off) : … »
    source = source.replace(/^\s*(?:\([^)]*\))?[\s:]*/, '');
  }

  let text = toPlainText(source);
  if (text === null || text.includes('\n')) return null;
  text = text.replace(/^[«"“]\s*(.*?)\s*[»"”]$/, '$1').replace(/^[—–-]\s+/, '').trim();
  if (text.length < MIN_QUOTE || text.length > MAX_QUOTE || !/\p{L}{3}/u.test(text)) return null;
  if (character && character.length > 60) character = null;
  return { text, character };
}

/**
 * Transforme une page Wikiquote (réponse de l'API) en répliques jouables.
 * Chaque réplique porte les métadonnées du film : les indices absents sont omis.
 */
function parseFilmPage(page) {
  const wikitext = page?.revisions?.[0]?.slots?.main?.content;
  if (!wikitext || !page.title) return [];

  const templates = findTemplates(wikitext);
  // Les catégories d'année (« Œuvre de 1995 ») mélangent films, livres et séries :
  // on exige une fiche « Réf Film » ou une catégorie « Film… ».
  const isFilm =
    templates.some((t) => t.name === 'réf film') || extractCategories(wikitext).some((c) => /^films?\b/i.test(c));
  if (!isFilm) return [];

  const meta = extractFilmMeta(page.title, wikitext);
  const url = `${WIKI_HOST}/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`;
  const records = [];
  let index = -1;

  templates.forEach((tpl, i) => {
    if (tpl.name !== 'citation') return;
    index += 1;

    // La fiche « Réf Film » suit la citation, avant la citation suivante.
    let ref = null;
    for (let j = i + 1; j < templates.length && templates[j].name !== 'citation'; j += 1) {
      if (templates[j].name === 'réf film') {
        ref = templates[j];
        break;
      }
    }

    const quote = extractQuote(tpl.named.citation ?? tpl.positional[0]);
    if (!quote) return;
    const refTitle = ref?.named.titre ? toPlainText(ref.named.titre, { lenient: true }) : null;
    if (mentionsTitle(quote.text, [meta.title, refTitle])) return;

    const actor = firstActor(ref?.named.acteur);
    const record = {
      id: `wq-${page.pageid}-${index}`,
      quote: quote.text,
      // Certaines pages nomment l'acteur à la place du personnage : indice redondant, on l'écarte.
      character: quote.character && fold(quote.character) !== fold(actor ?? '') ? quote.character : null,
      title: meta.title,
      year: meta.year ?? validYear(/\d{4}/.exec(ref?.named.date ?? '')?.[0]),
      country: meta.country,
      genre: meta.genre,
      director: meta.director,
      actor,
      source: { name: 'Wikiquote', url },
    };
    // Initiale du titre mise à part, il faut au moins deux autres indices pour que la réplique vaille le coup.
    const clues = ['year', 'country', 'genre', 'director', 'actor', 'character'].filter((k) => record[k]);
    if (clues.length >= 2) records.push(record);
  });

  return records;
}

class WikiquoteError extends Error {
  constructor(message, { status = 0, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'WikiquoteError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/** Client minimal de l'API MediaWiki : un lot de 50 pages (avec leur wikitext) par appel. */
function createClient({
  fetchImpl = globalThis.fetch,
  userAgent = DEFAULT_USER_AGENT,
  apiUrl = API_URL,
  timeoutMs = 30_000,
} = {}) {
  async function fetchBatch(category, cursor = null) {
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      generator: 'categorymembers',
      gcmtitle: `Catégorie:${category}`,
      gcmnamespace: '0',
      gcmtype: 'page',
      gcmlimit: '50',
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
    });
    for (const [key, value] of Object.entries(cursor ?? {})) params.set(key, String(value));

    const res = await fetchImpl(`${apiUrl}?${params}`, {
      headers: { 'User-Agent': userAgent, 'Api-User-Agent': userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 429 || res.status === 503) {
      throw new WikiquoteError(`Wikiquote : HTTP ${res.status}`, {
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      });
    }
    if (!res.ok) throw new WikiquoteError(`Wikiquote : HTTP ${res.status}`, { status: res.status });

    const body = await res.json();
    if (body.error) throw new WikiquoteError(`Wikiquote : ${body.error.code}`, { status: 200 });
    return { pages: body.query?.pages ?? [], next: body.continue ?? null };
  }

  return { fetchBatch };
}

module.exports = {
  CATEGORIES,
  DEFAULT_USER_AGENT,
  WikiquoteError,
  createClient,
  parseFilmPage,
  extractQuote,
  extractFilmMeta,
  mentionsTitle,
};
