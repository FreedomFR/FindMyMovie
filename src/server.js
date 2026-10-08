'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const quotes = require('./quotes');
const auth = require('./auth');
const { QuotePool, createFileStore } = require('./pool');
const { AccountError, UserStore } = require('./users');
const { createHarvester } = require('./harvester');
const { createClient } = require('./wikiquote');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_COOKIE = 'fmm_session';
const FIRST_YEAR = 1888;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    // Une réponse ne doit jamais être mise en cache : chaque tirage est nouveau, chaque compte est privé.
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

const ID_PATTERN = /^[a-z0-9-]{1,40}$/;

function parseExclude(value) {
  if (!value) return [];
  return value
    .split(',')
    .filter((id) => ID_PATTERN.test(id))
    .slice(0, 200);
}

/** `?from=1990&to=2005` : l'une ou l'autre borne peut manquer. Renvoie null s'il n'y a aucune plage. */
function parseRange(params) {
  const year = (value) => {
    if (value == null || value === '') return null;
    if (!/^\d{1,4}$/.test(value)) throw new HttpError(400, 'Année invalide.');
    return Number(value);
  };
  let from = year(params.get('from'));
  let to = year(params.get('to'));
  if (from == null && to == null) return null;
  if (from != null && to != null && from > to) [from, to] = [to, from];
  return { from, to };
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  // Empêche de sortir de public/ (../, chemins absolus…).
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 404, { error: 'Introuvable' });
  }
  fs.readFile(file, (err, content) => {
    if (err) return sendJson(res, 404, { error: 'Introuvable' });
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
}

/** Corps JSON limité en taille. Le type JSON obligatoire empêche les formulaires d'un autre site (CSRF). */
function readJson(req, limit = 4_096) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return reject(new HttpError(415, 'Corps JSON attendu.'));

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > limit) return reject(new HttpError(413, 'Requête trop volumineuse.'));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new HttpError(400, 'JSON invalide.'));
      }
    });
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const { origin, host } = req.headers;
  if (!origin) return true; // pas d'en-tête Origin (curl, tests) : le type JSON obligatoire protège déjà
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function isSecure(req) {
  return Boolean(req.socket.encrypted) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function createServer(pool = new QuotePool(quotes.load()), { users = null, harvester = null, trustProxy = false } = {}) {
  const loginByIp = auth.createLimiter({ max: 30, windowMs: 15 * 60_000 });
  const loginByUser = auth.createLimiter({ max: 8, windowMs: 15 * 60_000 });
  const registerByIp = auth.createLimiter({ max: 10, windowMs: 60 * 60_000 });

  const clientIp = (req) =>
    (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'inconnue';

  const currentToken = (req) => auth.parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const currentUser = (req) => users?.userForToken(currentToken(req)) ?? null;

  function requireUser(req) {
    if (!users) throw new HttpError(503, 'Les comptes sont désactivés.');
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'Connexion requise.');
    return user;
  }

  function tooMany(limiter, key) {
    return new HttpError(429, 'Trop de tentatives, réessaie un peu plus tard.', {
      'Retry-After': String(Math.ceil(limiter.retryAfterMs(key) / 1000)),
    });
  }

  function startSession(req, res, user, status = 200) {
    const { token, maxAgeSeconds } = users.createSession(user);
    const cookie = auth.serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds, secure: isSecure(req) });
    sendJson(res, status, { user: { username: user.username } }, { 'Set-Cookie': cookie });
  }

  // ---- réponses de l'API --------------------------------------------------------------------

  function handleQuote(url, res) {
    const range = parseRange(url.searchParams);
    // Une plage choisie : la moisson s'occupe en priorité des années qui manquent de films.
    if (range && harvester) {
      harvester.prioritize({ from: range.from ?? FIRST_YEAR, to: range.to ?? new Date().getFullYear() });
    }
    const candidates = pool.inRange(range ?? {});
    const base = { total: pool.size, inRange: candidates.length, bounds: pool.bounds() };

    const { movie, reset } = quotes.pickRandom(candidates, parseExclude(url.searchParams.get('exclude')));
    if (!movie) return sendJson(res, 200, { ...base, empty: true });
    sendJson(res, 200, { ...quotes.publicView(movie), ...base, reset });
  }

  async function handleRegister(req, res) {
    if (!users) throw new HttpError(503, 'Les comptes sont désactivés.');
    const ip = clientIp(req);
    if (registerByIp.isBlocked(ip)) throw tooMany(registerByIp, ip);
    registerByIp.hit(ip);

    const { username, password } = await readJson(req);
    const user = await users.register(username, password);
    startSession(req, res, user, 201);
  }

  async function handleLogin(req, res) {
    if (!users) throw new HttpError(503, 'Les comptes sont désactivés.');
    const { username, password } = await readJson(req);
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new HttpError(400, 'Pseudo et mot de passe requis.');
    }
    const ip = clientIp(req);
    const userKey = `u:${auth.normalizeUsername(username)}`;
    if (loginByIp.isBlocked(ip)) throw tooMany(loginByIp, ip);
    if (loginByUser.isBlocked(userKey)) throw tooMany(loginByUser, userKey);

    const user = await users.authenticate(username, password);
    if (!user) {
      loginByIp.hit(ip);
      loginByUser.hit(userKey);
      throw new HttpError(401, 'Pseudo ou mot de passe incorrect.');
    }
    loginByUser.reset(userKey);
    startSession(req, res, user);
  }

  async function handleAddHistory(req, res) {
    const user = requireUser(req);
    const { quoteId, hintsUsed } = await readJson(req);
    const movie = typeof quoteId === 'string' && ID_PATTERN.test(quoteId) ? pool.get(quoteId) : null;
    if (!movie) throw new HttpError(404, 'Citation inconnue.');
    if (!Number.isInteger(hintsUsed) || hintsUsed < 0) throw new HttpError(400, "Nombre d'indices invalide.");

    // Le titre et la réponse viennent du serveur : le client ne peut pas falsifier son historique.
    const hintsAvailable = quotes.availableHints(movie).length;
    const entry = users.addHistory(user, {
      quoteId: movie.id,
      quote: movie.quote.length > 160 ? `${movie.quote.slice(0, 159)}…` : movie.quote, // le fichier est réécrit en entier : on le garde compact
      title: movie.title,
      year: movie.year ?? null,
      hintsUsed: Math.min(hintsUsed, hintsAvailable),
      hintsAvailable,
    });
    sendJson(res, 201, { entry });
  }

  async function handleResult(req, res, entryId) {
    const user = requireUser(req);
    const { found } = await readJson(req);
    if (typeof found !== 'boolean') throw new HttpError(400, '« found » doit être vrai ou faux.');
    const entry = users.setResult(user, entryId, found);
    if (!entry) throw new HttpError(404, 'Entrée inconnue.');
    sendJson(res, 200, { entry });
  }

  // ---- routage -------------------------------------------------------------------------------

  async function route(req, res) {
    const { method } = req;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      throw new HttpError(405, 'Méthode non autorisée', { Allow: 'GET, HEAD, POST' });
    }

    let url;
    let pathname;
    try {
      url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'Requête invalide');
    }

    if (method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, 'Origine refusée.');
      let match;
      if (pathname === '/api/auth/register') return handleRegister(req, res);
      if (pathname === '/api/auth/login') return handleLogin(req, res);
      if (pathname === '/api/auth/logout') {
        users?.destroySession(currentToken(req));
        const cookie = auth.serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: isSecure(req) });
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
      }
      if (pathname === '/api/history') return handleAddHistory(req, res);
      if ((match = pathname.match(/^\/api\/history\/([a-f0-9]{16})\/result$/))) return handleResult(req, res, match[1]);
      throw new HttpError(405, 'Méthode non autorisée', { Allow: 'GET, HEAD' });
    }

    if (pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
    if (pathname === '/api/quote') return handleQuote(url, res);

    if (pathname === '/api/auth/me') {
      const user = currentUser(req);
      return sendJson(res, 200, { accountsEnabled: Boolean(users), user: user ? { username: user.username } : null });
    }

    if (pathname === '/api/history') {
      const user = requireUser(req);
      const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit'), 10) || 50, 1), 200);
      return sendJson(res, 200, users.history(user, limit));
    }

    const match = pathname.match(/^\/api\/quote\/([a-z0-9-]{1,40})\/(answer|hint\/([a-z]+))$/);
    if (match) {
      const movie = pool.get(match[1]);
      if (!movie) throw new HttpError(404, 'Citation inconnue');
      if (match[2] === 'answer') return sendJson(res, 200, quotes.answerFor(movie));
      const hint = quotes.hintFor(movie, match[3]);
      if (!hint) throw new HttpError(404, 'Indice inconnu');
      return sendJson(res, 200, hint);
    }

    if (pathname.startsWith('/api/')) throw new HttpError(404, 'Introuvable');
    return serveStatic(req, res, pathname);
  }

  return http.createServer((req, res) => {
    Promise.resolve()
      .then(() => route(req, res))
      .catch((error) => {
        if (res.headersSent) return res.end();
        if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message }, error.headers);
        if (error instanceof AccountError) return sendJson(res, error.status, { error: error.message, code: error.code });
        console.error(`Erreur sur ${req.method} ${String(req.url).split('?')[0]} : ${error.message}`);
        sendJson(res, 500, { error: 'Erreur interne.' });
      });
  });
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'cache');
  const pool = new QuotePool(quotes.load());

  // Les répliques de départ suffisent pour jouer ; Wikiquote en ajoute en arrière-plan.
  const store = createFileStore(path.join(dataDir, 'wikiquote-cache.json'));
  let harvester = null;
  if (process.env.WIKIQUOTE_ENABLED !== 'false') {
    harvester = createHarvester({
      pool,
      client: createClient(),
      store,
      intervalMs: Number(process.env.WIKIQUOTE_INTERVAL_MS) || 5_000,
    });
    harvester.start();
  } else {
    // Récolte désactivée : plus aucun appel à Wikiquote, mais le cache déjà récolté reste utilisé.
    pool.add(store.load().records);
  }

  // Comptes facultatifs : sans eux, le jeu fonctionne exactement comme avant.
  const users =
    process.env.ACCOUNTS_ENABLED === 'false'
      ? null
      : new UserStore({
          file: path.join(dataDir, 'users.json'),
          maxUsers: Number(process.env.MAX_USERS) || 1_000,
        });

  const server = createServer(pool, { users, harvester, trustProxy: process.env.TRUST_PROXY === 'true' });
  server.listen(port, '0.0.0.0', () => console.log(`FindMyMovie écoute sur le port ${port}`));
  // Arrêt propre quand Docker envoie SIGTERM.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await harvester?.stop();
      await users?.flush();
      server.close(() => process.exit(0));
    });
  }
}
