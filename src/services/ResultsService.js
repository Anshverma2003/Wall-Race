import { REPORT_ENDPOINT, STORAGE_KEYS } from '../config.js';

const MAX_PENDING = 20;
const WAITING_RETRIES = 4;
const WAITING_DELAY_MS = 2500;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends finished games to /api/report, where they are replayed and verified
 * before reaching the leaderboard.
 *
 * Reports that fail because of the network or a server error are kept in
 * localStorage and retried the next time the app starts.
 */
export class ResultsService {
  /**
   * @param {import('./StorageService.js').StorageService} storage
   * @param {import('../models/PlayerModel.js').PlayerModel} player
   */
  constructor(storage, player) {
    this.storage = storage;
    this.player = player;
    this.sent = new Set(); // report ids already sent this session
  }

  /**
   * Online game. Counts once both players have reported it, so if we are
   * first we poll briefly until the opponent's report arrives.
   * @returns {Promise<object|null>} server result ({status, ratings, deltas}) or null
   */
  async reportOnline({ matchId, players, game }) {
    const body = { kind: 'online', matchId, players, game };
    let result = await this.#send(`online:${matchId}`, body);
    for (let i = 0; result?.status === 'waiting' && i < WAITING_RETRIES; i++) {
      await delay(WAITING_DELAY_MS);
      result = await this.#send(`online:${matchId}`, body, { retry: true });
    }
    return result;
  }

  /** Win against the Hard AI. */
  reportAiWin({ gameId, seed, game }) {
    return this.#send(`ai:${gameId}`, { kind: 'ai', gameId, difficulty: 'hard', seed, game });
  }

  /** Re-send reports that could not be delivered earlier. */
  async flushPending() {
    const pending = this.storage.get(STORAGE_KEYS.PENDING_REPORTS, []);
    if (!pending.length || !this.player.code) return;
    this.storage.set(STORAGE_KEYS.PENDING_REPORTS, []);
    for (const { key, body } of pending) await this.#send(key, body, { retry: true });
  }

  // ------------------------------------------------------------ internals

  async #send(key, body, { retry = false } = {}) {
    if (!this.player.code) return null;
    if (!retry && this.sent.has(key)) return null;
    this.sent.add(key);

    let res;
    try {
      res = await fetch(REPORT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.player.code}` },
        body: JSON.stringify(body),
      });
    } catch {
      this.#keep(key, body);
      return null;
    }

    if (res.status >= 500) {
      this.#keep(key, body);
      return null;
    }
    // 4xx: rejected (not verifiable, unknown player, or no API on a local dev server) – do not retry.
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      console.warn('[ResultsService] report rejected', res.status, data?.error);
      return null;
    }
    return data;
  }

  #keep(key, body) {
    const pending = this.storage.get(STORAGE_KEYS.PENDING_REPORTS, []).filter((p) => p.key !== key);
    pending.push({ key, body });
    this.storage.set(STORAGE_KEYS.PENDING_REPORTS, pending.slice(-MAX_PENDING));
  }
}
