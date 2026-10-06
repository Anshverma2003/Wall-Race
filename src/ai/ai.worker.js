/**
 * Runs the AI search off the main thread so the UI never freezes.
 * Message in:  { id, game, player, difficulty }
 * Message out: { id, ok: true, result } | { id, ok: false, error }
 */
import { chooseAction } from './AIEngine.js';

self.addEventListener('message', (e) => {
  const { id, game, player, difficulty } = e.data;
  try {
    const result = chooseAction(game, player, difficulty);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});
