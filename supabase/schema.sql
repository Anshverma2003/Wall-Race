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
  created_at       timestamptz not null default now()
);

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

-- Called by /api/report after it replayed and verified the game.
-- Stores this player's report; once BOTH players reported the same game,
-- updates Elo ratings (K = 32) and stats exactly once.
create or replace function public.submit_online_report(
  p_match_id uuid, p_reporter uuid, p_payload_hash text,
  p_p0 uuid, p_p1 uuid, p_winner smallint, p_moves integer, p_grid smallint
)
returns json language plpgsql volatile security definer
set search_path = public as $$
declare
  v_match  public.online_matches;
  v_mine   text;
  v_theirs text;
  r0 integer;
  r1 integer;
  e0 numeric;
  d  integer;
begin
  if p_reporter not in (p_p0, p_p1) or p_p0 = p_p1 then raise exception 'NOT_A_PLAYER'; end if;

  -- Serialise the two reports of the same match.
  perform pg_advisory_xact_lock(hashtextextended(p_match_id::text, 0));

  select * into v_match from public.online_matches where id = p_match_id;
  if found then
    return json_build_object(
      'status', 'recorded',
      'ratings', json_build_array(v_match.p0_rating_after, v_match.p1_rating_after),
      'deltas', json_build_array(v_match.p0_rating_after - v_match.p0_rating_before,
                                 v_match.p1_rating_after - v_match.p1_rating_before));
  end if;

  insert into public.match_reports (match_id, reporter, payload_hash)
  values (p_match_id, p_reporter, p_payload_hash)
  on conflict (match_id, reporter) do nothing;

  select payload_hash into v_mine from public.match_reports where match_id = p_match_id and reporter = p_reporter;
  select payload_hash into v_theirs from public.match_reports
  where match_id = p_match_id and reporter = case when p_reporter = p_p0 then p_p1 else p_p0 end;

  if v_theirs is null then return json_build_object('status', 'waiting'); end if;
  if v_theirs <> v_mine then return json_build_object('status', 'mismatch'); end if;

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
    (id, p0, p1, winner, moves, grid_size, p0_rating_before, p1_rating_before, p0_rating_after, p1_rating_after)
  values
    (p_match_id, p_p0, p_p1, p_winner, p_moves, p_grid, r0, r1, r0 + d, r1 - d);

  return json_build_object('status', 'recorded',
                           'ratings', json_build_array(r0 + d, r1 - d),
                           'deltas', json_build_array(d, -d));
end $$;

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
  public.leaderboard_ai(text, integer, uuid)
to anon, authenticated;

grant execute on function
  public.submit_online_report(uuid, uuid, text, uuid, uuid, smallint, integer, smallint),
  public.record_ai_win(uuid, uuid, integer, integer, smallint)
to service_role;
