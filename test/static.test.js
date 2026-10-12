'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const { QuotePool } = require('../src/pool');
const { startServer } = require('./helpers');

const PUBLIC = path.join(__dirname, '..', 'public');

/** GET/HEAD brut : ni décompression ni en-têtes ajoutés par `fetch`, et le chemin part tel quel (pas normalisé par `URL`). */
function raw(base, route, { method = 'GET', headers = {} } = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: route, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn) {
  const server = await startServer(new QuotePool());
  try {
    await fn(server.base);
  } finally {
    await server.close();
  }
}

test('un fichier statique est servi avec une empreinte (ETag) et doit être revalidé', async () => {
  await withServer(async (base) => {
    const res = await raw(base, '/app.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.etag, /^"[A-Za-z0-9_-]{22}"$/);
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.match(res.headers['content-type'], /^text\/javascript/);
    assert.deepEqual(res.body, fs.readFileSync(path.join(PUBLIC, 'app.js')));
    assert.equal(Number(res.headers['content-length']), res.body.length);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  });
});

test("si le navigateur a déjà la bonne version, la réponse est un 304 sans corps, même avec une empreinte « faible »", async () => {
  await withServer(async (base) => {
    const { headers } = await raw(base, '/style.css');
    for (const header of [headers.etag, `W/${headers.etag}`, `"autre", ${headers.etag}`, '*']) {
      const res = await raw(base, '/style.css', { headers: { 'If-None-Match': header } });
      assert.equal(res.status, 304, header);
      assert.equal(res.body.length, 0);
      assert.equal(res.headers.etag, headers.etag);
      assert.equal(res.headers['cache-control'], 'no-cache');
    }
    const stale = await raw(base, '/style.css', { headers: { 'If-None-Match': '"vieille-version"' } });
    assert.equal(stale.status, 200);
    assert.ok(stale.body.length > 0);
  });
});

test('le texte est compressé en gzip pour qui l\'accepte, et l\'empreinte reste la même', async () => {
  await withServer(async (base) => {
    const plain = await raw(base, '/app.js');
    const gz = await raw(base, '/app.js', { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    assert.equal(gz.status, 200);
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.headers.vary, 'Accept-Encoding');
    assert.ok(gz.body.length < plain.body.length / 2, 'au moins deux fois plus petit');
    assert.equal(Number(gz.headers['content-length']), gz.body.length);
    assert.deepEqual(zlib.gunzipSync(gz.body), plain.body);
    assert.equal(gz.headers.etag, plain.headers.etag);

    // Sans gzip (ou refusé explicitement) : le fichier tel quel, mais « Vary » reste annoncé aux caches.
    for (const encoding of [undefined, 'identity', 'gzip;q=0', 'br']) {
      const res = await raw(base, '/app.js', { headers: encoding ? { 'Accept-Encoding': encoding } : {} });
      assert.equal(res.headers['content-encoding'], undefined, String(encoding));
      assert.deepEqual(res.body, plain.body, String(encoding));
      assert.equal(res.headers.vary, 'Accept-Encoding');
    }
  });
});

test('une page, une feuille de style et un script sont compressés, pas les formats déjà compacts', async () => {
  await withServer(async (base) => {
    for (const route of ['/', '/index.html', '/style.css', '/app.js', '/favicon.svg']) {
      const res = await raw(base, route, { headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(res.status, 200, route);
      assert.equal(res.headers['content-encoding'], 'gzip', route);
    }
  });
});

test('HEAD renvoie les en-têtes (taille comprise) sans corps', async () => {
  await withServer(async (base) => {
    const res = await raw(base, '/', { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 0);
    assert.equal(Number(res.headers['content-length']), fs.readFileSync(path.join(PUBLIC, 'index.html')).length);
    assert.ok(res.headers.etag);
  });
});

test('un fichier absent ou une sortie de public/ répondent 404', async () => {
  await withServer(async (base) => {
    for (const route of ['/absent.js', '/%2e%2e/package.json', '/..%2fpackage.json', '/../package.json']) {
      const res = await raw(base, route);
      assert.equal(res.status, 404, route);
      assert.match(res.headers['content-type'], /json/);
    }
  });
});

test('un fichier modifié sur le disque est relu : nouvelle empreinte, nouveau contenu', async () => {
  const name = `zz-test-statique-${process.pid}.txt`; // retiré en fin de test
  const file = path.join(PUBLIC, name);
  fs.writeFileSync(file, 'première version');
  try {
    await withServer(async (base) => {
      const before = await raw(base, `/${name}`);
      assert.equal(before.body.toString(), 'première version');

      fs.writeFileSync(file, 'deuxième version, plus longue');
      const after = await raw(base, `/${name}`, { headers: { 'If-None-Match': before.headers.etag } });
      assert.equal(after.status, 200, "l'ancienne empreinte ne vaut plus");
      assert.equal(after.body.toString(), 'deuxième version, plus longue');
      assert.notEqual(after.headers.etag, before.headers.etag);
      assert.equal(after.headers.vary, undefined, 'un .txt n\'est pas compressé');
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
});
