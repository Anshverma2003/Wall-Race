/**
 * Application-wide constants. Tweak gameplay limits and networking here.
 */

/** Only odd sizes keep a true centre column for both starting pawns. */
export const GRID_SIZES = Object.freeze([7, 9]);

export const WALL_LIMIT = Object.freeze({ MIN: 0, MAX: 50 });

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'dark',          // 'dark' | 'light'
  flipBoard: true,        // show the local player's pawn at the bottom
  gridSize: 7,            // host only
  wallLimit: 10,          // host only; null = unlimited
});

export const PLAYER_LABELS = Object.freeze(['P1', 'P2']);

export const ROOM = Object.freeze({
  CODE_LENGTH: 6,
  /** Room codes are mapped to PeerJS ids with this prefix to avoid clashing with other apps. */
  PEER_PREFIX: 'wallrace-v1-room-',
  /** How long a stored session can be resumed after a refresh / disconnect. */
  SESSION_TTL_MS: 30 * 60 * 1000,
  MAX_CREATE_ATTEMPTS: 5,
});

export const NETWORK = Object.freeze({
  CONNECT_TIMEOUT_MS: 12000,
  HEARTBEAT_INTERVAL_MS: 3000,
  /** A connection is considered dead after this long without any message. */
  HEARTBEAT_TIMEOUT_MS: 10000,
  /** Covers the opponent refreshing their page (guest retries / host reclaiming its room code). */
  RECONNECT_ATTEMPTS: 10,
  RECONNECT_DELAY_MS: 2000,
  /**
   * Options passed straight to `new Peer(id, options)`.
   * Uses the free public PeerJS signalling server by default. To use your own,
   * add { host, port, path, secure } – see https://peerjs.com/docs/#peer-options
   */
  PEER_OPTIONS: { debug: 1 },
});

export const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'wallrace.settings',
  PROFILE: 'wallrace.profile',
  SESSION: 'wallrace.session',
});
