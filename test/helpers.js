'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fmm-'));

/** Démarre un serveur sur un port libre ; `close()` l'arrête. */
async function startServer(pool, options = {}) {
  const server = createServer(pool, options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** POST JSON avec, si besoin, un cookie de session. */
function postJson(base, route, body, { cookie, headers = {} } = {}) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

/** « fmm_session=…» à renvoyer dans l'en-tête Cookie, extrait d'une réponse. */
const sessionCookie = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

module.exports = { postJson, sessionCookie, startServer, tempDir };
