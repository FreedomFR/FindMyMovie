'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QuotePool, createFileStore } = require('../src/pool');
const { createHarvester, defaultSleep } = require('../src/harvester');
const { WikiquoteError } = require('../src/wikiquote');

const fixture = require('./fixtures/wikiquote-sample.json');
const pages = fixture.query.pages;

const silent = { info() {}, warn() {} };
const memoryStore = (initial) => {
  let saved = initial ?? { cursors: {}, records: [] };
  return {
    saves: 0,
    load: () => structuredClone(saved),
    async save(state) {
      this.saves += 1;
      saved = structuredClone(state);
    },
    get saved() {
      return saved;
    },
  };
};

const record = (id, quote = `Réplique ${id}`) => ({ id, quote, title: `Film ${id}`, year: 2000 });

test('le réservoir ignore les doublons (même id ou même réplique du même film)', () => {
  const pool = new QuotePool([record('a')]);
  const added = pool.add([record('a'), { ...record('b', 'RÉPLIQUE   a'), title: 'Film a' }, record('c')]);
  assert.deepEqual(added.map((r) => r.id), ['c']);
  assert.equal(pool.size, 2);
  assert.equal(pool.get('c').quote, 'Réplique c');
});

test('le réservoir évite les répliques exclues puis repart de zéro', () => {
  const pool = new QuotePool([record('a'), record('b')]);
  assert.equal(pool.pick(['a']).movie.id, 'b');
  assert.equal(pool.pick(['a', 'b']).reset, true);
});

test('le cache survit à un redémarrage et tolère un fichier abîmé', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmm-'));
  const file = path.join(dir, 'sous', 'cache.json'); // le dossier est créé à la demande
  const store = createFileStore(file);

  assert.deepEqual(store.load(), { cursors: {}, records: [] }); // fichier absent

  await store.save({ cursors: { A: { next: { gcmcontinue: 'x' }, done: false } }, records: [record('a')] });
  const loaded = store.load();
  assert.deepEqual(loaded.cursors.A, { next: { gcmcontinue: 'x' }, done: false });
  assert.equal(loaded.records[0].id, 'a');
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  fs.writeFileSync(file, '{ pas du json');
  assert.deepEqual(store.load(), { cursors: {}, records: [] });
});

test("le cache écarte les enregistrements invalides et les liens non-https", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmm-'));
  const file = path.join(dir, 'cache.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      cursors: {},
      records: [
        { ...record('ok'), source: { name: 'Wikiquote', url: 'https://fr.wikiquote.org/wiki/X' } },
        { ...record('piege'), source: { name: 'Wikiquote', url: 'javascript:alert(1)' } },
        { id: 'sans-titre', quote: 'x' },
        null,
      ],
    }),
  );
  const { records } = createFileStore(file).load();
  assert.deepEqual(records.map((r) => r.id), ['ok', 'piege']);
  assert.equal(records[0].source.url, 'https://fr.wikiquote.org/wiki/X');
  assert.equal(records[1].source, null);
});

test('le moissonneur alterne les catégories, suit les curseurs et sauvegarde', async () => {
  const calls = [];
  const batches = { A: [pages.slice(0, 2), pages.slice(2, 4)], B: [pages.slice(4, 6)] };
  const client = {
    async fetchBatch(category, cursor) {
      calls.push([category, cursor]);
      const n = cursor ? cursor.n : 0;
      const more = n + 1 < batches[category].length;
      return { pages: batches[category][n], next: more ? { n: n + 1 } : null };
    },
  };
  const pool = new QuotePool();
  const store = memoryStore();
  const harvester = createHarvester({ pool, client, store, categories: ['A', 'B'], sleep: async () => {}, log: silent });
  await harvester.start();

  assert.deepEqual(calls, [['A', null], ['B', null], ['A', { n: 1 }]]);
  assert.ok(pool.size > 5, `réservoir trop petit : ${pool.size}`);
  assert.equal(store.saves, 3);
  assert.equal(store.saved.records.length, pool.size);
  assert.deepEqual(Object.values(store.saved.cursors).map((c) => c.done), [true, true]);
});

test('le moissonneur reprend où il s\'était arrêté après un redémarrage', async () => {
  const store = memoryStore({
    cursors: { A: { next: { n: 1 }, done: false }, B: { next: null, done: true } },
    records: [record('deja-la')],
  });
  const calls = [];
  const client = {
    async fetchBatch(category, cursor) {
      calls.push([category, cursor]);
      return { pages: [], next: null };
    },
  };
  const pool = new QuotePool();
  const harvester = createHarvester({ pool, client, store, categories: ['A', 'B'], sleep: async () => {}, log: silent });

  assert.equal(pool.size, 1, 'les répliques en cache sont disponibles immédiatement');
  await harvester.start();
  assert.deepEqual(calls, [['A', { n: 1 }]]);
});

test('une limite de débit (429) est attendue pour la durée demandée, puis on réessaie', async () => {
  const waits = [];
  let attempt = 0;
  const client = {
    async fetchBatch() {
      attempt += 1;
      if (attempt === 1) throw new WikiquoteError('429', { status: 429, retryAfterMs: 31_000 });
      return { pages: pages.slice(0, 1), next: null };
    },
  };
  const pool = new QuotePool();
  const harvester = createHarvester({
    pool,
    client,
    store: memoryStore(),
    categories: ['A'],
    sleep: async (ms) => waits.push(ms),
    random: () => 0,
    log: silent,
  });
  await harvester.start();

  assert.equal(attempt, 2);
  assert.equal(waits[0], 31_000);
  assert.ok(pool.size > 0);
});

test('après une erreur, le moissonneur réessaie la même catégorie avant de passer à la suivante', async () => {
  const calls = [];
  const client = {
    async fetchBatch(category) {
      calls.push(category);
      if (calls.length === 1) throw new WikiquoteError('429', { status: 429, retryAfterMs: 1000 });
      return { pages: [], next: null };
    },
  };
  const harvester = createHarvester({
    pool: new QuotePool(), client, store: memoryStore(), categories: ['A', 'B'], sleep: async () => {}, log: silent,
  });
  await harvester.start();
  assert.deepEqual(calls, ['A', 'A', 'B']);
});

test("les autres erreurs déclenchent une attente exponentielle plafonnée", async () => {
  const waits = [];
  let attempt = 0;
  const client = {
    async fetchBatch() {
      attempt += 1;
      if (attempt <= 7) throw new WikiquoteError('HTTP 500', { status: 500 });
      return { pages: [], next: null };
    },
  };
  const harvester = createHarvester({
    pool: new QuotePool(),
    client,
    store: memoryStore(),
    categories: ['A'],
    sleep: async (ms) => waits.push(ms),
    random: () => 0,
    log: silent,
  });
  await harvester.start();
  assert.deepEqual(waits.slice(0, 7), [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
});

test("un cache impossible à écrire n'interrompt pas la moisson", async () => {
  const store = memoryStore();
  store.save = async () => {
    throw new Error('système de fichiers en lecture seule');
  };
  const warnings = [];
  const client = { fetchBatch: async () => ({ pages: pages.slice(0, 2), next: null }) };
  const pool = new QuotePool();
  const harvester = createHarvester({
    pool, client, store, categories: ['A'], sleep: async () => {}, log: { info() {}, warn: (m) => warnings.push(m) },
  });
  await harvester.start();
  assert.ok(pool.size > 0);
  assert.equal(warnings.length, 1);
});

test("la pause s'interrompt à l'arrêt, qu'il survienne avant ou pendant l'attente", async () => {
  const hour = 60 * 60_000;
  const started = Date.now();

  const already = new AbortController();
  already.abort();
  await defaultSleep(hour, already.signal); // arrêt demandé avant la pause : ne doit pas attendre

  const during = new AbortController();
  const pending = defaultSleep(hour, during.signal);
  during.abort();
  await pending; // arrêt demandé pendant la pause

  assert.ok(Date.now() - started < 1000);
});

test('stop() interrompt immédiatement une attente en cours', async () => {
  let calls = 0;
  const client = {
    async fetchBatch() {
      calls += 1;
      return { pages: [], next: { more: true } };
    },
  };
  const harvester = createHarvester({
    pool: new QuotePool(), client, store: memoryStore(), categories: ['A'], intervalMs: 60 * 60_000, log: silent,
  });
  harvester.start();
  while (calls < 1) await new Promise((resolve) => setImmediate(resolve));

  const started = Date.now();
  await harvester.stop();
  assert.ok(Date.now() - started < 1000, "stop() ne doit pas attendre la fin de l'intervalle");
  assert.equal(calls, 1);
});

test('le plafond de répliques arrête la moisson', async () => {
  const client = { fetchBatch: async () => ({ pages: pages.slice(0, 4), next: { more: true } }) };
  const pool = new QuotePool();
  const harvester = createHarvester({
    pool, client, store: memoryStore(), categories: ['A'], maxRecords: 5, sleep: async () => {}, log: silent,
  });
  await harvester.start();
  assert.ok(pool.size >= 5 && pool.size < 30);
});
