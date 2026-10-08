import { SUPABASE } from '../config.js';

/**
 * Error from a Supabase call. `code` is one of the codes raised by
 * supabase/schema.sql (TAG_TAKEN, BAD_CODE, …) or NETWORK / SERVER.
 */
export class SupabaseError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

/**
 * Calls the public RPC functions with the publishable key. Browsers cannot
 * read or write tables directly – only these functions are granted to them.
 */
export class SupabaseService {
  async rpc(name, args = {}) {
    let res;
    try {
      res = await fetch(`${SUPABASE.URL}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE.PUBLISHABLE_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(args),
      });
    } catch {
      throw new SupabaseError('NETWORK', 'Could not reach the server.');
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      // Our functions raise their error code as the message (e.g. "TAG_TAKEN").
      const message = data?.message ?? '';
      const code = /^[A-Z_]+$/.test(message) ? message : 'SERVER';
      throw new SupabaseError(code, message || `Server error ${res.status}`);
    }
    return data;
  }

  tagAvailable(tag) {
    return this.rpc('tag_available', { p_tag: tag });
  }

  createPlayer(name, tag) {
    return this.rpc('create_player', { p_name: name, p_tag: tag });
  }

  getPlayer(code) {
    return this.rpc('get_player', { p_code: code });
  }

  updatePlayer(code, name, tag) {
    return this.rpc('update_player', { p_code: code, p_name: name, p_tag: tag });
  }

  playerCards(ids) {
    return this.rpc('player_cards', { p_ids: ids });
  }

  leaderboardOnline(limit, playerId) {
    return this.rpc('leaderboard_online', { p_limit: limit, p_player: playerId ?? null });
  }

  leaderboardAi(period, limit, playerId) {
    return this.rpc('leaderboard_ai', { p_period: period, p_limit: limit, p_player: playerId ?? null });
  }
}
