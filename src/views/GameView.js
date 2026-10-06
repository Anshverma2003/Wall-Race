import { EventEmitter } from '../core/EventEmitter.js';
import { BoardView } from './BoardView.js';

/**
 * Game screen: player HUD, status line, banner, board and footer.
 * Board events ('move', 'wall', 'invalid', 'preview') are re-emitted.
 *
 * Events: 'move', 'wall', 'invalid', 'preview', 'leave'
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

    for (const evt of ['move', 'wall', 'invalid', 'preview']) {
      this.board.on(evt, (payload) => this.emit(evt, payload));
    }
    document.getElementById('btn-game-leave').addEventListener('click', () => this.emit('leave'));
  }

  get isTouch() {
    return this.board.isTouch;
  }

  /**
   * @param {{
   *   game: import('../models/GameModel.js').GameModel,
   *   localIndex: 0|1,
   *   flip: boolean,
   *   interactive: boolean,
   *   validateWall: Function,
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

    this.board.render(state);
  }

  setHint(text) {
    this.hint.textContent = text;
  }
}
