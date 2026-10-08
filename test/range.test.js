'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const quotes = require('../src/quotes');
const { QuotePool } = require('../src/pool');
const { createHarvester } = require('../src/harvester');
const { parseFilmPage } = require('../src/wikiquote');
const { startServer } = require('./helpers');

const seed = quotes.load();
const yearOf = (id) => seed.find((m) => m.id === id).year;
const fixture = require('./fixtures/wikiquote-sample.json');

async function getQuote(base, query = '') {
  const res = await fetch(`${base}/api/quote${query}`);
  return { status: res.status, body: await res.json() };
}

// ---- réservoir -------------------------------------------------------------------------------

test('le réservoir filtre par années (bornes incluses), calcule les bornes et les effectifs', () => {
  const noYear = { id: 'x', quote: 'Sans année', title: 'Inconnu', year: null };
  const pool = new QuotePool([...seed, noYear]);

  const nineties = pool.inRange({ from: 1990, to: 1999 });
  assert.ok(nineties.length > 5);
  assert.ok(nineties.every((r) => r.year >= 1990 && r.year <= 1999));
  assert.ok(!nineties.includes(noYear), 'une réplique sans année ne peut pas être dans une plage');

  assert.ok(pool.inRange({}).includes(noYear), 'sans plage, tout est permis');
  assert.ok(pool.inRange({ from: 2008 }).every((r) => r.year >= 2008));
  assert.ok(pool.inRange({ to: 1940 }).every((r) => r.year <= 1940));
  assert.deepEqual(pool.inRange({ from: 1994, to: 1994 }).map((r) => r.year), [1994, 1994, 1994, 1994, 1994]);

  assert.deepEqual(pool.bounds(), { min: 1938, max: 2014 });
  assert.equal(new QuotePool().bounds(), null);
  assert.equal(pool.yearCounts().get(1994), 5);
  assert.equal(pool.yearCounts().has(null), false);
});

test("pickRandom tolère une liste vide (aucun film dans la plage)", () => {
  assert.deepEqual(quotes.pickRandom([]), { movie: null, reset: false });
});

// ---- API -------------------------------------------------------------------------------------

test("/api/quote ne renvoie que des films de la plage demandée, bornes comprises", async () => {
  const server = await startServer(new QuotePool(seed));
  try {
    const years = new Set();
    for (let i = 0; i < 60; i += 1) {
      const { body } = await getQuote(server.base, '?from=1990&to=2005');
      assert.ok(!body.empty);
      const year = yearOf(body.id);
      assert.ok(year >= 1990 && year <= 2005, `hors plage : ${year}`);
      years.add(year);
    }
    assert.ok(years.size > 3, 'le tirage doit varier dans la plage');

    // Une seule année : chaque tirage est de cette année-là.
    for (let i = 0; i < 15; i += 1) {
      const { body } = await getQuote(server.base, '?from=1994&to=1994');
      assert.equal(yearOf(body.id), 1994);
      assert.equal(body.inRange, 5);
    }
  } finally {
    await server.close();
  }
});

test('les bornes inversées sont remises dans l\'ordre, une borne seule suffit', async () => {
  const server = await startServer(new QuotePool(seed));
  try {
    for (let i = 0; i < 20; i += 1) {
      assert.ok(yearOf((await getQuote(server.base, '?from=2005&to=1990')).body.id) >= 1990);
      assert.ok(yearOf((await getQuote(server.base, '?from=2008')).body.id) >= 2008);
      assert.ok(yearOf((await getQuote(server.base, '?to=1950')).body.id) <= 1950);
    }
  } finally {
    await server.close();
  }
});

test('la réponse indique le nombre de répliques de la plage et les bornes disponibles', async () => {
  const pool = new QuotePool(seed);
  const server = await startServer(pool);
  try {
    const all = (await getQuote(server.base)).body;
    assert.equal(all.total, seed.length);
    assert.equal(all.inRange, seed.length);
    assert.deepEqual(all.bounds, { min: 1938, max: 2014 });

    const range = (await getQuote(server.base, '?from=1980&to=1989')).body;
    assert.equal(range.inRange, pool.inRange({ from: 1980, to: 1989 }).length);
    assert.equal(range.total, seed.length);
  } finally {
    await server.close();
  }
});

test("une plage sans aucun film répond « vide » au lieu de tirer au hasard", async () => {
  const server = await startServer(new QuotePool(seed));
  try {
    const { status, body } = await getQuote(server.base, '?from=1800&to=1850');
    assert.equal(status, 200);
    assert.deepEqual(body, { total: seed.length, inRange: 0, bounds: { min: 1938, max: 2014 }, empty: true });
  } finally {
    await server.close();
  }
});

test('une plage invalide est refusée', async () => {
  const server = await startServer(new QuotePool(seed));
  try {
    for (const query of ['?from=abc', '?to=1.5', '?from=-5', '?from=12345', '?from=1990;drop']) {
      assert.equal((await getQuote(server.base, query)).status, 400, query);
    }
  } finally {
    await server.close();
  }
});

test('les répliques déjà vues sont exclues dans la plage, qui repart de zéro quand elle est épuisée', async () => {
  const pool = new QuotePool(seed);
  const server = await startServer(pool);
  try {
    const inRange = pool.inRange({ from: 1994, to: 1994 }).map((r) => r.id);
    const [last, ...seen] = inRange;

    const rest = (await getQuote(server.base, `?from=1994&to=1994&exclude=${seen.join(',')}`)).body;
    assert.equal(rest.id, last);
    assert.equal(rest.reset, false);

    const exhausted = (await getQuote(server.base, `?from=1994&to=1994&exclude=${inRange.join(',')}`)).body;
    assert.equal(exhausted.reset, true);
    assert.ok(inRange.includes(exhausted.id));
  } finally {
    await server.close();
  }
});

test("choisir une plage demande à la moisson de s'en occuper (avec des bornes par défaut)", async () => {
  const calls = [];
  const harvester = { prioritize: (range) => calls.push(range) };
  const server = await startServer(new QuotePool(seed), { harvester });
  try {
    await getQuote(server.base);
    assert.deepEqual(calls, [], 'sans plage, rien à prioriser');

    await getQuote(server.base, '?from=1990&to=1995');
    await getQuote(server.base, '?from=2000');
    await getQuote(server.base, '?to=1950');
    const thisYear = new Date().getFullYear();
    assert.deepEqual(calls, [
      { from: 1990, to: 1995 },
      { from: 2000, to: thisYear },
      { from: 1888, to: 1950 },
    ]);
  } finally {
    await server.close();
  }
});

// ---- moisson ciblée --------------------------------------------------------------------------

const silent = { info() {}, warn() {} };
const memoryStore = (cursors = {}) => ({ load: () => ({ cursors, records: [] }), save: async () => {} });

function recordingClient(pagesFor = () => []) {
  const calls = [];
  return {
    calls,
    async fetchBatch(category) {
      calls.push(category);
      return { pages: pagesFor(category), next: null };
    },
  };
}

test('la moisson traite en premier les années demandées, les moins fournies d\'abord', async () => {
  const client = recordingClient();
  const harvester = createHarvester({
    pool: new QuotePool(seed), client, store: memoryStore(), categories: ['A'], sleep: async () => {}, log: silent,
  });
  // Dans le jeu de départ : 1990 → 0 réplique, 1991 → 2, 1992 → 0.
  assert.deepEqual(harvester.prioritize({ from: 1990, to: 1992 }), ['Œuvre de 1990', 'Œuvre de 1992', 'Œuvre de 1991']);
  await harvester.start();
  assert.deepEqual(client.calls, ['Œuvre de 1990', 'Œuvre de 1992', 'Œuvre de 1991', 'A']);
});

test('les années déjà bien fournies, déjà terminées ou hors période sont ignorées', () => {
  const full = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, quote: `Réplique ${i}`, title: `Film ${i}`, year: 2000 }));
  const harvester = createHarvester({
    pool: new QuotePool(full),
    client: recordingClient(),
    store: memoryStore({ 'Œuvre de 2001': { next: null, done: true } }),
    categories: [],
    sleep: async () => {},
    log: silent,
  });
  assert.deepEqual(harvester.prioritize({ from: 2000, to: 2002 }), ['Œuvre de 2002']);

  assert.deepEqual(harvester.prioritize({ from: 2002, to: 2000 }), [], 'plage inversée');
  assert.deepEqual(harvester.prioritize({ from: 1500, to: 1800 }), [], 'avant le cinéma');
  assert.deepEqual(harvester.prioritize({ from: 3000, to: 3010 }), [], 'dans le futur');
  assert.deepEqual(harvester.prioritize({ from: 'a', to: 1 }), []);
});

test('la moisson ciblée est limitée à quelques années à la fois', () => {
  const harvester = createHarvester({
    pool: new QuotePool(), client: recordingClient(), store: memoryStore(), categories: [], sleep: async () => {}, log: silent,
  });
  assert.equal(harvester.prioritize({ from: 1950, to: 2000 }).length, 12);
});

test('la moisson repart quand une plage est demandée après la fin de la moisson générale', async () => {
  const client = recordingClient();
  const harvester = createHarvester({
    pool: new QuotePool(seed),
    client,
    store: memoryStore({ A: { next: null, done: true } }),
    categories: ['A'],
    sleep: async () => {},
    log: silent,
  });
  await harvester.start(); // rien à faire : la boucle s'arrête aussitôt
  assert.deepEqual(client.calls, []);

  harvester.prioritize({ from: 1990, to: 1990 });
  await harvester.start();
  assert.deepEqual(client.calls, ['Œuvre de 1990']);
});

test('les films récoltés pour une année rejoignent le réservoir et peuvent être tirés', async () => {
  const pool = new QuotePool();
  const client = recordingClient(() => fixture.query.pages);
  const harvester = createHarvester({
    pool, client, store: memoryStore(), categories: [], sleep: async () => {}, log: silent,
  });
  assert.equal(pool.inRange({ from: 1968, to: 1968 }).length, 0);
  harvester.prioritize({ from: 1968, to: 1968 });
  await harvester.start();
  assert.equal(pool.inRange({ from: 1968, to: 1968 }).length, 4, '« 2001 : l\'odyssée de l\'espace »');
  assert.equal(pool.pick([], Math.random, { from: 1968, to: 1968 }).movie.year, 1968);
});

// ---- ne garder que les films -----------------------------------------------------------------

const wikiPage = (content, title = 'Un Titre') => ({ pageid: 7, title, revisions: [{ slots: { main: { content } } }] });
const citation = '{{citation|citation=Une réplique tout à fait correcte.}}';

test("les pages qui ne sont pas des films (livres, séries) sont écartées", () => {
  const book = wikiPage(`'''Un roman''' est un livre.\n== Citations ==\n${citation}\n{{Réf Livre|titre=Un roman|auteur=Quelqu'un|date=1995}}\n[[Catégorie:Roman]]\n[[Catégorie:Œuvre de 1995]]`);
  assert.deepEqual(parseFilmPage(book), []);
});

test("une page est un film si elle a une fiche « Réf Film » ou une catégorie « Film… »", () => {
  const withRef = wikiPage(`Intro.\n${citation}\n{{Réf Film|titre=Un Titre|date=1995|acteur=Jean Reno}}\n[[Catégorie:Œuvre de 1995]]`);
  assert.equal(parseFilmPage(withRef).length, 1);

  const withCategory = wikiPage(`Intro.\n${citation}\n[[Catégorie:Film français]]\n[[Catégorie:Œuvre de 1995]]`);
  assert.equal(parseFilmPage(withCategory).length, 1);

  const neither = wikiPage(`Intro.\n${citation}\n[[Catégorie:Œuvre de 1995]]`);
  assert.deepEqual(parseFilmPage(neither), []);
});
