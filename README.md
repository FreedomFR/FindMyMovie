# 🎬 FindMyMovie

Un petit jeu web : une réplique culte s'affiche, à toi de retrouver le film.
Si tu sèches, des **indices** (année, pays, genre, réalisateur, acteur, personnage, initiale du titre) sont disponibles — mais ils ne se dévoilent **qu'au clic**. Un bouton **Révéler la réponse** affiche le film et sa fiche complète.

Les répliques viennent de deux sources :
- **44 répliques embarquées** (`data/quotes.json`), toujours disponibles, même hors ligne ;
- **des centaines, puis des milliers de répliques récoltées sur [Wikiquote](https://fr.wikiquote.org/)** via son API, en arrière-plan.

## Lancer avec Docker

```bash
docker compose up --build
```

Puis ouvre <http://localhost:3000>.

Pour changer le port d'écoute : `PORT=8080 docker compose up --build`.

Sans Compose :

```bash
docker build -t findmymovie .
docker run --rm -p 3000:3000 -v findmymovie-data:/data findmymovie
```

Le volume `/data` conserve les répliques déjà récoltées : sans lui, tout est récolté à nouveau à chaque démarrage.

L'image est basée sur `node:22-alpine`, ne contient aucune dépendance npm et s'exécute avec l'utilisateur non-root `node` (le `docker-compose.yml` ajoute système de fichiers en lecture seule et suppression des capabilities).

## Lancer sans Docker

Node.js ≥ 20 suffit, il n'y a rien à installer :

```bash
npm start      # http://localhost:3000 (cache dans ./cache)
npm test       # tests de l'analyse Wikiquote, du moissonneur et de l'API
```

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port d'écoute |
| `DATA_DIR` | `./cache` (`/data` dans Docker) | Dossier du cache des répliques récoltées |
| `WIKIQUOTE_ENABLED` | `true` | `false` : plus aucun appel à Wikiquote (le cache déjà récolté reste utilisé) |
| `WIKIQUOTE_INTERVAL_MS` | `5000` | Pause entre deux requêtes à Wikiquote |

Derrière un proxy d'entreprise, Node ≥ 22.21 sait l'utiliser avec `NODE_USE_ENV_PROXY=1`.

## Comment ça marche

### Récolte des répliques

Au démarrage, le serveur charge les répliques embarquées et le cache, puis un **moissonneur** interroge Wikiquote en tâche de fond :

- un appel récupère **50 pages de films** (avec leur wikitext) d'une catégorie (« Film américain », « Film français », « Film de science-fiction »…), en alternant les catégories ;
- le wikitext est analysé : on garde les répliques d'**une seule voix, sur une ligne, de 12 à 220 caractères**. Les dialogues, les poèmes et les répliques qui **contiennent le titre du film** (ce serait la réponse offerte) sont écartés ;
- les indices sont déduits de la page : acteur de la réplique (`{{Réf Film}}`), année, pays et genre (catégories), réalisateur, personnage. **Un indice dont la donnée manque n'est simplement pas proposé** ;
- la progression est sauvegardée dans `wikiquote-cache.json` : au redémarrage, les répliques sont disponibles tout de suite et la récolte reprend où elle s'était arrêtée. Une catégorie entièrement parcourue n'est pas relue : pour récupérer les films ajoutés plus tard sur Wikiquote, supprime le cache (`docker volume rm findmymovie_findmymovie-data`, ou le dossier `cache/`).

Le jeu n'attend jamais Wikiquote : il pioche dans ce qui est déjà récolté. Si Wikiquote est injoignable, le jeu continue avec ce qu'il a.

**Courtoisie envers Wikiquote.** Le moissonneur s'identifie par un `User-Agent` explicite, fait une requête à la fois, et respecte les limites de débit : sur un `429`, il attend le délai demandé par `Retry-After` ; sur les autres erreurs, il attend de plus en plus longtemps (30 s, puis 1 min, 2 min… jusqu'à 15 min).

### Pas de triche possible

Le navigateur ne reçoit au départ que la réplique et la **liste** des indices disponibles. Le contenu de chaque indice et la réponse sont demandés au serveur au moment du clic, donc impossible de tricher en lisant le code source ou la réponse réseau initiale.

| Route | Rôle |
|---|---|
| `GET /api/quote?exclude=id1,id2` | Tire une réplique au hasard en évitant celles déjà vues (si tout a été vu, le tirage repart de zéro : `reset: true`) |
| `GET /api/quote/:id/hint/:key` | Révèle un indice (`year`, `country`, `genre`, `director`, `actor`, `character`, `initial`) |
| `GET /api/quote/:id/answer` | Révèle le titre, la fiche complète et la source |
| `GET /healthz` | Sonde de santé (utilisée par le `HEALTHCHECK` Docker) |

## Structure

```
data/quotes.json   les répliques embarquées
src/server.js      serveur HTTP (API + fichiers statiques) et démarrage
src/quotes.js      indices, vues publiques, tirage
src/pool.js        réservoir de répliques + cache JSON sur disque
src/harvester.js   moissonneur d'arrière-plan (débit, reprise, arrêt propre)
src/wikiquote.js   client de l'API Wikiquote + analyse d'une page de film
src/wikitext.js    lecture des modèles {{…}} et nettoyage du wikitext
public/            interface (HTML / CSS / JS, sans framework)
test/              tests (node:test) et extrait réel de Wikiquote
```

## Ajouter une réplique à la main

Ajoute une entrée **à la fin** de `data/quotes.json` (les identifiants sont `seed-` + la position dans le fichier) :

```json
{ "quote": "…", "title": "…", "year": 1999, "country": "…", "genre": "…", "director": "…", "actor": "…" }
```

`npm test` vérifie que tous les champs sont renseignés.

Pour ajouter un nouveau type d'indice, il suffit d'ajouter une entrée au tableau `HINTS` de `src/quotes.js` : le front l'affiche automatiquement.

## Licences

Les répliques récoltées proviennent de Wikiquote et sont sous licence [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.fr) : la source est mentionnée en pied de page et un lien vers la page d'origine est affiché avec chaque réponse.
