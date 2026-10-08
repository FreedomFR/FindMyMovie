'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1 };
const KEY_LENGTH = 64;

const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]{3,24}$/u;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

const normalizeUsername = (username) => String(username).normalize('NFKC').trim().toLowerCase();

/** Renvoie le message d'erreur à afficher, ou null si les identifiants sont acceptables. */
function validateCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username.trim())) {
    return 'Pseudo invalide : 3 à 24 caractères (lettres, chiffres, _ . -).';
  }
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return `Mot de passe invalide : ${PASSWORD_MIN} à ${PASSWORD_MAX} caractères.`;
  }
  return null;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false; // enregistrement abîmé : jamais de connexion possible
  }
}

let dummyHash;
/** Calcule un hachage pour rien : un pseudo inconnu coûte le même temps qu'un mot de passe faux. */
async function burnPasswordCheck(password) {
  dummyHash ??= hashPassword('mot-de-passe-factice');
  await verifyPassword(password, await dummyHash);
}

const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const newId = () => crypto.randomBytes(8).toString('hex');

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

function serializeCookie(name, value, { maxAgeSeconds, secure }) {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    secure ? 'Secure' : null,
  ]
    .filter(Boolean)
    .join('; ');
}

/** Compteur à fenêtre fixe, en mémoire : suffisant pour freiner l'essai de mots de passe. */
function createLimiter({ max, windowMs, now = Date.now }) {
  const entries = new Map();

  function entry(key) {
    const t = now();
    let e = entries.get(key);
    if (!e || e.resetAt <= t) {
      e = { count: 0, resetAt: t + windowMs };
      entries.set(key, e);
      if (entries.size > 10_000) {
        for (const [k, v] of entries) if (v.resetAt <= t) entries.delete(k);
      }
    }
    return e;
  }

  return {
    /** Sans compter l'appel : le client est-il actuellement bloqué ? */
    isBlocked(key) {
      const e = entries.get(key);
      return Boolean(e && e.resetAt > now() && e.count >= max);
    },
    retryAfterMs(key) {
      const e = entries.get(key);
      return e ? Math.max(0, e.resetAt - now()) : 0;
    },
    hit(key) {
      entry(key).count += 1;
    },
    reset(key) {
      entries.delete(key);
    },
  };
}

module.exports = {
  PASSWORD_MAX,
  PASSWORD_MIN,
  burnPasswordCheck,
  createLimiter,
  hashPassword,
  hashToken,
  newId,
  newToken,
  normalizeUsername,
  parseCookies,
  serializeCookie,
  validateCredentials,
  verifyPassword,
};
