/**
 * The local player's queued premoves. Personal and temporary: it lives only
 * in this browser and is never sent to the opponent.
 *
 * Any square or wall slot is accepted when queued; legality is checked only
 * when a premove is about to be played (see GameController).
 */
export class PremoveQueue {
  /** @type {({kind:'move', r:number, c:number} | {kind:'wall', o:'h'|'v', r:number, c:number})[]} */
  #items = [];

  get items() {
    return this.#items;
  }

  get length() {
    return this.#items.length;
  }

  add(action) {
    this.#items.push({ ...action });
  }

  peek() {
    return this.#items[0] ?? null;
  }

  shift() {
    return this.#items.shift() ?? null;
  }

  clear() {
    this.#items = [];
  }

  /** Where the pawn would end up after all queued pawn premoves (or `fallback` if none). */
  projectedPawn(fallback) {
    for (let i = this.#items.length - 1; i >= 0; i--) {
      const item = this.#items[i];
      if (item.kind === 'move') return { r: item.r, c: item.c };
    }
    return fallback;
  }
}
