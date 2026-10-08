'use strict';

const { CATEGORIES, parseFilmPage } = require('./wikiquote');

const MIN_WAIT_MS = 1_000;
const MAX_RATE_LIMIT_WAIT_MS = 10 * 60_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    // Arrêt déjà demandé (pendant une requête, par exemple) : l'événement « abort »
    // ne se redéclencherait pas, on ne doit donc pas attendre.
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Moissonne Wikiquote en arrière-plan : un lot de 50 pages à la fois, en alternant
 * les catégories, en respectant les limites de débit (429 / Retry-After), et en
 * sauvegardant sa progression pour reprendre là où il s'était arrêté.
 * Le jeu ne l'attend jamais : il pioche dans ce qui est déjà récolté.
 */
function createHarvester({
  pool,
  client,
  store,
  categories = CATEGORIES,
  intervalMs = 5_000,
  maxRecords = 20_000,
  sleep = defaultSleep,
  random = Math.random,
  log = console,
}) {
  const state = store.load();
  pool.add(state.records);
  const controller = new AbortController();
  let running = null;

  const pendingCategories = () => categories.filter((c) => !state.cursors[c]?.done);

  function parseBatch(pages) {
    return pages.flatMap((page) => {
      try {
        return parseFilmPage(page);
      } catch (error) {
        log.warn(`Page ignorée (« ${page?.title} ») : ${error.message}`);
        return [];
      }
    });
  }

  function backoffMs(error, failures) {
    const jitter = Math.floor(random() * 5_000);
    if (error.retryAfterMs != null) {
      return Math.min(Math.max(error.retryAfterMs, MIN_WAIT_MS), MAX_RATE_LIMIT_WAIT_MS) + jitter;
    }
    return Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS) + jitter;
  }

  async function loop() {
    const { signal } = controller;
    let turn = 0;
    let failures = 0;
    let saveWarned = false;

    while (!signal.aborted) {
      if (state.records.length >= maxRecords) {
        log.info(`Wikiquote : plafond de ${maxRecords} répliques atteint, moisson arrêtée.`);
        return;
      }
      const todo = pendingCategories();
      if (todo.length === 0) {
        log.info(`Wikiquote : moisson terminée (${pool.size} répliques au total).`);
        return;
      }
      const category = todo[turn % todo.length];
      turn += 1;

      try {
        const { pages, next } = await client.fetchBatch(category, state.cursors[category]?.next ?? null);
        const added = pool.add(parseBatch(pages));
        state.records.push(...added);
        state.cursors[category] = { next, done: !next };
        failures = 0;
        log.info(`Wikiquote « ${category} » : ${pages.length} pages, +${added.length} répliques (total ${pool.size})`);

        try {
          await store.save(state);
        } catch (error) {
          if (!saveWarned) log.warn(`Cache non sauvegardé (${error.message}) : la moisson continue en mémoire.`);
          saveWarned = true;
        }
        await sleep(intervalMs, signal);
      } catch (error) {
        failures += 1;
        turn -= 1; // le prochain essai porte sur la même catégorie
        const wait = backoffMs(error, failures);
        log.warn(`Wikiquote « ${category} » : ${error.message} — nouvel essai dans ${Math.round(wait / 1000)} s`);
        await sleep(wait, signal);
      }
    }
  }

  return {
    start() {
      running ??= loop();
      return running;
    },
    async stop() {
      controller.abort();
      await running;
    },
    state,
  };
}

module.exports = { createHarvester, defaultSleep };
