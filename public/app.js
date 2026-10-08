'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  round: $('round'),
  quote: $('quote'),
  hintsSection: $('hints-section'),
  hints: $('hints'),
  reveal: $('reveal'),
  next: $('next'),
  answer: $('answer'),
  error: $('error'),
  hintsUsed: $('hints-used'),
};

const SEEN_KEY = 'findmymovie.seen';

const state = {
  current: null, // { id, quote, hints }
  revealedHints: 0,
  totalHintsUsed: 0,
  busy: false,
  seen: loadSeen(),
};

function loadSeen() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

function saveSeen() {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify(state.seen));
  } catch {
    // Stockage indisponible (navigation privée…) : on continue sans.
  }
}

async function api(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Erreur ${res.status}`);
  return res.json();
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
}

function setBusy(busy) {
  state.busy = busy;
  els.reveal.disabled = busy || !state.current || !els.answer.hidden;
  els.next.disabled = busy || !state.current;
}

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
    if (state.current.id !== quoteId) return; // l'utilisateur est déjà passé à la suite
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
    if (state.current.id !== quoteId) return;
    renderAnswer(answer);
  } catch {
    showError('Impossible de récupérer la réponse. Réessaie dans un instant.');
  } finally {
    setBusy(false);
  }
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

  const used = document.createElement('p');
  used.className = 'used';
  used.textContent =
    state.revealedHints === 0
      ? 'Aucun indice utilisé : bien joué !'
      : `Indices utilisés : ${state.revealedHints} / ${state.current.hints.length}`;

  els.answer.replaceChildren(title, list, used);
  els.answer.hidden = false;
  els.hintsSection.hidden = true; // tout est déjà dans la fiche
  els.reveal.disabled = true;
  els.next.classList.add('emphasis');
}

async function nextQuote() {
  if (state.busy) return;
  setBusy(true);
  showError('');
  try {
    const exclude = state.seen.join(',');
    const data = await api(`/api/quote${exclude ? `?exclude=${exclude}` : ''}`);
    if (data.reset) state.seen = []; // toutes les répliques ont été vues : on repart de zéro
    state.seen.push(data.id);
    saveSeen();

    state.current = { id: data.id, quote: data.quote, hints: data.hints };
    state.revealedHints = 0;

    els.quote.textContent = data.quote;
    els.round.textContent = `${state.seen.length} sur ${data.total}`;
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

els.reveal.addEventListener('click', revealAnswer);
els.next.addEventListener('click', nextQuote);
nextQuote();
