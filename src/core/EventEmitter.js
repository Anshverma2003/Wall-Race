/**
 * Minimal publish/subscribe base class used by models, views and services.
 */
export class EventEmitter {
  #listeners = new Map();

  /** @returns {() => void} unsubscribe function */
  on(event, handler) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.#listeners.get(event)?.delete(handler);
  }

  emit(event, ...args) {
    for (const handler of [...(this.#listeners.get(event) ?? [])]) {
      try {
        handler(...args);
      } catch (err) {
        console.error(`[EventEmitter] "${event}" handler failed`, err);
      }
    }
  }
}
