import { GRID_SIZES } from '../config.js';
import { SettingsModel } from './SettingsModel.js';

export const Role = Object.freeze({ HOST: 'host', GUEST: 'guest' });

export const RoomStatus = Object.freeze({
  LOBBY: 'lobby',
  PLAYING: 'playing',
  FINISHED: 'finished',
});

const emptySeat = () => ({ playerId: null, connected: false, card: null });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A player's public identity as received from a peer, or null if malformed. */
export function sanitizeCard(card) {
  if (!card || typeof card !== 'object') return null;
  const { id, name, tag } = card;
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  if (typeof name !== 'string' || name.length < 1 || name.length > 16) return null;
  if (typeof tag !== 'string' || !/^[0-9]{4}$/.test(tag)) return null;
  return { id, name, tag };
}

/**
 * State of the current room. The host owns the source of truth and sends
 * `snapshot()` to the guest, which mirrors it with `applySnapshot()`.
 *
 * Seat 0 is always the host (P1, top), seat 1 the guest (P2, bottom).
 */
export class RoomModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.code = null;
    this.role = null;
    this.localIndex = null;
    this.status = RoomStatus.LOBBY;
    this.settings = { gridSize: GRID_SIZES[0], wallLimit: 10 };
    this.seats = [emptySeat(), emptySeat()];
    this.rematch = [false, false];
    /** Id of the current / last game, used to report its result to the leaderboard. */
    this.matchId = null;
  }

  get isActive() {
    return this.code !== null;
  }

  get isHost() {
    return this.role === Role.HOST;
  }

  get opponentIndex() {
    return this.localIndex === null ? null : 1 - this.localIndex;
  }

  get opponentConnected() {
    return this.opponentIndex !== null && this.seats[this.opponentIndex].connected;
  }

  get isFull() {
    return this.seats.every((s) => s.connected);
  }

  /** Host-side initialisation. */
  openAsHost(code, playerId, matchSettings, card = null) {
    this.reset();
    this.code = code;
    this.role = Role.HOST;
    this.localIndex = 0;
    this.seats[0] = { playerId, connected: true, card };
    this.setSettings(matchSettings);
  }

  /** Guest-side initialisation, before the first snapshot arrives. */
  openAsGuest(code) {
    this.reset();
    this.code = code;
    this.role = Role.GUEST;
    this.localIndex = 1;
  }

  setSettings({ gridSize, wallLimit }) {
    this.settings = {
      gridSize: GRID_SIZES.includes(gridSize) ? gridSize : GRID_SIZES[0],
      wallLimit: SettingsModel.sanitizeWallLimit(wallLimit),
    };
  }

  freeGuestSeat() {
    this.seats[1] = emptySeat();
    this.rematch = [false, false];
  }

  snapshot() {
    return {
      code: this.code,
      status: this.status,
      settings: { ...this.settings },
      seats: this.seats.map((s) => ({ connected: s.connected, card: s.card })),
      rematch: [...this.rematch],
      matchId: this.matchId,
    };
  }

  applySnapshot(snap) {
    this.code = snap.code;
    this.status = snap.status;
    this.setSettings(snap.settings);
    this.seats = snap.seats.map((s, i) => ({
      playerId: this.seats[i]?.playerId ?? null,
      connected: !!s.connected,
      card: sanitizeCard(s.card),
    }));
    this.rematch = [...snap.rematch];
    this.matchId = typeof snap.matchId === 'string' ? snap.matchId : null;
  }

  /** Full host state for localStorage, so a refresh can restore the room. */
  toJSON() {
    return {
      code: this.code,
      role: this.role,
      localIndex: this.localIndex,
      status: this.status,
      settings: { ...this.settings },
      seats: this.seats.map((s) => ({ ...s })),
      rematch: [...this.rematch],
      matchId: this.matchId,
    };
  }

  restore(data) {
    this.reset();
    Object.assign(this, {
      code: data.code,
      role: data.role,
      localIndex: data.localIndex,
      status: data.status,
      seats: data.seats.map((s) => ({ ...emptySeat(), ...s })),
      rematch: [...data.rematch],
      matchId: data.matchId ?? null,
    });
    this.setSettings(data.settings);
  }
}
