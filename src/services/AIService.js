/**
 * Promise-based access to the AI engine. Uses a module Web Worker when the
 * browser supports it, otherwise runs the engine on the main thread.
 */
export class AIService {
  #worker = null;
  #pending = new Map();
  #nextId = 1;
  #fallback = false;

  /**
   * @param {object} game GameModel.toJSON()
   * @param {0|1} player
   * @param {"easy"|"medium"|"hard"} difficulty
   * @param {number} [seed] 32-bit game seed; makes the move reproducible (server verification)
   * @returns {Promise<{action:object, depth:number, nodes:number, ms:number, score:number}>}
   */
  async chooseAction(game, player, difficulty, seed) {
    const worker = this.#getWorker();
    if (!worker) return this.#runInline(game, player, difficulty, seed);

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      worker.postMessage({ id, game, player, difficulty, seed });
    });
  }

  /** Abandon any in-flight requests (e.g. the player left the game). */
  cancelAll() {
    for (const { reject } of this.#pending.values()) reject(new Error('cancelled'));
    this.#pending.clear();
    // Terminate so a long Hard search does not keep burning CPU.
    this.#worker?.terminate();
    this.#worker = null;
  }

  #getWorker() {
    if (this.#fallback) return null;
    if (this.#worker) return this.#worker;
    try {
      this.#worker = new Worker(new URL('../ai/ai.worker.js', import.meta.url), { type: 'module' });
      this.#worker.addEventListener('message', (e) => {
        const { id, ok, result, error } = e.data;
        const entry = this.#pending.get(id);
        if (!entry) return;
        this.#pending.delete(id);
        if (ok) entry.resolve(result);
        else entry.reject(new Error(error));
      });
      this.#worker.addEventListener('error', (e) => {
        console.warn('[AIService] worker failed, falling back to main thread', e.message);
        e.preventDefault?.();
        this.#worker?.terminate();
        this.#worker = null;
        this.#fallback = true;
        const pending = [...this.#pending.values()];
        this.#pending.clear();
        for (const { reject } of pending) reject(new Error('worker-failed'));
      });
      return this.#worker;
    } catch {
      this.#fallback = true;
      return null;
    }
  }

  async #runInline(game, player, difficulty, seed) {
    const { chooseAction, seededRandom } = await import('../ai/AIEngine.js');
    // Yield a frame so the "thinking" state can paint first.
    await new Promise((r) => setTimeout(r, 30));
    const random = Number.isInteger(seed) ? seededRandom(seed, game.history?.length ?? 0) : Math.random;
    return chooseAction(game, player, difficulty, random);
  }
}
