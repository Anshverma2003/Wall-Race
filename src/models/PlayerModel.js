import { EventEmitter } from '../core/EventEmitter.js';
import { PLAYER_RULES, STORAGE_KEYS } from '../config.js';

/**
 * This device's leaderboard profile: name#tag, stats and the secret recovery
 * code (which also authenticates reports). Cached in localStorage; the
 * server copy is the source of truth.
 *
 * Emits 'change' whenever the profile is set, refreshed or cleared.
 */
export class PlayerModel extends EventEmitter {
  #data = null;

  /** @param {import('../services/StorageService.js').StorageService} storage */
  constructor(storage) {
    super();
    this.storage = storage;
    const saved = storage.get(STORAGE_KEYS.PLAYER);
    if (saved?.id && saved?.code && saved?.tag) this.#data = saved;
  }

  get exists() { return !!this.#data; }
  get id() { return this.#data?.id ?? null; }
  get name() { return this.#data?.name ?? ''; }
  get tag() { return this.#data?.tag ?? ''; }
  get code() { return this.#data?.code ?? null; }
  get rating() { return this.#data?.rating ?? null; }
  get label() { return this.#data ? `${this.#data.name}#${this.#data.tag}` : ''; }

  /** Date from which the tag may change again, or null if it can change now. */
  get tagUnlocksAt() {
    const at = this.#data?.tag_unlocks_at ? new Date(this.#data.tag_unlocks_at) : null;
    return at && at > new Date() ? at : null;
  }

  /** Public identity sent to an online opponent. */
  get card() {
    return this.#data ? { id: this.id, name: this.name, tag: this.tag } : null;
  }

  /**
   * Store a profile returned by the server.
   * @param {object} profile  server JSON (id, name, tag, rating, …)
   * @param {string} [code]   recovery code, when it was just created or entered
   */
  set(profile, code = this.code) {
    this.#data = { ...profile, code };
    this.storage.set(STORAGE_KEYS.PLAYER, this.#data);
    this.emit('change');
  }

  clear() {
    this.#data = null;
    this.storage.remove(STORAGE_KEYS.PLAYER);
    this.emit('change');
  }

  // -------------------------------------------------------- validation

  static cleanName(name) {
    return String(name ?? '').trim().replace(/\s+/g, ' ');
  }

  /** @returns {string|null} error message, or null if valid */
  static nameError(raw) {
    const name = PlayerModel.cleanName(raw);
    if (name.length < PLAYER_RULES.NAME_MIN || name.length > PLAYER_RULES.NAME_MAX) {
      return `Name must be ${PLAYER_RULES.NAME_MIN}–${PLAYER_RULES.NAME_MAX} characters.`;
    }
    if (!PLAYER_RULES.NAME_PATTERN.test(name)) return 'Use only letters, numbers, spaces, _ or -.';
    return null;
  }

  static tagError(tag) {
    return PLAYER_RULES.TAG_PATTERN.test(String(tag ?? '')) ? null : 'Tag must be exactly 4 digits.';
  }
}
