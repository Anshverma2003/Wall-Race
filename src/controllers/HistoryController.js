import { GameModel } from '../models/GameModel.js';

/**
 * "My games": loads the player's recent online games (private, via their
 * recovery code) and replays a chosen game move by move.
 */
export class HistoryController {
  #requestId = 0;
  /** @type {null | {info:object, full:GameModel, ply:number}} */
  #replay = null;

  /**
   * @param {{
   *   app: import('./AppController.js').AppController,
   *   supabase: import('../services/SupabaseService.js').SupabaseService,
   *   player: import('../models/PlayerModel.js').PlayerModel,
   *   settings: import('../models/SettingsModel.js').SettingsModel,
   *   view: import('../views/HistoryView.js').HistoryView,
   *   toast: import('../views/ToastView.js').ToastView,
   *   homeButton: HTMLElement,
   * }} deps
   */
  constructor(deps) {
    Object.assign(this, deps);
  }

  init() {
    this.homeButton.addEventListener('click', () => this.open());
    this.view.on('back', () => this.app.showScreen('home'));
    this.view.on('refresh', () => this.load());
    this.view.on('open', (matchId) => this.openReplay(matchId));
    this.view.on('no-replay', () => this.#explainNoReplay());
    this.view.on('replay-back', () => this.app.showScreen('history'));
    this.view.on('replay-nav', (where) => this.#navigate(where));
    this.settings.on('change', (keys) => {
      if (keys.includes('flipBoard') && this.#replay) this.#renderReplay();
    });
  }

  open() {
    this.app.showScreen('history');
    this.load();
  }

  async load() {
    const id = ++this.#requestId;
    if (!this.player.code) {
      this.view.renderList({ status: 'error', message: 'Create your player profile first.' });
      return;
    }
    this.view.renderList({ status: 'loading' });
    try {
      const games = await this.supabase.myGames(this.player.code, 50);
      if (id === this.#requestId) this.view.renderList({ status: 'ready', games });
    } catch (err) {
      if (id !== this.#requestId) return;
      this.view.renderList({
        status: 'error',
        message: err.code === 'NETWORK'
          ? "Couldn't reach the server. Check your connection and tap refresh."
          : "Couldn't load your games. Please try again.",
      });
    }
  }

  async openReplay(matchId) {
    try {
      const info = await this.supabase.myGame(this.player.code, matchId);
      if (!Array.isArray(info?.history)) {
        this.#explainNoReplay();
        return;
      }
      // Rebuild the whole game once; earlier positions come from positionAt().
      const full = new GameModel({ size: info.grid_size, wallLimit: info.wall_limit, startingPlayer: info.starting_player });
      for (const { by, ...action } of info.history) full.applyAction(by, action);
      this.#replay = { info, full, ply: full.history.length };
      this.app.showScreen('replay');
      this.#renderReplay();
    } catch {
      this.toast.show("Couldn't open that game. Please try again.", 'error');
    }
  }

  /** Older games are listed (results, rating) but their moves were never saved. */
  #explainNoReplay() {
    this.toast.show("This game was played before replays were added, so its moves weren't saved.", 'info', 4500);
  }

  /** @param {'first'|'prev'|'next'|'last'} where */
  #navigate(where) {
    const r = this.#replay;
    if (!r) return;
    const total = r.full.history.length;
    if (where === 'first') r.ply = 0;
    else if (where === 'prev') r.ply = Math.max(0, r.ply - 1);
    else if (where === 'next') r.ply = Math.min(total, r.ply + 1);
    else r.ply = total;
    this.#renderReplay();
  }

  #renderReplay() {
    const { info, full, ply } = this.#replay;
    const total = full.history.length;
    const game = ply === total ? full : full.positionAt(ply);
    this.view.renderReplay({ game, info, ply, total, flip: this.settings.flipBoard });
  }
}
