'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../src/auth');

test('les identifiants sont validés (pseudo et mot de passe)', () => {
  assert.equal(auth.validateCredentials('Alice_75', 'motdepasse1'), null);
  assert.equal(auth.validateCredentials('éloïse.d-1', '12345678'), null);
  for (const pseudo of ['ab', 'a'.repeat(25), 'with space', 'sémi;colon', '<b>', '', null, 42]) {
    assert.match(auth.validateCredentials(pseudo, 'motdepasse1'), /Pseudo invalide/, String(pseudo));
  }
  for (const mdp of ['court', 'x'.repeat(129), '', null, undefined]) {
    assert.match(auth.validateCredentials('alice', mdp), /Mot de passe invalide/, String(mdp));
  }
});

test('les pseudos sont comparés sans tenir compte de la casse', () => {
  assert.equal(auth.normalizeUsername('  Alice '), 'alice');
  assert.equal(auth.normalizeUsername('ÉLOÏSE'), auth.normalizeUsername('éloïse'));
});

test('le hachage de mot de passe est salé et se vérifie', async () => {
  const a = await auth.hashPassword('motdepasse1');
  const b = await auth.hashPassword('motdepasse1');
  assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(a, b, 'deux hachages du même mot de passe doivent différer (sel)');
  assert.ok(!a.includes('motdepasse1'));

  assert.equal(await auth.verifyPassword('motdepasse1', a), true);
  assert.equal(await auth.verifyPassword('motdepasse2', a), false);
  assert.equal(await auth.verifyPassword('', a), false);
});

test('un enregistrement de mot de passe abîmé ne permet jamais de se connecter', async () => {
  for (const stored of ['', 'n-importe-quoi', 'bcrypt$x$y', 'scrypt$a$b$c$d$e', null, undefined]) {
    assert.equal(await auth.verifyPassword('motdepasse1', stored), false, String(stored));
  }
});

test('les jetons de session sont aléatoires et seul leur hachage est conservé', () => {
  const a = auth.newToken();
  const b = auth.newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 43);
  assert.match(auth.hashToken(a), /^[0-9a-f]{64}$/);
  assert.notEqual(auth.hashToken(a), a);
  assert.equal(auth.hashToken(a), auth.hashToken(a));
});

test('les cookies sont lus et écrits avec les bons attributs', () => {
  assert.deepEqual(auth.parseCookies('a=1; fmm_session=abc; b=x=y'), { a: '1', fmm_session: 'abc', b: 'x=y' });
  assert.deepEqual(auth.parseCookies(undefined), {});

  const plain = auth.serializeCookie('fmm_session', 'tok', { maxAgeSeconds: 60, secure: false });
  assert.equal(plain, 'fmm_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=60');
  const secure = auth.serializeCookie('fmm_session', 'tok', { maxAgeSeconds: 60, secure: true });
  assert.ok(secure.endsWith('; Secure'));
});

test('le limiteur bloque après le maximum, puis se libère à la fin de la fenêtre', () => {
  let now = 1_000;
  const limiter = auth.createLimiter({ max: 3, windowMs: 10_000, now: () => now });

  for (let i = 0; i < 2; i += 1) limiter.hit('k');
  assert.equal(limiter.isBlocked('k'), false);
  limiter.hit('k');
  assert.equal(limiter.isBlocked('k'), true);
  assert.equal(limiter.isBlocked('autre'), false);
  assert.equal(limiter.retryAfterMs('k'), 10_000);

  now += 4_000;
  assert.equal(limiter.retryAfterMs('k'), 6_000);
  now += 6_000;
  assert.equal(limiter.isBlocked('k'), false, 'la fenêtre est terminée');

  limiter.hit('k');
  limiter.hit('k');
  limiter.hit('k');
  assert.equal(limiter.isBlocked('k'), true);
  limiter.reset('k');
  assert.equal(limiter.isBlocked('k'), false);
});
