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
 *  maxNodes       – search work budget; iterative deepening stops when it is used up.
 *                   A node count (not a clock) keeps moves identical on every device.
 *  wallCandidates – how many wall slots are considered per position
 *  wallSpread     – also try walls that extend / flank the blocking spot
 *  noise          – random ± added to root scores (makes weaker levels err)
 *  wallBias       – score adjustment for walls at the root (negative = reluctant)
 */
export const AI_LEVELS = Object.freeze({
  easy: Object.freeze({ label: 'Easy', maxDepth: 1, maxNodes: 500, wallCandidates: 4, wallSpread: false, noise: 2.2, wallBias: -0.9 }),
  medium: Object.freeze({ label: 'Medium', maxDepth: 2, maxNodes: 2000, wallCandidates: 14, wallSpread: true, noise: 0.4, wallBias: 0 }),
  hard: Object.freeze({ label: 'Hard', maxDepth: 4, maxNodes: 6000, wallCandidates: 28, wallSpread: true, noise: 0, wallBias: 0 }),
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
  PLAYER: 'wallrace.player',            // leaderboard profile: id, name, tag, recovery code
  PENDING_REPORTS: 'wallrace.pendingReports',
});

/**
 * Supabase (leaderboard + player profiles). The publishable key is meant to be
 * public: it can only call the functions granted to `anon` in supabase/schema.sql.
 * The secret key lives only in Vercel (SUPABASE_SECRET_KEY) and is used by /api/report.
 */
export const SUPABASE = Object.freeze({
  URL: 'https://lropqqaeqhotjawwcqaf.supabase.co',
  PUBLISHABLE_KEY: 'sb_publishable_c9hvopO0UG7c0cuFkfXgnA_rNPF4SL7',
});

/** Where finished games are sent for verification (Vercel function). */
export const REPORT_ENDPOINT = '/api/report';

/** Player identity rules – keep in sync with supabase/schema.sql. */
export const PLAYER_RULES = Object.freeze({
  NAME_MIN: 3,
  NAME_MAX: 16,
  NAME_PATTERN: /^[A-Za-z0-9_-]+( [A-Za-z0-9_-]+)*$/,
  TAG_PATTERN: /^[0-9]{4}$/,
  TAG_LOCK_DAYS: 30,
});

export const LEADERBOARD = Object.freeze({ LIMIT: 50 });
