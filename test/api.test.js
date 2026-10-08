'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const quotes = require('../src/quotes');
const { QuotePool } = require('../src/pool');
const { createServer } = require('../src/server');

const movies = quotes.load();

async function withServer(fn, pool = new QuotePool(movies)) {
  const server = createServer(pool);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('chaque citation a tous les champs nécessaires aux indices', () => {
  const ids = new Set();
  for (const m of movies) {
    assert.ok(!ids.has(m.id), `id en double : ${m.id}`);
    ids.add(m.id);
    for (const field of ['quote', 'title', 'country', 'genre', 'director', 'actor']) {
      assert.equal(typeof m[field], 'string', `${m.title} : champ « ${field} » manquant`);
      assert.ok(m[field].trim(), `${m.title} : champ « ${field} » vide`);
    }
    assert.ok(Number.isInteger(m.year) && m.year > 1890, `${m.title} : année invalide`);
  }
});

test("l'initiale ignore les articles", () => {
  assert.equal(quotes.initialOf('Le Parrain'), 'P');
  assert.equal(quotes.initialOf("L'Empire contre-attaque"), 'E');
  assert.equal(quotes.initialOf('Les Évadés'), 'É');
  assert.equal(quotes.initialOf('Titanic'), 'T');
});

test('le tirage évite les citations déjà vues puis repart de zéro', () => {
  const [first, ...rest] = movies;
  const excludeAllButFirst = rest.map((m) => m.id);
  assert.deepEqual(quotes.pickRandom(movies, excludeAllButFirst), { movie: first, reset: false });

  const all = movies.map((m) => m.id);
  assert.equal(quotes.pickRandom(movies, all).reset, true);
});

test("/api/quote ne révèle ni la réponse ni le contenu des indices", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/quote`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const movie = movies.find((m) => m.id === body.id);

    assert.equal(body.quote, movie.quote);
    assert.equal(body.total, movies.length);
    assert.deepEqual(body.hints.map((h) => h.key), quotes.availableHints(movie).map((h) => h.key));

    const raw = JSON.stringify(body);
    for (const secret of [movie.title, movie.director, movie.actor, movie.country, String(movie.year)]) {
      // La citation peut contenir par hasard le titre ou une année : on ne vérifie que le reste.
      if (!movie.quote.includes(secret)) assert.ok(!raw.includes(secret), `fuite : « ${secret} »`);
    }
    assert.ok(!('title' in body) && !('year' in body));
  });
});

test('/api/quote?exclude= évite les identifiants fournis', async () => {
  await withServer(async (base) => {
    const exclude = movies.slice(1).map((m) => m.id).join(',');
    for (let i = 0; i < 5; i += 1) {
      const body = await (await fetch(`${base}/api/quote?exclude=${exclude}`)).json();
      assert.equal(body.id, movies[0].id);
      assert.equal(body.reset, false);
    }
  });
});

test('un indice et la réponse sont servis à la demande', async () => {
  await withServer(async (base) => {
    const movie = movies[0];

    const year = await (await fetch(`${base}/api/quote/${movie.id}/hint/year`)).json();
    assert.deepEqual(year, { key: 'year', label: 'Année de sortie', value: String(movie.year) });

    const answer = await (await fetch(`${base}/api/quote/${movie.id}/answer`)).json();
    assert.equal(answer.title, movie.title);
    assert.deepEqual(answer.details.map((d) => d.key), quotes.availableHints(movie).map((h) => h.key));
    assert.equal(answer.source, null);
  });
});

test('identifiants et indices inconnus -> 404', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/quote/inconnu/answer`)).status, 404);
    assert.equal((await fetch(`${base}/api/quote/${movies[0].id}/hint/secret`)).status, 404);
    // Les répliques de départ n'ont pas de « personnage » : l'indice n'existe pas pour elles.
    assert.equal((await fetch(`${base}/api/quote/${movies[0].id}/hint/character`)).status, 404);
    assert.equal((await fetch(`${base}/api/inconnu`)).status, 404);
  });
});

test('les fichiers statiques sont servis et le répertoire parent est protégé', async () => {
  await withServer(async (base) => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.ok(home.headers.get('content-security-policy'));

    assert.equal((await fetch(`${base}/style.css`)).status, 200);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);

    // fetch() normalise « /../ » : on passe par un socket brut pour tester le vrai chemin.
    const net = require('node:net');
    const port = new URL(base).port;
    const raw = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () =>
        socket.write('GET /..%2fpackage.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let data = '';
      socket.on('data', (c) => (data += c));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 404/);
  });
});

test('les méthodes autres que GET/HEAD sont refusées', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/quote`, { method: 'POST' });
    assert.equal(res.status, 405);
  });
});

test('les indices sans donnée sont omis et la source apparaît dans la réponse', async () => {
  const remote = {
    id: 'wq-1-0',
    quote: 'Une réplique venue de Wikiquote.',
    title: 'Un Film',
    year: 1999,
    country: null,
    genre: null,
    director: null,
    actor: null,
    character: 'Léon',
    source: { name: 'Wikiquote', url: 'https://fr.wikiquote.org/wiki/Un_Film' },
  };
  await withServer(async (base) => {
    const quote = await (await fetch(`${base}/api/quote`)).json();
    assert.deepEqual(quote.hints.map((h) => h.key), ['year', 'character', 'initial']);
    assert.equal((await fetch(`${base}/api/quote/wq-1-0/hint/country`)).status, 404);

    const answer = await (await fetch(`${base}/api/quote/wq-1-0/answer`)).json();
    assert.deepEqual(answer.source, remote.source);
    assert.deepEqual(answer.details.map((d) => d.key), ['year', 'character', 'initial']);
  }, new QuotePool([remote]));
});

test("/api/quote ignore les identifiants d'exclusion invalides", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/quote?exclude=${encodeURIComponent('<script>,../etc,')}`);
    assert.equal(res.status, 200);
  });
});
