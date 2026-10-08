'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'quotes.json');

// Articles ignorés pour l'indice « initiale du titre ».
const LEADING_ARTICLES = /^(?:l['’]|le |la |les |un |une |des |the )/i;

// Les indices disponibles, dans l'ordre d'affichage.
// `get` extrait la valeur à révéler depuis une entrée complète.
const HINTS = [
  { key: 'year', label: 'Année de sortie', get: (m) => String(m.year) },
  { key: 'country', label: "Pays d'origine", get: (m) => m.country },
  { key: 'genre', label: 'Genre', get: (m) => m.genre },
  { key: 'director', label: 'Réalisateur', get: (m) => m.director },
  { key: 'actor', label: 'Acteur', get: (m) => m.actor },
  { key: 'initial', label: 'Initiale du titre', get: (m) => initialOf(m.title) },
];

function initialOf(title) {
  const rest = title.replace(LEADING_ARTICLES, '');
  return rest.charAt(0).toLocaleUpperCase('fr-FR');
}

function load(file = DATA_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  // L'identifiant est la position dans le fichier (+1) : n'ajouter qu'à la fin.
  return raw.map((entry, i) => ({ id: i + 1, ...entry }));
}

/**
 * Ce que le client a le droit de voir avant de cliquer : la citation et la
 * liste des indices disponibles, jamais leur contenu.
 */
function publicView(movie) {
  return {
    id: movie.id,
    quote: movie.quote,
    hints: HINTS.map(({ key, label }) => ({ key, label })),
  };
}

function hintFor(movie, key) {
  const hint = HINTS.find((h) => h.key === key);
  if (!hint) return null;
  return { key: hint.key, label: hint.label, value: hint.get(movie) };
}

function answerFor(movie) {
  return {
    id: movie.id,
    title: movie.title,
    details: HINTS.map((h) => ({ key: h.key, label: h.label, value: h.get(movie) })),
  };
}

/**
 * Tire une citation au hasard en évitant celles déjà vues.
 * Quand tout a été vu, le tirage repart de zéro (`reset: true`).
 */
function pickRandom(movies, excludeIds = [], rng = Math.random) {
  const excluded = new Set(excludeIds);
  let pool = movies.filter((m) => !excluded.has(m.id));
  let reset = false;
  if (pool.length === 0) {
    pool = movies;
    reset = true;
  }
  return { movie: pool[Math.floor(rng() * pool.length)], reset };
}

module.exports = { HINTS, load, publicView, hintFor, answerFor, pickRandom, initialOf };
