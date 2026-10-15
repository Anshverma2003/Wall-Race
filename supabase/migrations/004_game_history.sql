-- =====================================================================
-- Wall Race – migration 004: game history ("My games")
--
-- Run once in Supabase → SQL Editor → New query → Run, AFTER 003 and
-- BEFORE deploying the code that uses it. Safe to run again.
--
--  * online_matches now also stores the verified move list and the setup
--    needed to replay a game (wall limit, who started).
--  * my_games(code) lists a player's 50 most recent online games and
--    my_game(code, id) returns one of them for replay. Both only return
--    games of the player owning the recovery code (history is private).
-- =====================================================================

alter table public.online_matches add column if not exists moves_list      jsonb;     -- verified history, null for games before 004
alter table public.online_matches add column if not exists wall_limit      smallint;  -- null = unlimited (only meaningful with moves_list)
alter table public.online_matches add column if not exists starting_player smallint;

create index if not exists online_matches_p0_time_idx on public.online_matches (p0, created_at desc);
create index if not exists online_matches_p1_time_idx on public.online_matches (p1, created_at desc);

-- New signatures (extra replay data) replace the 003 versions.
drop function if exists public.submit_online_report(uuid, uuid, text, uuid, uuid, smallint, integer, smallint, text, integer);
drop function if exists public._finalize_online_match(uuid, uuid, uuid, smallint, integer, smallint, text);

-- Elo update (K = 32) + stats + match record, exactly once. Internal helper.
create or replace function public._finalize_online_match(
  p_match_id uuid, p_p0 uuid, p_p1 uuid, p_winner smallint, p_moves integer, p_grid smallint, p_reason text,
  p_history jsonb default null, p_wall_limit smallint default null, p_starting smallint default null
)
returns json language plpgsql volatile security definer
set search_path = public as $$
declare
  r0 integer;
  r1 integer;
  e0 numeric;
  d  integer;
begin
  perform 1 from public.players where id in (p_p0, p_p1) order by id for update;
  select rating into r0 from public.players where id = p_p0;
  select rating into r1 from public.players where id = p_p1;
  if r0 is null or r1 is null then raise exception 'NOT_A_PLAYER'; end if;

  e0 := 1 / (1 + power(10::numeric, (r1 - r0) / 400.0));
  d  := round(32 * ((case when p_winner = 0 then 1 else 0 end) - e0));

  update public.players set
    rating      = rating + d,
    games       = games + 1,
    wins        = wins + (p_winner = 0)::int,
    losses      = losses + (p_winner = 1)::int,
    streak      = case when p_winner = 0 then streak + 1 else 0 end,
    best_streak = greatest(best_streak, case when p_winner = 0 then streak + 1 else 0 end),
    last_active = now()
  where id = p_p0;

  update public.players set
    rating      = rating - d,
    games       = games + 1,
    wins        = wins + (p_winner = 1)::int,
    losses      = losses + (p_winner = 0)::int,
    streak      = case when p_winner = 1 then streak + 1 else 0 end,
    best_streak = greatest(best_streak, case when p_winner = 1 then streak + 1 else 0 end),
    last_active = now()
  where id = p_p1;

  insert into public.online_matches
    (id, p0, p1, winner, moves, grid_size, end_reason,
     p0_rating_before, p1_rating_before, p0_rating_after, p1_rating_after,
     moves_list, wall_limit, starting_player)
  values
    (p_match_id, p_p0, p_p1, p_winner, p_moves, p_grid, p_reason, r0, r1, r0 + d, r1 - d,
     p_history, p_wall_limit, p_starting);

  return json_build_object('status', 'recorded',
                           'ratings', json_build_array(r0 + d, r1 - d),
                           'deltas', json_build_array(d, -d));
end $$;

-- Called by /api/report after it replayed and verified the game (same rules
-- as 003, plus the verified move list for the history).
create or replace function public.submit_online_report(
  p_match_id uuid, p_reporter uuid, p_payload_hash text,
  p_p0 uuid, p_p1 uuid, p_winner smallint, p_moves integer, p_grid smallint,
  p_reason text default 'goal', p_loser_moves integer default null,
  p_history jsonb default null, p_wall_limit smallint default null, p_starting smallint default null
)
returns json language plpgsql volatile security definer
set search_path = public as $$
declare
  v_match  public.online_matches;
  v_start  public.online_match_starts;
  v_loser  uuid;
  v_seen   timestamptz;
  v_mine   text;
  v_theirs text;
begin
  if p_reporter not in (p_p0, p_p1) or p_p0 = p_p1 then raise exception 'NOT_A_PLAYER'; end if;
  if p_reason not in ('goal', 'timeout', 'forfeit') then raise exception 'INVALID_RESULT'; end if;

  -- Serialise all reports of the same match.
  perform pg_advisory_xact_lock(hashtextextended(p_match_id::text, 0));

  select * into v_match from public.online_matches where id = p_match_id;
  if found then
    return json_build_object(
      'status', 'recorded',
      'ratings', json_build_array(v_match.p0_rating_after, v_match.p1_rating_after),
      'deltas', json_build_array(v_match.p0_rating_after - v_match.p0_rating_before,
                                 v_match.p1_rating_after - v_match.p1_rating_before));
  end if;

  if p_reason = 'forfeit' then
    -- One report is enough, for a game both players confirmed starting.
    select * into v_start from public.online_match_starts where match_id = p_match_id;
    if not found or v_start.p0 <> p_p0 or v_start.p1 <> p_p1
       or not (v_start.p0_confirmed and v_start.p1_confirmed) then
      return json_build_object('status', 'unverified');
    end if;
    -- Early leave (no move yet, game under 10 s old): cancelled, nobody's rating changes.
    if coalesce(p_loser_moves, 0) = 0 and now() - v_start.created_at < interval '10 seconds' then
      return json_build_object('status', 'cancelled');
    end if;
    -- Claimed by the winner: the accused must really be gone (no heartbeat for 45 s).
    v_loser := case when p_winner = 0 then p_p1 else p_p0 end;
    if p_reporter <> v_loser then
      v_seen := case when v_loser = v_start.p0 then v_start.p0_seen_at else v_start.p1_seen_at end;
      if v_seen is not null and v_seen > now() - interval '45 seconds' then
        return json_build_object('status', 'opponent_active');
      end if;
    end if;
    return public._finalize_online_match(p_match_id, p_p0, p_p1, p_winner, p_moves, p_grid, p_reason,
                                         p_history, p_wall_limit, p_starting);
  end if;

  -- Won on the board or on time: both players must report the identical game.
  insert into public.match_reports (match_id, reporter, payload_hash)
  values (p_match_id, p_reporter, p_payload_hash)
  on conflict (match_id, reporter) do nothing;

  select payload_hash into v_mine from public.match_reports where match_id = p_match_id and reporter = p_reporter;
  select payload_hash into v_theirs from public.match_reports
  where match_id = p_match_id and reporter = case when p_reporter = p_p0 then p_p1 else p_p0 end;

  if v_theirs is null then return json_build_object('status', 'waiting'); end if;
  if v_theirs <> v_mine then return json_build_object('status', 'mismatch'); end if;

  return public._finalize_online_match(p_match_id, p_p0, p_p1, p_winner, p_moves, p_grid, p_reason,
                                       p_history, p_wall_limit, p_starting);
end $$;

-- Browser → database (publishable key): my 50 most recent online games.
create or replace function public.my_games(p_code text, p_limit integer default 50)
returns table (
  match_id uuid, played_at timestamptz, my_index smallint, won boolean, end_reason text,
  opponent_name text, opponent_tag text, rating_before integer, rating_after integer,
  moves integer, grid_size smallint, can_replay boolean
)
language plpgsql stable security definer
set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_player uuid;
begin
  select p.id into v_player from public.players p where p.secret_hash = public._secret_hash(p_code);
  if v_player is null then raise exception 'BAD_CODE'; end if;

  return query
  select m.id,
         m.created_at,
         (case when m.p0 = v_player then 0 else 1 end)::smallint,
         m.winner = (case when m.p0 = v_player then 0 else 1 end),
         m.end_reason,
         o.name,
         o.tag,
         case when m.p0 = v_player then m.p0_rating_before else m.p1_rating_before end,
         case when m.p0 = v_player then m.p0_rating_after else m.p1_rating_after end,
         m.moves,
         m.grid_size,
         m.moves_list is not null
  from public.online_matches m
  join public.players o on o.id = case when m.p0 = v_player then m.p1 else m.p0 end
  where v_player in (m.p0, m.p1)
  order by m.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 50);
end $$;

-- Browser → database: one of my games, with everything needed to replay it.
create or replace function public.my_game(p_code text, p_match_id uuid)
returns json language plpgsql stable security definer
set search_path = public, extensions as $$
declare
  v_player uuid;
  v_m      public.online_matches;
  v_a      public.players;
  v_b      public.players;
begin
  select id into v_player from public.players where secret_hash = public._secret_hash(p_code);
  if v_player is null then raise exception 'BAD_CODE'; end if;

  select * into v_m from public.online_matches where id = p_match_id and v_player in (p0, p1);
  if not found then raise exception 'NOT_FOUND'; end if;
  select * into v_a from public.players where id = v_m.p0;
  select * into v_b from public.players where id = v_m.p1;

  return json_build_object(
    'match_id', v_m.id,
    'played_at', v_m.created_at,
    'my_index', case when v_m.p0 = v_player then 0 else 1 end,
    'winner', v_m.winner,
    'end_reason', v_m.end_reason,
    'grid_size', v_m.grid_size,
    'wall_limit', v_m.wall_limit,
    'starting_player', v_m.starting_player,
    'history', v_m.moves_list,
    'players', json_build_array(
      json_build_object('name', v_a.name, 'tag', v_a.tag, 'rating_before', v_m.p0_rating_before, 'rating_after', v_m.p0_rating_after),
      json_build_object('name', v_b.name, 'tag', v_b.tag, 'rating_before', v_m.p1_rating_before, 'rating_after', v_m.p1_rating_after)
    )
  );
end $$;

revoke execute on function
  public._finalize_online_match(uuid, uuid, uuid, smallint, integer, smallint, text, jsonb, smallint, smallint),
  public.submit_online_report(uuid, uuid, text, uuid, uuid, smallint, integer, smallint, text, integer, jsonb, smallint, smallint),
  public.my_games(text, integer),
  public.my_game(text, uuid)
from public, anon, authenticated;

grant execute on function
  public.submit_online_report(uuid, uuid, text, uuid, uuid, smallint, integer, smallint, text, integer, jsonb, smallint, smallint)
to service_role;

grant execute on function
  public.my_games(text, integer),
  public.my_game(text, uuid)
to anon, authenticated;

notify pgrst, 'reload schema';
