# 🎬 FindMyMovie

Un petit jeu web : une réplique culte s'affiche, à toi de retrouver le film.
Si tu sèches, des **indices** (année, pays, genre, réalisateur, acteur, personnage, initiale du titre) sont disponibles — mais ils ne se dévoilent **qu'au clic**. Un bouton **Révéler la réponse** affiche le film et sa fiche complète.

Tu peux aussi **choisir une période** (« 1990 – 1999 », « avant 1970 »…) : seuls des films sortis dans cette plage sont proposés. Et, si tu veux, **créer un compte** (facultatif) pour conserver ton historique de joueur.

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

## Déployer en ligne (Render)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/FreedomFR/FindMyMovie)

Le fichier `render.yaml` décrit le service : un clic sur le bouton, une connexion à Render (compte GitHub accepté) puis **Apply**, et l'appli est en ligne sur une URL `https://findmymovie-….onrender.com`.

Limites de l'offre gratuite (voir la [documentation de Render](https://render.com/docs/free)) :

- le service **se met en veille après 15 minutes sans visite** et met environ une minute à se réveiller ;
- son disque est **éphémère** : le cache des répliques récoltées est perdu à chaque veille ou redéploiement, la récolte repart donc de zéro (les 44 répliques embarquées restent toujours disponibles) ;
- pour la même raison, **les comptes et les historiques des joueurs sont aussi perdus** (voir « Comptes et historique » plus bas). Pour les conserver, il faut un disque persistant (offre payante de Render) ou un autre hébergeur avec volume.

N'importe quel hébergeur de conteneurs convient : l'image écoute sur `$PORT`, expose `/healthz` et utilise `/data` pour son cache (à monter sur un disque persistant pour le conserver).

## Lancer sans Docker

Node.js ≥ 20 suffit, il n'y a rien à installer :

```bash
npm start      # http://localhost:3000 (cache dans ./cache)
npm test       # tests de l'analyse Wikiquote, du moissonneur, des comptes et de l'API
```

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port d'écoute |
| `DATA_DIR` | `./cache` (`/data` dans Docker) | Dossier du cache des répliques récoltées |
| `WIKIQUOTE_ENABLED` | `true` | `false` : plus aucun appel à Wikiquote (le cache déjà récolté reste utilisé) |
| `WIKIQUOTE_INTERVAL_MS` | `5000` | Pause entre deux requêtes à Wikiquote |
| `ACCOUNTS_ENABLED` | `true` | `false` : pas de comptes, le jeu fonctionne comme avant |
| `MAX_USERS` | `1000` | Nombre maximal de comptes (les inscriptions se ferment ensuite) |
| `TRUST_PROXY` | `false` | `true` derrière un reverse proxy de confiance : l'adresse du joueur est lue dans `X-Forwarded-For` (déjà réglé pour Render) |

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

### Période d'années

Le panneau « Période » au-dessus de la réplique accepte deux années (l'une ou l'autre peut rester vide) ou un préréglage. Le serveur ne tire alors que des films sortis **entre ces deux années, bornes comprises** ; si les bornes sont inversées, elles sont remises dans l'ordre. Le choix est mémorisé dans le navigateur.

La plage guide aussi la récolte : les années choisies qui manquent de films passent en tête de la moisson, via les catégories Wikiquote « Œuvre de 1995 »… (qui mélangent films, livres et séries : seules les pages avec une fiche `{{Réf Film}}` ou une catégorie « Film… » sont gardées). Si aucun film n'est encore disponible pour la période, l'interface le dit et réessaie toute seule quelques fois pendant que la récolte cherche.

### Comptes et historique

Les comptes sont **facultatifs** : sans compte, rien ne change. Avec un compte (pseudo + mot de passe, sans e-mail), chaque réponse révélée est ajoutée à l'historique, et le joueur indique s'il avait trouvé (« Oui / Non »). Le bouton **Mon historique** affiche les 50 dernières parties et les statistiques (parties, trouvées, taux de réussite, indices par partie). Les 300 dernières parties sont conservées.

Sécurité :

- mots de passe hachés avec `scrypt` (sel aléatoire, comparaison à temps constant), jamais écrits en clair ni renvoyés ;
- session par cookie `HttpOnly`, `SameSite=Lax` (et `Secure` en HTTPS), valable 30 jours ; seul le hachage du jeton est stocké, la déconnexion le révoque ;
- les tentatives de connexion sont limitées (8 échecs par pseudo et 30 par adresse sur 15 minutes) et les inscriptions aussi (10 par adresse et par heure) ; un pseudo inconnu et un mauvais mot de passe donnent la même réponse ;
- protection CSRF : les requêtes `POST` doivent être en JSON et, si un en-tête `Origin` est présent, venir du même site ;
- l'historique est écrit côté serveur à partir de ses propres données : un joueur ne peut pas y inscrire un titre de son choix.

Le stockage est un simple fichier, réécrit en entier à chaque changement : il est pensé pour une petite communauté (quelques centaines de joueurs). Au-delà, il faudrait une vraie base de données.

Les comptes sont dans `users.json`, dans `DATA_DIR` (fichier lisible par son seul propriétaire, écriture atomique). **Ce fichier doit être sur un disque persistant** (le volume `/data` de Docker Compose) : sinon comptes et historiques disparaissent au redémarrage.

### Pas de triche possible

Le navigateur ne reçoit au départ que la réplique et la **liste** des indices disponibles. Le contenu de chaque indice et la réponse sont demandés au serveur au moment du clic, donc impossible de tricher en lisant le code source ou la réponse réseau initiale.

| Route | Rôle |
|---|---|
| `GET /api/quote?from=1990&to=1999&exclude=id1,id2` | Tire une réplique au hasard parmi les films de la période (`from` / `to` facultatifs) en évitant celles déjà vues (si tout a été vu, le tirage repart de zéro : `reset: true`) ; `empty: true` si la période n'a aucun film |
| `GET /api/quote/:id/hint/:key` | Révèle un indice (`year`, `country`, `genre`, `director`, `actor`, `character`, `initial`) |
| `GET /api/quote/:id/answer` | Révèle le titre, la fiche complète et la source |
| `POST /api/auth/register`, `/login`, `/logout` · `GET /api/auth/me` | Compte du joueur (corps JSON `{ username, password }`) |
| `GET /api/history` · `POST /api/history` · `POST /api/history/:id/result` | Historique du joueur connecté : liste et statistiques, ajout d'une partie, résultat (`{ found: true \| false }`) |
| `GET /healthz` | Sonde de santé (utilisée par le `HEALTHCHECK` Docker) |

## Structure

```
data/quotes.json   les répliques embarquées
src/server.js      serveur HTTP (API + fichiers statiques) et démarrage
src/quotes.js      indices, vues publiques, tirage
src/pool.js        réservoir de répliques (filtre par années) + cache JSON sur disque
src/auth.js        mots de passe (scrypt), jetons, cookies, limiteur de tentatives
src/users.js       comptes, sessions et historique des joueurs (fichier JSON)
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
