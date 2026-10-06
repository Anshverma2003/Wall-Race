import { RoomStatus } from '../models/RoomModel.js';

const GAME_OVER_MODAL = 'game-over';
const LEAVE_MODAL = 'confirm-leave';

/**
 * @typedef {object} GameSession
 * Implemented by RoomController (online) and AIController (vs AI) so the game
 * screen does not care who the opponent is.
 * @property {'online'|'ai'} kind
 * @property {boolean} isActive
 * @property {'lobby'|'playing'|'finished'} status
 * @property {import('../models/GameModel.js').GameModel|null} game
 * @property {0|1} localIndex
 * @property {string} opponentName        e.g. "Opponent" or "AI"
 * @property {boolean} opponentOnline
 * @property {boolean} opponentThinking   AI is computing its move
 * @property {string|null} banner
 * @property {{label:string, value:string}} footer
 * @property {boolean[]} rematchVotes
 * @property {boolean} rematchNeedsBoth
 * @property {string} leaveWarning
 * @property {(action:object) => boolean} submitAction
 * @property {() => void} requestRematch
 * @property {() => void} leave
 */

/**
 * Drives the game screen: turns board input into actions for the active
 * session and renders the game state it holds.
 */
export class GameController {
  /** Waiting for our action to be confirmed (prevents double submits). */
  #pending = false;
  /** Last computed hint, restored after a touch wall-preview is cancelled. */
  #hint = '';

  /**
   * @param {{
   *   getSession: () => GameSession|null,
   *   settings: import('../models/SettingsModel.js').SettingsModel,
   *   view: import('../views/GameView.js').GameView,
   *   modal: import('../views/ModalView.js').ModalView,
   *   toast: import('../views/ToastView.js').ToastView,
   * }} deps
   */
  constructor(deps) {
    Object.assign(this, deps);
  }

  init() {
    this.view.on('move', ({ r, c }) => this.#submit({ kind: 'move', r, c }));
    this.view.on('wall', ({ o, r, c }) => this.#submit({ kind: 'wall', o, r, c }));
    this.view.on('invalid', (reason) => this.toast.show(reason, 'error'));
    this.view.on('preview', (wall) => {
      this.view.setHint(wall ? 'Tap the same spot again to place the wall.' : this.#hint);
    });
    this.view.on('leave', () => this.#confirmLeave());
  }

  get #session() {
    const s = this.getSession();
    return s?.isActive && s.game ? s : null;
  }

  /**
   * Re-render after any state change.
   * @param {null | {kind:string, by?:0|1, first?:0|1, reason?:string, action?:object}} event
   */
  update(event = null) {
    this.#pending = false;
    if (!this.#session) return;
    this.#render();
    this.#announce(event);
    this.#syncGameOverModal();
  }

  /** Re-render without an event (e.g. flip-board setting changed, AI started thinking). */
  refresh() {
    const s = this.#session;
    if (s && s.status !== RoomStatus.LOBBY) this.#render();
  }

  closeModals() {
    this.modal.hide(GAME_OVER_MODAL);
    this.modal.hide(LEAVE_MODAL);
  }

  // ------------------------------------------------------------- rendering

  #render() {
    const s = this.#session;
    const game = s.game;
    const me = s.localIndex;
    const myTurn = !game.isOver && game.turn === me;
    const online = s.opponentOnline;
    const interactive = myTurn && online && !this.#pending;

    let status;
    if (game.isOver) status = { text: game.winner === me ? 'You win!' : 'You lose' };
    else if (myTurn) status = { text: 'Your turn', tone: 'mine' };
    else status = { text: `${s.opponentName}'s turn` };

    let hint = '';
    if (game.isOver) hint = 'Game over.';
    else if (!myTurn) hint = s.opponentThinking ? `${s.opponentName} is thinking…` : `Waiting for ${s.opponentName.toLowerCase()} to play…`;
    else if (!game.hasWallsLeft(me)) hint = 'No walls left. Move your pawn to a highlighted square.';
    else if (this.view.isTouch) hint = 'Tap a highlighted square to move, or tap a gap between two dots twice to place a wall.';
    else hint = 'Click a highlighted square to move, or click a gap between two dots to place a wall.';
    this.#hint = hint;

    this.view.render({
      game,
      localIndex: me,
      flip: this.settings.flipBoard,
      interactive,
      validateWall: (wall) => game.checkWall(me, wall),
      footer: s.footer,
      names: [0, 1].map((i) => (i === me ? 'You' : s.opponentName)),
      thinking: [0, 1].map((i) => i !== me && s.opponentThinking),
      status,
      hint,
      banner: s.banner,
      offline: [0, 1].map((i) => i !== me && !online),
    });
  }

  #announce(event) {
    if (!event) return;
    const s = this.#session;
    const me = s.localIndex;
    switch (event.kind) {
      case 'start':
        this.toast.show(event.first === me ? 'You go first!' : `${s.opponentName} goes first.`, 'info');
        break;
      case 'rejected':
        if (event.by === me) this.toast.show(event.reason, 'error');
        break;
      case 'action':
        if (event.by !== me && event.action?.kind === 'wall' && !s.game.isOver) {
          this.toast.show(`${s.opponentName} placed a wall.`, 'info', 1800);
        }
        break;
      case 'rematch':
        if (event.by !== me) this.toast.show('Your opponent wants a rematch!', 'info');
        break;
      default:
        break;
    }
  }

  #syncGameOverModal() {
    const s = this.#session;
    const game = s.game;
    if (!game.isOver || s.status !== RoomStatus.FINISHED) {
      this.modal.hide(GAME_OVER_MODAL);
      return;
    }

    const me = s.localIndex;
    const won = game.winner === me;
    const iVoted = s.rematchNeedsBoth && s.rematchVotes[me];
    const theyVoted = s.rematchNeedsBoth && s.rematchVotes[1 - me];
    const online = s.opponentOnline;

    let message = won ? 'You reached the other side first.' : `${s.opponentName} reached the other side first.`;
    if (!online) message += ' Your opponent is offline.';
    else if (theyVoted && !iVoted) message += ' Your opponent wants a rematch.';
    else if (iVoted) message += ' Waiting for your opponent…';

    this.modal.show({
      id: GAME_OVER_MODAL,
      title: won ? 'You win! 🏆' : 'You lose',
      message,
      actions: [
        { label: 'Exit', variant: 'ghost', onClick: () => s.leave() },
        {
          label: iVoted ? 'Waiting…' : 'Play again',
          variant: 'primary',
          disabled: iVoted || !online,
          onClick: () => s.requestRematch(),
        },
      ],
    });
  }

  // ---------------------------------------------------------------- input

  #submit(action) {
    const s = this.#session;
    if (!s || this.#pending) return;
    this.#pending = true;
    this.#render(); // lock the board until the action is confirmed
    if (!s.submitAction(action)) {
      this.#pending = false;
      this.#render();
    }
  }

  #confirmLeave() {
    const s = this.#session;
    if (!s) return;
    if (s.status !== RoomStatus.PLAYING) {
      s.leave();
      return;
    }
    this.modal.show({
      id: LEAVE_MODAL,
      title: 'Leave the match?',
      message: s.leaveWarning,
      actions: [
        { label: 'Stay', variant: 'ghost', onClick: () => this.modal.hide(LEAVE_MODAL) },
        { label: 'Leave', variant: 'primary', onClick: () => s.leave() },
      ],
    });
  }
}
