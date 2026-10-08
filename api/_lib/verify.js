/**
 * Server-side verification of reported games. Pure functions (no I/O) so they
 * can be unit-tested in a browser too.
 *
 * A report is only trusted after the full move list has been replayed through
 * the same GameModel the game uses. For games against the AI, every AI move is
 * also recomputed with the game's seed and must match exactly.
 */
import { chooseAction, seededRandom } from '../../src/ai/AIEngine.js';
import { GRID_SIZES, WALL_LIMIT } from '../../src/config.js';
import { GameModel } from '../../src/models/GameModel.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PLIES = 600;

export class VerifyError extends Error {}

const fail = (msg) => {
  throw new VerifyError(msg);
};

export const isUuid = (v) => typeof v === 'string' && UUID.test(v);

/** Validates the starting setup and normalises the move list. */
function readGame(game) {
  if (!game || typeof game !== 'object') fail('Missing game.');
  const { size, wallLimit, startingPlayer, history } = game;
  if (!GRID_SIZES.includes(size)) fail('Invalid grid size.');
  if (wallLimit !== null && !(Number.isInteger(wallLimit) && wallLimit >= WALL_LIMIT.MIN && wallLimit <= WALL_LIMIT.MAX)) {
    fail('Invalid wall limit.');
  }
  if (startingPlayer !== 0 && startingPlayer !== 1) fail('Invalid starting player.');
  if (!Array.isArray(history) || history.length === 0 || history.length > MAX_PLIES) fail('Invalid move list.');

  const moves = history.map((h) => {
    if (!h || (h.by !== 0 && h.by !== 1) || !Number.isInteger(h.r) || !Number.isInteger(h.c)) fail('Invalid move.');
    if (h.kind === 'move') return { by: h.by, kind: 'move', r: h.r, c: h.c };
    if (h.kind === 'wall' && (h.o === 'h' || h.o === 'v')) return { by: h.by, kind: 'wall', o: h.o, r: h.r, c: h.c };
    return fail('Invalid move.');
  });
  return { size, wallLimit, startingPlayer, history: moves };
}

/**
 * Replays a game from the start. `check(game, entry, ply)` runs before each
 * action (used to recompute AI moves). Throws VerifyError if anything is off.
 * @returns {GameModel} the finished game
 */
export function replay(setup, check) {
  const game = new GameModel({ size: setup.size, wallLimit: setup.wallLimit, startingPlayer: setup.startingPlayer });
  setup.history.forEach((entry, ply) => {
    if (game.isOver) fail('Moves after the game ended.');
    if (entry.by !== game.turn) fail('Move played out of turn.');
    check?.(game, entry, ply);
    const { by, ...action } = entry;
    const result = game.applyAction(by, action);
    if (!result.ok) fail(`Illegal move at ply ${ply + 1}: ${result.reason}`);
  });
  if (!game.isOver) fail('The game is not finished.');
  return game;
}

const countOf = (history, by, kind) => history.filter((h) => h.by === by && (!kind || h.kind === kind)).length;

/**
 * Online game report.
 * @returns {{matchId:string, players:[string,string], winner:0|1, moves:number, grid:number, canonical:string}}
 */
export function verifyOnline(body) {
  const { matchId, players } = body ?? {};
  if (!isUuid(matchId)) fail('Invalid match id.');
  if (!Array.isArray(players) || players.length !== 2 || !players.every(isUuid) || players[0] === players[1]) {
    fail('Invalid players.');
  }
  const setup = readGame(body.game);
  const game = replay(setup);

  // Both players' reports must be byte-identical to count.
  const canonical = JSON.stringify({
    matchId: matchId.toLowerCase(),
    players: players.map((p) => p.toLowerCase()),
    size: setup.size,
    wallLimit: setup.wallLimit,
    startingPlayer: setup.startingPlayer,
    history: setup.history,
  });
  return { matchId, players, winner: game.winner, moves: setup.history.length, grid: setup.size, canonical };
}

/**
 * Win against the Hard AI (the human is always seat 0, the AI seat 1).
 * @returns {{gameId:string, moves:number, walls:number, grid:number}}
 */
export function verifyAiWin(body) {
  const { gameId, difficulty, seed } = body ?? {};
  if (!isUuid(gameId)) fail('Invalid game id.');
  if (difficulty !== 'hard') fail('Only wins against the Hard AI are ranked.');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) fail('Invalid seed.');

  const setup = readGame(body.game);
  const game = replay(setup, (current, entry, ply) => {
    if (entry.by !== 1) return;
    const { action } = chooseAction(current.toJSON(), 1, 'hard', seededRandom(seed, ply));
    const same = action.kind === entry.kind && action.r === entry.r && action.c === entry.c
      && (action.kind !== 'wall' || action.o === entry.o);
    if (!same) fail(`AI move ${ply + 1} does not match the real AI.`);
  });
  if (game.winner !== 0) fail('The player did not win this game.');

  return {
    gameId,
    moves: countOf(setup.history, 0),
    walls: countOf(setup.history, 0, 'wall'),
    grid: setup.size,
  };
}

/** SHA-256 as lowercase hex (Web Crypto: works in Node 20+ and browsers). */
export async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Same normalisation as public._secret_hash() in supabase/schema.sql. */
export function secretHash(code) {
  return sha256Hex(String(code ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase());
}
