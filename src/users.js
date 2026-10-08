'use strict';

const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');

const STORE_VERSION = 1;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS_PER_USER = 10;

class AccountError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
    this.status = status;
  }
}

/** Calculé sur tout l'historique conservé. */
function computeStats(entries) {
  const found = entries.filter((e) => e.found === true).length;
  const missed = entries.filter((e) => e.found === false).length;
  const rated = found + missed;
  const hints = entries.reduce((sum, e) => sum + e.hintsUsed, 0);
  return {
    played: entries.length,
    found,
    missed,
    unrated: entries.length - rated,
    successRate: rated ? Math.round((found / rated) * 100) : null,
    averageHints: entries.length ? Math.round((hints / entries.length) * 10) / 10 : null,
  };
}

/**
 * Comptes, sessions et historique des joueurs, dans un fichier JSON écrit de façon atomique.
 * Les mots de passe sont hachés (scrypt) et seuls les hachages des jetons de session sont conservés.
 */
class UserStore {
  constructor({
    file,
    now = Date.now,
    maxHistory = 300,
    maxUsers = 1_000,
    persistDelayMs = 300,
  }) {
    this.file = file;
    this.now = now;
    this.maxHistory = maxHistory;
    this.maxUsers = maxUsers;
    this.persistDelayMs = persistDelayMs;
    this.users = new Map(); // clé normalisée -> utilisateur
    this.sessions = new Map(); // hachage du jeton -> { key, expiresAt }
    this.timer = null;
    this.writing = Promise.resolve();
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== STORE_VERSION) return;
      for (const user of data.users ?? []) {
        if (typeof user?.key !== 'string' || typeof user.passwordHash !== 'string') continue;
        this.users.set(user.key, {
          id: String(user.id),
          username: String(user.username),
          key: user.key,
          passwordHash: user.passwordHash,
          createdAt: user.createdAt,
          history: Array.isArray(user.history) ? user.history.filter((e) => e && typeof e.id === 'string') : [],
        });
      }
      for (const [hash, session] of Object.entries(data.sessions ?? {})) {
        if (this.users.has(session?.key) && session.expiresAt > this.now()) this.sessions.set(hash, session);
      }
    } catch {
      // fichier absent ou illisible : on repart de zéro
    }
  }

  // ---- persistance -------------------------------------------------------------------------

  schedulePersist() {
    if (this.timer || !this.file) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, this.persistDelayMs);
    this.timer.unref?.();
  }

  /** Écrit tout de suite (arrêt du serveur, tests). Les écritures sont mises en file. */
  flush() {
    if (!this.file) return Promise.resolve();
    clearTimeout(this.timer);
    this.timer = null;
    const payload = JSON.stringify({
      version: STORE_VERSION,
      users: [...this.users.values()],
      sessions: Object.fromEntries(this.sessions),
    });
    this.writing = this.writing.then(async () => {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.promises.writeFile(tmp, payload, { mode: 0o600 });
      await fs.promises.rename(tmp, this.file);
    });
    return this.writing;
  }

  // ---- comptes ---------------------------------------------------------------------------

  async register(username, password) {
    const problem = auth.validateCredentials(username, password);
    if (problem) throw new AccountError('invalid', problem, 400);
    const key = auth.normalizeUsername(username);
    if (this.users.has(key)) throw new AccountError('taken', 'Ce pseudo est déjà pris.', 409);
    if (this.users.size >= this.maxUsers) {
      throw new AccountError('closed', 'Les inscriptions sont fermées pour le moment.', 503);
    }

    const passwordHash = await auth.hashPassword(password);
    if (this.users.has(key)) throw new AccountError('taken', 'Ce pseudo est déjà pris.', 409); // course pendant le hachage
    const user = {
      id: auth.newId(),
      username: username.trim(),
      key,
      passwordHash,
      createdAt: new Date(this.now()).toISOString(),
      history: [],
    };
    this.users.set(key, user);
    this.schedulePersist();
    return user;
  }

  /** Renvoie l'utilisateur, ou null si les identifiants sont faux (sans dire lequel). */
  async authenticate(username, password) {
    const user = typeof username === 'string' ? this.users.get(auth.normalizeUsername(username)) : null;
    if (typeof password !== 'string' || password.length > auth.PASSWORD_MAX) return null;
    if (!user) {
      await auth.burnPasswordCheck(password);
      return null;
    }
    return (await auth.verifyPassword(password, user.passwordHash)) ? user : null;
  }

  // ---- sessions --------------------------------------------------------------------------

  createSession(user) {
    const token = auth.newToken();
    this.sessions.set(auth.hashToken(token), { key: user.key, expiresAt: this.now() + SESSION_TTL_MS });

    // Au plus quelques sessions par compte : les plus anciennes sont retirées.
    const mine = [...this.sessions.entries()].filter(([, s]) => s.key === user.key);
    mine
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
      .slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_USER))
      .forEach(([hash]) => this.sessions.delete(hash));

    this.schedulePersist();
    return { token, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) };
  }

  userForToken(token) {
    if (!token) return null;
    const hash = auth.hashToken(token);
    const session = this.sessions.get(hash);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(hash);
      return null;
    }
    return this.users.get(session.key) ?? null;
  }

  destroySession(token) {
    if (token && this.sessions.delete(auth.hashToken(token))) this.schedulePersist();
  }

  // ---- historique ------------------------------------------------------------------------

  addHistory(user, entry) {
    const stored = { id: auth.newId(), at: new Date(this.now()).toISOString(), found: null, ...entry };
    user.history.push(stored);
    if (user.history.length > this.maxHistory) user.history.splice(0, user.history.length - this.maxHistory);
    this.schedulePersist();
    return stored;
  }

  setResult(user, entryId, found) {
    const entry = user.history.find((e) => e.id === entryId);
    if (!entry) return null;
    entry.found = found;
    this.schedulePersist();
    return entry;
  }

  /** Les entrées les plus récentes d'abord, et les statistiques sur tout l'historique. */
  history(user, limit = 50) {
    return {
      stats: computeStats(user.history),
      entries: user.history.slice(-limit).reverse(),
    };
  }
}

module.exports = { AccountError, UserStore, computeStats };
