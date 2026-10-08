# 🎬 FindMyMovie

Un petit jeu web : une réplique culte s'affiche, à toi de retrouver le film.
Si tu sèches, des **indices** (année, pays, genre, réalisateur, acteur, initiale du titre) sont disponibles — mais ils ne se dévoilent **qu'au clic**. Un bouton **Révéler la réponse** affiche le film et sa fiche complète.

## Lancer avec Docker

```bash
docker compose up --build
```

Puis ouvre <http://localhost:3000>.

Pour changer le port d'écoute : `PORT=8080 docker compose up --build`.

Sans Compose :

```bash
docker build -t findmymovie .
docker run --rm -p 3000:3000 findmymovie
```

L'image est basée sur `node:22-alpine`, ne contient aucune dépendance npm et s'exécute avec l'utilisateur non-root `node` (le `docker-compose.yml` ajoute système de fichiers en lecture seule et suppression des capabilities).

## Lancer sans Docker

Node.js ≥ 20 suffit, il n'y a rien à installer :

```bash
npm start      # http://localhost:3000
npm test       # tests de l'API et des données
```

## Comment ça marche

Le navigateur ne reçoit au départ que la réplique et la **liste** des indices disponibles. Le contenu de chaque indice et la réponse sont demandés au serveur au moment du clic, donc impossible de tricher en lisant le code source ou la réponse réseau initiale.

| Route | Rôle |
|---|---|
| `GET /api/quote?exclude=1,2,3` | Tire une réplique au hasard en évitant celles déjà vues (si tout a été vu, le tirage repart de zéro : `reset: true`) |
| `GET /api/quote/:id/hint/:key` | Révèle un indice (`year`, `country`, `genre`, `director`, `actor`, `initial`) |
| `GET /api/quote/:id/answer` | Révèle le titre et la fiche complète |
| `GET /healthz` | Sonde de santé (utilisée par le `HEALTHCHECK` Docker) |

## Structure

```
data/quotes.json   les répliques et leurs métadonnées
src/quotes.js      chargement, tirage, définition des indices
src/server.js      serveur HTTP (API + fichiers statiques)
public/            interface (HTML / CSS / JS, sans framework)
test/              tests (node:test)
```

## Ajouter une réplique

Ajoute une entrée **à la fin** de `data/quotes.json` (les identifiants sont la position dans le fichier) :

```json
{ "quote": "…", "title": "…", "year": 1999, "country": "…", "genre": "…", "director": "…", "actor": "…" }
```

`npm test` vérifie que tous les champs sont renseignés.

Pour ajouter un nouveau type d'indice, il suffit d'ajouter une entrée au tableau `HINTS` de `src/quotes.js` : le front l'affiche automatiquement.
