/**
 * POST /api/report – a player's browser reports a finished game.
 *
 * Headers:  Authorization: Bearer <recovery code>
 * Body:     { kind: 'online', matchId, players: [p0Id, p1Id], game }
 *        or { kind: 'ai', gameId, difficulty: 'hard', seed, game }
 *           (`game` is GameModel.toJSON(), including the full move history)
 *
 * The game is replayed with the real rules (and, for AI games, the real AI)
 * before anything is written. Online games count only when both players'
 * browsers report the identical game.
 */
import { playerIdForSecretHash, rpc } from './_lib/db.js';
import { secretHash, sha256Hex, verifyAiWin, verifyOnline, VerifyError } from './_lib/verify.js';

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
