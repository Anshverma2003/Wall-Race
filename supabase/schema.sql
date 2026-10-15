-- =====================================================================
-- Wall Race – leaderboard & player profiles
--
-- Run this whole file once in Supabase → SQL Editor → New query → Run.
-- It is safe to run again: it only creates / replaces objects.
--
-- Security model
--  * Browsers use the PUBLISHABLE key. They can only call the RPC
--    functions granted to `anon` below (create / read / update their own
--    profile, read leaderboards). They cannot touch any table directly.
--  * Game results are written only by the Vercel function /api/report,
--    which uses the SECRET key (service_role) after replaying the game.
--  * A player is identified by a secret recovery code (no login). Only a
--    SHA-256 hash of it is stored.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------------- tables

create table if not exists public.players (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  tag            text not null,
  secret_hash    text not null unique,
  rating         integer not null default 1200,
  games          integer not null default 0,
  wins           integer not null default 0,
  losses         integer not null default 0,
  streak         integer not null default 0,
  best_streak    integer not null default 0,
  tag_changed_at timestamptz,
  created_at     timestamptz not null default now(),
  last_active    timestamptz not null default now(),
  constraint players_tag_unique unique (tag),
  constraint players_tag_format check (tag ~ '^[0-9]{4}$'),
  constraint players_name_format check (
    char_length(name) between 3 and 16
    and name ~ '^[A-Za-z0-9_-]+( [A-Za-z0-9_-]+)*$'
  )
);

create index if not exists players_rating_idx on public.players (rating desc) where games > 0;

-- Profile creations per IP, for a simple anti-spam limit (tags are scarce).
create table if not exists public.signup_log (
  ip         text not null,
  created_at timestamptz not null default now()
);
create index if not exists signup_log_ip_idx on public.signup_log (ip, created_at);

-- One row per finished, verified online game.
create table if not exists public.online_matches (
  id               uuid primary key,
  p0               uuid not null references public.players (id) on delete cascade,
  p1               uuid not null references public.players (id) on delete cascade,
  winner           smallint not null check (winner in (0, 1)),
  moves            integer not null,
  grid_size        smallint not null,
  p0_rating_before integer not null,
  p1_rating_before integer not null,
  p0_rating_after  integer not null,
  p1_rating_after  integer not null,
  end_reason       text not null default 'goal',   -- goal | timeout | forfeit
  moves_list       jsonb,      -- verified move history (null for games before migration 004)
  wall_limit       smallint,   -- null = unlimited (only meaningful with moves_list)
  starting_player  smallint,
  created_at       timestamptz not null default now()
);
alter table public.online_matches add column if not exists moves_list      jsonb;
alter table public.online_matches add column if not exists wall_limit      smallint;
alter table public.online_matches add column if not exists starting_player smallint;
create index if not exists online_matches_p0_time_idx on public.online_matches (p0, created_at desc);
create index if not exists online_matches_p1_time_idx on public.online_matches (p1, created_at desc);

-- Each player's browser reports the finished game; it counts once both agree.
create table if not exists public.match_reports (
  match_id     uuid not null,
  reporter     uuid not null references public.players (id) on delete cascade,
  payload_hash text not null,
  created_at   timestamptz not null default now(),
  primary key (match_id, reporter)
);

-- One row per verified win against the Hard AI.
create table if not exists public.ai_wins (
  id         uuid primary key,
  player_id  uuid not null references public.players (id) on delete cascade,
  difficulty text not null check (difficulty = 'hard'),
  moves      integer not null,          -- the player's own actions in that game
  walls_used integer not null,
  grid_size  smallint not null,
  created_at timestamptz not null default now()
);
create index if not exists ai_wins_time_idx on public.ai_wins (created_at);
create index if not exists ai_wins_player_idx on public.ai_wins (player_id);

-- Lock every table: no direct access for browsers (service_role bypasses RLS).
alter table public.players        enable row level security;
alter table public.signup_log     enable row level security;
alter table public.online_matches enable row level security;
alter table public.match_reports  enable row level security;
alter table public.ai_wins        enable row level security;
revoke all on public.players, public.signup_log, public.online_matches, public.match_reports, public.ai_wins
  from anon, authenticated;

-- ------------------------------------------------------------ helpers

create or replace function public._secret_hash(p_code text)
returns text language sql immutable
set search_path = public, extensions as $$
  select encode(digest(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex')
$$;

-- WR-XXXX-XXXX-XXXX-XXXX from an unambiguous 32-letter alphabet (80 random bits).
create or replace function public._new_recovery_code()
returns text language plpgsql volatile
set search_path = public, extensions as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := gen_random_bytes(16);
  result text := 'WR';
begin
  for i in 0..15 loop
    if i % 4 = 0 then result := result || '-'; end if;
    result := result || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return result;
end $$;

create or replace function public._clean_name(p_name text)
returns text language sql immutable as $$
  select regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')
$$;

create or replace function public._valid_name(p_name text)
returns boolean language sql immutable as $$
  select char_length(p_name) between 3 and 16 and p_name ~ '^[A-Za-z0-9_-]+( [A-Za-z0-9_-]+)*$'
$$;

create or replace function public._player_json(p public.players)
returns json language sql stable as $$
  select json_build_object(
    'id', p.id,
    'name', p.name,
    'tag', p.tag,
    'rating', p.rating,
    'games', p.games,
    'wins', p.wins,
    'losses', p.losses,
    'streak', p.streak,
    'best_streak', p.best_streak,
    'tag_changed_at', p.tag_changed_at,
    'tag_unlocks_at', p.tag_changed_at + interval '30 days',
    'created_at', p.created_at
  )
$$;

-- Best-effort client IP from the API gateway headers (null if unknown).
create or replace function public._client_ip()
returns text language sql stable as $$
  select nullif(btrim(coalesce(
    h ->> 'cf-connecting-ip',
    split_part(h ->> 'x-forwarded-for', ',', 1),
    h ->> 'x-real-ip'
  )), '')
  from (select coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json as h) s
$$;

-- --------------------------------------------- profile API (browsers)

-- Errors are raised as plain codes the app translates:
--   INVALID_NAME, INVALID_TAG, TAG_TAKEN, TAG_LOCKED, BAD_CODE, RATE_LIMIT

create or replace function public.tag_available(p_tag text)
returns boolean language sql stable security definer
set search_path = public as $$
  select p_tag ~ '^[0-9]{4}$' and not exists (select 1 from public.players where tag = p_tag)
$$;

create or replace function public.create_player(p_name text, p_tag text)
returns json language plpgsql volatile security definer
set search_path = public, extensions as $$
declare
  v_name text := public._clean_name(p_name);
  v_ip   text := public._client_ip();
  v_code text;
  v_row  public.players;
begin
  if not public._valid_name(v_name) then raise exception 'INVALID_NAME'; end if;
  if coalesce(p_tag, '') !~ '^[0-9]{4}$' then raise exception 'INVALID_TAG'; end if;

  if v_ip is not null and (
    select count(*) from public.signup_log where ip = v_ip and created_at > now() - interval '1 hour'
  ) >= 10 then
    raise exception 'RATE_LIMIT';
  end if;

  v_code := public._new_recovery_code();
  begin
    insert into public.players (name, tag, secret_hash)
    values (v_name, p_tag, public._secret_hash(v_code))
    returning * into v_row;
  exception when unique_violation then
    raise exception 'TAG_TAKEN';
  end;

  if v_ip is not null then insert into public.signup_log (ip) values (v_ip); end if;

  -- The recovery code is returned exactly once; only its hash is stored.
  return (public._player_json(v_row)::jsonb || jsonb_build_object('code', v_code))::json;
end $$;

-- Read your own profile (also used to restore it on a new device).
create or replace function public.get_player(p_code text)
returns json language plpgsql volatile security definer
set search_path = public, extensions as $$
declare
  v_row public.players;
begin
  update public.players set last_active = now()
  where secret_hash = public._secret_hash(p_code)
  returning * into v_row;
  if not found then raise exception 'BAD_CODE'; end if;
  return public._player_json(v_row);
end $$;

-- Change your name (any time) and/or tag (once every 30 days).
create or replace function public.update_player(p_code text, p_name text, p_tag text)
returns json language plpgsql volatile security definer
set search_path = public, extensions as $$
declare
  v_row  public.players;
  v_name text := public._clean_name(p_name);
begin
  select * into v_row from public.players where secret_hash = public._secret_hash(p_code) for update;
  if not found then raise exception 'BAD_CODE'; end if;
  if not public._valid_name(v_name) then raise exception 'INVALID_NAME'; end if;

  if p_tag is not null and p_tag <> v_row.tag then
    if p_tag !~ '^[0-9]{4}$' then raise exception 'INVALID_TAG'; end if;
    if v_row.tag_changed_at is not null and v_row.tag_changed_at > now() - interval '30 days' then
      raise exception 'TAG_LOCKED';
    end if;
    begin
      update public.players set tag = p_tag, tag_changed_at = now() where id = v_row.id;
    exception when unique_violation then
      raise exception 'TAG_TAKEN';
    end;
  end if;

  update public.players set name = v_name, last_active = now()
  where id = v_row.id
  returning * into v_row;
  return public._player_json(v_row);
end $$;

-- Public player cards (no secrets) – used to show an opponent's name and rating.
create or replace function public.player_cards(p_ids uuid[])
returns table (id uuid, name text, tag text, rating integer, games integer, wins integer)
language sql stable security definer
set search_path = public as $$
  select id, name, tag, rating, games, wins from public.players where id = any (p_ids[1:10])
$$;

-- ------------------------------------------------ leaderboards (browsers)

-- Top N by rating, plus the given player's own row wherever they rank.
create or replace function public.leaderboard_online(p_limit integer default 50, p_player uuid default null)
returns table (
  rank bigint, player_id uuid, name text, tag text, rating integer,
  games integer, wins integer, losses integer, streak integer, best_streak integer, last_active timestamptz
)
language sql stable security definer
set search_path = public as $$
  with ranked as (
    select rank() over (order by p.rating desc, p.wins desc) as rank,
           p.id as player_id, p.name, p.tag, p.rating, p.games, p.wins, p.losses,
           p.streak, p.best_streak, p.last_active
    from public.players p
    where p.games > 0
  )
  select * from ranked
  where rank <= least(greatest(coalesce(p_limit, 50), 1), 100) or player_id = p_player
  order by rank, name
$$;

-- Wins against the Hard AI in a period ('week' = last 7 days, 'month' = last 30 days, 'all').
create or replace function public.leaderboard_ai(p_period text default 'all', p_limit integer default 50, p_player uuid default null)
returns table (
  rank bigint, player_id uuid, name text, tag text,
  hard_wins bigint, fastest integer, fastest_grid smallint, last_win timestamptz
)
language sql stable security definer
set search_path = public as $$
  with w as (
    select * from public.ai_wins
    where coalesce(p_period, 'all') = 'all'
       or (p_period = 'week'  and created_at >= now() - interval '7 days')
       or (p_period = 'month' and created_at >= now() - interval '30 days')
  ), agg as (
    select player_id,
           count(*) as hard_wins,
           (array_agg(moves     order by moves, grid_size, created_at))[1] as fastest,
           (array_agg(grid_size order by moves, grid_size, created_at))[1] as fastest_grid,
           max(created_at) as last_win
    from w
    group by player_id
  ), ranked as (
    select rank() over (order by a.hard_wins desc, a.fastest asc) as rank,
           a.player_id, p.name, p.tag, a.hard_wins, a.fastest, a.fastest_grid, a.last_win
    from agg a
    join public.players p on p.id = a.player_id
  )
  select * from ranked
  where rank <= least(greatest(coalesce(p_limit, 50), 1), 100) or player_id = p_player
  order by rank, name
$$;

-- ------------------------------------ result recording (server only)

alter table public.online_matches add column if not exists end_reason text not null default 'goal';

-- Both players' browsers confirm a game started (used to accept forfeits).
create table if not exists public.online_match_starts (
  match_id     uuid primary key,
  p0           uuid not null references public.players (id) on delete cascade,
  p1           uuid not null references public.players (id) on delete cascade,
  p0_confirmed boolean not null default false,
  p1_confirmed boolean not null default false,
  p0_seen_at   timestamptz,          -- last "still here" heartbeat
  p1_seen_at   timestamptz,
  created_at   timestamptz not null default now()
);
alter table public.online_match_starts enable row level security;
revoke all on public.online_match_starts from anon, authenticated;

alter table public.online_match_starts add column if not exists p0_seen_at timestamptz;
alter table public.online_match_starts add column if not exists p1_seen_at timestamptz;

-- Browser → database (publishable key): "I'm still in this game".
create or replace function public.match_heartbeat(p_code text, p_match_id uuid)
returns json language plpgsql volatile security definer
set search_path = public, extensions as $$
declare
  v_player uuid;
begin
  select id into v_player from public.players where secret_hash = public._secret_hash(p_code);
  if v_player is null then raise exception 'BAD_CODE'; end if;

  update public.online_match_starts set
    p0_seen_at = case when p0 = v_player then now() else p0_seen_at end,
    p1_seen_at = case when p1 = v_player then now() else p1_seen_at end
  where match_id = p_match_id and v_player in (p0, p1);

  return json_build_object('status', case when found then 'ok' else 'unknown' end);
end $$;

-- Starting a game also counts as being seen.
create or replace function public.register_online_start(
  p_match_id uuid, p_reporter uuid, p_p0 uuid, p_p1 uuid
)
returns json language plpgsql volatile security definer
set search_path = public as $$
declare
  v_start public.online_match_starts;
begin
  if p_reporter not in (p_p0, p_p1) or p_p0 = p_p1 then raise exception 'NOT_A_PLAYER'; end if;

  insert into public.online_match_starts (match_id, p0, p1)
  values (p_match_id, p_p0, p_p1)
  on conflict (match_id) do nothing;

  update public.online_match_starts set
    p0_confirmed = p0_confirmed or p_reporter = p0,
    p1_confirmed = p1_confirmed or p_reporter = p1,
    p0_seen_at   = case when p_reporter = p0 then now() else p0_seen_at end,
    p1_seen_at   = case when p_reporter = p1 then now() else p1_seen_at end
  where match_id = p_match_id and p0 = p_p0 and p1 = p_p1
  returning * into v_start;

  if not found then return json_build_object('status', 'mismatch'); end if;
  return json_build_object('status', case when v_start.p0_confirmed and v_start.p1_confirmed then 'confirmed' else 'waiting' end);
end $$;

-- Older signatures (before 003 / 004) are replaced.
drop function if exists public.submit_online_report(uuid, uuid, text, uuid, uuid, smallint, integer, smallint);
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


-- Only the server (service_role) may record results.
revoke execute on function
  public.register_online_start(uuid, uuid, uuid, uuid),
  public._finalize_online_match(uuid, uuid, uuid, smallint, integer, smallint, text, jsonb, smallint, smallint),
  public.submit_online_report(uuid, uuid, text, uuid, uuid, smallint, integer, smallint, text, integer, jsonb, smallint, smallint)
from public, anon, authenticated;

grant execute on function
  public.register_online_start(uuid, uuid, uuid, uuid),
  public.submit_online_report(uuid, uuid, text, uuid, uuid, smallint, integer, smallint, text, integer, jsonb, smallint, smallint)
to service_role;


-- Called by /api/report after it replayed the game against the Hard AI.
create or replace function public.record_ai_win(
  p_game_id uuid, p_player uuid, p_moves integer, p_walls integer, p_grid smallint
)
returns json language plpgsql volatile security definer
set search_path = public as $$
declare
  v_inserted integer;
begin
  insert into public.ai_wins (id, player_id, difficulty, moves, walls_used, grid_size)
  values (p_game_id, p_player, 'hard', p_moves, p_walls, p_grid)
  on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;
  update public.players set last_active = now() where id = p_player;
  return json_build_object(
    'status', case when v_inserted = 1 then 'recorded' else 'duplicate' end,
    'hard_wins', (select count(*) from public.ai_wins where player_id = p_player));
end $$;

-- ------------------------------------------------------------ grants

revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.tag_available(text),
  public.create_player(text, text),
  public.get_player(text),
  public.update_player(text, text, text),
  public.player_cards(uuid[]),
  public.leaderboard_online(integer, uuid),
  public.leaderboard_ai(text, integer, uuid),
  public.match_heartbeat(text, uuid),
  public.my_games(text, integer),
  public.my_game(text, uuid)
to anon, authenticated;

grant execute on function
  public.register_online_start(uuid, uuid, uuid, uuid),
  public.submit_online_report(uuid, uuid, text, uuid, uuid, smallint, integer, smallint, text, integer, jsonb, smallint, smallint),
  public.record_ai_win(uuid, uuid, integer, integer, smallint)
to service_role;

-- Make the API see new / changed functions right away.
notify pgrst, 'reload schema';
