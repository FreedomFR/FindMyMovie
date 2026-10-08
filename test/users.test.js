'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AccountError, UserStore, computeStats } = require('../src/users');
const { tempDir } = require('./helpers');

const newStore = (options = {}) => new UserStore({ persistDelayMs: 5, ...options });
const entry = (over = {}) => ({ quoteId: 'seed-1', quote: 'Une réplique', title: 'Un Film', year: 1999, hintsUsed: 0, hintsAvailable: 6, ...over });

test("l'inscription refuse les identifiants invalides et les pseudos déjà pris", async () => {
  const store = newStore();
  await assert.rejects(store.register('ab', 'motdepasse1'), (e) => e instanceof AccountError && e.status === 400 && e.code === 'invalid');
  await assert.rejects(store.register('alice', 'court'), (e) => e.status === 400);

  const alice = await store.register('Alice', 'motdepasse1');
  assert.equal(alice.username, 'Alice');
  assert.ok(!JSON.stringify(alice).includes('motdepasse1'));
  await assert.rejects(store.register('ALICE', 'autremotdepasse'), (e) => e.status === 409 && e.code === 'taken');
});

test("l'inscription se ferme quand le nombre maximal de comptes est atteint", async () => {
  const store = newStore({ maxUsers: 1 });
  await store.register('alice', 'motdepasse1');
  await assert.rejects(store.register('bob', 'motdepasse1'), (e) => e.status === 503 && e.code === 'closed');
});

test('la connexion accepte le bon mot de passe, sans tenir compte de la casse du pseudo', async () => {
  const store = newStore();
  await store.register('Alice', 'motdepasse1');
  assert.equal((await store.authenticate('alice', 'motdepasse1')).username, 'Alice');
  assert.equal(await store.authenticate('alice', 'faux-mot-de-passe'), null);
  assert.equal(await store.authenticate('inconnu', 'motdepasse1'), null);
  assert.equal(await store.authenticate('alice', 'x'.repeat(5_000)), null);
  assert.equal(await store.authenticate(null, 'motdepasse1'), null);
  assert.equal(await store.authenticate('alice', 42), null);
});

test('les sessions expirent, se révoquent et sont limitées par compte', async () => {
  let now = 1_000_000;
  const store = newStore({ now: () => now });
  const alice = await store.register('alice', 'motdepasse1');

  const { token, maxAgeSeconds } = store.createSession(alice);
  assert.equal(maxAgeSeconds, 30 * 24 * 3600);
  assert.equal(store.userForToken(token).username, 'alice');
  assert.equal(store.userForToken('jeton-inconnu'), null);
  assert.equal(store.userForToken(undefined), null);

  store.destroySession(token);
  assert.equal(store.userForToken(token), null);

  const old = store.createSession(alice).token;
  now += 31 * 24 * 3600 * 1000;
  assert.equal(store.userForToken(old), null, 'session expirée');

  const tokens = [];
  for (let i = 0; i < 12; i += 1) {
    now += 1_000;
    tokens.push(store.createSession(alice).token);
  }
  assert.equal(store.userForToken(tokens[0]), null, 'les plus anciennes sont retirées');
  assert.equal(store.userForToken(tokens[1]), null);
  assert.ok(store.userForToken(tokens[11]));
});

test("l'historique garde les parties, les résultats et calcule les statistiques", async () => {
  const store = newStore();
  const alice = await store.register('alice', 'motdepasse1');

  const a = store.addHistory(alice, entry({ hintsUsed: 0 }));
  const b = store.addHistory(alice, entry({ title: 'Deux', hintsUsed: 2 }));
  const c = store.addHistory(alice, entry({ title: 'Trois', hintsUsed: 4 }));
  store.addHistory(alice, entry({ title: 'Quatre', hintsUsed: 0 }));

  assert.equal(a.found, null);
  assert.match(a.id, /^[a-f0-9]{16}$/);
  assert.equal(store.setResult(alice, a.id, true).found, true);
  store.setResult(alice, b.id, true);
  store.setResult(alice, c.id, false);
  assert.equal(store.setResult(alice, 'inconnu', true), null);

  const { stats, entries } = store.history(alice, 3);
  assert.deepEqual(stats, { played: 4, found: 2, missed: 1, unrated: 1, successRate: 67, averageHints: 1.5 });
  assert.deepEqual(entries.map((e) => e.title), ['Quatre', 'Trois', 'Deux'], 'les plus récentes d\'abord, limitées');
});

test("les statistiques d'un historique vide n'inventent rien", () => {
  assert.deepEqual(computeStats([]), { played: 0, found: 0, missed: 0, unrated: 0, successRate: null, averageHints: null });
});

test("l'historique est plafonné : les plus anciennes parties sont oubliées", async () => {
  const store = newStore({ maxHistory: 3 });
  const alice = await store.register('alice', 'motdepasse1');
  for (const title of ['A', 'B', 'C', 'D', 'E']) store.addHistory(alice, entry({ title }));
  assert.deepEqual(store.history(alice).entries.map((e) => e.title), ['E', 'D', 'C']);
});

test("l'historique d'un joueur est invisible pour les autres", async () => {
  const store = newStore();
  const alice = await store.register('alice', 'motdepasse1');
  const bob = await store.register('bob', 'motdepasse1');
  const secret = store.addHistory(alice, entry());
  assert.equal(store.history(bob).entries.length, 0);
  assert.equal(store.setResult(bob, secret.id, true), null);
});

test('comptes, sessions et historique survivent à un redémarrage, sans mot de passe en clair', async () => {
  const file = path.join(tempDir(), 'sous-dossier', 'users.json');
  const first = newStore({ file });
  const alice = await first.register('Alice', 'motdepasse1');
  const { token } = first.createSession(alice);
  const played = first.addHistory(alice, entry());
  first.setResult(alice, played.id, true);
  await first.flush();

  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('motdepasse1'), 'le mot de passe ne doit jamais être écrit');
  assert.ok(!raw.includes(token), 'le jeton brut ne doit jamais être écrit, seulement son hachage');
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'fichier lisible par son seul propriétaire');
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  const second = newStore({ file });
  assert.equal((await second.authenticate('alice', 'motdepasse1')).username, 'Alice');
  assert.equal(second.userForToken(token).username, 'Alice');
  assert.equal(second.history(second.userForToken(token)).entries[0].found, true);
});

test("l'écriture différée finit par arriver sur le disque", async () => {
  const file = path.join(tempDir(), 'users.json');
  const store = newStore({ file, persistDelayMs: 10 });
  await store.register('alice', 'motdepasse1');
  await new Promise((resolve) => setTimeout(resolve, 150));
  await store.writing;
  assert.ok(fs.existsSync(file));
});

test('un fichier abîmé ou périmé repart de zéro, et les sessions expirées sont écartées au chargement', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'users.json');

  fs.writeFileSync(file, '{ pas du json');
  assert.equal(newStore({ file }).users.size, 0);
  fs.writeFileSync(file, JSON.stringify({ version: 99, users: [{ key: 'x', passwordHash: 'y' }] }));
  assert.equal(newStore({ file }).users.size, 0);

  let now = 1_000;
  const first = newStore({ file, now: () => now });
  const alice = await first.register('alice', 'motdepasse1');
  const { token } = first.createSession(alice);
  await first.flush();

  now += 40 * 24 * 3600 * 1000;
  const later = newStore({ file, now: () => now });
  assert.equal(later.users.size, 1);
  assert.equal(later.userForToken(token), null);
});
