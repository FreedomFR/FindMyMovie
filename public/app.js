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
  // période
  period: $('period'),
  periodLabel: $('period-label'),
  periodCount: $('period-count'),
  periodForm: $('period-form'),
  periodError: $('period-error'),
  presets: $('presets'),
  yearFrom: $('year-from'),
  yearTo: $('year-to'),
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
// On n'envoie au serveur que les dernières répliques vues (l'URL doit rester courte).
const MAX_EXCLUDED = 150;
const MIN_YEAR = 1888;
const MAX_YEAR = 2100;
// Période sans film : la moisson cherche en arrière-plan, on réessaie quelques fois toute seule.
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

const state = {
  current: null, // { id, quote, hints }
  revealedHints: 0,
  totalHintsUsed: 0,
  round: 0,
  busy: false,
  refreshQueued: false,
  seen: loadSeen(),
  range: loadRange(), // { from, to } ; null = pas de borne
  bounds: null, // années disponibles côté serveur
  emptyRetries: 0,
  retryTimer: null,
  accountsEnabled: false,
  user: null,
  authMode: 'login',
};

// ---- stockage local (jamais indispensable) -------------------------------------------------

function loadSeen() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function saveSeen() {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify(state.seen.slice(-MAX_EXCLUDED)));
  } catch {
    // Stockage indisponible (navigation privée…) : on continue sans.
  }
}

function loadRange() {
  const none = { from: null, to: null };
  try {
    const stored = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null');
    const valid = (y) => y === null || (Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR);
    return stored && valid(stored.from) && valid(stored.to) ? { from: stored.from, to: stored.to } : none;
  } catch {
    return none;
  }
}

function saveRange() {
  try {
    localStorage.setItem(RANGE_KEY, JSON.stringify(state.range));
  } catch {
    // idem
  }
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

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
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

// ---- période -------------------------------------------------------------------------------

const isRangeActive = () => state.range.from !== null || state.range.to !== null;

function rangeLabel({ from, to }) {
  if (from === null && to === null) return 'toutes les années';
  if (from === null) return `jusqu'en ${to}`;
  if (to === null) return `depuis ${from}`;
  return from === to ? `${from} uniquement` : `${from} – ${to}`;
}

function buildPresets() {
  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = preset.label;
    button.addEventListener('click', () => applyRange({ from: preset.from, to: preset.to }));
    els.presets.append(button);
  }
}

function renderRange() {
  els.periodLabel.textContent = rangeLabel(state.range);
  els.yearFrom.value = state.range.from ?? '';
  els.yearTo.value = state.range.to ?? '';
  [...els.presets.children].forEach((button, i) => {
    const { from, to } = PRESETS[i];
    button.setAttribute('aria-pressed', String(from === state.range.from && to === state.range.to));
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

function applyRange({ from, to }) {
  if (from !== null && to !== null && from > to) [from, to] = [to, from];
  state.range = { from, to };
  state.emptyRetries = 0;
  saveRange();
  renderRange();
  els.periodError.hidden = true;
  els.period.open = false;
  nextQuote();
}

function updateCounts(data) {
  els.total.textContent = String(data.total);
  state.bounds = data.bounds;
  if (data.bounds) {
    els.yearFrom.placeholder = String(data.bounds.min);
    els.yearTo.placeholder = String(data.bounds.max);
  }
  els.periodCount.textContent = isRangeActive() ? `· ${data.inRange} réplique${data.inRange > 1 ? 's' : ''}` : '';
}

// ---- indices et réponse --------------------------------------------------------------------

function renderHints(hints) {
  els.hints.replaceChildren();
  for (const hint of hints) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hint';
    button.dataset.key = hint.key;

    const label = document.createElement('span');
    label.className = 'hint-label';
    label.textContent = hint.label;
    const value = document.createElement('span');
    value.className = 'hint-value hidden';
    value.textContent = '???';
    // Le texte de l'indice est lu par les lecteurs d'écran quand il change.
    value.setAttribute('aria-live', 'polite');

    button.append(label, value);
    button.addEventListener('click', () => revealHint(button, value));
    li.append(button);
    els.hints.append(li);
  }
}

async function revealHint(button, valueEl) {
  if (state.busy || button.classList.contains('revealed')) return;
  const quoteId = state.current.id;
  setBusy(true);
  showError('');
  try {
    const hint = await api(`/api/quote/${quoteId}/hint/${encodeURIComponent(button.dataset.key)}`);
    if (state.current?.id !== quoteId) return; // l'utilisateur est déjà passé à la suite
    valueEl.textContent = hint.value;
    valueEl.classList.remove('hidden');
    button.classList.add('revealed');
    button.setAttribute('aria-label', `${hint.label} : ${hint.value}`);
    state.revealedHints += 1;
    state.totalHintsUsed += 1;
    els.hintsUsed.textContent = String(state.totalHintsUsed);
  } catch {
    showError("Impossible de récupérer l'indice. Réessaie dans un instant.");
  } finally {
    setBusy(false);
  }
}

async function revealAnswer() {
  if (state.busy || !state.current) return;
  const quoteId = state.current.id;
  setBusy(true);
  showError('');
  try {
    const answer = await api(`/api/quote/${quoteId}/answer`);
    if (state.current?.id !== quoteId) return;
    renderAnswer(answer);
  } catch {
    showError('Impossible de récupérer la réponse. Réessaie dans un instant.');
  } finally {
    setBusy(false);
  }
}

function paragraph(className, ...content) {
  const p = document.createElement('p');
  p.className = className;
  p.append(...content);
  return p;
}

function sourceLink(source) {
  const a = document.createElement('a');
  a.href = source.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = `${source.name} (CC BY-SA 4.0)`;
  return paragraph('used', 'Source : ', a);
}

function loginNudge() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link';
  button.textContent = 'Connecte-toi';
  button.addEventListener('click', openAuth);
  return paragraph('used', 'Envie de garder ton historique ? ', button, ' (facultatif).');
}

function renderAnswer(answer) {
  const title = document.createElement('h2');
  title.textContent = answer.title;

  const list = document.createElement('dl');
  for (const detail of answer.details) {
    const dt = document.createElement('dt');
    dt.textContent = detail.label;
    const dd = document.createElement('dd');
    dd.textContent = detail.value;
    list.append(dt, dd);
  }

  const used = paragraph(
    'used',
    state.revealedHints === 0
      ? 'Aucun indice utilisé : bien joué !'
      : `Indices utilisés : ${state.revealedHints} / ${state.current.hints.length}`,
  );

  const parts = [title, list, used];
  if (answer.source?.url) parts.push(sourceLink(answer.source));

  let resultBox = null;
  if (state.user) {
    resultBox = document.createElement('div');
    resultBox.className = 'result';
    parts.push(resultBox);
  } else if (state.accountsEnabled) {
    parts.push(loginNudge());
  }

  els.answer.replaceChildren(...parts);
  els.answer.hidden = false;
  els.hintsSection.hidden = true; // tout est déjà dans la fiche
  els.reveal.disabled = true;
  els.next.classList.add('emphasis');

  if (resultBox) recordPlay(resultBox);
}

// ---- enchaînement des répliques ------------------------------------------------------------

function showEmpty() {
  state.current = null;
  els.quote.hidden = true;
  els.hintsSection.hidden = true;
  els.answer.hidden = true;
  els.answer.replaceChildren();
  els.next.classList.remove('emphasis');

  const canRetry = state.emptyRetries < EMPTY_RETRY_MAX;
  els.empty.textContent =
    `Aucune réplique pour la période « ${rangeLabel(state.range)} » pour l'instant. ` +
    (canRetry
      ? 'La récolte cherche des films de cette époque : nouvelle tentative automatique dans quelques secondes…'
      : 'Élargis la période ou réessaie plus tard avec « Réplique suivante ».');
  els.empty.hidden = false;

  if (canRetry) {
    state.emptyRetries += 1;
    state.retryTimer = setTimeout(nextQuote, EMPTY_RETRY_MS);
  }
}

async function nextQuote() {
  if (state.busy) {
    state.refreshQueued = true; // ex. une période choisie pendant une autre requête
    return;
  }
  clearTimeout(state.retryTimer);
  setBusy(true);
  showError('');
  try {
    const params = new URLSearchParams();
    const exclude = state.seen.slice(-MAX_EXCLUDED).join(',');
    if (exclude) params.set('exclude', exclude);
    if (state.range.from !== null) params.set('from', state.range.from);
    if (state.range.to !== null) params.set('to', state.range.to);
    const query = params.toString();

    const data = await api(`/api/quote${query ? `?${query}` : ''}`);
    updateCounts(data);
    if (data.empty) return showEmpty();

    if (data.reset) state.seen = []; // toutes les répliques ont été vues : on repart de zéro
    state.seen.push(data.id);
    saveSeen();

    state.current = { id: data.id, quote: data.quote, hints: data.hints };
    state.revealedHints = 0;
    state.emptyRetries = 0;

    els.quote.textContent = data.quote;
    els.quote.hidden = false;
    els.empty.hidden = true;
    state.round += 1;
    els.round.textContent = `n°${state.round}`;
    els.answer.hidden = true;
    els.answer.replaceChildren();
    els.hintsSection.hidden = false;
    els.next.classList.remove('emphasis');
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
  els.authError.hidden = true;
}

function openAuth() {
  setAuthMode('login');
  els.authForm.reset();
  els.authDialog.showModal();
  els.authUsername.focus();
}

async function submitAuth(event) {
  event.preventDefault();
  els.authError.hidden = true;
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
    els.authError.textContent = error instanceof ApiError ? error.message : 'Connexion impossible. Réessaie dans un instant.';
    els.authError.hidden = false;
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
      body: { quoteId: state.current.id, hintsUsed: state.revealedHints },
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

  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'btn btn-small btn-ghost';
  yes.textContent = '✅ Oui';
  yes.addEventListener('click', () => choose(true));
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'btn btn-small btn-ghost';
  no.textContent = '❌ Non';
  no.addEventListener('click', () => choose(false));

  const question = document.createElement('span');
  question.className = 'question';
  question.textContent = "Tu l'avais trouvée ?";
  box.replaceChildren(question, yes, no);
}

function statTile(label, value) {
  const tile = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  tile.append(dt, dd);
  return tile;
}

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
      const li = document.createElement('li');

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = icon;
      badge.title = text;
      badge.setAttribute('aria-label', text);

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = entry.year ? `${entry.title} (${entry.year})` : entry.title;

      const excerpt = document.createElement('span');
      excerpt.className = 'excerpt';
      excerpt.textContent = `« ${entry.quote.length > 140 ? `${entry.quote.slice(0, 137)}…` : entry.quote} »`;

      const when = new Date(entry.at).toLocaleString('fr-FR', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${text} · ${when} · ${entry.hintsUsed} indice${entry.hintsUsed > 1 ? 's' : ''} sur ${entry.hintsAvailable}`;

      li.append(badge, title, excerpt, meta);
      return li;
    }),
  );
}

async function openHistory() {
  els.historyError.hidden = true;
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
    els.historyError.textContent = "Impossible de charger l'historique. Réessaie dans un instant.";
    els.historyError.hidden = false;
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

els.periodForm.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    applyRange({ from: parseYear(els.yearFrom), to: parseYear(els.yearTo) });
  } catch (error) {
    els.periodError.textContent = error.message;
    els.periodError.hidden = false;
  }
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
renderRange();
loadAccount();
nextQuote();
