/**
 * Switches between the top-level screens (home / lobby / game).
 */
export class ScreenView {
  #screens;
  #current = null;

  constructor(root = document) {
    this.#screens = new Map([...root.querySelectorAll('[data-screen]')].map((s) => [s.dataset.screen, s]));
  }

  get current() {
    return this.#current;
  }

  show(name) {
    if (this.#current === name) return;
    for (const [key, section] of this.#screens) section.hidden = key !== name;
    this.#current = name;
    window.scrollTo({ top: 0 });
  }
}
