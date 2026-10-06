import { RoomStatus } from '../models/RoomModel.js';

/**
 * Connects the settings dialog to the SettingsModel.
 *  - Theme / flip board: always editable, personal to this device.
 *  - Grid size / walls: editable only by the host, and not during a match.
 */
export class SettingsController {
  /**
   * @param {{
   *   settings: import('../models/SettingsModel.js').SettingsModel,
   *   room: import('../models/RoomModel.js').RoomModel,
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

  open() {
    this.refresh();
    this.view.open();
  }

  /** Re-render the dialog if it is open (room state may have changed). */
  refresh() {
    const room = this.room;
    const values = this.settings.toJSON();
    if (room.isActive) Object.assign(values, room.settings); // show what the match actually uses
    this.view.render(values, { gameEditable: this.#matchEditable, note: this.#note });
  }

  applyTheme() {
    document.documentElement.dataset.theme = this.settings.theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', this.settings.theme === 'dark' ? '#050507' : '#f4f2ee');
  }

  get #matchEditable() {
    const room = this.room;
    if (!room.isActive) return true;
    return room.isHost && room.status !== RoomStatus.PLAYING;
  }

  get #note() {
    const room = this.room;
    if (!room.isActive) return 'Used when you host a room.';
    if (!room.isHost) return 'Only the host can change match settings.';
    if (room.status === RoomStatus.PLAYING) return "Match settings can't be changed during a game.";
    if (room.status === RoomStatus.FINISHED) return 'Changes apply to the next game.';
    return 'Changes are shared with your opponent instantly.';
  }
}
