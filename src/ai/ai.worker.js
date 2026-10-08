/**
 * Runs the AI search off the main thread so the UI never freezes.
 * Message in:  { id, game, player, difficulty, seed }
 * Message out: { id, ok: true, result } | { id, ok: false, error }
 */
import { chooseAction, seededRandom } from './AIEngine.js';

self.addEventListener('message', (e) => {
  const { id, game, player, difficulty, seed } = e.data;
  try {
    const random = Number.isInteger(seed) ? seededRandom(seed, game.history?.length ?? 0) : Math.random;
    const result = chooseAction(game, player, difficulty, random);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});
