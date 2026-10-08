import { RoomStatus } from '../models/RoomModel.js';

/**
 * Connects the settings dialog to the SettingsModel.
 *  - Theme / flip board: always editable, personal to this device.
 *  - Grid size / walls: editable by the host (or the player in a vs-AI game),
 *    and never during a match.
 */
export class SettingsController {
  /**
   * @param {{
   *   settings: import('../models/SettingsModel.js').SettingsModel,
   *   getSession: () => import('./GameController.js').GameSession|null,
   *   view: import('../views/SettingsView.js').SettingsView,
   * }} deps
   */
  constructor(deps) {
    Object.assign(this, deps);
  }

  init() {
    this.applyTheme();
    document.getElementById('btn-open-settings').addEventListener('click', () => this.open());

    this.view.on('change', (partial) => {
      const touchesMatch = 'gridSize' in partial || 'wallLimit' in partial;
      if (touchesMatch && !this.#matchEditable) return;
      this.settings.update(partial);
    });

    this.settings.on('change', (keys) => {
      if (keys.includes('theme')) this.applyTheme();
      this.refresh();
    });
  }

  #openListeners = [];

  /** Run `fn` every time the dialog opens (e.g. to refresh the profile section). */
  onOpen(fn) {
    this.#openListeners.push(fn);
  }

  open() {
    this.refresh();
    for (const fn of this.#openListeners) fn();
    this.view.open();
  }

  close() {
    this.view.close();
  }

  /** Re-render the dialog if it is open (session state may have changed). */
  refresh() {
    const session = this.#activeSession;
    const values = this.settings.toJSON();
    if (session) Object.assign(values, session.matchSettings); // show what the match actually uses
    this.view.render(values, { gameEditable: this.#matchEditable, note: this.#note });
  }

  applyTheme() {
    document.documentElement.dataset.theme = this.settings.theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', this.settings.theme === 'dark' ? '#050507' : '#f4f2ee');
  }

  get #activeSession() {
    const s = this.getSession();
    return s?.isActive ? s : null;
  }

  get #matchEditable() {
    const s = this.#activeSession;
    return !s || s.canEditMatch;
  }

  get #note() {
    const s = this.#activeSession;
    if (!s) return 'Used when you host a room or play vs AI.';
    if (!s.canEditMatch && s.status !== RoomStatus.PLAYING) return 'Only the host can change match settings.';
    if (s.status === RoomStatus.PLAYING) return "Match settings can't be changed during a game.";
    if (s.status === RoomStatus.FINISHED) return 'Changes apply to the next game.';
    return 'Changes are shared with your opponent instantly.';
  }
}
