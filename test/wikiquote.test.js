'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findTemplates, toPlainText } = require('../src/wikitext');
const {
  WikiquoteError,
  createClient,
  extractQuote,
  mentionsTitle,
  parseFilmPage,
} = require('../src/wikiquote');

// Vraies pages de Wikiquote FR (extrait de l'API, CC BY-SA 4.0).
const fixture = require('./fixtures/wikiquote-sample.json');
const page = (title) => fixture.query.pages.find((p) => p.title === title);

test('findTemplates gère les modèles imbriqués', () => {
  const [tpl] = findTemplates('avant {{Personnage|{{w|Gorgô}}}} après');
  assert.equal(tpl.name, 'personnage');
  assert.equal(tpl.positional[0], '{{w|Gorgô}}');
});

test('findTemplates sépare arguments nommés et positionnels', () => {
  const [tpl] = findTemplates('{{citation|citation = Salut = ça va\n | original=Hi |langue=en}}');
  assert.equal(tpl.named.citation, 'Salut = ça va');
  assert.equal(tpl.named.langue, 'en');
  const [pos] = findTemplates('{{citation|Il dit 2+2=4}}');
  assert.deepEqual(pos.positional, ['Il dit 2+2=4']);
});

test('findTemplates ignore un modèle jamais refermé', () => {
  assert.deepEqual(findTemplates('{{citation|oups'), []);
});

test('toPlainText nettoie le balisage connu', () => {
  assert.equal(
    toPlainText("{{w|Page|Texte}} et [[a|b]], [[Simple]] ''ital'' '''gras'''&nbsp;fin"),
    'Texte et b, Simple ital gras fin',
  );
});

test('toPlainText refuse un balisage inconnu, sauf en mode tolérant', () => {
  assert.equal(toPlainText('x {{inconnu|y}} z'), null);
  assert.equal(toPlainText('x {{inconnu|y}} z', { lenient: true }), 'x y z');
  assert.equal(toPlainText('[[Fichier:a.jpg|vignette]]'), null);
});

test("extractQuote sépare le personnage et écarte dialogues, poèmes et textes trop courts", () => {
  assert.deepEqual(extractQuote("{{Personnage|Paul}} (''en voix off'') : On dit que nous perdons tous 21 grammes."), {
    text: 'On dit que nous perdons tous 21 grammes.',
    character: 'Paul',
  });
  assert.deepEqual(extractQuote('« Une réplique entre guillemets ! »'), {
    text: 'Une réplique entre guillemets !',
    character: null,
  });
  assert.equal(extractQuote('<poem>{{Personnage|A}} : Bonjour toi\n{{Personnage|B}} : Salut toi</poem>'), null);
  assert.equal(extractQuote('<poem>Ligne un\nLigne deux</poem>'), null);
  assert.equal(extractQuote('Oui.'), null);
  assert.equal(extractQuote(`${'x'.repeat(300)}`), null);
});

test("extractQuote ne garde que le nom du personnage, sans commentaire ni fonction", () => {
  assert.equal(extractQuote('{{Personnage|James Gordon (à propos de Gotham City)}} : Une ville assez particulière.').character, 'James Gordon');
  assert.equal(extractQuote("{{Personnage|Wolf Jackson, officier de police de l'Après-Vie}} : Plus un geste, tout le monde !").character, 'Wolf Jackson');
  assert.equal(extractQuote("{{Personnage|Bruce Wayne / Batman}} : Je ne suis pas seulement un homme.").character, 'Bruce Wayne / Batman');
});

test('le réalisateur est coupé avant « et produit par… » ou « et adapté de… »', () => {
  const pageWith = (lead) => ({
    pageid: 99,
    title: 'Un Film (film)',
    revisions: [{ slots: { main: { content: `${lead}\n\n== Citations ==\n{{citation|citation=Une réplique tout à fait correcte.}}\n{{Réf Film|titre=Un Film|date=2001|acteur=Jean Dujardin}}\n[[Catégorie:Film américain]]\n[[Catégorie:Œuvre de 2001]]` } } }],
  });
  const lead = (text) => parseFilmPage(pageWith(`'''Un Film''' est un film américain ${text}`))[0].director;
  assert.equal(lead('réalisé par Nicholas Stoller et produit par Judd Apatow, sorti en 2010.'), 'Nicholas Stoller');
  assert.equal(lead("réalisé par Taylor Hackford et adapté du roman éponyme d'Andrew Neiderman."), 'Taylor Hackford');
  assert.equal(lead('réalisé par Sam Liu et Lauren Montgomery, sorti en 2011.'), 'Sam Liu et Lauren Montgomery');
});

test('mentionsTitle détecte le titre en mots entiers, articles compris', () => {
  assert.equal(mentionsTitle('Il pèse 21 grammes, dit-on.', ['21 Grammes']), true);
  assert.equal(mentionsTitle("Parlez-moi de l'affaire du collier", ["L'Affaire du collier"]), true);
  assert.equal(mentionsTitle('Une affaire du collier étrange', ["L'Affaire du collier"]), true);
  assert.equal(mentionsTitle('She inherited it', ['Her']), false);
  assert.equal(mentionsTitle('Rien à voir', ['Titanic', null]), false);
});

test('parseFilmPage : métadonnées et répliques de « 2001 »', () => {
  const records = parseFilmPage(page("2001 : l'odyssée de l'espace (film)"));
  assert.equal(records.length, 4); // le poème de Daisy (multi-lignes) est écarté
  for (const r of records) {
    assert.equal(r.title, "2001 : l'odyssée de l'espace");
    assert.equal(r.year, 1968);
    assert.equal(r.country, 'États-Unis / Royaume-Uni');
    assert.equal(r.genre, 'Science-fiction');
    assert.equal(r.director, 'Stanley Kubrick');
    assert.match(r.id, /^wq-4717-\d+$/);
    assert.deepEqual(r.source, {
      name: 'Wikiquote',
      url: 'https://fr.wikiquote.org/wiki/2001_%3A_l\'odyss%C3%A9e_de_l\'espace_(film)',
    });
  }
  assert.equal(records[0].quote, "Je regrette, Dave. Cela m'est malheureusement impossible.");
  assert.equal(records[0].actor, 'Douglas Rain'); // sans la voix française entre parenthèses
  assert.equal(records[3].character, 'Dave Bowman');
});

test('parseFilmPage écarte les répliques qui contiennent le titre du film', () => {
  const records = parseFilmPage(page('21 Grammes'));
  assert.equal(records.length, 1);
  assert.match(records[0].quote, /^La terre a tourné pour nous rapprocher/);
  assert.equal(records[0].character, 'Paul');
  assert.equal(records[0].actor, 'Sean Penn');
  assert.equal(records[0].director, 'Alejandro González Iñárritu');
});

test('parseFilmPage écarte les dialogues à plusieurs voix', () => {
  assert.deepEqual(parseFilmPage(page('Adventureland')), []);
  assert.deepEqual(parseFilmPage(page('1 001 Pattes')), []);
});

test("parseFilmPage n'invente pas d'indices : « Voix off » n'est pas un acteur", () => {
  const collier = parseFilmPage(page("L'Affaire du collier")).find((r) => r.character === 'Narrateur');
  assert.equal(collier.actor, null);
  assert.equal(collier.director, 'Charles Shyer');
  assert.equal(collier.genre, 'Historique');
});

test("parseFilmPage écarte un « personnage » qui n'est que le nom de l'acteur", () => {
  const [record] = parseFilmPage(page("L'Abominable Vérité"));
  assert.equal(record.actor, 'Gerard Butler');
  assert.equal(record.character, null);
});

test('parseFilmPage résiste aux pages vides ou invalides', () => {
  assert.deepEqual(parseFilmPage(null), []);
  assert.deepEqual(parseFilmPage({ title: 'X', pageid: 1 }), []);
  assert.deepEqual(parseFilmPage({ title: 'X', pageid: 1, revisions: [{ slots: { main: { content: '{{citation|' } } }] }), []);
});

test("le client demande un lot de 50 pages avec un User-Agent identifiable", async () => {
  let seen;
  const fetchImpl = async (url, options) => {
    seen = { url: new URL(url), headers: options.headers };
    return new Response(JSON.stringify({ query: { pages: [{ pageid: 1 }] }, continue: { gcmcontinue: 'abc', continue: 'gcmcontinue||' } }), {
      status: 200,
    });
  };
  const client = createClient({ fetchImpl, userAgent: 'Test/1.0 (contact)' });
  const result = await client.fetchBatch('Film américain', { gcmcontinue: 'prev', continue: 'gcmcontinue||' });

  assert.equal(seen.url.origin + seen.url.pathname, 'https://fr.wikiquote.org/w/api.php');
  assert.equal(seen.url.searchParams.get('gcmtitle'), 'Catégorie:Film américain');
  assert.equal(seen.url.searchParams.get('gcmlimit'), '50');
  assert.equal(seen.url.searchParams.get('rvprop'), 'content');
  assert.equal(seen.url.searchParams.get('gcmcontinue'), 'prev');
  assert.equal(seen.headers['User-Agent'], 'Test/1.0 (contact)');
  assert.deepEqual(result, { pages: [{ pageid: 1 }], next: { gcmcontinue: 'abc', continue: 'gcmcontinue||' } });
});

test('le client signale la limite de débit avec le délai demandé', async () => {
  const limited = async () => new Response('trop de requêtes', { status: 429, headers: { 'retry-after': '31' } });
  await assert.rejects(createClient({ fetchImpl: limited }).fetchBatch('X'), (error) => {
    assert.ok(error instanceof WikiquoteError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 31_000);
    return true;
  });

  const broken = async () => new Response('oups', { status: 500 });
  await assert.rejects(createClient({ fetchImpl: broken }).fetchBatch('X'), (error) => error.status === 500 && error.retryAfterMs === null);

  const apiError = async () => new Response(JSON.stringify({ error: { code: 'badtitle' } }), { status: 200 });
  await assert.rejects(createClient({ fetchImpl: apiError }).fetchBatch('X'), /badtitle/);
});
