-- =====================================================================
-- Wall Race – migration 002: chess clock results and forfeits
--
-- Run once in Supabase → SQL Editor → New query → Run.
-- Safe to run again. (A fresh install can run supabase/schema.sql instead,
-- which already contains these changes.)
--
-- What it changes
--  * Online games can now end on the board ('goal'), on time ('timeout') or
--    by forfeit ('forfeit' – a player left or did not reconnect in time).
--  * 'goal' and 'timeout' still need both players' identical reports.
--  * A forfeit counts on a single report, but only for a game both players
--    confirmed starting (online_match_starts). If the leaver had not moved
--    and the game was under 10 seconds old, it is cancelled instead.
-- =====================================================================

alter table public.online_matches add column if not exists end_reason text not null default 'goal';

-- Both players' browsers confirm a game started (used to accept forfeits).
create table if not exists public.online_match_starts (
  match_id     uuid primary key,
  p0           uuid not null references public.players (id) on delete cascade,
  p1           uuid not null references public.players (id) on delete cascade,
  p0_confirmed boolean not null default false,
  p1_confirmed boolean not null default false,
  created_at   timestamptz not null default now()
);
alter table public.online_match_starts enable row level security;
revoke all on public.online_match_starts from anon, authenticated;

-- Called by /api/report when a game starts (one call per player).
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
    p1_confirmed = p1_confirmed or p_reporter = p1
  where match_id = p_match_id and p0 = p_p0 and p1 = p_p1
  returning * into v_start;

  if not found then return json_build_object('status', 'mismatch'); end if;
  return json_build_object('status', case when v_start.p0_confirmed and v_start.p1_confirmed then 'confirmed' else 'waiting' end);
end $$;

-- Elo update (K = 32) + stats + match record, exactly once. Internal helper.
create or replace function public._finalize_online_match(
  p_match_id uuid, p_p0 uuid, p_p1 uuid, p_winner smallint, p_moves integer, p_grid smallint, p_reason text
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
     p0_rating_before, p1_rating_before, p0_rating_after, p1_rating_after)
  values
    (p_match_id, p_p0, p_p1, p_winner, p_moves, p_grid, p_reason, r0, r1, r0 + d, r1 - d);

  return json_build_object('status', 'recorded',
                           'ratings', json_build_array(r0 + d, r1 - d),
                           'deltas', json_build_array(d, -d));
end $$;

-- Replaces the previous version (it had no result reason).
drop function if exists public.submit_online_report(uuid, uuid, text, uuid, uuid, smallint, integer, smallint);

-- Called by /api/report after it replayed and verified the game.
create or replace function public.submit_online_report(
  p_match_id uuid, p_reporter uuid, p_payload_hash text,
  p_p0 uuid, p_p1 uuid, p_winner smallint, p_moves integer, p_grid smallint,
  p_reason text default 'goal', p_loser_moves integer default null
)
returns json language plpgsql volatile security definer
set search_path = public as $$
declare
  v_match  public.online_matches;
  v_start  public.online_match_starts;
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
    return public._finalize_online_match(p_match_id, p_p0, p_p1, p_winner, p_moves, p_grid, p_reason);
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

  return public._finalize_online_match(p_match_id, p_p0, p_p1, p_winner, p_moves, p_grid, p_reason);
end $$;

-- Only the server (service_role) may record results.
revoke execute on function
  public.register_online_start(uuid, uuid, uuid, uuid),
  public._finalize_online_match(uuid, uuid, uuid, smallint, integer, smallint, text),
  public.submit_online_report(uuid, uuid, text, uuid, uuid, smallint, integer, smallint, text, integer)
from public, anon, authenticated;

grant execute on function
  public.register_online_start(uuid, uuid, uuid, uuid),
  public.submit_online_report(uuid, uuid, text, uuid, uuid, smallint, integer, smallint, text, integer)
to service_role;

-- Make the API see the new functions right away.
notify pgrst, 'reload schema';
