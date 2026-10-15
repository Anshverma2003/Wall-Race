/**
 * POST /api/report – a player's browser reports a finished game.
 *
 * Headers:  Authorization: Bearer <recovery code>
 * Body:     { kind: 'online-start', matchId, players: [p0Id, p1Id] }
 *        or { kind: 'online', matchId, players: [p0Id, p1Id], game, result: { reason, winner } }
 *        or { kind: 'ai', gameId, difficulty: 'hard', seed, game }
 *           (`game` is GameModel.toJSON(), including the full move history)
 *
 * The game is replayed with the real rules (and, for AI games, the real AI)
 * before anything is written. Online games won on the board or on time count
 * only when both players' browsers report the identical game. A forfeit
 * (left / disconnected) counts on one report, but only for a game both
 * players confirmed starting ('online-start').
 */
import { playerIdForSecretHash, rpc } from './_lib/db.js';
import { secretHash, sha256Hex, verifyAiWin, verifyOnline, verifyOnlineStart, VerifyError } from './_lib/verify.js';

export const maxDuration = 30;

const MAX_BODY_BYTES = 64 * 1024;

const json = (status, data) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export async function POST(request) {
  try {
    const code = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!code) return json(401, { error: 'Missing player code.' });

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'Report too large.' });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: 'Invalid JSON.' });
    }

    const playerId = await playerIdForSecretHash(await secretHash(code));
    if (!playerId) return json(401, { error: 'Unknown player.' });

    if (body?.kind === 'online-start') {
      const start = verifyOnlineStart(body);
      if (!start.players.includes(playerId)) return json(403, { error: 'You are not in this game.' });
      const result = await rpc('register_online_start', {
        p_match_id: start.matchId,
        p_reporter: playerId,
        p_p0: start.players[0],
        p_p1: start.players[1],
      });
      return json(200, result);
    }

    if (body?.kind === 'online') {
      const report = verifyOnline(body);
      if (!report.players.includes(playerId)) return json(403, { error: 'You did not play in this game.' });
      const result = await rpc('submit_online_report', {
        p_match_id: report.matchId,
        p_reporter: playerId,
        p_payload_hash: await sha256Hex(report.canonical),
        p_p0: report.players[0],
        p_p1: report.players[1],
        p_winner: report.winner,
        p_moves: report.moves,
        p_grid: report.grid,
        p_reason: report.reason,
        p_loser_moves: report.loserMoves,
        // stored with the match so players can replay it later ("My games")
        p_history: report.history,
        p_wall_limit: report.wallLimit,
        p_starting: report.startingPlayer,
      });
      return json(200, result);
    }

    if (body?.kind === 'ai') {
      const win = verifyAiWin(body);
      const result = await rpc('record_ai_win', {
        p_game_id: win.gameId,
        p_player: playerId,
        p_moves: win.moves,
        p_walls: win.walls,
        p_grid: win.grid,
      });
      return json(200, result);
    }

    return json(400, { error: 'Unknown report kind.' });
  } catch (err) {
    if (err instanceof VerifyError) return json(422, { error: err.message });
    console.error('[api/report]', err);
    return json(err.status || 500, { error: 'Server error.' });
  }
}
