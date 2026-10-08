'use strict';

/**
 * Outils minimaux pour lire le wikitext de Wikiquote : modèles {{…}} imbriqués
 * et nettoyage du balisage en texte brut. Volontairement strict : quand un
 * balisage n'est pas compris, on renvoie null plutôt que d'afficher du bruit.
 */

const normalizeName = (name) => name.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Découpe sur les « | » de premier niveau (hors {{…}} et [[…]]). */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const two = text.slice(i, i + 2);
    if (two === '{{' || two === '[[') {
      depth += 1;
      current += two;
      i += 1;
    } else if (two === '}}' || two === ']]') {
      depth = Math.max(0, depth - 1);
      current += two;
      i += 1;
    } else if (text[i] === '|' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += text[i];
    }
  }
  parts.push(current);
  return parts;
}

const PARAM_KEY = /^[\p{L}\p{N}_ -]{1,30}$/u;

function parseTemplate(raw, start, end) {
  const [name, ...args] = splitTopLevel(raw.slice(2, -2));
  const positional = [];
  const named = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    const key = eq > 0 ? arg.slice(0, eq).trim() : '';
    if (key && PARAM_KEY.test(key)) named[normalizeName(key)] = arg.slice(eq + 1).trim();
    else positional.push(arg.trim());
  }
  return { name: normalizeName(name), positional, named, start, end, raw };
}

/** Modèles de premier niveau, dans l'ordre d'apparition. */
function findTemplates(text) {
  const found = [];
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf('{{', from);
    if (start === -1) break;
    let depth = 0;
    let i = start;
    for (; i < text.length - 1; i += 1) {
      if (text[i] === '{' && text[i + 1] === '{') {
        depth += 1;
        i += 1;
      } else if (text[i] === '}' && text[i + 1] === '}') {
        depth -= 1;
        i += 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break; // modèle jamais refermé : on s'arrête là
    const end = i + 1;
    found.push(parseTemplate(text.slice(start, end), start, end));
    from = end;
  }
  return found;
}

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' };

// Modèles dont on sait extraire le texte affiché.
const TEMPLATE_TEXT = {
  w: (t) => t.positional.filter(Boolean).pop() ?? '',
  personnage: (t) => t.positional[0] ?? '',
  nobr: (t) => t.positional[0] ?? '',
  lang: (t) => t.positional[1] ?? '',
};

function expandTemplates(text, lenient) {
  const templates = findTemplates(text);
  let out = text;
  for (const tpl of templates.reverse()) {
    const render = TEMPLATE_TEXT[tpl.name];
    let replacement;
    if (render) replacement = expandTemplates(render(tpl), lenient);
    else if (lenient) replacement = expandTemplates(tpl.positional.filter(Boolean).pop() ?? '', lenient);
    else replacement = null;
    if (replacement === null) return null;
    out = out.slice(0, tpl.start) + replacement + out.slice(tpl.end);
  }
  return out;
}

/**
 * Transforme du wikitext en texte brut sur une seule ligne logique.
 * `lenient` : tolère les modèles inconnus (utile pour l'introduction d'une page).
 * Renvoie null si un balisage non géré subsiste.
 */
function toPlainText(wikitext, { lenient = false } = {}) {
  let text = expandTemplates(String(wikitext ?? ''), lenient);
  if (text === null) return null;

  text = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref\b[^>]*\/>/gi, '')
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:poem|i|b|em|strong|small|big|span|u|nowiki|center)\b[^>]*>/gi, '');

  if (/\[\[\s*:?\s*(?:fichier|file|image)\s*:/i.test(text)) return null;
  text = text
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[\s*:?\s*(?:w|wikipedia|catégorie|category)\s*:([^\]]*)\]\]/gi, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1')
    .replace(/\[https?:\/\/\S+\]/g, '')
    .replace(/'{2,}/g, '')
    .replace(/&(?:nbsp|amp|quot|lt|gt|#39);/g, (e) => ENTITIES[e])
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();

  if (!lenient && /\{\{|\}\}|\[\[|\]\]|[<>]/.test(text)) return null;
  return text;
}

module.exports = { findTemplates, toPlainText, normalizeName };
