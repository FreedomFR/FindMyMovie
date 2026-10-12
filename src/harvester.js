'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { CATEGORIES, FIRST_YEAR, countryCategory, countryOfCategory, parseFilmPage } = require('./wikiquote');

const MIN_WAIT_MS = 1_000;
const MAX_RATE_LIMIT_WAIT_MS = 10 * 60_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

// Moisson ciblée sur une plage d'années (catégories « Œuvre de 1995 »…).
const MAX_PRIORITY_YEARS = 12; // années traitées à la fois
const ENOUGH_PER_YEAR = 40; // au-delà, une année est considérée comme bien fournie
const yearCategory = (year) => `Œuvre de ${year}`;

// Moisson ciblée sur des pays (catégories « Film français »…).
const MAX_PRIORITY_COUNTRIES = 6; // pays traités à la fois
const ENOUGH_PER_COUNTRY = 100; // au-delà, un pays est considéré comme bien fourni

// Une pause qu'un arrêt interrompt (ou qui n'a pas lieu si l'arrêt est déjà demandé). On passe par les minuteurs
// de Node, qui détachent eux-mêmes l'écouteur du signal : l'ancienne version en laissait un par pause (~9 Mo par jour).
const defaultSleep = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {});

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

  /** Les catégories à moissonner d'abord, les moins fournies en tête, et pas plus de `limit`. */
  function leastFilled(candidates, limit) {
    return candidates
      .filter(({ category, have, enough }) => category && !state.cursors[category]?.done && have < enough)
      .sort((a, b) => a.have - b.have)
      .slice(0, limit)
      .map((c) => c.category);
  }

  /**
   * Un joueur a choisi une plage d'années et/ou des pays : les années et les pays les moins fournis passent
   * en tête de la moisson (et la moisson redémarre si elle s'était arrêtée). Les pays d'abord, puis les années.
   * Les deux filtres se combinent : un pays est jugé sur la période choisie, une année sur les pays choisis.
   * Renvoie les catégories retenues.
   */
  function prioritize({ from = null, to = null, countries = [] } = {}) {
    const wanted = Array.isArray(countries) ? countries : [];
    // Une borne absente reste ouverte ; sans aucune borne, on ne moissonne pas par années.
    const bound = (year) => (Number.isInteger(year) ? year : null);
    const period = { from: bound(from), to: bound(to) };
    const byYear = period.from !== null || period.to !== null;
    if (!byYear && wanted.length === 0) return [];

    const countryCounts = pool.countryCounts(period);
    const countryCategories = leastFilled(
      wanted.map((country) => ({
        category: countryCategory(country),
        have: countryCounts.get(country) ?? 0,
        enough: ENOUGH_PER_COUNTRY,
      })),
      MAX_PRIORITY_COUNTRIES,
    );

    const yearCategories = [];
    if (byYear) {
      const yearCounts = pool.yearCounts({ countries: wanted });
      const thisYear = new Date().getFullYear();
      const years = [];
      for (let year = Math.max(period.from ?? FIRST_YEAR, FIRST_YEAR); year <= Math.min(period.to ?? thisYear, thisYear); year += 1) {
        years.push({ category: yearCategory(year), have: yearCounts.get(year) ?? 0, enough: ENOUGH_PER_YEAR });
      }
      yearCategories.push(...leastFilled(years, MAX_PRIORITY_YEARS));
    }

    priority = [...countryCategories, ...yearCategories];
    if (priority.length > 0) start();
    return priority;
  }

  /** Les pays que la moisson générale sait récolter (une catégorie « Film <nationalité> » dans sa liste). */
  const harvestableCountries = [...new Set(categories.map(countryOfCategory).filter(Boolean))];

  return {
    start,
    prioritize,
    harvestableCountries,
    async stop() {
      controller.abort();
      await running;
    },
    state,
  };
}

module.exports = { createHarvester, defaultSleep };
