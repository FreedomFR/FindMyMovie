'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  round: $('round'),
  quote: $('quote'),
  empty: $('empty'),
  hintsSection: $('hints-section'),
  hints: $('hints'),
  reveal: $('reveal'),
  next: $('next'),
  answer: $('answer'),
  error: $('error'),
  hintsUsed: $('hints-used'),
  total: $('total'),
  // filtres
  filters: $('filters'),
  filtersSummary: $('filters-summary'),
  filtersCount: $('filters-count'),
  filtersForm: $('filters-form'),
  filtersError: $('filters-error'),
  filtersReset: $('filters-reset'),
  presets: $('presets'),
  yearFrom: $('year-from'),
  yearTo: $('year-to'),
  countryChips: $('country-chips'),
  // compte
  loginOpen: $('login-open'),
  userMenu: $('user-menu'),
  username: $('username'),
  logout: $('logout'),
  historyOpen: $('history-open'),
  authDialog: $('auth-dialog'),
  authForm: $('auth-form'),
  authTitle: $('auth-title'),
  authUsername: $('auth-username'),
  authPassword: $('auth-password'),
  authHelp: $('auth-help'),
  authError: $('auth-error'),
  authSubmit: $('auth-submit'),
  authCancel: $('auth-cancel'),
  tabLogin: $('tab-login'),
  tabRegister: $('tab-register'),
  // historique
  historyDialog: $('history-dialog'),
  historyStats: $('history-stats'),
  historyList: $('history-list'),
  historyEmpty: $('history-empty'),
  historyError: $('history-error'),
  historyClose: $('history-close'),
};

const SEEN_KEY = 'findmymovie.seen';
const RANGE_KEY = 'findmymovie.range';
const COUNTRIES_KEY = 'findmymovie.countries';
const MAX_COUNTRIES = 40; // comme côté serveur
const COUNTRY_PATTERN = /^\p{L}[\p{L} '’-]{0,39}$/u; // idem
// On n'envoie au serveur que les dernières répliques vues (l'URL doit rester courte).
const MAX_EXCLUDED = 150;
// Les bornes des années ont une seule source : les champs du formulaire.
const MIN_YEAR = Number(els.yearFrom.min);
const MAX_YEAR = Number(els.yearFrom.max);
// Filtres sans film : la moisson cherche en arrière-plan, on réessaie quelques fois toute seule.
const EMPTY_RETRY_MS = 8_000;
const EMPTY_RETRY_MAX = 8;

const PRESETS = [
  { label: 'Toutes', from: null, to: null },
  { label: 'Avant 1970', from: null, to: 1969 },
  { label: '1970-1989', from: 1970, to: 1989 },
  { label: '1990-1999', from: 1990, to: 1999 },
  { label: '2000-2009', from: 2000, to: 2009 },
  { label: '2010 et après', from: 2010, to: null },
];

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  current: null, // { id, hintCount, countries } : la réplique en cours et le filtre de pays avec lequel elle a été tirée
  revealedHints: 0,
  totalHintsUsed: 0,
  round: 0,
  busy: false,
  refreshQueued: false,
  seen: loadSeen(),
  filters: loadFilters(), // { from, to, countries } ; null = pas de borne, [] = tous les pays (aucun filtre)
  pendingCountries: new Set(), // sélection en cours dans le panneau, avant « Appliquer »
  countryList: [], // pays proposés à l'ouverture du panneau : [{ name, count }]
  emptyRetries: 0,
  retryTimer: null,
  accountsEnabled: false,
  user: null,
  authMode: 'login',
};

// ---- stockage local (jamais indispensable) -------------------------------------------------

// `area` : 'local' ou 'session'. On accède au stockage DANS le try : l'accès seul peut lever (navigation privée…).
function readStored(area, key) {
  try {
    return JSON.parse(window[`${area}Storage`].getItem(key));
  } catch {
    return null;
  }
}

function writeStored(area, key, value) {
  try {
    window[`${area}Storage`].setItem(key, JSON.stringify(value));
  } catch {
    // Stockage indisponible : on continue sans.
  }
}

function loadSeen() {
  const stored = readStored('session', SEEN_KEY);
  return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string').slice(-MAX_EXCLUDED) : [];
}

function loadFilters() {
  const range = readStored('local', RANGE_KEY);
  const validYear = (y) => y === null || (Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR);
  const validRange = range && validYear(range.from) && validYear(range.to);

  // Un nom que le serveur refuserait (400) bloquerait le jeu : on ne garde que les noms bien formés.
  const names = readStored('local', COUNTRIES_KEY);
  const countries = Array.isArray(names)
    ? [...new Set(names.filter((name) => typeof name === 'string' && COUNTRY_PATTERN.test(name)))].slice(0, MAX_COUNTRIES)
    : [];

  return { from: validRange ? range.from : null, to: validRange ? range.to : null, countries };
}

// ---- petits outils DOM ---------------------------------------------------------------------

/** Crée un élément. Les chaînes passées en contenu deviennent des nœuds texte, jamais du HTML. */
function el(tag, className, ...content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...content);
  return node;
}

function button(className, text, onClick) {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function showMessage(node, message) {
  node.textContent = message;
  node.hidden = !message;
}

const showError = (message) => showMessage(els.error, message);

/** Un léger fondu à l'arrivée d'un contenu, sauf si le système demande de réduire les animations. */
function animateIn(node) {
  if (reducedMotion.matches || !node.animate) return;
  node.animate(
    [
      { opacity: 0, transform: 'translateY(6px)' },
      { opacity: 1, transform: 'none' },
    ],
    { duration: 220, easing: 'ease-out' },
  );
}

// ---- réseau --------------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // corps vide ou illisible
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Erreur ${res.status}`);
  return data;
}

function setBusy(busy) {
  state.busy = busy;
  els.reveal.disabled = busy || !state.current || !els.answer.hidden;
  els.next.disabled = busy;
  if (!busy && state.refreshQueued) {
    state.refreshQueued = false;
    queueMicrotask(nextQuote);
  }
}

// ---- filtres : période et pays -------------------------------------------------------------

const isRangeActive = ({ from, to }) => from !== null || to !== null;
const isFilterActive = ({ from, to, countries }) => from !== null || to !== null || countries.length > 0;

/** La période choisie, en toutes lettres (à n'appeler que s'il y a une borne). */
function rangeLabel({ from, to }) {
  if (from === null) return `jusqu'en ${to}`;
  if (to === null) return `depuis ${from}`;
  return from === to ? `${from} uniquement` : `${from} – ${to}`;
}

const countriesLabel = (names) => (names.length <= 3 ? names.join(', ') : `${names.length} pays`);

/** Le filtre sous forme de paramètres d'URL ; ce qui n'est pas filtré n'y figure pas. */
function filterParams({ from, to, countries }) {
  const params = new URLSearchParams();
  if (from !== null) params.set('from', from);
  if (to !== null) params.set('to', to);
  if (countries.length > 0) params.set('countries', countries.join(','));
  return params;
}

function renderFilters() {
  const filters = state.filters;
  const active = [];
  if (isRangeActive(filters)) active.push(rangeLabel(filters));
  if (filters.countries.length > 0) active.push(countriesLabel(filters.countries));
  els.filtersSummary.textContent = active.join(' · ') || 'aucun';
  els.filters.dataset.active = String(isFilterActive(filters));
  [...els.presets.children].forEach((chip, i) => {
    const { from, to } = PRESETS[i];
    chip.setAttribute('aria-pressed', String(from === filters.from && to === filters.to));
  });
}

function parseYear(input) {
  const text = input.value.trim();
  if (text === '') return null;
  if (!/^\d{1,4}$/.test(text)) throw new Error('Saisis des années entières, par exemple 1994.');
  const year = Number(text);
  if (year < MIN_YEAR || year > MAX_YEAR) throw new Error(`Les années doivent être comprises entre ${MIN_YEAR} et ${MAX_YEAR}.`);
  return year;
}

/** Aucun filtre de pays : rien de coché, ou tous les pays proposés (qui sont alors équivalents à « tous »). */
const coversAllCountries = () =>
  state.pendingCountries.size === 0 || state.pendingCountries.size === state.countryList.length;

/** « Tous » est allumée quand rien n'est filtré ; les autres pastilles reflètent la sélection en cours. */
function syncCountryChips() {
  const everything = coversAllCountries();
  for (const chip of els.countryChips.children) {
    const pressed = chip.dataset.country === undefined ? everything : state.pendingCountries.has(chip.dataset.country);
    chip.setAttribute('aria-pressed', String(pressed));
  }
}

function renderCountryChips() {
  const all = button('chip', 'Tous', () => {
    state.pendingCountries.clear();
    syncCountryChips();
  });
  const chips = state.countryList.map(({ name, count }) => {
    const chip = button('chip', `${name} (${count})`, () => {
      if (!state.pendingCountries.delete(name)) state.pendingCountries.add(name);
      syncCountryChips();
    });
    chip.dataset.country = name;
    return chip;
  });
  els.countryChips.replaceChildren(all, ...chips);
  syncCountryChips();
}

const countryNotice = (text) => el('span', 'muted small', text);

/** À l'ouverture du panneau : la liste des pays de la période, avec leurs effectifs du moment (la moisson les fait évoluer). */
async function loadCountryList() {
  state.countryList = [];
  try {
    const { from, to } = state.filters;
    const { countries } = await api(`/api/countries?${filterParams({ from, to, countries: [...state.pendingCountries] })}`);
    if (!els.filters.open) return; // refermé entre-temps
    state.countryList = countries;
    renderCountryChips();
  } catch {
    if (els.filters.open) els.countryChips.replaceChildren(countryNotice('Liste des pays indisponible pour le moment.'));
  }
}

/** Le formulaire repart de ce qui est appliqué. */
function openFilters() {
  els.yearFrom.value = state.filters.from ?? '';
  els.yearTo.value = state.filters.to ?? '';
  state.pendingCountries = new Set(state.filters.countries);
  showMessage(els.filtersError, '');
  loadCountryList();
}

function applyFilters() {
  let from;
  let to;
  try {
    from = parseYear(els.yearFrom);
    to = parseYear(els.yearTo);
  } catch (error) {
    return showMessage(els.filtersError, error.message);
  }
  if (from !== null && to !== null && from > to) [from, to] = [to, from];
  // Tout choisir revient à ne rien filtrer : les films dont on ne connaît pas le pays restent alors possibles.
  const countries = coversAllCountries() ? [] : [...state.pendingCountries].slice(0, MAX_COUNTRIES);

  state.filters = { from, to, countries };
  state.emptyRetries = 0;
  writeStored('local', RANGE_KEY, { from, to });
  writeStored('local', COUNTRIES_KEY, countries);
  renderFilters();
  showMessage(els.filtersError, '');
  els.filters.open = false;
  nextQuote();
}

function buildPresets() {
  els.presets.append(
    ...PRESETS.map(({ label, from, to }) =>
      button('chip', label, () => {
        els.yearFrom.value = from ?? '';
        els.yearTo.value = to ?? '';
        applyFilters();
      }),
    ),
  );
}

function updateCounts(data) {
  els.total.textContent = String(data.total);
  if (data.bounds) {
    els.yearFrom.placeholder = String(data.bounds.min);
    els.yearTo.placeholder = String(data.bounds.max);
  }
  els.filtersCount.textContent = isFilterActive(state.filters) ? `· ${data.inRange} réplique${data.inRange > 1 ? 's' : ''}` : '';
}

// ---- indices et réponse --------------------------------------------------------------------

function renderHints(hints) {
  els.hints.replaceChildren(
    ...hints.map((hint) => {
      const value = el('span', 'hint-value hidden', '???');
      value.setAttribute('aria-live', 'polite'); // lu par les lecteurs d'écran quand il change
      const tile = button('hint', '', () => revealHint(tile, value));
      tile.dataset.key = hint.key;
      tile.append(el('span', 'hint-label', hint.label), value);
      return el('li', '', tile);
    }),
  );
}

/** Interroge le serveur sur la réplique en cours ; la réponse est ignorée si le joueur est déjà passé à la suivante. */
async function askAboutCurrent(path, onData, failureMessage) {
  const quoteId = state.current.id;
  setBusy(true);
  showError('');
  try {
    const data = await api(`/api/quote/${quoteId}/${path}`);
    if (state.current?.id === quoteId) onData(data);
  } catch {
    showError(failureMessage);
  } finally {
    setBusy(false);
  }
}

function revealHint(tile, valueEl) {
  if (state.busy || tile.classList.contains('revealed')) return;
  return askAboutCurrent(
    `hint/${encodeURIComponent(tile.dataset.key)}`,
    (hint) => {
      valueEl.textContent = hint.value;
      valueEl.classList.remove('hidden');
      tile.classList.add('revealed');
      tile.setAttribute('aria-label', `${hint.label} : ${hint.value}`);
      state.revealedHints += 1;
      state.totalHintsUsed += 1;
      els.hintsUsed.textContent = String(state.totalHintsUsed);
    },
    "Impossible de récupérer l'indice. Réessaie dans un instant.",
  );
}

function revealAnswer() {
  if (state.busy || !state.current) return;
  return askAboutCurrent('answer', renderAnswer, 'Impossible de récupérer la réponse. Réessaie dans un instant.');
}

function sourceLink(source) {
  const link = el('a', '', `${source.name} (CC BY-SA 4.0)`);
  link.href = source.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return el('p', 'used', 'Source : ', link);
}

function loginNudge() {
  return el('p', 'used', 'Envie de garder ton historique ? ', button('link', 'Connecte-toi', openAuth), ' (facultatif).');
}

function renderAnswer(answer) {
  const used =
    state.revealedHints === 0
      ? 'Aucun indice utilisé : bien joué !'
      : `Indices utilisés : ${state.revealedHints} / ${state.current.hintCount}`;
  const parts = [
    el('h2', '', answer.title),
    el('dl', '', ...answer.details.flatMap(({ label, value }) => [el('dt', '', label), el('dd', '', value)])),
    el('p', 'used', used),
  ];
  if (answer.source?.url) parts.push(sourceLink(answer.source));

  let resultBox = null;
  if (state.user) {
    resultBox = el('div', 'result');
    parts.push(resultBox);
  } else if (state.accountsEnabled) {
    parts.push(loginNudge());
  }

  els.answer.replaceChildren(...parts);
  els.answer.hidden = false;
  els.hintsSection.hidden = true; // tout est déjà dans la fiche
  els.next.classList.add('emphasis');
  // Sur un petit écran la fiche peut tomber sous le pli : on la ramène à l'écran.
  els.answer.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });

  if (resultBox) recordPlay(resultBox);
}

// ---- enchaînement des répliques ------------------------------------------------------------

function clearAnswer() {
  els.answer.hidden = true;
  els.answer.replaceChildren();
  els.next.classList.remove('emphasis');
}

function showEmpty() {
  state.current = null;
  els.quote.hidden = true;
  els.hintsSection.hidden = true;
  clearAnswer();

  const filters = [];
  if (isRangeActive(state.filters)) filters.push(`période « ${rangeLabel(state.filters)} »`);
  if (state.filters.countries.length > 0) filters.push(`pays « ${state.filters.countries.join(', ')} »`);

  const canRetry = state.emptyRetries < EMPTY_RETRY_MAX;
  els.empty.textContent =
    `Aucune réplique pour l'instant${filters.length ? ` (${filters.join(', ')})` : ''}. ` +
    (canRetry
      ? 'La récolte cherche des films correspondants : nouvelle tentative automatique dans quelques secondes…'
      : 'Élargis les filtres ou réessaie plus tard avec « Réplique suivante ».');
  els.empty.hidden = false;

  if (canRetry) {
    state.emptyRetries += 1;
    state.retryTimer = setTimeout(nextQuote, EMPTY_RETRY_MS);
  }
}

async function nextQuote() {
  if (state.busy) {
    state.refreshQueued = true; // ex. un filtre choisi pendant une autre requête
    return;
  }
  clearTimeout(state.retryTimer);
  setBusy(true);
  showError('');
  try {
    const params = filterParams(state.filters);
    if (state.seen.length > 0) params.set('exclude', state.seen.join(','));
    const query = params.toString();

    const data = await api(`/api/quote${query ? `?${query}` : ''}`);
    updateCounts(data);
    if (data.empty) return showEmpty();

    // Toutes les répliques ont été vues : on repart de zéro.
    state.seen = [...(data.reset ? [] : state.seen), data.id].slice(-MAX_EXCLUDED);
    writeStored('session', SEEN_KEY, state.seen);

    state.current = { id: data.id, hintCount: data.hints.length, countries: state.filters.countries };
    state.revealedHints = 0;
    state.emptyRetries = 0;

    els.quote.textContent = data.quote;
    els.quote.hidden = false;
    animateIn(els.quote);
    els.empty.hidden = true;
    state.round += 1;
    els.round.textContent = `n°${state.round}`;
    clearAnswer();
    els.hintsSection.hidden = false;
    renderHints(data.hints);
  } catch {
    showError('Impossible de charger une réplique. Vérifie ta connexion puis réessaie.');
  } finally {
    setBusy(false);
  }
}

// ---- compte --------------------------------------------------------------------------------

function renderAccount() {
  els.loginOpen.hidden = !state.accountsEnabled || Boolean(state.user);
  els.userMenu.hidden = !state.user;
  els.username.textContent = state.user?.username ?? '';
}

function setUser(user) {
  state.user = user;
  renderAccount();
}

async function loadAccount() {
  try {
    const me = await api('/api/auth/me');
    state.accountsEnabled = me.accountsEnabled;
    state.user = me.user;
  } catch {
    state.accountsEnabled = false; // serveur injoignable : le jeu reste utilisable anonymement
  }
  renderAccount();
}

function setAuthMode(mode) {
  state.authMode = mode;
  const registering = mode === 'register';
  els.tabLogin.setAttribute('aria-pressed', String(!registering));
  els.tabRegister.setAttribute('aria-pressed', String(registering));
  els.authTitle.textContent = registering ? 'Créer un compte' : 'Connexion';
  els.authSubmit.textContent = registering ? 'Créer mon compte' : 'Se connecter';
  els.authPassword.autocomplete = registering ? 'new-password' : 'current-password';
  els.authHelp.hidden = !registering;
  showMessage(els.authError, '');
}

function openAuth() {
  setAuthMode('login');
  els.authForm.reset();
  els.authDialog.showModal();
  els.authUsername.focus();
}

async function submitAuth(event) {
  event.preventDefault();
  showMessage(els.authError, '');
  els.authSubmit.disabled = true;
  try {
    const { user } = await api(`/api/auth/${state.authMode}`, {
      method: 'POST',
      body: { username: els.authUsername.value, password: els.authPassword.value },
    });
    setUser(user);
    els.authForm.reset();
    els.authDialog.close();
  } catch (error) {
    showMessage(els.authError, error instanceof ApiError ? error.message : 'Connexion impossible. Réessaie dans un instant.');
  } finally {
    els.authSubmit.disabled = false;
  }
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST', body: {} });
  } catch {
    // Même si le serveur ne répond pas, on se déconnecte côté page.
  }
  setUser(null);
  els.historyDialog.close();
  els.answer.querySelector('.result')?.remove();
}

// ---- historique ----------------------------------------------------------------------------

const RESULT_LABELS = {
  true: ['✅', 'Trouvée'],
  false: ['❌', 'Ratée'],
  null: ['•', 'Non notée'],
};

/** La partie est enregistrée dès la révélation de la réponse ; le joueur dit ensuite s'il avait trouvé. */
async function recordPlay(box) {
  try {
    const { entry } = await api('/api/history', {
      method: 'POST',
      // Le filtre de pays sert au serveur à compter les indices comme ceux qui ont été proposés.
      body: { quoteId: state.current.id, hintsUsed: state.revealedHints, countries: state.current.countries },
    });
    if (box.isConnected) renderResultChoice(box, entry.id);
  } catch (error) {
    if (!box.isConnected) return;
    if (error.status === 401) {
      setUser(null);
      box.textContent = 'Ta session a expiré : reconnecte-toi pour enregistrer tes parties.';
    }
  }
}

function renderResultChoice(box, entryId) {
  const choose = async (found) => {
    box.replaceChildren('Enregistrement…');
    try {
      await api(`/api/history/${entryId}/result`, { method: 'POST', body: { found } });
      box.replaceChildren(found ? '✅ Enregistré : tu l\'avais trouvée !' : '❌ Enregistré : ce sera pour la prochaine.');
    } catch {
      box.replaceChildren("Impossible d'enregistrer le résultat.");
    }
  };

  box.replaceChildren(
    el('span', 'question', "Tu l'avais trouvée ?"),
    button('btn btn-small btn-ghost', '✅ Oui', () => choose(true)),
    button('btn btn-small btn-ghost', '❌ Non', () => choose(false)),
  );
}

const statTile = (label, value) => el('div', '', el('dt', '', label), el('dd', '', value));

function renderHistory({ stats, entries }) {
  els.historyStats.replaceChildren(
    statTile('Parties', String(stats.played)),
    statTile('Trouvées', String(stats.found)),
    statTile('Réussite', stats.successRate === null ? '–' : `${stats.successRate} %`),
    statTile('Indices / partie', stats.averageHints === null ? '–' : String(stats.averageHints).replace('.', ',')),
  );
  els.historyEmpty.hidden = entries.length > 0;

  els.historyList.replaceChildren(
    ...entries.map((entry) => {
      const [icon, text] = RESULT_LABELS[String(entry.found)];
      const badge = el('span', 'badge', icon);
      badge.title = text;
      badge.setAttribute('aria-label', text);

      const when = new Date(entry.at).toLocaleString('fr-FR', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      return el(
        'li',
        '',
        badge,
        el('span', 'title', entry.year ? `${entry.title} (${entry.year})` : entry.title),
        el('span', 'excerpt', `« ${entry.quote.length > 140 ? `${entry.quote.slice(0, 137)}…` : entry.quote} »`),
        el('span', 'meta', `${text} · ${when} · ${entry.hintsUsed} indice${entry.hintsUsed > 1 ? 's' : ''} sur ${entry.hintsAvailable}`),
      );
    }),
  );
}

async function openHistory() {
  showMessage(els.historyError, '');
  els.historyDialog.showModal();
  try {
    renderHistory(await api('/api/history?limit=50'));
  } catch (error) {
    if (error.status === 401) {
      setUser(null);
      els.historyDialog.close();
      openAuth();
      return;
    }
    showMessage(els.historyError, "Impossible de charger l'historique. Réessaie dans un instant.");
  }
}

// ---- démarrage -----------------------------------------------------------------------------

function closeOnBackdropClick(dialog) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

els.reveal.addEventListener('click', revealAnswer);
els.next.addEventListener('click', nextQuote);

els.filters.addEventListener('toggle', () => {
  if (els.filters.open) return openFilters();
  // Refermé : on ne garde pas les pastilles de cette fois (ni leur sélection) pour la prochaine ouverture.
  els.countryChips.replaceChildren(countryNotice('Chargement des pays…'));
});
els.filtersForm.addEventListener('submit', (event) => {
  event.preventDefault();
  applyFilters();
});
els.filtersReset.addEventListener('click', () => {
  els.yearFrom.value = '';
  els.yearTo.value = '';
  state.pendingCountries.clear();
  applyFilters();
});

els.loginOpen.addEventListener('click', openAuth);
els.logout.addEventListener('click', logout);
els.historyOpen.addEventListener('click', openHistory);
els.authForm.addEventListener('submit', submitAuth);
els.authCancel.addEventListener('click', () => els.authDialog.close());
els.tabLogin.addEventListener('click', () => setAuthMode('login'));
els.tabRegister.addEventListener('click', () => setAuthMode('register'));
els.historyClose.addEventListener('click', () => els.historyDialog.close());
closeOnBackdropClick(els.authDialog);
closeOnBackdropClick(els.historyDialog);

buildPresets();
renderFilters();
loadAccount();
nextQuote();
