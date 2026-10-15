/**
 * Small transient notifications at the bottom of the screen. Each one
 * disappears on its own after a few seconds, or straight away with its × button.
 */
export class ToastView {
  constructor() {
    this.root = document.getElementById('toasts');
  }

  /**
   * @param {string} text
   * @param {'info'|'success'|'warning'|'error'} tone
   */
  show(text, tone = 'info', duration = 3200) {
    // Avoid stacking the exact same message.
    for (const t of this.root.children) {
      if (t.dataset.text === text && !t.classList.contains('toast--leaving')) t.remove();
    }

    const toast = document.createElement('div');
    toast.className = `toast toast--${tone}`;
    toast.dataset.text = text;
    toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');

    const message = document.createElement('span');
    message.className = 'toast__text';
    message.textContent = text;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast__close';
    close.setAttribute('aria-label', 'Dismiss');
    close.title = 'Dismiss';
    close.textContent = '×';

    toast.append(message, close);
    this.root.appendChild(toast);

    while (this.root.children.length > 3) this.root.firstElementChild.remove();

    const timer = setTimeout(() => this.#dismiss(toast), duration);
    close.addEventListener('click', () => {
      clearTimeout(timer);
      this.#dismiss(toast);
    });
  }

  #dismiss(toast) {
    if (!toast.isConnected || toast.classList.contains('toast--leaving')) return;
    toast.classList.add('toast--leaving');
    setTimeout(() => toast.remove(), 300);
  }
}
