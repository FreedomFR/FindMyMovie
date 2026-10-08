'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const quotes = require('./quotes');
const { QuotePool, createFileStore } = require('./pool');
const { createHarvester } = require('./harvester');
const { createClient } = require('./wikiquote');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

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

function sendJson(res, status, body) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    // Une réponse ne doit jamais être mise en cache : chaque tirage est nouveau.
    'Cache-Control': 'no-store',
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

function createServer(pool = new QuotePool(quotes.load())) {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return sendJson(res, 405, { error: 'Méthode non autorisée' });
    }

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Requête invalide' });
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, { error: 'Requête invalide' });
    }

    if (pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });

    if (pathname === '/api/quote') {
      const { movie, reset } = pool.pick(parseExclude(url.searchParams.get('exclude')));
      return sendJson(res, 200, { ...quotes.publicView(movie), total: pool.size, reset });
    }

    const match = pathname.match(/^\/api\/quote\/([a-z0-9-]{1,40})\/(answer|hint\/([a-z]+))$/);
    if (match) {
      const movie = pool.get(match[1]);
      if (!movie) return sendJson(res, 404, { error: 'Citation inconnue' });
      if (match[2] === 'answer') return sendJson(res, 200, quotes.answerFor(movie));
      const hint = quotes.hintFor(movie, match[3]);
      if (!hint) return sendJson(res, 404, { error: 'Indice inconnu' });
      return sendJson(res, 200, hint);
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Introuvable' });
    return serveStatic(req, res, pathname);
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

  const server = createServer(pool);
  server.listen(port, '0.0.0.0', () => console.log(`FindMyMovie écoute sur le port ${port}`));
  // Arrêt propre quand Docker envoie SIGTERM.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await harvester?.stop();
      server.close(() => process.exit(0));
    });
  }
}
