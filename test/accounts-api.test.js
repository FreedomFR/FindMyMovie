'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const quotes = require('../src/quotes');
const { QuotePool } = require('../src/pool');
const { UserStore } = require('../src/users');
const { postJson, sessionCookie, startServer, tempDir } = require('./helpers');

const seed = quotes.load();

async function withAccounts(fn, { serverOptions = {}, file } = {}) {
  const users = new UserStore({ file: file ?? path.join(tempDir(), 'users.json'), persistDelayMs: 5 });
  const server = await startServer(new QuotePool(seed), { users, ...serverOptions });
  try {
    await fn(server.base, users);
  } finally {
    await server.close();
  }
}

const credentials = { username: 'Alice', password: 'motdepasse1' };

test('sans compte, le joueur est anonyme et le jeu fonctionne', async () => {
  await withAccounts(async (base) => {
    const me = await (await fetch(`${base}/api/auth/me`)).json();
    assert.deepEqual(me, { accountsEnabled: true, user: null });
    assert.equal((await fetch(`${base}/api/quote`)).status, 200);
  });
});

test('quand les comptes sont désactivés, le reste du jeu est intact', async () => {
  const server = await startServer(new QuotePool(seed));
  try {
    const me = await (await fetch(`${server.base}/api/auth/me`)).json();
    assert.deepEqual(me, { accountsEnabled: false, user: null });
    assert.equal((await postJson(server.base, '/api/auth/register', credentials)).status, 503);
    assert.equal((await fetch(`${server.base}/api/history`)).status, 503);
    assert.equal((await fetch(`${server.base}/api/quote`)).status, 200);
  } finally {
    await server.close();
  }
});

test("l'inscription ouvre une session par cookie HttpOnly, la déconnexion la ferme", async () => {
  await withAccounts(async (base) => {
    const res = await postJson(base, '/api/auth/register', credentials);
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { user: { username: 'Alice' } });

    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /^fmm_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    assert.ok(!setCookie.includes('Secure'), 'pas de Secure sur du http local');

    const cookie = sessionCookie(res);
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).json();
    assert.equal(me.user.username, 'Alice');

    const out = await postJson(base, '/api/auth/logout', {}, { cookie });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);

    const after = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).json();
    assert.equal(after.user, null, 'le jeton est révoqué côté serveur');
  });
});

test('le cookie est marqué Secure derrière un proxy HTTPS', async () => {
  await withAccounts(async (base) => {
    const res = await postJson(base, '/api/auth/register', credentials, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.match(res.headers.get('set-cookie'), /; Secure$/);
  });
});

test('la connexion refuse un mauvais mot de passe sans dire si le pseudo existe', async () => {
  await withAccounts(async (base) => {
    await postJson(base, '/api/auth/register', credentials);

    const wrong = await postJson(base, '/api/auth/login', { username: 'alice', password: 'mauvais-mot-de-passe' });
    const unknown = await postJson(base, '/api/auth/login', { username: 'inconnu', password: 'mauvais-mot-de-passe' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(await wrong.json(), await unknown.json());

    const ok = await postJson(base, '/api/auth/login', { username: 'ALICE', password: 'motdepasse1' });
    assert.equal(ok.status, 200);
    assert.ok(sessionCookie(ok).startsWith('fmm_session='));
  });
});

test("l'inscription signale un pseudo pris ou des identifiants invalides", async () => {
  await withAccounts(async (base) => {
    await postJson(base, '/api/auth/register', credentials);
    const taken = await postJson(base, '/api/auth/register', { username: 'alice', password: 'autremotdepasse' });
    assert.equal(taken.status, 409);
    assert.equal((await taken.json()).code, 'taken');

    const invalid = await postJson(base, '/api/auth/register', { username: 'a', password: 'x' });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /Pseudo invalide/);
  });
});

test('les tentatives de connexion sont limitées (force brute) même avec le bon mot de passe ensuite', async () => {
  await withAccounts(async (base) => {
    await postJson(base, '/api/auth/register', credentials);
    for (let i = 0; i < 8; i += 1) {
      const res = await postJson(base, '/api/auth/login', { username: 'alice', password: `faux-mot-de-passe-${i}` });
      assert.equal(res.status, 401);
    }
    const blocked = await postJson(base, '/api/auth/login', { username: 'alice', password: 'motdepasse1' });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);

    // Un autre pseudo n'est pas touché par ce blocage-là.
    await postJson(base, '/api/auth/register', { username: 'bob', password: 'motdepasse1' });
    assert.equal((await postJson(base, '/api/auth/login', { username: 'bob', password: 'motdepasse1' })).status, 200);
  });
});

test("les inscriptions d'une même adresse sont limitées", async () => {
  await withAccounts(async (base) => {
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await postJson(base, '/api/auth/register', { username: `joueur${i}`, password: 'motdepasse1' })).status, 201);
    }
    assert.equal((await postJson(base, '/api/auth/register', { username: 'joueur10', password: 'motdepasse1' })).status, 429);
  });
});

test("l'adresse du client vient de X-Forwarded-For seulement si on fait confiance au proxy", async () => {
  // Un pseudo différent à chaque essai : seule la limite par adresse peut se déclencher.
  let n = 0;
  const attempt = (base, ip) =>
    postJson(base, '/api/auth/login', { username: `joueur${n++}`, password: 'faux-mot-de-passe' }, { headers: { 'X-Forwarded-For': ip } });

  // Sans confiance : l'en-tête est ignoré, toutes les requêtes comptent pour la même adresse.
  await withAccounts(async (base) => {
    for (let i = 0; i < 30; i += 1) assert.equal((await attempt(base, `10.0.0.${i}`)).status, 401);
    assert.equal((await attempt(base, '10.9.9.9')).status, 429);
  });

  // Avec confiance : chaque adresse a son propre compteur.
  await withAccounts(
    async (base) => {
      for (let i = 0; i < 30; i += 1) assert.equal((await attempt(base, '10.0.0.1')).status, 401);
      assert.equal((await attempt(base, '10.0.0.1')).status, 429);
      assert.equal((await attempt(base, '10.0.0.2')).status, 401);
    },
    { serverOptions: { trustProxy: true } },
  );
});

test('les requêtes POST doivent être du JSON de même origine et de taille raisonnable', async () => {
  await withAccounts(async (base) => {
    const form = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=alice&password=x',
    });
    assert.equal(form.status, 415, 'un formulaire venu d\'un autre site est refusé');

    const foreign = await postJson(base, '/api/auth/login', credentials, { headers: { Origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403);
    const same = await postJson(base, '/api/auth/register', credentials, { headers: { Origin: new URL(base).origin } });
    assert.equal(same.status, 201);

    const broken = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{pas du json' });
    assert.equal(broken.status, 400);
    const notObject = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[1,2]' });
    assert.equal(notObject.status, 400);
    const huge = await postJson(base, '/api/auth/login', { username: 'alice', password: 'x'.repeat(10_000) });
    assert.equal(huge.status, 413);
  });
});

test("l'historique demande une connexion", async () => {
  await withAccounts(async (base) => {
    assert.equal((await fetch(`${base}/api/history`)).status, 401);
    assert.equal((await postJson(base, '/api/history', { quoteId: seed[0].id, hintsUsed: 0 })).status, 401);
    assert.equal((await postJson(base, '/api/history/0123456789abcdef/result', { found: true })).status, 401);
    const stale = { cookie: 'fmm_session=jeton-invalide' };
    assert.equal((await fetch(`${base}/api/history`, { headers: { Cookie: stale.cookie } })).status, 401);
  });
});

test("l'historique enregistre la partie avec les données du serveur, puis le résultat", async () => {
  await withAccounts(async (base) => {
    const cookie = sessionCookie(await postJson(base, '/api/auth/register', credentials));
    const movie = seed[0];

    // Le client ne peut pas imposer un titre : seuls l'identifiant et le nombre d'indices comptent.
    const res = await postJson(base, '/api/history', { quoteId: movie.id, hintsUsed: 99, title: 'Faux titre', year: 1 }, { cookie });
    assert.equal(res.status, 201);
    const { entry } = await res.json();
    assert.equal(entry.title, movie.title);
    assert.equal(entry.year, movie.year);
    assert.equal(entry.quote, movie.quote);
    assert.equal(entry.hintsAvailable, quotes.availableHints(movie).length);
    assert.equal(entry.hintsUsed, entry.hintsAvailable, 'le nombre d\'indices est plafonné');
    assert.equal(entry.found, null);

    const rated = await postJson(base, `/api/history/${entry.id}/result`, { found: false }, { cookie });
    assert.equal(rated.status, 200);
    assert.equal((await rated.json()).entry.found, false);

    const history = await (await fetch(`${base}/api/history`, { headers: { Cookie: cookie } })).json();
    assert.equal(history.entries.length, 1);
    assert.equal(history.entries[0].title, movie.title);
    assert.equal(history.stats.played, 1);
    assert.equal(history.stats.missed, 1);
    assert.equal(history.stats.successRate, 0);
  });
});

test("l'historique rejette les données invalides et les entrées d'un autre joueur", async () => {
  await withAccounts(async (base) => {
    const alice = sessionCookie(await postJson(base, '/api/auth/register', credentials));
    const bob = sessionCookie(await postJson(base, '/api/auth/register', { username: 'Bob', password: 'motdepasse1' }));

    assert.equal((await postJson(base, '/api/history', { quoteId: 'inconnue', hintsUsed: 0 }, { cookie: alice })).status, 404);
    assert.equal((await postJson(base, '/api/history', { quoteId: '../etc', hintsUsed: 0 }, { cookie: alice })).status, 404);
    for (const hintsUsed of [-1, 1.5, '2', null]) {
      assert.equal((await postJson(base, '/api/history', { quoteId: seed[0].id, hintsUsed }, { cookie: alice })).status, 400, String(hintsUsed));
    }

    const { entry } = await (await postJson(base, '/api/history', { quoteId: seed[0].id, hintsUsed: 1 }, { cookie: alice })).json();
    assert.equal((await postJson(base, `/api/history/${entry.id}/result`, { found: 'oui' }, { cookie: alice })).status, 400);
    assert.equal((await postJson(base, `/api/history/${entry.id}/result`, { found: true }, { cookie: bob })).status, 404);
    assert.equal((await postJson(base, '/api/history/0000000000000000/result', { found: true }, { cookie: alice })).status, 404);

    const bobHistory = await (await fetch(`${base}/api/history`, { headers: { Cookie: bob } })).json();
    assert.equal(bobHistory.entries.length, 0);
  });
});

test('le mot de passe ne figure dans aucune réponse ni dans le fichier des comptes', async () => {
  const file = path.join(tempDir(), 'users.json');
  await withAccounts(async (base, users) => {
    const res = await postJson(base, '/api/auth/register', credentials);
    const body = await res.text();
    assert.ok(!body.includes('motdepasse1') && !body.includes('passwordHash'));
    await users.flush();
    assert.ok(!fs.readFileSync(file, 'utf8').includes('motdepasse1'));
  }, { file });
});

test("la réplique enregistrée dans l'historique est tronquée pour garder le fichier compact", async () => {
  const long = { id: 'wq-9-0', quote: 'Très long. '.repeat(20), title: 'Un Film', year: 2000, character: 'Léon' };
  const users = new UserStore({ file: path.join(tempDir(), 'users.json'), persistDelayMs: 5 });
  const server = await startServer(new QuotePool([long]), { users });
  try {
    const cookie = sessionCookie(await postJson(server.base, '/api/auth/register', credentials));
    const { entry } = await (await postJson(server.base, '/api/history', { quoteId: 'wq-9-0', hintsUsed: 0 }, { cookie })).json();
    assert.equal(entry.quote.length, 160);
    assert.ok(entry.quote.endsWith('…'));
  } finally {
    await server.close();
  }
});
