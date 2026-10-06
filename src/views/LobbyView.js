import { EventEmitter } from '../core/EventEmitter.js';
import { PLAYER_LABELS } from '../config.js';

/**
 * Lobby: shows the room code, who is connected and the match settings.
 *
 * Events: 'copy-code', 'copy-link', 'leave', 'start', 'edit-settings'
 */
export class LobbyView extends EventEmitter {
  constructor() {
    super();
    this.code = document.getElementById('lobby-code');
    this.hint = document.getElementById('lobby-hint');
    this.players = document.getElementById('lobby-players');
    this.grid = document.getElementById('lobby-grid');
    this.walls = document.getElementById('lobby-walls');
    this.startBtn = document.getElementById('btn-start-game');
    this.waiting = document.getElementById('lobby-waiting');
    this.editBtn = document.getElementById('btn-lobby-settings');

    document.getElementById('btn-copy-code').addEventListener('click', () => this.emit('copy-code'));
    document.getElementById('btn-copy-link').addEventListener('click', () => this.emit('copy-link'));
    document.getElementById('btn-lobby-leave').addEventListener('click', () => this.emit('leave'));
    this.startBtn.addEventListener('click', () => this.emit('start'));
    this.editBtn.addEventListener('click', () => this.emit('edit-settings'));
  }

  /**
   * @param {{code:string, isHost:boolean, localIndex:0|1, seats:{connected:boolean}[],
   *          settings:{gridSize:number, wallLimit:number|null}}} state
   */
  render({ code, isHost, localIndex, seats, settings }) {
    this.code.textContent = code ?? '------';
    const full = seats.every((s) => s.connected);

    this.hint.textContent = isHost
      ? full
        ? 'Both players are here. Start whenever you are ready.'
        : 'Share this code with your opponent so they can join.'
      : 'You are in! The host can change the settings and start the game.';

    this.players.replaceChildren(
      ...seats.map((seat, i) => {
        const li = document.createElement('li');
        li.className = 'player-row';

        const pawn = document.createElement('span');
        pawn.className = 'player-row__pawn';
        pawn.dataset.player = String(i);
        pawn.textContent = PLAYER_LABELS[i];

        const name = document.createElement('span');
        name.className = 'player-row__name';
        name.textContent = `Player ${i + 1}${i === 0 ? ' · Host' : ''}${i === localIndex ? ' (You)' : ''}`;

        const status = document.createElement('span');
        status.className = 'player-row__status';
        status.dataset.state = seat.connected ? 'online' : 'waiting';
        status.textContent = seat.connected ? 'Connected' : 'Waiting…';

        li.append(pawn, name, status);
        return li;
      }),
    );

    this.grid.textContent = `${settings.gridSize} × ${settings.gridSize}`;
    this.walls.textContent = settings.wallLimit === null ? 'Unlimited' : String(settings.wallLimit);

    this.editBtn.hidden = !isHost;
    this.startBtn.hidden = !isHost;
    this.startBtn.disabled = !full;
    this.waiting.hidden = isHost;
  }
}
