import { EventEmitter } from '../core/EventEmitter.js';
import { MATCH_RULES, NETWORK, ROOM, STORAGE_KEYS } from '../config.js';
import { ClockModel } from '../models/ClockModel.js';
import { GameModel } from '../models/GameModel.js';
import { RoomStatus, sanitizeCard } from '../models/RoomModel.js';
import { PeerService } from '../services/PeerService.js';
import { copyText } from '../utils/clipboard.js';
import { generateId, generateRoomCode, generateUuid, isValidRoomCode, randomInt } from '../utils/random.js';

/**
 * Network protocol (all messages are JSON objects with a `t` field):
 *
 *  guest → host
 *    hello   { playerId, card }   ask to take (or reclaim) seat P2; card = {id, name, tag} profile
 *    action  { action }           move / wall intent, validated by the host
 *    rematch {}                   vote to play again
 *    leave   {}                   leaving the room on purpose
 *
 *  host → guest
 *    sync    { room, game, clock, event }  full authoritative state (+ what just happened)
 *    reject  { reason }             cannot join (room full)
 *    leave   {}                     host closed the room
 *
 * The host is authoritative: it runs the GameModel and the chess clock,
 * validates every action and broadcasts the full state after each change.
 * The guest only renders it.
 *
 * Leaving a game in progress (MATCH_RULES):
 *  - Leave button: immediate loss for the leaver.
 *  - Disconnect: the game pauses; the player has DISCONNECT_GRACE_MS to come
 *    back, otherwise they lose.
 *  - Either way, if the leaver had not moved yet and the game is less than
 *    EARLY_LEAVE_MS old, the game is cancelled instead (no rating change).
 *
 * Emits 'change' whenever room or game state changes (used by other controllers).
 */
export class RoomController extends EventEmitter {
  /** @type {GameModel|null} */
  game = null;
  /** True while a guest is trying to get back to a lost host. */
  reconnecting = false;

  #guestConnId = null;
  #hostConnId = null;
  #busy = false;
  /** Bumped whenever a new connection is started (create / join / resume). */
  #netGeneration = 0;
  #welcomeTimer = null;
  #gameController = null;
  /** Verified public cards (name, tag, rating) by player id. */
  #cards = new Map();
  /** Match ids already reported from this tab. */
  #reported = new Set();

  /** @type {ClockModel|null} chess clock of the current game (host: authoritative, guest: mirror) */
  clock = null;
  /** Rating result of the last finished game, shown in the game-over card. */
  ratingChange = null;
  #clockTimer = null;
  #aliveTimer = null;
  /** Local time the current game started (for the early-leave rule). */
  #startedAt = 0;
  /** Profile ids of P1 and P2 for the current game (kept even if a seat empties). */
  #matchPlayers = null;
  /** Disconnect countdown: {player, deadline, early, timer} while waiting for someone to come back. */
  #grace = null;

  /**
   * @param {{
   *   app: import('./AppController.js').AppController,
   *   room: import('../models/RoomModel.js').RoomModel,
   *   settings: import('../models/SettingsModel.js').SettingsModel,
   *   storage: import('../services/StorageService.js').StorageService,
   *   network: PeerService,
   *   homeView: import('../views/HomeView.js').HomeView,
   *   lobbyView: import('../views/LobbyView.js').LobbyView,
   *   modal: import('../views/ModalView.js').ModalView,
   *   toast: import('../views/ToastView.js').ToastView,
   *   player: import('../models/PlayerModel.js').PlayerModel,
   *   supabase: import('../services/SupabaseService.js').SupabaseService,
   *   results: import('../services/ResultsService.js').ResultsService,
   * }} deps
   */
  constructor(deps) {
    super();
    Object.assign(this, deps);
  }

  setGameController(gameController) {
    this.#gameController = gameController;
  }

  init() {
    this.homeView.on('create', () => this.createRoom());
    this.homeView.on('join', (code) => this.joinRoom(code));
    this.homeView.on('rejoin', () => this.rejoin());
    this.homeView.on('forget-session', () => {
      this.#clearSession();
      this.homeView.showRejoin(null);
    });

    this.lobbyView.on('copy-code', () => this.#copy(this.room.code, 'Room code copied.'));
    this.lobbyView.on('copy-link', () => this.#copy(this.inviteLink, 'Invite link copied.'));
    this.lobbyView.on('start', () => this.startGame());
    this.lobbyView.on('leave', () => this.leave());

    this.network.on('message', (connId, msg) => this.#onMessage(connId, msg));
    this.network.on('disconnect', (connId) => this.#onDisconnect(connId));
    this.network.on('error', (err) => {
      this.toast.show(describeError(err), 'error');
    });

    // A refresh must not count as "leaving": just drop the connection and keep the session.
    window.addEventListener('pagehide', () => {
      this.#saveSession(); // remembers when we left (a host back within the grace period continues)
      this.network.destroy();
    });
    // Restored from the back/forward cache: the old connection is gone, start fresh.
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) location.reload();
    });

    const params = new URLSearchParams(location.search);
    const code = params.get('room');
    const invite = code && isValidRoomCode(code) ? code : null;
    if (invite) {
      this.homeView.setCode(invite);
      this.homeView.setMessage('Invite code filled in. Press Join to enter the room.');
    }
    this.#refreshRejoinBanner();

    if (!PeerService.isSupported) {
      this.homeView.setMessage('Could not load the networking library (PeerJS). Check your internet connection and reload.', 'error');
      return;
    }

    // Page was refreshed mid-session → jump straight back in (unless an invite for another room was opened).
    const session = this.#loadSession();
    if (session && (!invite || invite === session.code)) this.rejoin();
  }

  // ------------------------------------------------ GameSession interface

  get kind() { return 'online'; }
  get isActive() { return this.room.isActive; }
  get status() { return this.room.status; }
  get localIndex() { return this.room.localIndex; }
  get opponentName() { return this.#opponentCard?.name ?? 'Opponent'; }
  get opponentLabel() {
    const card = this.#opponentCard;
    return card ? `${card.name}#${card.tag}` : 'Opponent';
  }
  get opponentOnline() { return this.room.opponentConnected && !this.reconnecting; }
  get opponentThinking() { return false; }
  get rematchVotes() { return this.room.rematch; }
  get rematchNeedsBoth() { return true; }
  get footer() { return { label: 'Room', value: this.room.code ?? '' }; }
  get canEditMatch() { return this.room.isHost && this.room.status !== RoomStatus.PLAYING; }
  get matchSettings() { return this.room.settings; }

  get leaveWarning() {
    if (this.room.status === RoomStatus.PLAYING && this.game && this.#isEarly(this.room.localIndex)) {
      return "You haven't moved yet, so leaving now cancels the game with no rating change.";
    }
    return 'Leaving now counts as a loss, and your opponent wins the rating points.';
  }

  /** Ratings shown next to the names: [P1, P2] (null when unknown). */
  get ratings() {
    return this.room.seats.map((seat, i) => {
      const card = this.#verifiedCard(seat.card);
      if (card?.rating) return card.rating;
      return i === this.room.localIndex ? this.player.rating : null;
    });
  }

  get banner() {
    if (this.#grace && this.room.status === RoomStatus.PLAYING) {
      const secs = Math.max(0, Math.ceil((this.#grace.deadline - Date.now()) / 1000));
      return this.room.isHost
        ? `Your opponent disconnected. The game is paused – waiting ${secs}s for them to come back.`
        : `Lost connection to the host. The game is paused – waiting ${secs}s for them to come back.`;
    }
    if (this.reconnecting) return 'Connection to the host lost. Reconnecting…';
    if (this.room.isActive && !this.room.opponentConnected) {
      return this.room.isHost
        ? `Your opponent disconnected. They can rejoin with code ${this.room.code}.`
        : 'The host is offline.';
    }
    return null;
  }

  /** A room session is stored and would be resumed on load. */
  get hasStoredSession() {
    return !!this.#loadSession();
  }

  get inviteLink() {
    const url = new URL(location.href);
    url.search = `?room=${this.room.code}`;
    url.hash = '';
    return url.toString();
  }

  get playerId() {
    let profile = this.storage.get(STORAGE_KEYS.PROFILE);
    if (!profile?.playerId) {
      profile = { playerId: generateId() };
      this.storage.set(STORAGE_KEYS.PROFILE, profile);
    }
    return profile.playerId;
  }

  // =========================================================== home actions

  async createRoom() {
    if (!this.#beginBusy('create')) return;
    try {
      let code = null;
      for (let attempt = 0; attempt < ROOM.MAX_CREATE_ATTEMPTS && !code; attempt++) {
        const candidate = generateRoomCode();
        try {
          await this.network.host(candidate);
          code = candidate;
        } catch (err) {
          if (err.type !== 'unavailable-id') throw err; // code taken → try another
        }
      }
      if (!code) throw new Error('Could not find a free room code. Please try again.');

      this.room.openAsHost(code, this.playerId, this.settings.matchSettings, this.player.card);
      this.game = null;
      this.homeView.setMessage('');
      this.#changed();
      this.#enterLobby();
    } catch (err) {
      this.homeView.setMessage(describeError(err), 'error');
    } finally {
      this.#endBusy();
    }
  }

  async joinRoom(code, { busyLabel = 'join' } = {}) {
    if (!isValidRoomCode(code)) {
      this.homeView.setMessage(`Enter the ${ROOM.CODE_LENGTH}-digit room code.`, 'error');
      this.homeView.focusCode();
      return;
    }
    if (!this.#beginBusy(busyLabel)) return;
    try {
      this.homeView.setMessage('Connecting…');
      this.#hostConnId = await this.network.join(code);
      this.room.openAsGuest(code);
      this.game = null;
      this.network.send(this.#hostConnId, this.#hello());
      this.homeView.setMessage('Connected. Joining room…');

      // The host answers with `sync` (or `reject`).
      clearTimeout(this.#welcomeTimer);
      this.#welcomeTimer = setTimeout(() => {
        this.#abortToHome('The host did not respond. Please try again.');
      }, NETWORK.CONNECT_TIMEOUT_MS);
    } catch (err) {
      this.homeView.setMessage(describeError(err), 'error');
    } finally {
      this.#endBusy();
    }
  }

  async rejoin() {
    const session = this.#loadSession();
    if (!session) {
      this.homeView.showRejoin(null);
      this.homeView.setMessage('That session has expired.', 'error');
      return;
    }
    if (session.role === 'host') await this.#resumeAsHost(session);
    else await this.joinRoom(session.code, { busyLabel: 'rejoin' });
  }

  /** Leave the room on purpose. The other player is told. */
  leave() {
    // Leaving a game in progress is a loss (unless it's an early leave, which cancels the game).
    if (this.room.status === RoomStatus.PLAYING && this.game && !this.game.isOver) {
      const me = this.room.localIndex;
      if (!this.#isEarly(me)) {
        const lost = GameModel.fromJSON(this.game.toJSON());
        lost.endGame(1 - me, 'forfeit');
        this.#sendReport(lost);
        this.toast.show('You left the game. It counts as a loss.', 'warning', 4000);
      } else {
        this.toast.show('Game cancelled. No rating change.', 'info');
      }
    }
    this.#stopMatchTimers();

    const target = this.room.isHost ? this.#guestConnId : this.#hostConnId;
    if (target) this.network.send(target, { t: 'leave' });

    // Give the message a moment to flush before closing the channel – unless a new
    // room was created / joined in the meantime (that reuses the network).
    const network = this.network;
    const generation = this.#netGeneration;
    setTimeout(() => {
      if (!this.room.isActive && generation === this.#netGeneration) network.destroy();
    }, 250);

    this.#resetLocal();
    this.#clearSession();
    this.homeView.setMessage('');
    this.homeView.showRejoin(null);
    this.app.showScreen('home');
  }

  // ========================================================== host actions

  startGame() {
    if (!this.room.isHost || !this.room.seats[1].connected) return;
    if (this.room.status === RoomStatus.PLAYING) return;

    const first = randomInt(2);
    this.game = new GameModel({
      size: this.room.settings.gridSize,
      wallLimit: this.room.settings.wallLimit,
      startingPlayer: first,
    });
    this.room.status = RoomStatus.PLAYING;
    this.room.rematch = [false, false];
    this.room.matchId = generateUuid();
    this.clock = new ClockModel({ limitMs: this.room.settings.timeMinutes * 60_000 });
    this.clock.run(first);
    this.#onMatchStarted();
    this.#scheduleTimeout();
    this.#broadcast({ kind: 'start', first });
  }

  /** Called by the GameController for the local player. @returns {boolean} sent */
  submitAction(action) {
    if (this.room.isHost) {
      this.#applyAction(0, action);
      return true;
    }
    if (!this.#hostConnId || !this.network.send(this.#hostConnId, { t: 'action', action })) {
      this.toast.show('Not connected to the host.', 'error');
      return false;
    }
    return true;
  }

  requestRematch() {
    if (this.room.isHost) this.#voteRematch(0);
    else if (this.#hostConnId) this.network.send(this.#hostConnId, { t: 'rematch' });
  }

  /** Host changed match settings in the settings dialog. */
  onMatchSettingsChanged() {
    if (!this.room.isHost || this.room.status === RoomStatus.PLAYING) return;
    this.room.setSettings(this.settings.matchSettings);
    this.#broadcast(null);
  }

  // ======================================================= host internals

  #applyAction(player, action) {
    if (!this.game || this.room.status !== RoomStatus.PLAYING) return;

    // A move that arrives after the flag fell loses on time instead.
    if (this.clock && this.clock.running === player && this.clock.left(player) <= 0) {
      this.#onTimeout();
      return;
    }

    let result;
    if (!this.room.seats[1].connected) {
      result = { ok: false, reason: 'Waiting for your opponent to reconnect.' };
    } else {
      result = this.game.applyAction(player, action);
    }

    if (!result.ok) {
      const event = { kind: 'rejected', by: player, reason: result.reason };
      if (player === 0) this.#gameController?.update(event);
      else this.#sendSync(event);
      return;
    }

    if (this.game.isOver) {
      this.room.status = RoomStatus.FINISHED;
      this.room.rematch = [false, false];
      this.clock?.stop();
    } else {
      this.clock?.run(this.game.turn);
    }
    this.#scheduleTimeout();
    this.#broadcast({ kind: 'action', by: player, action: this.game.lastAction });
  }

  // ------------------------------------------------------------ chess clock (host)

  #scheduleTimeout() {
    clearTimeout(this.#clockTimer);
    if (!this.room.isHost || !this.clock?.isRunning || this.room.status !== RoomStatus.PLAYING) return;
    this.#clockTimer = setTimeout(() => {
      if (this.clock?.isRunning && this.clock.msToTimeout <= 0) this.#onTimeout();
      else this.#scheduleTimeout();
    }, this.clock.msToTimeout + 25);
  }

  /** The player to move ran out of time: they lose. */
  #onTimeout() {
    if (!this.game || this.game.isOver || !this.clock || this.clock.running === null) return;
    const loser = this.clock.running;
    this.#endMatch(1 - loser, 'timeout');
  }

  #voteRematch(player) {
    if (this.room.status !== RoomStatus.FINISHED) return;
    this.room.rematch[player] = true;
    if (this.room.rematch.every(Boolean)) this.startGame();
    else this.#broadcast({ kind: 'rematch', by: player });
  }

  #admitGuest(connId, playerId, card) {
    if (typeof playerId !== 'string' || !playerId) return;
    const seat = this.room.seats[1];
    const otherPlayer = seat.playerId && seat.playerId !== playerId;

    // Seat is taken by someone online, or reserved mid-match for a disconnected player.
    if (otherPlayer && (seat.connected || this.room.status !== RoomStatus.LOBBY)) {
      this.network.send(connId, { t: 'reject', reason: 'This room is full.' });
      setTimeout(() => this.network.closeConnection(connId), 300);
      return;
    }

    if (this.#guestConnId && this.#guestConnId !== connId) {
      this.network.closeConnection(this.#guestConnId); // stale channel from before a refresh
    }

    const returning = seat.playerId === playerId && this.room.status !== RoomStatus.LOBBY;
    if (!returning && this.room.status === RoomStatus.FINISHED) {
      // A new opponent after the last one left: start over in the lobby.
      this.room.status = RoomStatus.LOBBY;
      this.game = null;
      this.clock = null;
    }
    this.room.seats[1] = { playerId, connected: true, card: sanitizeCard(card) };
    this.#guestConnId = connId;

    // Back within the grace period: the paused game continues.
    if (returning && this.room.status === RoomStatus.PLAYING) {
      this.#endGrace();
      this.clock?.run(this.game.turn);
      this.#scheduleTimeout();
    }

    this.toast.show(returning ? 'Your opponent reconnected.' : 'Player 2 joined the room.', 'success');
    this.#broadcast(null);
  }

  #onGuestLeft(explicit) {
    this.#guestConnId = null;
    const inMatch = this.room.status !== RoomStatus.LOBBY;

    if (this.room.status === RoomStatus.PLAYING) {
      if (explicit) {
        // Left on purpose: immediate loss, or a cancelled game if it was an early leave.
        this.room.seats[1] = { ...this.room.seats[1], playerId: null, connected: false };
        if (this.#isEarly(1)) this.#cancelMatch('Your opponent left before moving. Game cancelled – no rating change.');
        else this.#endMatch(0, 'forfeit');
      } else {
        // Dropped: pause and give them time to come back.
        this.room.seats[1].connected = false;
        this.clock?.stop();
        clearTimeout(this.#clockTimer);
        this.#beginGrace(1);
        this.toast.show('Your opponent disconnected. The game is paused.', 'warning');
        this.#broadcast(null);
      }
      return;
    }

    if (explicit || !inMatch) {
      this.room.freeGuestSeat();
      this.room.status = RoomStatus.LOBBY;
      this.game = null;
      this.toast.show(explicit ? 'Your opponent left the room.' : 'Player 2 disconnected.', 'warning');
    } else {
      this.room.seats[1].connected = false;
      this.toast.show('Your opponent disconnected. Waiting for them to come back…', 'warning');
    }
    this.#broadcast(null);
  }

  /** Persist, send to guest and refresh local views. */
  #broadcast(event) {
    this.#sendSync(event);
    this.#changed();
    this.#route(event);
    this.#reportResult();
  }

  #sendSync(event) {
    if (!this.room.isHost || !this.#guestConnId) return;
    this.network.send(this.#guestConnId, {
      t: 'sync',
      room: this.room.snapshot(),
      game: this.game ? this.game.toJSON() : null,
      clock: this.clock ? this.clock.snapshot() : null,
      event,
    });
  }

  async #resumeAsHost(session) {
    if (!this.#beginBusy('rejoin')) return;
    try {
      // The old peer id may linger on the signalling server for a few seconds after a refresh.
      let lastErr = null;
      let ok = false;
      for (let attempt = 0; attempt < NETWORK.RECONNECT_ATTEMPTS && !ok; attempt++) {
        try {
          await this.network.host(session.code);
          ok = true;
        } catch (err) {
          lastErr = err;
          if (err.type !== 'unavailable-id') break;
          this.homeView.setMessage('Reclaiming your room code…');
          await delay(NETWORK.RECONNECT_DELAY_MS);
        }
      }
      if (!ok) throw lastErr ?? new Error('Could not reopen the room.');

      this.room.restore(session.room);
      this.room.seats[0] = { playerId: this.playerId, connected: true, card: this.player.card };
      this.room.seats[1].connected = false;
      this.game = session.game ? GameModel.fromJSON(session.game) : null;
      // The clock stays paused until the guest is back.
      this.clock = session.clock ? ClockModel.fromSnapshot(session.clock, { paused: true }) : null;
      if (this.room.status === RoomStatus.LOBBY || !this.game) {
        this.room.status = RoomStatus.LOBBY;
        this.room.freeGuestSeat();
        this.game = null;
        this.clock = null;
      }
      this.#matchPlayers = session.matchPlayers ?? null;

      this.homeView.setMessage('');
      if (this.room.status === RoomStatus.PLAYING) {
        const away = Date.now() - (session.aliveAt ?? session.savedAt);
        if (away > MATCH_RULES.DISCONNECT_GRACE_MS) {
          // We were gone longer than the grace period: the guest has already been given the win.
          this.#endMatch(1, 'forfeit');
          this.toast.show('You were away too long, so the game was lost.', 'warning', 5000);
          return;
        }
        this.#beginGrace(1);
        this.#startAliveTimer(); // "still here" pings resume right away
      }
      this.#changed();
      this.#route(null);
      this.toast.show(`Room ${session.code} reopened.`, 'success');
    } catch (err) {
      const msg = err?.type === 'unavailable-id'
        ? 'That room code is still in use. Wait a few seconds and try again.'
        : describeError(err);
      this.homeView.setMessage(msg, 'error');
    } finally {
      this.#endBusy();
    }
  }

  // ====================================================== guest internals

  #onHostMessage(msg) {
    switch (msg.t) {
      case 'sync': {
        clearTimeout(this.#welcomeTimer);
        this.reconnecting = false;
        this.#endGrace();
        this.room.applySnapshot(msg.room);
        this.game = msg.game ? GameModel.fromJSON(msg.game) : null;
        this.clock = this.game ? ClockModel.fromSnapshot(msg.clock) : null;
        if (msg.event?.kind === 'start') this.#onMatchStarted();
        else if (this.room.status === RoomStatus.PLAYING && !this.#matchPlayers) this.#matchPlayers = this.#seatPlayers();
        if (this.room.status === RoomStatus.PLAYING) this.#startAliveTimer();
        this.homeView.setMessage('');
        this.#changed();
        this.#route(msg.event ?? null);
        this.#reportResult();
        break;
      }
      case 'reject':
        this.#abortToHome(msg.reason || 'Could not join the room.', { keepSession: false });
        break;
      case 'leave':
        if (this.room.status === RoomStatus.PLAYING && this.game && !this.game.isOver) {
          // The host left mid-game: we win, unless it was an early leave.
          this.#hostConnId = null;
          this.network.destroy();
          if (this.#isEarly(0)) {
            this.#abortToHome('The host left before moving. Game cancelled – no rating change.', { keepSession: false });
          } else {
            this.#winAfterHostLeft();
          }
          break;
        }
        this.#abortToHome('', { keepSession: false });
        this.modal.show({
          id: 'room-closed',
          title: 'Room closed',
          message: 'The host left the room.',
          actions: [{ label: 'OK', variant: 'primary', onClick: () => this.modal.hide('room-closed') }],
        });
        break;
      default:
        break;
    }
  }

  async #onHostLost() {
    this.#hostConnId = null;
    if (this.reconnecting) return;
    this.reconnecting = true;
    const inGame = this.room.status === RoomStatus.PLAYING && this.game && !this.game.isOver;
    if (inGame) {
      // Pause the game and wait up to the grace period for the host.
      this.clock?.stop();
      this.#beginGrace(0);
    }
    this.toast.show('Connection to the host lost. Reconnecting…', 'warning');
    this.#changed();
    this.#route(null);

    const code = this.room.code;
    const deadline = inGame ? this.#grace.deadline : Infinity;
    for (let attempt = 0; inGame ? Date.now() < deadline : attempt < NETWORK.RECONNECT_ATTEMPTS; attempt++) {
      await delay(NETWORK.RECONNECT_DELAY_MS);
      if (!this.room.isActive || this.room.code !== code || !this.reconnecting) return; // left, or the game ended meanwhile
      try {
        this.#hostConnId = await this.network.join(code);
        this.network.send(this.#hostConnId, this.#hello());
        return; // `sync` clears the reconnecting flag
      } catch {
        /* retry */
      }
    }

    // In a game the grace timer decides the outcome (see #onGraceExpired).
    if (!inGame && this.room.isActive && this.room.code === code) {
      this.#abortToHome('Lost connection to the host. You can try to rejoin.', { keepSession: true });
    }
  }

  // =========================================================== shared

  #onMessage(connId, msg) {
    if (!msg || typeof msg.t !== 'string' || !this.room.isActive) return;

    if (!this.room.isHost) {
      if (connId === this.#hostConnId) this.#onHostMessage(msg);
      return;
    }

    switch (msg.t) {
      case 'hello':
        this.#admitGuest(connId, msg.playerId, msg.card);
        break;
      case 'action':
        if (connId === this.#guestConnId) this.#applyAction(1, msg.action);
        break;
      case 'rematch':
        if (connId === this.#guestConnId) this.#voteRematch(1);
        break;
      case 'leave':
        if (connId === this.#guestConnId) {
          this.network.closeConnection(connId);
          this.#onGuestLeft(true);
        }
        break;
      default:
        break;
    }
  }

  #onDisconnect(connId) {
    if (!this.room.isActive) return;
    if (this.room.isHost) {
      if (connId === this.#guestConnId) this.#onGuestLeft(false);
    } else if (connId === this.#hostConnId) {
      this.#onHostLost();
    }
  }

  /** Show the right screen for the current room status. */
  #route(event) {
    if (!this.room.isActive) return;
    if (this.room.status === RoomStatus.LOBBY) this.#enterLobby();
    else {
      this.app.showScreen('game');
      this.#gameController?.update(event);
    }
  }

  #enterLobby() {
    this.#gameController?.closeModals();
    this.app.showScreen('lobby');
    this.#renderLobby();
    this.#loadRatings();
  }

  #renderLobby() {
    this.lobbyView.render({
      code: this.room.code,
      isHost: this.room.isHost,
      localIndex: this.room.localIndex,
      seats: this.room.seats.map((s) => ({ ...s, card: this.#verifiedCard(s.card) })),
      settings: this.room.settings,
    });
  }

  #abortToHome(message, { keepSession = false } = {}) {
    clearTimeout(this.#welcomeTimer);
    this.network.destroy();
    this.#resetLocal();
    if (!keepSession) this.#clearSession();
    this.app.showScreen('home');
    this.homeView.setMessage(message, message ? 'error' : 'info');
    this.#refreshRejoinBanner();
  }

  #resetLocal() {
    clearTimeout(this.#welcomeTimer);
    this.room.reset();
    this.game = null;
    this.clock = null;
    this.ratingChange = null;
    this.#matchPlayers = null;
    this.#stopMatchTimers();
    this.reconnecting = false;
    this.#guestConnId = null;
    this.#hostConnId = null;
    this.#gameController?.closeModals();
    this.emit('change');
  }

  /** Persist and notify listeners. */
  #changed() {
    this.#saveSession();
    this.emit('change');
  }

  #beginBusy(label) {
    if (this.#busy) return false;
    if (!PeerService.isSupported) {
      this.homeView.setMessage('Networking library (PeerJS) failed to load. Check your connection and reload.', 'error');
      return false;
    }
    this.#busy = true;
    this.#netGeneration++;
    this.homeView.setBusy(label);
    return true;
  }

  #endBusy() {
    this.#busy = false;
    this.homeView.setBusy(false);
  }

  async #copy(text, successMsg) {
    const ok = await copyText(text);
    this.toast.show(ok ? successMsg : `Copy failed. Your code is ${this.room.code}.`, ok ? 'success' : 'warning');
  }

  // ====================================================== player profiles

  /** Join / rejoin request with this device's seat id and public profile. */
  #hello() {
    return { t: 'hello', playerId: this.playerId, card: this.player.card };
  }

  get #opponentCard() {
    const index = this.room.opponentIndex;
    return index === null ? null : this.#verifiedCard(this.room.seats[index].card);
  }

  /** Prefer the name / tag / rating from the database over what a peer claims. */
  #verifiedCard(card) {
    if (!card) return null;
    const known = this.#cards.get(card.id);
    return known ? { ...card, name: known.name, tag: known.tag, rating: known.rating } : card;
  }

  /** Fetch both players' public cards (name, tag, rating) for the lobby. */
  async #loadRatings() {
    const ids = this.room.seats.map((s) => s.card?.id).filter((id) => id && !this.#cards.has(id));
    if (!ids.length) return;
    try {
      for (const card of await this.supabase.playerCards(ids)) this.#cards.set(card.id, card);
      if (this.room.isActive && this.room.status === RoomStatus.LOBBY) this.#renderLobby();
      this.emit('change');
    } catch {
      /* offline: show the names the players sent */
    }
  }

  // ====================================================== match lifecycle

  #seatPlayers() {
    const ids = this.room.seats.map((s) => s.card?.id ?? null);
    return ids.every(Boolean) && ids[0] !== ids[1] ? ids : null;
  }

  /** Both sides: a new game has started. */
  #onMatchStarted() {
    this.#startedAt = performance.now();
    this.#matchPlayers = this.#seatPlayers();
    this.ratingChange = null;
    this.#endGrace();
    this.#startAliveTimer();
    // Tell the server the game exists, so a later forfeit can be checked against it.
    if (this.#matchPlayers && this.player.exists) {
      this.results.registerStart({ matchId: this.room.matchId, players: this.#matchPlayers });
    }
  }

  /**
   * Early leave: the player hasn't moved yet and the game is less than
   * EARLY_LEAVE_MS old. Leaving then cancels the game instead of losing it.
   */
  #isEarly(player) {
    if (!this.game || !this.#startedAt) return false;
    return this.game.actionsBy(player) === 0 && performance.now() - this.#startedAt < MATCH_RULES.EARLY_LEAVE_MS;
  }

  /** End the current game without reaching the goal (timeout / forfeit). Works on host and guest. */
  #endMatch(winner, reason) {
    if (!this.game || this.game.isOver) return;
    this.game.endGame(winner, reason);
    this.clock?.stop();
    this.#stopMatchTimers();
    this.reconnecting = false;
    this.room.status = RoomStatus.FINISHED;
    this.room.rematch = [false, false];
    this.#broadcast({ kind: 'end', reason, winner });
  }

  /** Early leave: drop the game, nobody's rating changes. Host only (the guest goes home). */
  #cancelMatch(message) {
    this.#stopMatchTimers();
    this.game = null;
    this.clock = null;
    this.room.freeGuestSeat();
    this.room.status = RoomStatus.LOBBY;
    this.toast.show(message, 'info', 5000);
    this.#broadcast(null);
  }

  #beginGrace(player) {
    this.#endGrace();
    const early = this.#isEarly(player);
    const deadline = Date.now() + MATCH_RULES.DISCONNECT_GRACE_MS;
    const timer = setTimeout(() => this.#onGraceExpired(), MATCH_RULES.DISCONNECT_GRACE_MS);
    this.#grace = { player, deadline, early, timer };
  }

  #endGrace() {
    if (this.#grace) clearTimeout(this.#grace.timer);
    this.#grace = null;
  }

  /** The disconnected player did not come back in time. */
  #onGraceExpired() {
    const grace = this.#grace;
    this.#grace = null;
    if (!grace || this.room.status !== RoomStatus.PLAYING || !this.game || this.game.isOver) return;

    if (this.room.isHost) {
      if (grace.early) this.#cancelMatch("Your opponent didn't come back. Game cancelled – no rating change.");
      else {
        this.room.seats[1] = { ...this.room.seats[1], playerId: null, connected: false };
        this.#endMatch(0, 'forfeit');
      }
      return;
    }

    // Guest: the host never came back.
    this.network.destroy();
    this.#hostConnId = null;
    if (grace.early) {
      this.#abortToHome("The host didn't come back. Game cancelled – no rating change.", { keepSession: false });
    } else {
      this.#winAfterHostLeft();
    }
  }

  /** Guest: the host left or never came back – we win by forfeit. The room is gone afterwards. */
  #winAfterHostLeft() {
    this.room.seats[0] = { ...this.room.seats[0], connected: false };
    this.#endMatch(this.room.localIndex, 'forfeit');
    this.#clearSession();
  }

  /**
   * While a game is on:
   *  - refresh the saved session regularly (clock + "still here" time for a host restart), and
   *  - tell the server we are still in the game, so nobody can falsely claim we left.
   */
  #startAliveTimer() {
    if (this.#aliveTimer) return; // already running (called on every sync)
    let lastPing = 0;
    const tick = () => {
      if (this.room.status !== RoomStatus.PLAYING) {
        this.#stopAliveTimer();
        return;
      }
      this.#saveSession();
      if (Date.now() - lastPing >= MATCH_RULES.HEARTBEAT_MS && this.room.matchId && this.player.code) {
        lastPing = Date.now();
        this.supabase.matchHeartbeat(this.player.code, this.room.matchId).catch(() => {
          lastPing = 0; // network hiccup: try again on the next tick
        });
      }
    };
    this.#aliveTimer = setInterval(tick, 2000);
    tick();
  }

  #stopAliveTimer() {
    clearInterval(this.#aliveTimer);
    this.#aliveTimer = null;
  }

  #stopMatchTimers() {
    clearTimeout(this.#clockTimer);
    this.#stopAliveTimer();
    this.#endGrace();
  }

  // ====================================================== results

  /**
   * When a game finishes, each player's browser reports it to the server,
   * which replays it before touching ratings. Games won on the board or on
   * time count when both reports agree; a forfeit counts on one report.
   * The outcome is shown in the game-over card (ratingChange).
   */
  async #reportResult() {
    const { room, game } = this;
    if (room.status !== RoomStatus.FINISHED || !game?.isOver || !room.matchId) return;
    if (this.#reported.has(room.matchId)) return;
    if (!(this.#matchPlayers ?? this.#seatPlayers()) || !this.player.exists) return;
    await this.#sendReport(game, { showResult: true });
  }

  async #sendReport(game, { showResult = false } = {}) {
    const matchId = this.room.matchId;
    const players = this.#matchPlayers ?? this.#seatPlayers();
    if (!matchId || !players || !this.player.exists || this.#reported.has(matchId)) return;
    this.#reported.add(matchId);

    const me = this.room.localIndex;
    if (showResult) this.#setRatingChange({ matchId, status: 'pending' });
    const result = await this.results.reportOnline({
      matchId,
      players,
      game: game.toJSON(),
      result: { reason: game.endReason, winner: game.winner },
    });
    if (!showResult) return;

    if (result?.status === 'recorded' && Array.isArray(result.deltas)) {
      // The server returns both new ratings: show them in the chips / lobby straight away.
      players.forEach((id, i) => {
        const known = this.#cards.get(id) ?? this.room.seats[i]?.card ?? { id };
        this.#cards.set(id, { ...known, rating: result.ratings[i] });
      });
      this.#setRatingChange({ matchId, status: 'done', rating: result.ratings[me], delta: result.deltas[me] });
      this.emit('rated');
    } else if (result?.status === 'opponent_active') {
      // Our claim that they left was refused: the server still heard from them. No result.
      this.#setRatingChange({ matchId, status: 'disputed' });
    } else if (result?.status === 'cancelled') {
      this.#setRatingChange({ matchId, status: 'cancelled' });
    } else {
      this.#setRatingChange({ matchId, status: 'none' });
    }
  }

  #setRatingChange(change) {
    if (change.matchId !== this.room.matchId) return; // a newer game already started
    this.ratingChange = change;
    this.emit('change');
    this.#gameController?.refresh();
  }

  // ====================================================== session storage

  #saveSession() {
    if (!this.room.isActive) return;
    const data = { code: this.room.code, role: this.room.role, savedAt: Date.now() };
    if (this.room.isHost) {
      data.room = this.room.toJSON();
      data.game = this.game ? this.game.toJSON() : null;
      data.clock = this.clock ? this.clock.snapshot() : null;
      data.matchPlayers = this.#matchPlayers;
      data.aliveAt = data.savedAt;
    }
    this.storage.set(STORAGE_KEYS.SESSION, data);
  }

  #loadSession() {
    const session = this.storage.get(STORAGE_KEYS.SESSION);
    if (!session || !isValidRoomCode(session.code) || Date.now() - session.savedAt > ROOM.SESSION_TTL_MS) {
      this.#clearSession();
      return null;
    }
    if (session.role === 'host' && !session.room) return null;
    return session;
  }

  #clearSession() {
    this.storage.remove(STORAGE_KEYS.SESSION);
  }

  #refreshRejoinBanner() {
    this.homeView.showRejoin(this.#loadSession()?.code ?? null);
  }
}

// ------------------------------------------------------------------ helpers

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describeError(err) {
  switch (err?.type) {
    case 'peer-unavailable':
      return 'Room not found. Check the code and make sure the host is still online.';
    case 'unavailable-id':
      return 'That room code is already in use.';
    case 'browser-incompatible':
      return 'Your browser does not support WebRTC. Try a recent Chrome, Firefox, Edge or Safari.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Could not reach the matchmaking server. Check your internet connection.';
    case 'timeout':
      return err.message;
    default:
      return err?.message || 'Something went wrong. Please try again.';
  }
}
