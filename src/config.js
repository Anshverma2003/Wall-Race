/**
 * Application-wide constants. Tweak gameplay limits and networking here.
 */

/** Only odd sizes keep a true centre column for both starting pawns. */
export const GRID_SIZES = Object.freeze([7, 9]);

export const WALL_LIMIT = Object.freeze({ MIN: 0, MAX: 50 });

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'dark',          // 'dark' | 'light'
  flipBoard: true,        // show the local player's pawn at the bottom
  gridSize: 7,            // host / vs-AI only
  wallLimit: 10,          // host / vs-AI only; null = unlimited
  aiDifficulty: 'medium', // 'easy' | 'medium' | 'hard'
});

/**
 * AI opponent strength. See src/ai/AIEngine.js for how each knob is used.
 *  maxDepth       – how many turns ahead the search looks (backtracking depth)
 *  timeMs         – thinking budget; iterative deepening stops when it runs out
 *  wallCandidates – how many wall slots are considered per position
 *  wallSpread     – also try walls that extend / flank the blocking spot
 *  noise          – random ± added to root scores (makes weaker levels err)
 *  wallBias       – score adjustment for walls at the root (negative = reluctant)
 */
export const AI_LEVELS = Object.freeze({
  easy: Object.freeze({ label: 'Easy', maxDepth: 1, timeMs: 250, wallCandidates: 4, wallSpread: false, noise: 2.2, wallBias: -0.9 }),
  medium: Object.freeze({ label: 'Medium', maxDepth: 2, timeMs: 900, wallCandidates: 14, wallSpread: true, noise: 0.4, wallBias: 0 }),
  hard: Object.freeze({ label: 'Hard', maxDepth: 4, timeMs: 1800, wallCandidates: 28, wallSpread: true, noise: 0, wallBias: 0 }),
});

/** Minimum time the AI "thinks" so its moves don't appear instantly. */
export const AI_MIN_THINK_MS = 450;

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
  AI_SESSION: 'wallrace.aiSession',
});
