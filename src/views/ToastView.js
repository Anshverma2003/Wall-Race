/**
 * Small transient notifications at the bottom of the screen.
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
      if (t.textContent === text && !t.classList.contains('toast--leaving')) t.remove();
    }

    const toast = document.createElement('div');
    toast.className = `toast toast--${tone}`;
    toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    toast.textContent = text;
    this.root.appendChild(toast);

    while (this.root.children.length > 3) this.root.firstElementChild.remove();

    setTimeout(() => {
      toast.classList.add('toast--leaving');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
}
