-- =====================================================================
-- Wall Race – migration 003: "still here" heartbeat for forfeits
--
-- Run once in Supabase → SQL Editor → New query → Run, AFTER 002.
-- Safe to run again. (A fresh install can run supabase/schema.sql instead.)
--
-- Closes a hole in 002: a player could send a hand-made report claiming
-- "my opponent left" while the opponent was still playing.
--
-- Now each player's browser pings the server every 15 s during an online
-- game (signed with their own recovery code, so nobody can ping for
-- someone else). A forfeit claimed by the winner only counts if the
-- accused player has been silent for at least 45 s. A player reporting
-- their own loss (Leave button) is still accepted straight away.
-- =====================================================================

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

-- Same as 002, plus the heartbeat check for forfeits claimed by the winner.
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
    -- A player reporting their own loss is always believed.
    v_loser := case when p_winner = 0 then p_p1 else p_p0 end;
    if p_reporter <> v_loser then
      v_seen := case when v_loser = v_start.p0 then v_start.p0_seen_at else v_start.p1_seen_at end;
      if v_seen is not null and v_seen > now() - interval '45 seconds' then
        return json_build_object('status', 'opponent_active');
      end if;
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

revoke execute on function public.match_heartbeat(text, uuid) from public;
grant execute on function public.match_heartbeat(text, uuid) to anon, authenticated;

revoke execute on function
  public.register_online_start(uuid, uuid, uuid, uuid),
  public.submit_online_report(uuid, uuid, text, uuid, uuid, smallint, integer, smallint, text, integer)
from public, anon, authenticated;
grant execute on function
  public.register_online_start(uuid, uuid, uuid, uuid),
  public.submit_online_report(uuid, uuid, text, uuid, uuid, smallint, integer, smallint, text, integer)
to service_role;

notify pgrst, 'reload schema';
