import { EventEmitter } from '../core/EventEmitter.js';
import { NETWORK, ROOM, STORAGE_KEYS } from '../config.js';
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
 *    sync    { room, game, event }  full authoritative state (+ what just happened)
 *    reject  { reason }             cannot join (room full)
 *    leave   {}                     host closed the room
 *
 * The host is authoritative: it runs the GameModel, validates every action and
 * broadcasts the full state after each change. The guest only renders it.
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
  #welcomeTimer = null;
  #gameController = null;
  /** Verified public cards (name, tag, rating) by player id. */
  #cards = new Map();
  /** Match ids already reported from this tab. */
  #reported = new Set();

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
    window.addEventListener('pagehide', () => this.network.destroy());
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
  get leaveWarning() { return 'The current game will end for both players.'; }
  get footer() { return { label: 'Room', value: this.room.code ?? '' }; }
  get canEditMatch() { return this.room.isHost && this.room.status !== RoomStatus.PLAYING; }
  get matchSettings() { return this.room.settings; }

  get banner() {
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
    const target = this.room.isHost ? this.#guestConnId : this.#hostConnId;
    if (target) this.network.send(target, { t: 'leave' });

    // Give the message a moment to flush before closing the channel.
    const network = this.network;
    setTimeout(() => {
      if (!this.room.isActive) network.destroy();
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
    }
    this.#broadcast({ kind: 'action', by: player, action: this.game.lastAction });
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
    this.room.seats[1] = { playerId, connected: true, card: sanitizeCard(card) };
    this.#guestConnId = connId;

    this.toast.show(returning ? 'Your opponent reconnected.' : 'Player 2 joined the room.', 'success');
    this.#broadcast(null);
  }

  #onGuestLeft(explicit) {
    this.#guestConnId = null;
    const inMatch = this.room.status !== RoomStatus.LOBBY;

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
      if (this.room.status === RoomStatus.LOBBY || !this.game) {
        this.room.status = RoomStatus.LOBBY;
        this.room.freeGuestSeat();
        this.game = null;
      }

      this.homeView.setMessage('');
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
        this.room.applySnapshot(msg.room);
        this.game = msg.game ? GameModel.fromJSON(msg.game) : null;
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
    this.toast.show('Connection to the host lost. Reconnecting…', 'warning');
    this.#changed();
    this.#route(null);

    const code = this.room.code;
    for (let attempt = 0; attempt < NETWORK.RECONNECT_ATTEMPTS; attempt++) {
      await delay(NETWORK.RECONNECT_DELAY_MS);
      if (!this.room.isActive || this.room.code !== code) return; // user left meanwhile
      try {
        this.#hostConnId = await this.network.join(code);
        this.network.send(this.#hostConnId, this.#hello());
        return; // `sync` clears the reconnecting flag
      } catch {
        /* retry */
      }
    }

    if (this.room.isActive && this.room.code === code) {
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

  /**
   * When a game finishes, each player's browser reports it. It reaches the
   * leaderboard only after the server replays it and both reports agree.
   */
  async #reportResult() {
    const { room, game } = this;
    if (room.status !== RoomStatus.FINISHED || !game?.isOver || !room.matchId) return;
    if (this.#reported.has(room.matchId)) return;
    const players = room.seats.map((s) => s.card?.id);
    if (!players.every(Boolean) || players[0] === players[1] || !this.player.exists) return;

    this.#reported.add(room.matchId);
    const me = room.localIndex;
    const result = await this.results.reportOnline({ matchId: room.matchId, players, game: game.toJSON() });
    if (result?.status === 'recorded' && Array.isArray(result.deltas)) {
      const delta = result.deltas[me];
      this.toast.show(`Rating ${result.ratings[me]} (${delta >= 0 ? '+' : ''}${delta})`, delta >= 0 ? 'success' : 'info', 4500);
      this.#cards.clear(); // ratings changed
      this.emit('rated');
    }
  }

  // ====================================================== session storage

  #saveSession() {
    if (!this.room.isActive) return;
    const data = { code: this.room.code, role: this.room.role, savedAt: Date.now() };
    if (this.room.isHost) {
      data.room = this.room.toJSON();
      data.game = this.game ? this.game.toJSON() : null;
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
