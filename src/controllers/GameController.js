import { PremoveQueue } from '../models/PremoveQueue.js';
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
 * session and renders the game state it holds. Also owns two pieces of
 * purely local UI state:
 *  - which history position is being viewed (the < > buttons), and
 *  - the player's queued premoves.
 */
export class GameController {
  /** Waiting for our action to be confirmed (prevents double submits). */
  #pending = false;
  /** Last computed hint, restored after a touch wall-preview is cancelled. */
  #hint = '';
  /** History position being viewed (number of actions played), or null for the live position. */
  #viewPly = null;
  #premoves = new PremoveQueue();
  /** The action in flight was a premove – if it is rejected, clear the queue silently. */
  #premoveInFlight = false;
  /** Invalidates a scheduled premove when state changes again first. */
  #premoveTimer = null;

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
    this.view.on('wall', ({ o, r, c }) => this.#onWall({ kind: 'wall', o, r, c }));
    this.view.on('cell', ({ r, c }) => this.#queuePremove({ kind: 'move', r, c }));
    this.view.on('invalid', (reason) => this.toast.show(reason, 'error'));
    this.view.on('preview', (wall) => {
      this.view.setHint(wall ? 'Tap the same spot again to place the wall.' : this.#hint);
    });
    this.view.on('history', (where) => this.#navigate(where));
    this.view.on('clear-premoves', () => this.#clearPremoves());
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
    const s = this.#session;
    if (!s) {
      this.#resetLocalState();
      return;
    }

    const rejectedPremove = event?.kind === 'rejected' && this.#premoveInFlight;
    this.#premoveInFlight = false;

    if (event?.kind === 'start') this.#resetLocalState();
    // A new move from anyone takes the board back to the live position.
    if (event?.kind === 'action') this.#viewPly = null;
    // An illegal premove discards the whole queue, silently.
    if (rejectedPremove || s.game.isOver) this.#premoves.clear();

    this.#render();
    if (!rejectedPremove) this.#announce(event);
    this.#syncGameOverModal();
    this.#schedulePremove();
  }

  /** Re-render without an event (e.g. flip-board setting changed, AI started thinking). */
  refresh() {
    const s = this.#session;
    if (s && s.status !== RoomStatus.LOBBY) this.#render();
  }

  /** Called whenever a session starts, ends or returns to the lobby. */
  closeModals() {
    this.modal.hide(GAME_OVER_MODAL);
    this.modal.hide(LEAVE_MODAL);
    this.#resetLocalState();
  }

  #resetLocalState() {
    this.#viewPly = null;
    this.#premoves.clear();
    this.#premoveInFlight = false;
    clearTimeout(this.#premoveTimer);
  }

  // ------------------------------------------------------------- rendering

  #render() {
    const s = this.#session;
    const live = s.game;
    const me = s.localIndex;
    const total = live.history.length;
    const viewing = this.#viewPly !== null && this.#viewPly < total;
    const shown = viewing ? live.positionAt(this.#viewPly) : live;

    const myTurn = !live.isOver && live.turn === me;
    const online = s.opponentOnline;

    let mode = 'view';
    if (!viewing && !live.isOver) {
      if (myTurn && online && !this.#pending) mode = 'play';
      else if (!myTurn) mode = 'premove';
    }

    let status;
    if (live.isOver) status = { text: live.winner === me ? 'You win!' : 'You lose' };
    else if (myTurn) status = { text: 'Your turn', tone: 'mine' };
    else status = { text: `${s.opponentName}'s turn` };

    const queued = this.#premoves.length;
    let hint = '';
    if (viewing) hint = 'Viewing an earlier position. Press >| to return to the game.';
    else if (live.isOver) hint = 'Game over.';
    else if (!myTurn) {
      const waiting = s.opponentThinking ? `${s.opponentName} is thinking…` : `Waiting for ${s.opponentName.toLowerCase()} to play…`;
      hint = queued
        ? `${waiting} ${queued} premove${queued === 1 ? '' : 's'} queued.`
        : `${waiting} You can ${this.view.isTouch ? 'tap' : 'click'} squares or gaps to queue premoves.`;
    } else if (!live.hasWallsLeft(me)) hint = 'No walls left. Move your pawn to a highlighted square.';
    else if (this.view.isTouch) hint = 'Tap a highlighted square to move, or tap a gap between two dots twice to place a wall.';
    else hint = 'Click a highlighted square to move, or click a gap between two dots to place a wall.';
    this.#hint = hint;

    // Premoves are only drawn on the live board.
    const premoves = viewing ? [] : this.#premoves.items;
    const projected = this.#premoves.projectedPawn(null);

    this.view.render({
      game: shown,
      localIndex: me,
      flip: this.settings.flipBoard,
      mode,
      // Premove mode accepts any gap; legality is checked when the premove is played.
      validateWall: mode === 'premove' ? () => ({ ok: true }) : (wall) => live.checkWall(me, wall),
      premoves,
      pawnOverride: !viewing && projected ? { player: me, ...projected } : null,
      history: {
        canBack: total > 0 && (this.#viewPly === null || this.#viewPly > 0),
        canForward: viewing,
      },
      footer: s.footer,
      names: [0, 1].map((i) => (i === me ? 'You' : s.opponentLabel ?? s.opponentName)),
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

  // ---------------------------------------------------------------- history

  /** @param {'first'|'prev'|'next'|'last'} where */
  #navigate(where) {
    const s = this.#session;
    if (!s) return;
    const total = s.game.history.length;
    const current = this.#viewPly ?? total;
    let next = current;
    if (where === 'first') next = 0;
    else if (where === 'prev') next = Math.max(0, current - 1);
    else if (where === 'next') next = current + 1;
    else next = total;
    this.#viewPly = next >= total ? null : next;
    this.#render();
  }

  // --------------------------------------------------------------- premoves

  #onWall(action) {
    const s = this.#session;
    if (!s) return;
    const live = s.game;
    if (!live.isOver && live.turn !== s.localIndex) this.#queuePremove(action);
    else this.#submit(action);
  }

  #queuePremove(action) {
    const s = this.#session;
    if (!s || s.game.isOver || s.game.turn === s.localIndex || this.#viewPly !== null) return;
    this.#premoves.add(action);
    this.#render();
  }

  #clearPremoves() {
    this.#premoves.clear();
    if (this.#session) this.#render();
  }

  /** When it becomes our turn, play the next premove (after the opponent's move has been drawn). */
  #schedulePremove() {
    clearTimeout(this.#premoveTimer);
    if (!this.#premoves.length) return;
    this.#premoveTimer = setTimeout(() => this.#playNextPremove(), 0);
  }

  #playNextPremove() {
    const s = this.#session;
    if (!s || !this.#premoves.length || this.#pending) return;
    const live = s.game;
    const me = s.localIndex;
    if (live.isOver || live.turn !== me || !s.opponentOnline) return;

    const action = this.#premoves.peek();
    const legal = action.kind === 'move'
      ? live.getLegalMoves(me).some((m) => m.r === action.r && m.c === action.c)
      : live.checkWall(me, action).ok;

    if (!legal) {
      // Illegal now → drop it and every premove queued after it, without a message.
      this.#premoves.clear();
      this.#render();
      return;
    }

    this.#premoves.shift();
    this.#premoveInFlight = true;
    this.#submit(action);
  }

  // ---------------------------------------------------------------- input

  #submit(action) {
    const s = this.#session;
    if (!s || this.#pending) return;
    this.#viewPly = null;
    this.#pending = true;
    this.#render(); // lock the board until the action is confirmed
    if (!s.submitAction(action)) {
      this.#pending = false;
      this.#premoveInFlight = false;
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
