import { EventEmitter } from '../core/EventEmitter.js';
import { BoardView } from './BoardView.js';

/**
 * Game screen: player HUD, status line, banner, board, history buttons and footer.
 * Board events ('move', 'cell', 'wall', 'invalid', 'preview') are re-emitted.
 *
 * Events: 'move', 'cell', 'wall', 'invalid', 'preview', 'leave',
 *         'history' ('first'|'prev'|'next'|'last'), 'clear-premoves'
 */
export class GameView extends EventEmitter {
  constructor() {
    super();
    this.board = new BoardView(document.getElementById('board'));
    this.status = document.getElementById('game-status');
    this.banner = document.getElementById('game-banner');
    this.hint = document.getElementById('game-hint');
    this.footerLabel = document.getElementById('game-footer-label');
    this.footerValue = document.getElementById('game-footer-value');
    this.chips = [document.getElementById('chip-p0'), document.getElementById('chip-p1')];
    this.historyNav = document.getElementById('history-nav');
    this.navButtons = Object.fromEntries(
      [...this.historyNav.querySelectorAll('[data-nav]')].map((b) => [b.dataset.nav, b]),
    );
    this.clearPremovesBtn = document.getElementById('btn-clear-premoves');

    for (const evt of ['move', 'cell', 'wall', 'invalid', 'preview']) {
      this.board.on(evt, (payload) => this.emit(evt, payload));
    }
    this.historyNav.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-nav]');
      if (btn && !btn.disabled) this.emit('history', btn.dataset.nav);
    });
    this.clearPremovesBtn.addEventListener('click', () => this.emit('clear-premoves'));
    document.getElementById('btn-game-leave').addEventListener('click', () => this.emit('leave'));
  }

  get isTouch() {
    return this.board.isTouch;
  }

  /**
   * @param {{
   *   game: import('../models/GameModel.js').GameModel,   the position to show (live or from history)
   *   localIndex: 0|1,
   *   flip: boolean,
   *   mode: 'play'|'premove'|'view',
   *   validateWall: Function,
   *   premoves: object[],
   *   pawnOverride: object|null,
   *   history: {canBack:boolean, canForward:boolean},
   *   footer: {label:string, value:string},
   *   names: string[],
   *   thinking: boolean[],
   *   status: {text:string, tone?:string},
   *   hint: string,
   *   banner: string|null,
   *   offline: boolean[],
   * }} state
   */
  render(state) {
    const { game } = state;

    this.chips.forEach((chip, i) => {
      chip.querySelector('.player-chip__name').textContent = state.names[i];
      const left = game.wallsLeft[i];
      chip.querySelector('.player-chip__walls b').textContent = left === null ? '∞' : String(left);
      chip.dataset.active = String(!game.isOver && game.turn === i);
      chip.dataset.offline = String(!!state.offline[i]);
      chip.dataset.thinking = String(!!state.thinking[i]);
    });

    this.status.textContent = state.status.text;
    this.status.dataset.tone = state.status.tone ?? '';
    this.hint.textContent = state.hint;
    this.footerLabel.textContent = state.footer.label;
    this.footerValue.textContent = state.footer.value;

    this.banner.hidden = !state.banner;
    this.banner.textContent = state.banner ?? '';

    this.navButtons.first.disabled = !state.history.canBack;
    this.navButtons.prev.disabled = !state.history.canBack;
    this.navButtons.next.disabled = !state.history.canForward;
    this.navButtons.last.disabled = !state.history.canForward;

    const queued = state.premoves.length;
    this.clearPremovesBtn.hidden = queued === 0;
    this.clearPremovesBtn.textContent = queued > 1 ? `Clear premoves (${queued})` : 'Clear premove';

    this.board.render(state);
  }

  setHint(text) {
    this.hint.textContent = text;
  }
}
