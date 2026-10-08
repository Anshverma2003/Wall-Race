import { LEADERBOARD } from '../config.js';

/**
 * Loads and shows the global leaderboards (read-only, publishable key).
 */
export class LeaderboardController {
  board = 'online';
  period = 'week';
  #requestId = 0;

  /**
   * @param {{
   *   app: import('./AppController.js').AppController,
   *   supabase: import('../services/SupabaseService.js').SupabaseService,
   *   player: import('../models/PlayerModel.js').PlayerModel,
   *   view: import('../views/LeaderboardView.js').LeaderboardView,
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
    this.view.on('board', (board) => {
      this.board = board;
      this.load();
    });
    this.view.on('period', (period) => {
      this.period = period;
      this.load();
    });
  }

  open() {
    this.app.showScreen('leaderboard');
    this.load();
  }

  async load() {
    const id = ++this.#requestId;
    const base = { board: this.board, period: this.period, limit: LEADERBOARD.LIMIT, meId: this.player.id };
    this.view.render({ ...base, status: 'loading' });
    try {
      const rows = this.board === 'online'
        ? await this.supabase.leaderboardOnline(LEADERBOARD.LIMIT, this.player.id)
        : await this.supabase.leaderboardAi(this.period, LEADERBOARD.LIMIT, this.player.id);
      if (id !== this.#requestId) return; // a newer request superseded this one
      this.view.render({ ...base, status: 'ready', rows });
    } catch (err) {
      if (id !== this.#requestId) return;
      this.view.render({
        ...base,
        status: 'error',
        message: err.code === 'NETWORK'
          ? "Couldn't reach the server. Check your connection and tap refresh."
          : "Couldn't load the leaderboard. Please try again.",
      });
    }
  }
}
