import { EventEmitter } from '../core/EventEmitter.js';
import { AI_LEVELS, DEFAULT_SETTINGS, GRID_SIZES, STORAGE_KEYS, TIME_CONTROLS, WALL_LIMIT } from '../config.js';

/**
 * Local user preferences, persisted to localStorage.
 *  - theme / flipBoard:   personal, apply to any player.
 *  - gridSize / wallLimit: the match settings this user uses when hosting or playing vs AI.
 *  - timeMinutes: chess clock per player when hosting (online games only).
 *  - aiDifficulty: last chosen AI level.
 *
 * Emits 'change' (changedKeys: string[], settings) whenever something changes.
 */
export class SettingsModel extends EventEmitter {
  #storage;
  #data;

  /** @param {import('../services/StorageService.js').StorageService} storage */
  constructor(storage) {
    super();
    this.#storage = storage;
    this.#data = SettingsModel.sanitize({ ...DEFAULT_SETTINGS, ...storage.get(STORAGE_KEYS.SETTINGS, {}) });
  }

  static sanitize(raw) {
    const out = { ...DEFAULT_SETTINGS };
    if (raw.theme === 'dark' || raw.theme === 'light') out.theme = raw.theme;
    if (typeof raw.flipBoard === 'boolean') out.flipBoard = raw.flipBoard;
    if (GRID_SIZES.includes(Number(raw.gridSize))) out.gridSize = Number(raw.gridSize);
    out.wallLimit = SettingsModel.sanitizeWallLimit(raw.wallLimit);
    if (Object.hasOwn(AI_LEVELS, raw.aiDifficulty)) out.aiDifficulty = raw.aiDifficulty;
    out.timeMinutes = SettingsModel.sanitizeTime(raw.timeMinutes);
    return out;
  }

  static sanitizeWallLimit(value) {
    if (value === null) return null;
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS.wallLimit;
    return Math.min(WALL_LIMIT.MAX, Math.max(WALL_LIMIT.MIN, n));
  }

  /** One of TIME_CONTROLS (minutes per player), default 3. */
  static sanitizeTime(value) {
    const n = Number(value);
    return TIME_CONTROLS.includes(n) ? n : DEFAULT_SETTINGS.timeMinutes;
  }

  get theme() { return this.#data.theme; }
  get flipBoard() { return this.#data.flipBoard; }
  get gridSize() { return this.#data.gridSize; }
  get wallLimit() { return this.#data.wallLimit; }
  get aiDifficulty() { return this.#data.aiDifficulty; }
  get timeMinutes() { return this.#data.timeMinutes; }

  /** The subset shared with the opponent when hosting. */
  get matchSettings() {
    return { gridSize: this.#data.gridSize, wallLimit: this.#data.wallLimit, timeMinutes: this.#data.timeMinutes };
  }

  toJSON() {
    return { ...this.#data };
  }

  /** Merges a partial update, validates it, persists and emits. */
  update(partial) {
    const next = SettingsModel.sanitize({ ...this.#data, ...partial });
    const changed = Object.keys(next).filter((k) => next[k] !== this.#data[k]);
    if (!changed.length) return;
    this.#data = next;
    this.#storage.set(STORAGE_KEYS.SETTINGS, this.#data);
    this.emit('change', changed, this.toJSON());
  }
}
