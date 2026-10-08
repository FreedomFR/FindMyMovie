'use strict';

const { CATEGORIES, parseFilmPage } = require('./wikiquote');

const MIN_WAIT_MS = 1_000;
const MAX_RATE_LIMIT_WAIT_MS = 10 * 60_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

// Moisson ciblée sur une plage d'années (catégories « Œuvre de 1995 »…).
const FIRST_YEAR = 1888;
const MAX_PRIORITY_YEARS = 12; // années traitées à la fois
const ENOUGH_PER_YEAR = 40; // au-delà, une année est considérée comme bien fournie
const yearCategory = (year) => `Œuvre de ${year}`;

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
  let active = false;
  let priority = []; // catégories d'années demandées par les joueurs, traitées avant les autres

  const pendingCategories = () => categories.filter((c) => !state.cursors[c]?.done);
  const pendingPriority = () => priority.filter((c) => !state.cursors[c]?.done);

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
      const urgent = pendingPriority();
      const todo = urgent.length > 0 ? urgent : pendingCategories();
      if (todo.length === 0) {
        log.info(`Wikiquote : moisson terminée (${pool.size} répliques au total).`);
        return;
      }
      // Années demandées : dans l'ordre (les moins fournies d'abord). Sinon : rotation entre les catégories.
      const rotating = urgent.length === 0;
      const category = rotating ? todo[turn % todo.length] : urgent[0];
      if (rotating) turn += 1;

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
        if (rotating) turn -= 1; // le prochain essai porte sur la même catégorie
        const wait = backoffMs(error, failures);
        log.warn(`Wikiquote « ${category} » : ${error.message} — nouvel essai dans ${Math.round(wait / 1000)} s`);
        await sleep(wait, signal);
      }
    }
  }

  function start() {
    if (!active && !controller.signal.aborted) {
      active = true;
      running = loop().finally(() => {
        active = false;
      });
    }
    return running;
  }

  /**
   * Un joueur a choisi une plage d'années : les années les moins fournies passent en tête
   * de la moisson (et la moisson redémarre si elle s'était arrêtée).
   * Renvoie les catégories retenues.
   */
  function prioritize({ from, to }) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return [];
    const counts = pool.yearCounts();
    const candidates = [];
    for (let year = Math.max(from, FIRST_YEAR); year <= Math.min(to, new Date().getFullYear()); year += 1) {
      const category = yearCategory(year);
      const have = counts.get(year) ?? 0;
      if (!state.cursors[category]?.done && have < ENOUGH_PER_YEAR) candidates.push({ category, have });
    }
    priority = candidates
      .sort((a, b) => a.have - b.have)
      .slice(0, MAX_PRIORITY_YEARS)
      .map((c) => c.category);
    if (priority.length > 0) start();
    return priority;
  }

  return {
    start,
    prioritize,
    async stop() {
      controller.abort();
      await running;
    },
    state,
  };
}

module.exports = { createHarvester, defaultSleep };
