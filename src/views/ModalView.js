/**
 * Generic blocking modal used for game-over and confirmations.
 */
export class ModalView {
  #id = null;

  constructor() {
    this.overlay = document.getElementById('modal-overlay');
    this.title = document.getElementById('modal-title');
    this.message = document.getElementById('modal-message');
    this.actions = document.getElementById('modal-actions');
  }

  get isOpen() {
    return !this.overlay.hidden;
  }

  /** Identifier of the currently shown modal (lets controllers update or close their own modal). */
  get id() {
    return this.isOpen ? this.#id : null;
  }

  /**
   * @param {{
   *   id?: string,
   *   title: string,
   *   message?: string,
   *   actions: {label:string, variant?:'primary'|'secondary'|'ghost', disabled?:boolean, onClick?:() => void}[]
   * }} options
   */
  show({ id = null, title, message = '', actions }) {
    const focusedIndex = this.isOpen && this.#id === id
      ? [...this.actions.children].indexOf(document.activeElement)
      : -1;

    this.#id = id;
    this.title.textContent = title;
    this.message.textContent = message;
    this.message.hidden = !message;
    this.actions.replaceChildren(
      ...actions.map(({ label, variant = 'secondary', disabled = false, onClick }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn btn--${variant}`;
        btn.textContent = label;
        btn.disabled = disabled;
        btn.addEventListener('click', () => onClick?.());
        return btn;
      }),
    );
    this.overlay.hidden = false;

    const buttons = [...this.actions.children];
    const target = buttons[focusedIndex] && !buttons[focusedIndex].disabled
      ? buttons[focusedIndex]
      : buttons.find((b) => !b.disabled && b.classList.contains('btn--primary')) ?? buttons.find((b) => !b.disabled);
    target?.focus();
  }

  hide(id) {
    if (id !== undefined && id !== this.#id) return;
    this.overlay.hidden = true;
    this.#id = null;
  }
}
