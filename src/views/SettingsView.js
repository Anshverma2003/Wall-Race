import { EventEmitter } from '../core/EventEmitter.js';
import { DEFAULT_SETTINGS, GRID_SIZES, WALL_LIMIT } from '../config.js';

/**
 * Settings dialog. Changes are emitted immediately (no "save" button).
 *
 * Events: 'change' (partialSettings), 'close'
 */
export class SettingsView extends EventEmitter {
  #lastFiniteWalls = DEFAULT_SETTINGS.wallLimit;
  #returnFocus = null;

  constructor() {
    super();
    this.overlay = document.getElementById('settings-overlay');
    this.theme = document.getElementById('setting-theme');
    this.flip = document.getElementById('setting-flip');
    this.gameGroup = document.getElementById('setting-game-group');
    this.grid = document.getElementById('setting-grid');
    this.walls = document.getElementById('setting-walls');
    this.unlimited = document.getElementById('setting-walls-unlimited');
    this.note = document.getElementById('setting-game-note');

    this.walls.min = String(WALL_LIMIT.MIN);
    this.walls.max = String(WALL_LIMIT.MAX);

    this.grid.replaceChildren(
      ...GRID_SIZES.map((size) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('role', 'radio');
        btn.dataset.value = String(size);
        btn.textContent = `${size} × ${size}`;
        return btn;
      }),
    );

    this.#bind();
  }

  get isOpen() {
    return !this.overlay.hidden;
  }

  open() {
    this.#returnFocus = document.activeElement;
    this.overlay.hidden = false;
    this.overlay.querySelector('#btn-close-settings').focus();
  }

  close() {
    if (!this.isOpen) return;
    this.overlay.hidden = true;
    this.#returnFocus?.focus?.();
    this.emit('close');
  }

  /**
   * @param {{theme:string, flipBoard:boolean, gridSize:number, wallLimit:number|null}} values
   * @param {{gameEditable:boolean, note:string}} options
   */
  render(values, { gameEditable, note }) {
    setSegmented(this.theme, values.theme);
    this.flip.checked = values.flipBoard;
    setSegmented(this.grid, String(values.gridSize));

    const unlimited = values.wallLimit === null;
    if (!unlimited) this.#lastFiniteWalls = values.wallLimit;
    this.unlimited.checked = unlimited;
    if (document.activeElement !== this.walls) {
      this.walls.value = unlimited ? '' : String(values.wallLimit);
    }
    this.walls.placeholder = unlimited ? '∞' : '';

    this.gameGroup.disabled = !gameEditable;
    this.walls.disabled = !gameEditable || unlimited;
    this.note.textContent = note;
  }

  #bind() {
    document.getElementById('btn-close-settings').addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    });

    this.theme.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (btn) this.emit('change', { theme: btn.dataset.value });
    });

    this.flip.addEventListener('change', () => this.emit('change', { flipBoard: this.flip.checked }));

    this.grid.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (btn && !this.gameGroup.disabled) this.emit('change', { gridSize: Number(btn.dataset.value) });
    });

    this.walls.addEventListener('change', () => {
      if (this.walls.value === '') {
        this.walls.value = String(this.#lastFiniteWalls);
        return;
      }
      const n = Math.round(Number(this.walls.value));
      const clamped = Number.isFinite(n) ? Math.min(WALL_LIMIT.MAX, Math.max(WALL_LIMIT.MIN, n)) : this.#lastFiniteWalls;
      this.walls.value = String(clamped);
      this.emit('change', { wallLimit: clamped });
    });

    this.unlimited.addEventListener('change', () => {
      this.emit('change', { wallLimit: this.unlimited.checked ? null : this.#lastFiniteWalls });
    });
  }
}

function setSegmented(group, value) {
  for (const btn of group.querySelectorAll('button[data-value]')) {
    btn.setAttribute('aria-checked', String(btn.dataset.value === value));
  }
}
