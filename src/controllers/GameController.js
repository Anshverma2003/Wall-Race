import { PLAYER_LABELS } from '../config.js';
import { RoomStatus } from '../models/RoomModel.js';

const GAME_OVER_MODAL = 'game-over';
const LEAVE_MODAL = 'confirm-leave';

/**
 * Drives the game screen: turns board input into actions for the
 * RoomController and renders the authoritative game state it holds.
 */
export class GameController {
  /** Waiting for the host to confirm our action (prevents double submits). */
  #pending = false;
  /** Last computed hint, restored after a touch wall-preview is cancelled. */
  #hint = '';

  /**
   * @param {{
   *   roomCtrl: import('./RoomController.js').RoomController,
   *   room: import('../models/RoomModel.js').RoomModel,
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

  get #game() {
    return this.roomCtrl.game;
  }

  /**
   * Re-render after any state change.
   * @param {null | {kind:string, by?:0|1, first?:0|1, reason?:string, action?:object}} event
   */
  update(event = null) {
    this.#pending = false;
    if (!this.#game) return;
    this.#render();
    this.#announce(event);
    this.#syncGameOverModal();
  }

  /** Re-render without an event (e.g. flip-board setting changed). */
  refresh() {
    if (this.#game && this.room.status !== RoomStatus.LOBBY) this.#render();
  }

  closeModals() {
    this.modal.hide(GAME_OVER_MODAL);
    this.modal.hide(LEAVE_MODAL);
  }

  // ------------------------------------------------------------- rendering

  #render() {
    const game = this.#game;
    const me = this.room.localIndex;
    const myTurn = !game.isOver && game.turn === me;
    const opponentOnline = this.room.opponentConnected && !this.roomCtrl.reconnecting;
    const interactive = myTurn && opponentOnline && !this.#pending;

    let status;
    if (game.isOver) status = { text: game.winner === me ? 'You win!' : 'You lose' };
    else if (myTurn) status = { text: 'Your turn', tone: 'mine' };
    else status = { text: "Opponent's turn" };

    let hint = '';
    if (game.isOver) hint = 'Game over.';
    else if (!myTurn) hint = `Waiting for ${PLAYER_LABELS[1 - me]} to play…`;
    else if (!game.hasWallsLeft(me)) hint = 'No walls left. Move your pawn to a highlighted square.';
    else if (this.view.isTouch) hint = 'Tap a highlighted square to move, or tap a gap between two dots twice to place a wall.';
    else hint = 'Click a highlighted square to move, or click a gap between two dots to place a wall.';
    this.#hint = hint;

    let banner = null;
    if (this.roomCtrl.reconnecting) banner = 'Connection to the host lost. Reconnecting…';
    else if (!this.room.opponentConnected) {
      banner = this.room.isHost
        ? `Your opponent disconnected. They can rejoin with code ${this.room.code}.`
        : 'The host is offline.';
    }

    const offline = [0, 1].map((i) => i !== me && !opponentOnline);

    this.view.render({
      game,
      localIndex: me,
      flip: this.settings.flipBoard,
      interactive,
      validateWall: (wall) => game.checkWall(me, wall),
      roomCode: this.room.code,
      status,
      hint,
      banner,
      offline,
    });
  }

  #announce(event) {
    if (!event) return;
    const me = this.room.localIndex;
    switch (event.kind) {
      case 'start':
        this.toast.show(event.first === me ? 'You go first!' : `${PLAYER_LABELS[event.first]} goes first.`, 'info');
        break;
      case 'rejected':
        if (event.by === me) this.toast.show(event.reason, 'error');
        break;
      case 'action':
        if (event.by !== me && event.action?.kind === 'wall' && !this.#game.isOver) {
          this.toast.show('Your opponent placed a wall.', 'info', 1800);
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
    const game = this.#game;
    if (!game.isOver || this.room.status !== RoomStatus.FINISHED) {
      this.modal.hide(GAME_OVER_MODAL);
      return;
    }

    const me = this.room.localIndex;
    const won = game.winner === me;
    const iVoted = this.room.rematch[me];
    const theyVoted = this.room.rematch[1 - me];
    const online = this.room.opponentConnected && !this.roomCtrl.reconnecting;

    let message = won
      ? 'You reached the other side first.'
      : `${PLAYER_LABELS[game.winner]} reached the other side first.`;
    if (!online) message += ' Your opponent is offline.';
    else if (theyVoted && !iVoted) message += ' Your opponent wants a rematch.';
    else if (iVoted) message += ' Waiting for your opponent…';

    this.modal.show({
      id: GAME_OVER_MODAL,
      title: won ? 'You win! 🏆' : 'You lose',
      message,
      actions: [
        { label: 'Exit', variant: 'ghost', onClick: () => this.roomCtrl.leave() },
        {
          label: iVoted ? 'Waiting…' : 'Play again',
          variant: 'primary',
          disabled: iVoted || !online,
          onClick: () => this.roomCtrl.requestRematch(),
        },
      ],
    });
  }

  // ---------------------------------------------------------------- input

  #submit(action) {
    if (this.#pending) return;
    this.#pending = true;
    this.#render(); // lock the board until the host confirms
    if (!this.roomCtrl.submitAction(action)) {
      this.#pending = false;
      this.#render();
    }
  }

  #confirmLeave() {
    if (this.room.status !== RoomStatus.PLAYING) {
      this.roomCtrl.leave();
      return;
    }
    this.modal.show({
      id: LEAVE_MODAL,
      title: 'Leave the match?',
      message: 'The current game will end for both players.',
      actions: [
        { label: 'Stay', variant: 'ghost', onClick: () => this.modal.hide(LEAVE_MODAL) },
        { label: 'Leave', variant: 'primary', onClick: () => this.roomCtrl.leave() },
      ],
    });
  }
}
