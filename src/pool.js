'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pickRandom } = require('./quotes');

const dedupeKey = (r) => `${r.quote.toLowerCase().replace(/\s+/g, ' ')}|${r.title.toLowerCase()}`;

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

  pick(excludeIds, rng) {
    return pickRandom(this.records, excludeIds, rng);
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
