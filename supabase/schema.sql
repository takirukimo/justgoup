-- ═══════════════════════════════════════════════════════════════════════════════
-- JUST GO UP: Supabase schema (global leaderboards + community problems)
--
-- Idempotent: safe to run again after edits (tables are created if missing,
-- constraints / policies / triggers / functions are dropped and recreated).
-- Constraints are added NOT VALID: they are enforced for every new or changed
-- row, but a re-run that tightens a rule never fails on rows already stored.
-- Run it in the Supabase SQL Editor. See supabase/README.md.
--
-- Security model: the browser uses the public anon (publishable) key.
--   * RLS on every table. anon may SELECT and INSERT, never UPDATE or DELETE.
--   * Column-level INSERT grants: clients cannot set created_at, plays or sends.
--   * CHECK constraints bound every column (names, ranges, enums, JSON size).
--   * BEFORE INSERT triggers stamp created_at, zero the counters and rate-limit
--     writes per player / author name (HTTP 429 via PostgREST's PT429).
--   * Counters change only through record_attempt() (SECURITY DEFINER, fixed
--     search_path). Ranks come from score_rank().
-- Name rule (keep in sync with src/net/names.ts): 2..16 chars of
--   A-Z a-z 0-9 space . _ -  plus Latin-1 / Latin Extended-A letters,
--   single spaces, no leading/trailing space, at least one letter or digit.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pgcrypto; -- gen_random_uuid() (built in on PG 13+, harmless)

-- ───────────────────────────── scores ─────────────────────────────

create table if not exists public.scores (
  id          uuid        primary key default gen_random_uuid(),
  player      text        not null,
  mode        text        not null,
  score       integer     not null,
  sends       integer     not null default 0,
  max_grade   integer     not null default 0,
  head        text        not null default 'ibex',
  daily_key   text,
  created_at  timestamptz not null default now()
);

comment on table public.scores is 'JUST GO UP leaderboard runs (boulder / rope / daily).';

alter table public.scores drop constraint if exists scores_player_check;
alter table public.scores add constraint scores_player_check check (
  char_length(player) between 2 and 16
  and player = btrim(player)
  and position('  ' in player) = 0
  and player ~ '^[A-Za-z0-9 ._À-ÖØ-öø-ÿĀ-ſ-]+$'
  and player ~ '[A-Za-z0-9À-ÖØ-öø-ÿĀ-ſ]'
) not valid;

alter table public.scores drop constraint if exists scores_mode_check;
alter table public.scores add constraint scores_mode_check check (mode in ('boulder', 'rope', 'daily')) not valid;

alter table public.scores drop constraint if exists scores_score_check;
alter table public.scores add constraint scores_score_check check (score between 0 and 5000000) not valid;

alter table public.scores drop constraint if exists scores_sends_check;
alter table public.scores add constraint scores_sends_check check (sends between 0 and 10000) not valid;

alter table public.scores drop constraint if exists scores_max_grade_check;
alter table public.scores add constraint scores_max_grade_check check (max_grade between 0 and 12) not valid;

alter table public.scores drop constraint if exists scores_head_check;
alter table public.scores add constraint scores_head_check check (
  head in ('ibex', 'chamois', 'goat', 'marmot', 'snowleopard', 'eagle', 'lynx', 'ram', 'vulture')
) not valid;

-- daily_key: YYYY-MM-DD, present exactly when mode = 'daily'.
alter table public.scores drop constraint if exists scores_daily_key_check;
alter table public.scores add constraint scores_daily_key_check check (
  (daily_key is null or daily_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')
  and ((mode = 'daily') = (daily_key is not null))
) not valid;

-- Leaderboard reads: GET /scores?mode=eq.boulder&daily_key=is.null&order=score.desc,created_at.asc
create index if not exists scores_board_idx on public.scores (mode, score desc, created_at) where daily_key is null;
-- Daily board: GET /scores?mode=eq.daily&daily_key=eq.2026-10-17&order=score.desc,created_at.asc
create index if not exists scores_daily_idx on public.scores (daily_key, score desc, created_at) where mode = 'daily';
-- Rate limit lookups.
create index if not exists scores_player_recent_idx on public.scores (lower(player), created_at desc);

-- ───────────────────────────── problems ─────────────────────────────

create table if not exists public.problems (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  author      text        not null,
  grade       integer     not null,
  wall_angle  real        not null default 0,
  data        jsonb       not null,
  plays       integer     not null default 0,
  sends       integer     not null default 0,
  created_at  timestamptz not null default now()
);

comment on table public.problems is 'JUST GO UP community problems. data = BoulderDef JSON.';

alter table public.problems drop constraint if exists problems_name_check;
alter table public.problems add constraint problems_name_check check (
  char_length(name) between 1 and 32
  and name = btrim(name)
  and name !~ '[[:cntrl:]]'
) not valid;

alter table public.problems drop constraint if exists problems_author_check;
alter table public.problems add constraint problems_author_check check (
  char_length(author) between 2 and 16
  and author = btrim(author)
  and position('  ' in author) = 0
  and author ~ '^[A-Za-z0-9 ._À-ÖØ-öø-ÿĀ-ſ-]+$'
  and author ~ '[A-Za-z0-9À-ÖØ-öø-ÿĀ-ſ]'
) not valid;

alter table public.problems drop constraint if exists problems_grade_check;
alter table public.problems add constraint problems_grade_check check (grade between 0 and 12) not valid;

alter table public.problems drop constraint if exists problems_wall_angle_check;
alter table public.problems add constraint problems_wall_angle_check check (wall_angle between -15 and 45) not valid;

alter table public.problems drop constraint if exists problems_data_check;
alter table public.problems add constraint problems_data_check check (
  jsonb_typeof(data) = 'object'
  and coalesce(jsonb_typeof(data -> 'holds'), '') = 'array'
  and octet_length(data::text) < 60000
) not valid;

alter table public.problems drop constraint if exists problems_counters_check;
alter table public.problems add constraint problems_counters_check check (plays >= 0 and sends >= 0 and sends <= plays) not valid;

-- Community list: newest / most played.
create index if not exists problems_new_idx on public.problems (created_at desc, id);
create index if not exists problems_popular_idx on public.problems (plays desc, created_at desc);
-- Rate limit lookups.
create index if not exists problems_author_recent_idx on public.problems (lower(author), created_at desc);

-- ───────────────────────────── insert triggers (stamping + rate limits) ─────────────────────────────

create or replace function public.jgu_scores_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  recent integer;
  day    date;
  today  date := (now() at time zone 'utc')::date;
begin
  new.created_at := now();

  -- Daily runs are accepted for "today" (UTC, +1 day of clock skew) and up to two weeks late
  -- (offline clients flush their outbox later).
  if new.daily_key is not null then
    begin
      day := new.daily_key::date;
    exception when others then
      raise exception 'invalid daily_key: %', new.daily_key using errcode = '22023';
    end;
    if day > today + 1 or day < today - 14 then
      raise exception 'daily_key % is outside the accepted window', new.daily_key using errcode = '22023';
    end if;
  end if;

  -- At most 30 runs per minute per player name (case-insensitive). The advisory lock makes
  -- concurrent inserts for the same name count each other.
  perform pg_advisory_xact_lock(hashtext('jgu_scores:' || lower(new.player)));
  select count(*) into recent
    from public.scores
   where lower(player) = lower(new.player)
     and created_at > now() - interval '1 minute';
  if recent >= 30 then
    raise sqlstate 'PT429' using
      message = 'rate limit: too many scores for this player, try again in a minute',
      hint = 'rate_limited';
  end if;

  return new;
end;
$$;

create or replace function public.jgu_problems_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  recent integer;
begin
  new.plays := 0;
  new.sends := 0;
  new.created_at := now();

  -- At most 10 published problems per hour per author name (case-insensitive).
  perform pg_advisory_xact_lock(hashtext('jgu_problems:' || lower(new.author)));
  select count(*) into recent
    from public.problems
   where lower(author) = lower(new.author)
     and created_at > now() - interval '1 hour';
  if recent >= 10 then
    raise sqlstate 'PT429' using
      message = 'rate limit: too many problems from this author, try again later',
      hint = 'rate_limited';
  end if;

  return new;
end;
$$;

drop trigger if exists scores_before_insert on public.scores;
create trigger scores_before_insert
  before insert on public.scores
  for each row execute function public.jgu_scores_before_insert();

drop trigger if exists problems_before_insert on public.problems;
create trigger problems_before_insert
  before insert on public.problems
  for each row execute function public.jgu_problems_before_insert();

-- Trigger functions are not an API: nobody calls them directly.
revoke all on function public.jgu_scores_before_insert() from public, anon, authenticated;
revoke all on function public.jgu_problems_before_insert() from public, anon, authenticated;

-- ───────────────────────────── RPCs ─────────────────────────────

-- 1-based rank of a score on its board (ties share the better rank).
-- POST /rest/v1/rpc/score_rank {"p_mode":"boulder","p_score":1234,"p_daily_key":null}
create or replace function public.score_rank(p_mode text, p_score integer, p_daily_key text default null)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  ahead integer;
begin
  if p_mode = 'daily' then
    if p_daily_key is null then
      return null;
    end if;
    select count(*) into ahead
      from public.scores
     where mode = 'daily' and daily_key = p_daily_key and score > p_score;
  elsif p_mode in ('boulder', 'rope') then
    select count(*) into ahead
      from public.scores
     where mode = p_mode and daily_key is null and score > p_score;
  else
    return null;
  end if;
  return ahead + 1;
end;
$$;

-- Count one attempt on a community problem (+1 send when sent).
-- POST /rest/v1/rpc/record_attempt {"p_problem_id":"<uuid>","p_sent":true}
create or replace function public.record_attempt(p_problem_id uuid, p_sent boolean default false)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  update public.problems
     set plays = plays + 1,
         sends = sends + case when coalesce(p_sent, false) then 1 else 0 end
   where id = p_problem_id
     and plays < 2000000000;
end;
$$;

revoke all on function public.score_rank(text, integer, text) from public;
revoke all on function public.record_attempt(uuid, boolean) from public;
grant execute on function public.score_rank(text, integer, text) to anon, authenticated;
grant execute on function public.record_attempt(uuid, boolean) to anon, authenticated;

-- ───────────────────────────── privileges + RLS ─────────────────────────────

alter table public.scores enable row level security;
alter table public.problems enable row level security;

-- Start from nothing, then grant exactly what the game needs.
revoke all on table public.scores from anon, authenticated;
revoke all on table public.problems from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on table public.scores to anon, authenticated;
grant select on table public.problems to anon, authenticated;
-- Column-level: created_at / plays / sends are never client-supplied. `id` is allowed so a
-- retried insert (same client-generated uuid) is idempotent.
grant insert (id, player, mode, score, sends, max_grade, head, daily_key) on table public.scores to anon, authenticated;
grant insert (id, name, author, grade, wall_angle, data) on table public.problems to anon, authenticated;

drop policy if exists scores_select_all on public.scores;
create policy scores_select_all on public.scores
  for select to anon, authenticated
  using (true);

drop policy if exists scores_insert_checked on public.scores;
create policy scores_insert_checked on public.scores
  for insert to anon, authenticated
  with check (true); -- every column is bounded by the CHECK constraints above

drop policy if exists problems_select_all on public.problems;
create policy problems_select_all on public.problems
  for select to anon, authenticated
  using (true);

drop policy if exists problems_insert_checked on public.problems;
create policy problems_insert_checked on public.problems
  for insert to anon, authenticated
  with check (plays = 0 and sends = 0);

-- No UPDATE / DELETE policies: those are denied for anon and authenticated.

commit;

-- Make PostgREST pick up the new tables / functions right away.
notify pgrst, 'reload schema';
