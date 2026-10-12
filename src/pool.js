'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pickRandom } = require('./quotes');

const dedupeKey = (r) => `${r.quote.toLowerCase().replace(/\s+/g, ' ')}|${r.title.toLowerCase()}`;

/** Les pays d'origine d'un film : une coproduction en a plusieurs, séparés par « / ». Aucun si on ne les connaît pas. */
const countriesOf = (record) => (record.country ? record.country.split(' / ') : []);

/** L'ensemble des répliques jouables : le jeu de départ, puis ce que le moissonneur ajoute. */
class QuotePool {
  constructor(records = []) {
    this.records = [];
    this.byId = new Map();
    this.keys = new Set();
    this.add(records);
  }

  get size() {
    return this.records.length;
  }

  get(id) {
    return this.byId.get(id);
  }

  /** Ajoute les nouvelles répliques (doublons ignorés) et renvoie celles réellement ajoutées. */
  add(records) {
    const added = [];
    for (const record of records) {
      const key = dedupeKey(record);
      if (this.byId.has(record.id) || this.keys.has(key)) continue;
      this.byId.set(record.id, record);
      this.keys.add(key);
      this.records.push(record);
      added.push(record);
    }
    return added;
  }

  /**
   * Les répliques qui passent le filtre : film sorti entre `from` et `to` (bornes incluses) et dont
   * l'un des pays d'origine est dans `countries`. Un filtre absent (ou une liste de pays vide) laisse tout passer ;
   * un film dont on ne connaît pas le pays n'est donc écarté que si des pays sont demandés.
   */
  inRange({ from, to, countries } = {}) {
    const byYear = from != null || to != null;
    const wanted = countries?.length ? new Set(countries) : null;
    if (!byYear && !wanted) return this.records;
    const min = from ?? -Infinity;
    const max = to ?? Infinity;
    return this.records.filter(
      (r) =>
        (!byYear || (Number.isInteger(r.year) && r.year >= min && r.year <= max)) &&
        (!wanted || countriesOf(r).some((country) => wanted.has(country))),
    );
  }

  /** Première et dernière année de sortie présentes dans le réservoir. */
  bounds() {
    const years = this.records.map((r) => r.year).filter(Number.isInteger);
    return years.length ? { min: Math.min(...years), max: Math.max(...years) } : null;
  }

  /** Nombre de répliques par année de sortie, parmi les pays demandés (tous, par défaut). */
  yearCounts({ countries } = {}) {
    const counts = new Map();
    for (const { year } of this.inRange({ countries })) {
      if (Number.isInteger(year)) counts.set(year, (counts.get(year) ?? 0) + 1);
    }
    return counts;
  }

  /** Nombre de répliques par pays d'origine (une coproduction compte pour chacun de ses pays), dans la période donnée. */
  countryCounts({ from, to } = {}) {
    const counts = new Map();
    for (const record of this.inRange({ from, to })) {
      for (const country of countriesOf(record)) counts.set(country, (counts.get(country) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Les pays présents dans la période donnée, du mieux fourni au moins fourni : `[{ name, count }]`.
   * Les pays de `extra` sont ajoutés (avec zéro réplique) s'ils manquent : ceux que la moisson ira chercher.
   */
  countries(range = {}, extra = []) {
    const counts = this.countryCounts(range);
    for (const name of extra) if (!counts.has(name)) counts.set(name, 0);
    return [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fr'));
  }

  pick(excludeIds, rng, filter) {
    return pickRandom(this.inRange(filter), excludeIds, rng);
  }
}

const STORE_VERSION = 1;
const isText = (v) => typeof v === 'string' && v.length > 0;
const optionalText = (v) => (typeof v === 'string' && v ? v : null);

/** Ne garde du cache que ce qui a la forme attendue : un fichier abîmé ne doit jamais bloquer le démarrage. */
function sanitizeRecord(r) {
  if (!r || !isText(r.id) || !isText(r.quote) || !isText(r.title)) return null;
  const url = r.source && typeof r.source.url === 'string' && r.source.url.startsWith('https://') ? r.source.url : null;
  return {
    id: r.id,
    quote: r.quote,
    title: r.title,
    character: optionalText(r.character),
    year: Number.isInteger(r.year) ? r.year : null,
    country: optionalText(r.country),
    genre: optionalText(r.genre),
    director: optionalText(r.director),
    actor: optionalText(r.actor),
    source: url ? { name: 'Wikiquote', url } : null,
  };
}

const emptyState = () => ({ cursors: {}, records: [] });

/** Cache JSON sur disque : les répliques récoltées et l'endroit où reprendre la moisson. */
function createFileStore(file) {
  return {
    load() {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.version !== STORE_VERSION) return emptyState();
        return {
          cursors: data.cursors && typeof data.cursors === 'object' ? data.cursors : {},
          records: (Array.isArray(data.records) ? data.records : []).map(sanitizeRecord).filter(Boolean),
        };
      } catch {
        return emptyState(); // fichier absent ou illisible
      }
    },

    async save(state) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      const payload = { version: STORE_VERSION, savedAt: new Date().toISOString(), ...state };
      await fs.promises.writeFile(tmp, JSON.stringify(payload));
      await fs.promises.rename(tmp, file); // écriture atomique
    },
  };
}

module.exports = { QuotePool, createFileStore, sanitizeRecord };
