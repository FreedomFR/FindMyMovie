'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const quotes = require('../src/quotes');
const { QuotePool } = require('../src/pool');
const { UserStore } = require('../src/users');
const { createHarvester } = require('../src/harvester');
const { CATEGORIES, countryCategory, extractFilmMeta } = require('../src/wikiquote');
const { postJson, sessionCookie, startServer, tempDir } = require('./helpers');

const seed = quotes.load();
const countryOf = (id) => seed.find((m) => m.id === id).country;
const originsOf = (id) => (countryOf(id) ? countryOf(id).split(' / ') : []);

const film = (id, country, year = 2000) => ({ id, quote: `Réplique ${id}`, title: `Film ${id}`, country, year });
const pool = () =>
  new QuotePool([
    film('fr', 'France', 1995),
    film('fr2', 'France', 2005),
    film('it', 'Italie', 1995),
    film('us', 'États-Unis', 1995),
    film('us-uk', 'États-Unis / Royaume-Uni', 2005),
    film('jp', 'Japon', 1995),
    film('inconnu', null, 1995),
  ]);
const ids = (records) => records.map((r) => r.id).sort();

async function getQuote(base, query = '') {
  const res = await fetch(`${base}/api/quote${query}`);
  return { status: res.status, body: await res.json() };
}

// ---- réservoir -------------------------------------------------------------------------------

test('le réservoir garde les films dont un des pays est demandé, coproductions comprises', () => {
  const p = pool();
  assert.deepEqual(ids(p.inRange({ countries: ['France'] })), ['fr', 'fr2']);
  assert.deepEqual(ids(p.inRange({ countries: ['France', 'Italie'] })), ['fr', 'fr2', 'it']);
  assert.deepEqual(ids(p.inRange({ countries: ['Royaume-Uni'] })), ['us-uk'], 'une coproduction compte pour chaque pays');
  assert.deepEqual(ids(p.inRange({ countries: ['États-Unis'] })), ['us', 'us-uk']);
  assert.deepEqual(ids(p.inRange({ countries: ['Atlantide'] })), []);
});

test('sans pays demandé, rien n\'est filtré — y compris les films au pays inconnu', () => {
  const p = pool();
  assert.equal(p.inRange({}).length, 7);
  assert.equal(p.inRange({ countries: [] }).length, 7);
  assert.equal(p.inRange({ countries: undefined }).length, 7);
  assert.ok(p.inRange({ countries: [] }).some((r) => r.id === 'inconnu'));
  assert.ok(!p.inRange({ countries: ['France'] }).some((r) => r.id === 'inconnu'), 'avec un filtre, un pays inconnu ne passe pas');
});

test('les pays se combinent avec la période (les deux doivent correspondre)', () => {
  const p = pool();
  assert.deepEqual(ids(p.inRange({ from: 1990, to: 1999, countries: ['France', 'États-Unis'] })), ['fr', 'us']);
  assert.deepEqual(ids(p.inRange({ from: 2000, countries: ['France', 'États-Unis'] })), ['fr2', 'us-uk']);
  assert.deepEqual(ids(p.inRange({ from: 2010, countries: ['France'] })), []);
});

test('les effectifs par pays comptent chaque pays d\'une coproduction et suivent la période', () => {
  const p = pool();
  assert.deepEqual(Object.fromEntries(p.countryCounts()), {
    France: 2,
    Italie: 1,
    'États-Unis': 2,
    'Royaume-Uni': 1,
    Japon: 1,
  });
  assert.equal(p.countryCounts({ from: 2000 }).get('France'), 1);
  assert.equal(p.countryCounts({ from: 2000 }).has('Japon'), false);
});

test('la liste des pays est triée du mieux fourni au moins fourni, et complétée par ceux qu\'on ira chercher', () => {
  const p = pool();
  // À effectif égal, l'ordre alphabétique (« États-Unis » se classe à « E »).
  assert.deepEqual(p.countries().map((c) => c.name), ['États-Unis', 'France', 'Italie', 'Japon', 'Royaume-Uni']);
  assert.deepEqual(p.countries({ from: 2000 }), [
    { name: 'États-Unis', count: 1 },
    { name: 'France', count: 1 },
    { name: 'Royaume-Uni', count: 1 },
  ]);
  const extended = p.countries({ from: 2000 }, ['Japon', 'France', 'Belgique']);
  assert.deepEqual(extended.slice(-2), [
    { name: 'Belgique', count: 0 },
    { name: 'Japon', count: 0 },
  ]);
  assert.equal(extended.find((c) => c.name === 'France').count, 1, 'un pays déjà présent garde son effectif');
});

test('les effectifs par année peuvent être limités à des pays', () => {
  const p = pool();
  assert.equal(p.yearCounts().get(1995), 5, 'dont un film au pays inconnu');
  assert.equal(p.yearCounts({ countries: ['France'] }).get(1995), 1);
  assert.equal(p.yearCounts({ countries: ['Japon'] }).get(2005), undefined);
});

// ---- API -------------------------------------------------------------------------------------

test("/api/quote ne renvoie que des films des pays demandés", async () => {
  const server = await startServer(new QuotePool(seed));
  try {
    for (let i = 0; i < 40; i += 1) {
      const { body } = await getQuote(server.base, `?countries=${encodeURIComponent('France,Italie')}`);
      assert.ok(!body.empty);
      assert.ok(originsOf(body.id).some((c) => ['France', 'Italie'].includes(c)), countryOf(body.id));
    }
    // Un seul pays, avec accents et espaces : le nom revient tel que le serveur l'a donné.
    for (let i = 0; i < 20; i += 1) {
      const { body } = await getQuote(server.base, `?countries=${encodeURIComponent('États-Unis')}`);
      assert.ok(originsOf(body.id).includes('États-Unis'));
    }
  } finally {
    await server.close();
  }
});

test("sans le paramètre (ou vide), il n'y a aucun filtre : même les films au pays inconnu sont tirés", async () => {
  const p = pool();
  const server = await startServer(p);
  try {
    for (const query of ['', '?countries=', '?countries=,,']) {
      const { status, body } = await getQuote(server.base, query);
      assert.equal(status, 200, query);
      assert.equal(body.inRange, 7, query);
    }
    const drawn = new Set();
    for (let i = 0; i < 200 && !drawn.has('inconnu'); i += 1) drawn.add((await getQuote(server.base)).body.id);
    assert.ok(drawn.has('inconnu'));
  } finally {
    await server.close();
  }
});

test('les pays et la période se combinent, et le nombre de répliques tient compte des deux', async () => {
  const server = await startServer(pool());
  try {
    const both = (await getQuote(server.base, `?from=1990&to=1999&countries=${encodeURIComponent('France,États-Unis')}`)).body;
    assert.equal(both.inRange, 2);
    assert.equal(both.total, 7);
    assert.ok(['fr', 'us'].includes(both.id));

    const yearsOnly = (await getQuote(server.base, '?from=2000')).body;
    assert.equal(yearsOnly.inRange, 2);
  } finally {
    await server.close();
  }
});

async function getCountries(base, query = '') {
  const res = await fetch(`${base}/api/countries${query}`);
  return { status: res.status, body: await res.json() };
}

test('/api/countries liste les pays de la période (pas ceux de la sélection) avec leur effectif', async () => {
  const server = await startServer(pool());
  try {
    const { status, body: all } = await getCountries(server.base);
    assert.equal(status, 200);
    assert.deepEqual(all.countries.map((c) => c.name), ['États-Unis', 'France', 'Italie', 'Japon', 'Royaume-Uni']);
    assert.deepEqual(all.countries[1], { name: 'France', count: 2 });

    // Choisir la France ne retire pas les autres pays de la liste : on doit pouvoir en ajouter.
    assert.deepEqual((await getCountries(server.base, '?countries=France')).body, all);

    const recent = (await getCountries(server.base, '?from=2000')).body;
    assert.deepEqual(recent.countries.map((c) => c.name), ['États-Unis', 'France', 'Royaume-Uni']);
  } finally {
    await server.close();
  }
});

test('/api/countries ajoute les pays déjà choisis et ceux que la moisson sait récolter, même à zéro réplique', async () => {
  const harvester = { prioritize() {}, harvestableCountries: ['Belgique', 'France'] };
  const server = await startServer(pool(), { harvester });
  try {
    const { countries } = (await getCountries(server.base, `?from=2000&countries=${encodeURIComponent('Japon,Atlantide')}`)).body;
    assert.deepEqual(countries.slice(0, 3).map((c) => c.name), ['États-Unis', 'France', 'Royaume-Uni']);
    assert.deepEqual(countries.slice(3), [
      { name: 'Atlantide', count: 0 },
      { name: 'Belgique', count: 0 },
      { name: 'Japon', count: 0 },
    ]);
    assert.equal(countries.find((c) => c.name === 'France').count, 1, 'un pays présent garde son effectif');
  } finally {
    await server.close();
  }
});

test("/api/countries refuse une période ou un nom de pays invalides, et /api/quote n'embarque plus la liste", async () => {
  const server = await startServer(pool());
  try {
    assert.equal((await getCountries(server.base, '?from=abc')).status, 400);
    assert.equal((await getCountries(server.base, '?countries=France;drop')).status, 400);
    assert.ok(!('countries' in (await getQuote(server.base)).body), 'la liste est demandée à part, à l\'ouverture du panneau');
  } finally {
    await server.close();
  }
});

test('un pays sans aucune réplique répond « vide »', async () => {
  const server = await startServer(pool());
  try {
    const { status, body } = await getQuote(server.base, '?countries=Atlantide');
    assert.equal(status, 200);
    assert.equal(body.empty, true);
    assert.equal(body.inRange, 0);
  } finally {
    await server.close();
  }
});

test('les pays déjà vus sont exclus, puis le tirage repart de zéro quand ils sont épuisés', async () => {
  const server = await startServer(pool());
  try {
    const first = (await getQuote(server.base, '?countries=France&exclude=fr')).body;
    assert.equal(first.id, 'fr2');
    assert.equal(first.reset, false);

    const exhausted = (await getQuote(server.base, '?countries=France&exclude=fr,fr2')).body;
    assert.equal(exhausted.reset, true);
    assert.ok(['fr', 'fr2'].includes(exhausted.id));
  } finally {
    await server.close();
  }
});

test('un nom de pays invalide est refusé, et la liste est limitée', async () => {
  const server = await startServer(pool());
  try {
    const tooMany = Array.from({ length: 41 }, (_, i) => `Pays${i}`).join(',');
    for (const query of [
      '?countries=France;drop',
      '?countries=<script>',
      '?countries=1234',
      `?countries=${'x'.repeat(41)}`,
      `?countries=${tooMany}`,
    ]) {
      assert.equal((await getQuote(server.base, query)).status, 400, query);
    }
    // Un pays inconnu mais bien formé n'est pas une erreur : il n'a simplement aucune réplique.
    assert.equal((await getQuote(server.base, '?countries=Atlantide')).status, 200);
    // Les doublons et les espaces sont ignorés.
    assert.equal((await getQuote(server.base, '?countries=France,%20France,France')).body.inRange, 2);
  } finally {
    await server.close();
  }
});

test('choisir des pays demande à la moisson de s\'en occuper, avec ou sans période', async () => {
  const calls = [];
  const harvester = { prioritize: (target) => calls.push(target) };
  const server = await startServer(pool(), { harvester });
  try {
    await getQuote(server.base);
    assert.deepEqual(calls, [], 'sans filtre, rien à prioriser');

    await getQuote(server.base, `?countries=${encodeURIComponent('Japon,Belgique')}`);
    await getQuote(server.base, '?from=1990&to=1995&countries=France');
    assert.deepEqual(calls, [
      { from: null, to: null, countries: ['Japon', 'Belgique'] }, // pas de période : on ne cible aucune année
      { from: 1990, to: 1995, countries: ['France'] },
    ]);
  } finally {
    await server.close();
  }
});

// ---- indice « Pays d'origine » ---------------------------------------------------------------

const hintKeys = (movie, filter) => quotes.offeredHints(movie, filter).map((h) => h.key);

test("l'indice « Pays d'origine » n'est proposé que s'il apprend encore quelque chose", () => {
  const french = film('f', 'France');
  const coproduction = film('c', 'France / Italie');
  assert.deepEqual(hintKeys(french, undefined), ['year', 'country', 'initial']);
  assert.deepEqual(hintKeys(french, { countries: [] }), ['year', 'country', 'initial']);
  assert.deepEqual(hintKeys(french, { countries: ['France'] }), ['year', 'initial'], 'un seul pays choisi, un seul au film');
  assert.ok(hintKeys(french, { countries: ['France', 'Italie'] }).includes('country'), 'plusieurs pays : il les départage');
  assert.ok(hintKeys(coproduction, { countries: ['France'] }).includes('country'), 'une coproduction a un autre pays à révéler');
});

test("/api/quote ne propose pas l'indice pays quand il serait inutile, et la réponse le donne toujours", async () => {
  const p = new QuotePool([film('fr', 'France'), film('fr-it', 'France / Italie'), film('it', 'Italie')]);
  const server = await startServer(p);
  try {
    const keys = async (query) => (await getQuote(server.base, query)).body.hints.map((h) => h.key);
    assert.deepEqual(await keys('?countries=France&exclude=fr-it'), ['year', 'initial'], 'film français, filtre « France »');
    assert.ok((await keys('?countries=France&exclude=fr')).includes('country'), 'coproduction : « Italie » reste à découvrir');
    assert.ok((await keys('?countries=France,Italie&exclude=fr-it,it')).includes('country'), 'deux pays choisis');
    assert.ok((await keys('?exclude=fr-it,it')).includes('country'), 'aucun filtre');

    const answer = await (await fetch(`${server.base}/api/quote/fr/answer`)).json();
    assert.ok(answer.details.some((d) => d.key === 'country' && d.value === 'France'));
  } finally {
    await server.close();
  }
});

test("l'historique compte les indices comme ceux qui ont été proposés", async () => {
  const users = new UserStore({ file: path.join(tempDir(), 'users.json'), persistDelayMs: 5 });
  const server = await startServer(new QuotePool([film('fr', 'France')]), { users });
  try {
    const cookie = sessionCookie(await postJson(server.base, '/api/auth/register', { username: 'Alice', password: 'motdepasse1' }));
    const available = async (extra) => {
      const res = await postJson(server.base, '/api/history', { quoteId: 'fr', hintsUsed: 9, ...extra }, { cookie });
      return (await res.json()).entry.hintsAvailable;
    };
    assert.equal(await available({}), 3);
    assert.equal(await available({ countries: ['France'] }), 2, 'l\'indice pays n\'a pas été proposé');
    assert.equal(await available({ countries: ['France', 'Italie'] }), 3);
    assert.equal((await postJson(server.base, '/api/history', { quoteId: 'fr', hintsUsed: 0, countries: ['<b>'] }, { cookie })).status, 400);
  } finally {
    await server.close();
    await users.flush();
  }
});

test('bounds() se calcule en une passe : un grand réservoir ne fait pas déborder la pile', () => {
  const many = Array.from({ length: 200_000 }, (_, i) => film(`m${i}`, 'France', 1900 + (i % 100)));
  assert.deepEqual(new QuotePool(many).bounds(), { min: 1900, max: 1999 });
});

// ---- moisson ciblée --------------------------------------------------------------------------

const silent = { info() {}, warn() {} };
const memoryStore = (cursors = {}) => ({ load: () => ({ cursors, records: [] }), save: async () => {} });

function recordingClient() {
  const calls = [];
  return {
    calls,
    async fetchBatch(category) {
      calls.push(category);
      return { pages: [], next: null };
    },
  };
}

const harvesterFor = (p, { cursors, categories = [] } = {}) => {
  const client = recordingClient();
  const harvester = createHarvester({
    pool: p, client, store: memoryStore(cursors), categories, sleep: async () => {}, log: silent,
  });
  return { harvester, client };
};

test('la moisson traite en premier les pays demandés, les moins fournis d\'abord', async () => {
  const { harvester, client } = harvesterFor(new QuotePool(seed));
  // Dans le jeu de départ : le Japon n'a aucune réplique, la France en a 6, les États-Unis en ont plus de 30.
  assert.deepEqual(
    harvester.prioritize({ countries: ['France', 'Japon'] }),
    ['Film japonais', 'Film français'],
  );
  await harvester.start();
  assert.deepEqual(client.calls, ['Film japonais', 'Film français']);
});

test('les pays bien fournis, déjà terminés ou sans catégorie sont ignorés', () => {
  const full = Array.from({ length: 100 }, (_, i) => film(`f${i}`, 'France'));
  const { harvester } = harvesterFor(new QuotePool(full), { cursors: { 'Film belge': { next: null, done: true } } });
  assert.deepEqual(harvester.prioritize({ countries: ['France', 'Belgique', 'Italie'] }), ['Film italien']);
  assert.deepEqual(harvester.prioritize({ countries: ['Atlantide'] }), []);
  assert.deepEqual(harvester.prioritize({ countries: 'France' }), [], 'une liste attendue');
});

test('un pays est jugé sur la période choisie, une année sur les pays choisis', () => {
  const frenchNineties = Array.from({ length: 100 }, (_, i) => film(`f${i}`, 'France', 1995));
  const { harvester } = harvesterFor(new QuotePool(frenchNineties));
  // 100 films français, mais aucun après 2000 : la France manque de films pour cette période.
  assert.deepEqual(harvester.prioritize({ from: 2000, to: 2000, countries: ['France'] }), ['Film français', 'Œuvre de 2000']);
  // Sur la période où elle est bien fournie, la France n'a plus besoin d'aide ; l'année 1995 non plus, mais seulement pour la France.
  assert.deepEqual(harvester.prioritize({ from: 1995, to: 1995, countries: ['France'] }), []);
  assert.deepEqual(harvester.prioritize({ from: 1995, to: 1995, countries: ['Japon'] }), ['Film japonais', 'Œuvre de 1995']);
});

test('les pays passent avant les années, et la moisson est limitée à quelques pays à la fois', async () => {
  const { harvester, client } = harvesterFor(new QuotePool(seed));
  assert.deepEqual(harvester.prioritize({ from: 1990, to: 1990, countries: ['Japon'] }), ['Film japonais', 'Œuvre de 1990']);
  await harvester.start();
  assert.deepEqual(client.calls, ['Film japonais', 'Œuvre de 1990']);

  const many = ['Japon', 'Belgique', 'Canada', 'Australie', 'Espagne', 'Allemagne', 'Italie', 'Suisse'];
  assert.equal(harvesterFor(new QuotePool()).harvester.prioritize({ countries: many }).length, 6);
});

test('la moisson ne cible rien quand on ne lui demande ni période ni pays', () => {
  const { harvester } = harvesterFor(new QuotePool(seed));
  assert.deepEqual(harvester.prioritize({}), []);
  assert.deepEqual(harvester.prioritize({ countries: [] }), []);
  assert.deepEqual(harvester.prioritize({ from: 2002, to: 2000 }), [], 'période inversée');
});

test('la moisson repart quand des pays sont demandés après la fin de la moisson générale', async () => {
  const { harvester, client } = harvesterFor(new QuotePool(seed), {
    cursors: { A: { next: null, done: true } },
    categories: ['A'],
  });
  await harvester.start();
  assert.deepEqual(client.calls, []);

  harvester.prioritize({ countries: ['Japon'] });
  await harvester.start();
  assert.deepEqual(client.calls, ['Film japonais']);
});

test('la moisson sait quels pays elle peut récolter', () => {
  assert.deepEqual(harvesterFor(new QuotePool()).harvester.harvestableCountries, []);

  const { harvester } = harvesterFor(new QuotePool(), { categories: CATEGORIES });
  const countries = harvester.harvestableCountries;
  for (const expected of ['États-Unis', 'France', 'Royaume-Uni', 'Italie', 'Allemagne', 'Japon', 'Canada', 'Australie', 'Belgique', 'Espagne']) {
    assert.ok(countries.includes(expected), expected);
  }
  assert.ok(!countries.includes(undefined) && !countries.includes(null));
  assert.ok(countries.length <= 12, 'seules les catégories de nationalité comptent, pas les genres');
});

// ---- correspondance pays ↔ catégorie Wikiquote ----------------------------------------------

test('chaque pays reconnu a une catégorie qui redonne ce pays à la lecture d\'une page', () => {
  const countries = new Set(
    ['américain', 'français', 'britannique', 'italien', 'allemand', 'japonais', 'néo-zélandais', 'coréen', 'soviétique'].map(
      (demonym) => extractFilmMeta('X', `[[Catégorie:Film ${demonym}]]`).country,
    ),
  );
  assert.equal(countries.size, 9);
  for (const country of countries) {
    const category = countryCategory(country);
    assert.match(category, /^Film /, country);
    assert.equal(extractFilmMeta('X', `[[Catégorie:${category}]]`).country, country, category);
  }
});

test('les catégories de pays sont celles de Wikiquote, et un pays inconnu n\'en a pas', () => {
  assert.equal(countryCategory('États-Unis'), 'Film américain');
  assert.equal(countryCategory('Royaume-Uni'), 'Film britannique');
  assert.equal(countryCategory('France'), 'Film français');
  assert.equal(countryCategory('Japon'), 'Film japonais');
  assert.equal(countryCategory('Atlantide'), null);
  assert.equal(countryCategory(undefined), null);
});

test('une catégorie qui n\'est pas une nationalité ne donne pas de pays', () => {
  for (const category of ['Film musical', 'Film d\'action', 'Film constructor', 'Film d\'animation Disney', 'Drame']) {
    assert.equal(extractFilmMeta('X', `[[Catégorie:${category}]]`).country, null, category);
  }
  assert.equal(extractFilmMeta('X', "[[Catégorie:Film d'animation japonais]]").country, 'Japon');
});
