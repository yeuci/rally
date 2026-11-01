-- Rally account progress (M6 "Progression"; docs/progress.md): an account level that grows from playing (XP), and three
-- optional daily challenges per player that pay coins and XP when claimed. Built on the coin economy
-- (20261031000400_coins.sql) and its patterns. Pinned by test/progress.test.ts.
--
--   * progress_rules     every XP amount and cap, and the coins a level-up pays, one row each (key -> value). Read with
--                        private.progress_rule(key); tune with an UPDATE in Studio, no migration needed. Readable by
--                        clients, written only by the service role / Studio.
--   * player_progress    one row per user who ever earned XP: the total (xp) and the level it gives (stored, so reads
--                        are one primary-key lookup). Owner-read only; written only by private.apply_xp.
--   * xp_ledger          append-only history of every XP award: amount (> 0), reason, ref, the total and level after
--                        it. UNIQUE (user_id, reason, ref), so the same match, solo session, achievement or challenge
--                        can never pay twice. Owner-read only; written only by private.apply_xp; UPDATE is refused by a
--                        trigger; rows older than 365 days are purged daily (player_progress stays authoritative).
--   * Level curve (fixed, mirrored by packages/db/src/progress.ts; the test compares the two): reaching level L + 1
--     from level L takes 100 + 25 * (L - 1) XP, growing until it reaches 500 at level 17 and staying there. Total XP
--     for level L: 100 (L-1) + 12.5 (L-1)(L-2) up to level 17 (4,600 XP), then 500 per level.
--   * private.apply_xp is the single writer. It takes the user's WALLET lock first (private.lock_wallet), then the
--     player_progress row lock: every progress or challenge write takes the wallet first, so transactions that touch
--     coins, XP and challenges of one user serialise on one lock and cannot deadlock (server_record_match keeps
--     locking its players' wallets in user-id order before anything else). It skips a (reason, ref) already applied,
--     appends the ledger row and updates the total. A level-up pays rule-driven coins once per level reached
--     (coin_ledger reason 'level', ref = the level) and broadcasts a 'level' event.
--   * Earning XP happens in the same trusted paths as coins (clients can never grant themselves XP):
--       match        server_record_match, each eligible player of a counted match (the coins' definition): rule
--                    'match'; the winner + rule 'win'. Capped at 'match_daily_cap' per UTC day. ref = matchId.
--       achievement  a one-time award per newly unlocked achievement (unlock_achievement, server_record_match):
--                    rule 'achievement'. ref = '<game_id>:<key>'.
--       solo         submit_solo_score, a valid run (accepted or 'not_best'): rule 'solo', once per play session,
--                    capped at 'solo_daily_cap' per UTC day. ref = session id.
--       challenge    claim_daily_challenge: the challenge's own xp (and coins). ref = the challenge id.
--     Guests and anonymous sessions never earn (the same eligibility as coins).
--   * Daily challenges: challenge_templates (a seeded pool: kind, optional game / board, target, tier 1-3, coins,
--     xp) and daily_challenges (three per user per UTC day, a snapshot of their templates plus progress). The day's
--     set is picked lazily by private.ensure_daily_challenges (from my_daily_challenges, and from the progress paths
--     so a match played before opening the app still counts): one template per tier (easy, medium, harder), the first
--     eligible one in an order seeded by md5(user, date, template key), with distinct kinds where possible. So the
--     pick is stable (stored), deterministic, varied (differs per user and per day) and fair (every set has one of
--     each tier). Templates that name a game need it published and playable (owns_game); 'friend_match' needs an
--     accepted friend; 'play_games' needs that many published games.
--   * Progress (private.challenge_event) is counted inside server_record_match (a counted match, toward the UTC day
--     it ended) and submit_solo_score (a valid run), idempotent per match / session (refs). A completed challenge is
--     claimed with claim_daily_challenge(id): coins + XP through both ledgers (reason 'challenge', ref = the id),
--     once. Claimable on its day and the next (a challenge finished just before the 00:00 UTC reset is not lost).
--   * Realtime: event 'progress' on the private topic user:<uid> (like 'coins'), payload.type:
--       'xp'         every XP award (AFTER INSERT trigger on xp_ledger): {id, amount, reason, game_id, note, at} plus
--                    the progress after it {level, xp_into_level, xp_for_next, total_xp};
--       'level'      a level-up: {level, from, coins, at} plus the progress after it;
--       'challenge'  a challenge's progress, completion or claim (AFTER UPDATE trigger on daily_challenges): {id, day,
--                    kind, title, progress, target, coins, xp, completed, claimed, at}.
--     Level-up coins are also announced as a 'coins' event with reason 'level'.
--   * Public: public_progress(user) gives a player's level to anyone allowed to see their games
--     (profiles.privacy.games, blocks hide it both ways), like public_profile_games.
--
-- Signatures and results of server_record_match, submit_solo_score and unlock_achievement are unchanged.
-- Errors as in m2: UNAUTHENTICATED / ANONYMOUS_FORBIDDEN (42501), NOT_FOUND (P0002), RATE_LIMITED (P0001), plus
-- ALREADY_CLAIMED, NOT_COMPLETE and EXPIRED (P0001) from claim_daily_challenge.

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------

create table public.progress_rules (
  key text primary key,
  value int not null,
  description text not null default '',
  updated_at timestamptz not null default now(),
  constraint progress_rules_key check (key ~ '^[a-z][a-z0-9_]{0,47}$'),
  constraint progress_rules_value check (value between 0 and 1000000)
);
alter table public.progress_rules enable row level security;
create policy "progress rules are public" on public.progress_rules for select to anon, authenticated using (true);
create trigger progress_rules_updated_at before update on public.progress_rules
  for each row execute function public.set_updated_at();

insert into public.progress_rules (key, value, description) values
  ('match', 20, 'XP for every counted multiplayer match, per eligible player.'),
  ('win', 10, 'Extra XP for the winner of a counted match.'),
  ('match_daily_cap', 600, 'Most XP one player earns from match + win per UTC day.'),
  ('achievement', 25, 'XP for each newly unlocked achievement.'),
  ('solo', 10, 'XP for each valid solo run, once per play session.'),
  ('solo_daily_cap', 100, 'Most XP one player earns from solo runs per UTC day.'),
  ('level_coins', 50, 'Coins for reaching level 2.'),
  ('level_coins_step', 10, 'Extra coins for each level after level 2.'),
  ('level_coins_max', 250, 'Most coins one level-up pays.');

-- ---------------------------------------------------------------------------
-- Progress and the XP ledger
-- ---------------------------------------------------------------------------

create table public.player_progress (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  xp int not null default 0,
  level int not null default 1,
  updated_at timestamptz not null default now(),
  constraint player_progress_xp check (xp >= 0),
  constraint player_progress_level check (level >= 1)
);
alter table public.player_progress enable row level security;
create policy "users read their own progress" on public.player_progress
  for select to authenticated using (user_id = (select auth.uid()));

create table public.xp_ledger (
  id bigserial primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  amount int not null,
  reason text not null,
  ref text not null,                                     -- idempotency key within (user, reason)
  game_id text references public.games (id) on delete set null,
  note text,                                             -- display text: game title, achievement or challenge title
  xp_after int not null,
  level_after int not null,
  created_at timestamptz not null default now(),
  constraint xp_ledger_once unique (user_id, reason, ref),
  constraint xp_ledger_amount check (amount > 0),
  constraint xp_ledger_reason check (reason in ('match', 'win', 'solo', 'achievement', 'challenge', 'adjustment')),
  constraint xp_ledger_ref check (char_length(ref) between 1 and 200),
  constraint xp_ledger_note check (note is null or char_length(note) <= 80),
  constraint xp_ledger_after check (xp_after >= amount and level_after >= 1)
);
alter table public.xp_ledger enable row level security;
create policy "users read their own xp history" on public.xp_ledger
  for select to authenticated using (user_id = (select auth.uid()));
-- History (newest first), the daily caps (today's rows of one user) and the coin history's lookups by ref.
create index xp_ledger_user_idx on public.xp_ledger (user_id, created_at desc, id desc);

-- Level-up coins and claimed challenges pay through the coin ledger.
alter table public.coin_ledger drop constraint coin_ledger_reason;
alter table public.coin_ledger add constraint coin_ledger_reason check (reason in (
  'match', 'win', 'podium', 'achievement', 'solo', 'daily', 'purchase', 'adjustment', 'level', 'challenge'
));

-- ---------------------------------------------------------------------------
-- Daily challenges
-- ---------------------------------------------------------------------------

-- Kinds (what counts toward `target`):
--   play_matches  counted multiplayer matches                     play_game  counted matches or valid solo runs of game_id
--   win_matches   wins in counted matches                         score      a valid solo run of game_id scoring >= target
--   friend_match  counted matches with an accepted friend                     on board_key (progress = best score today)
--   play_games    distinct games played (matches or solo runs)    solo_runs  valid solo runs of any game
create table public.challenge_templates (
  key text primary key,
  kind text not null,
  game_id text,                                          -- not a foreign key: templates may name games published later
  board_key text,
  target int not null,
  title text not null,                                   -- '{game}' and '{target}' are filled in when picked
  tier smallint not null,                                -- 1 easy, 2 medium, 3 harder; every day has one of each
  coins int not null default 0,
  xp int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint challenge_templates_key check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  constraint challenge_templates_kind check (kind in (
    'play_matches', 'win_matches', 'friend_match', 'play_games', 'play_game', 'score', 'solo_runs'
  )),
  constraint challenge_templates_game check ((kind in ('play_game', 'score')) = (game_id is not null)),
  constraint challenge_templates_board check ((kind = 'score') = (board_key is not null)),
  constraint challenge_templates_target check (target between 1 and 100000 and (kind = 'score' or target <= 20)),
  constraint challenge_templates_title check (char_length(title) between 1 and 60),
  constraint challenge_templates_tier check (tier between 1 and 3),
  constraint challenge_templates_coins check (coins between 0 and 1000),
  constraint challenge_templates_xp check (xp between 0 and 1000)
);
alter table public.challenge_templates enable row level security;
create policy "challenge templates are public" on public.challenge_templates for select to anon, authenticated using (true);
create trigger challenge_templates_updated_at before update on public.challenge_templates
  for each row execute function public.set_updated_at();

create table public.daily_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,                                     -- the UTC day
  slot smallint not null,                                -- 1..3, easiest first
  template_key text not null,                            -- the template it was made from (a snapshot follows)
  kind text not null,
  game_id text,
  board_key text,
  target int not null,
  title text not null,
  tier smallint not null,
  coins int not null,
  xp int not null,
  progress int not null default 0,
  refs text[] not null default '{}',                     -- what already counted: 'match:<id>' / 'solo:<session>', or game ids for play_games
  completed_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_challenges_slot unique (user_id, day, slot),
  constraint daily_challenges_template unique (user_id, day, template_key),
  constraint daily_challenges_slot_range check (slot between 1 and 3),
  constraint daily_challenges_target check (target >= 1),
  constraint daily_challenges_progress check (progress between 0 and target),
  constraint daily_challenges_completed check ((completed_at is not null) = (progress >= target)),
  constraint daily_challenges_claimed check (claimed_at is null or completed_at is not null),
  constraint daily_challenges_title check (char_length(title) between 1 and 80),
  constraint daily_challenges_refs check (cardinality(refs) <= 100)
);
alter table public.daily_challenges enable row level security;
create policy "users read their own daily challenges" on public.daily_challenges
  for select to authenticated using (user_id = (select auth.uid()));

-- The seeded pool: achievable in a normal 15-20 minute session, never grindy. Rewards grow with the tier, so every
-- day pays 105 coins and 150 XP in all. Templates naming a game that is not published are simply never picked.
insert into public.challenge_templates (key, kind, game_id, board_key, target, title, tier, coins, xp) values
  ('play_2', 'play_matches', null, null, 2, 'Play 2 matches', 1, 20, 30),
  ('sumo_1', 'play_game', 'sumo', null, 1, 'Play a round of {game}', 1, 20, 30),
  ('gunrun_1', 'play_game', 'gunrun', null, 1, 'Play a round of {game}', 1, 20, 30),
  ('stack_2', 'play_game', 'stack', null, 2, 'Play {game} twice', 1, 20, 30),
  ('play_3', 'play_matches', null, null, 3, 'Play 3 matches', 2, 35, 50),
  ('variety_2', 'play_games', null, null, 2, 'Play 2 different games', 2, 35, 50),
  ('sumo_2', 'play_game', 'sumo', null, 2, 'Play {game} twice', 2, 35, 50),
  ('gunrun_2', 'play_game', 'gunrun', null, 2, 'Play {game} twice', 2, 35, 50),
  ('overrun_1', 'play_game', 'overrun', null, 1, 'Play a round of {game}', 2, 35, 50),
  ('stack_15', 'score', 'stack', 'height', 15, 'Build a {target}-block tower in {game}', 2, 35, 50),
  ('win_1', 'win_matches', null, null, 1, 'Win a match', 3, 50, 70),
  ('play_5', 'play_matches', null, null, 5, 'Play 5 matches', 3, 50, 70),
  ('friend_1', 'friend_match', null, null, 1, 'Play a match with a friend', 3, 50, 70),
  ('variety_3', 'play_games', null, null, 3, 'Play 3 different games', 3, 50, 70),
  ('stack_20', 'score', 'stack', 'height', 20, 'Build a {target}-block tower in {game}', 3, 50, 70)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Internal helpers (schema private: no client access)
-- ---------------------------------------------------------------------------

-- A progress_rules value; 0 for a missing key (an award that is not configured pays nothing rather than failing).
create or replace function private.progress_rule(p_key text)
returns int language sql stable set search_path = public, extensions as $$
  select coalesce((select value from public.progress_rules where key = p_key), 0);
$$;

-- LEVEL CURVE. Keep in step with packages/db/src/progress.ts (xpToNextLevel, xpForLevel, levelForXp); a change
-- needs a migration and an app release, and test/progress.test.ts compares both over thousands of values.
-- XP needed to go from p_level to p_level + 1: 100, 125, 150, ... capped at 500 (level 17 onwards).
create or replace function private.xp_to_next_level(p_level int)
returns int language sql immutable set search_path = public, extensions as $$
  select least(100 + 25 * (greatest(coalesce(p_level, 1), 1) - 1), 500);
$$;

-- Total XP at which p_level starts (0 for level 1, 100 for level 2, 4,600 for level 17).
create or replace function private.xp_for_level(p_level int)
returns bigint language sql immutable set search_path = public, extensions as $$
  select case
    when l <= 17 then 100 * (l - 1) + 25 * (l - 1) * (l - 2) / 2
    else 4600 + 500 * (l - 17)
  end
  from (select greatest(coalesce(p_level, 1), 1)::bigint as l) x;
$$;

-- The level a total of p_xp gives (1 for 0 or less).
create or replace function private.level_for_xp(p_xp bigint)
returns int language plpgsql immutable set search_path = public, extensions as $$
declare
  v_xp bigint := greatest(coalesce(p_xp, 0), 0);
  v_level int := 1;
begin
  if v_xp >= 4600 then
    return 17 + ((v_xp - 4600) / 500)::int;
  end if;
  while private.xp_for_level(v_level + 1) <= v_xp loop
    v_level := v_level + 1;
  end loop;
  return v_level;
end $$;

-- {level, xp_into_level, xp_for_next, total_xp} for a total.
create or replace function private.progress_of(p_xp bigint)
returns jsonb language sql immutable set search_path = public, extensions as $$
  select jsonb_build_object(
    'level', x.l,
    'xp_into_level', x.xp - private.xp_for_level(x.l),
    'xp_for_next', private.xp_to_next_level(x.l),
    'total_xp', x.xp
  )
  from (select greatest(coalesce(p_xp, 0), 0) as xp, private.level_for_xp(p_xp) as l) x;
$$;

-- Coins for reaching p_level: rule 'level_coins' at level 2, + 'level_coins_step' per level after it, at most
-- 'level_coins_max'. 0 below level 2.
create or replace function private.level_coins(p_level int)
returns int language sql stable set search_path = public, extensions as $$
  select case when coalesce(p_level, 1) < 2 then 0
    else greatest(0, least(private.progress_rule('level_coins') + private.progress_rule('level_coins_step') * (p_level - 2),
                           private.progress_rule('level_coins_max')))
  end;
$$;

-- Realtime: p_payload to the user's private topic user:<uid>, event 'progress'. Same delivery rules as
-- private.broadcast_coin_award: no-op without realtime.send (PGlite, a stack without Realtime); a failing send raises
-- a WARNING and never fails the award (the app also refetches on focus).
create or replace function private.broadcast_progress(p_user_id uuid, p_payload jsonb)
returns void language plpgsql volatile security definer set search_path = public, extensions, realtime as $$
begin
  if p_user_id is null or to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then
    return;
  end if;
  begin
    perform realtime.send(p_payload, 'progress', 'user:' || p_user_id::text, true);
  exception when others then
    raise warning 'realtime.send failed for progress to user:% (%): %', p_user_id, sqlstate, sqlerrm;
  end;
end $$;

create or replace function private.iso_now()
returns text language sql stable set search_path = public, extensions as $$
  select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

-- Takes the user's wallet lock (lock order: wallet, then progress), creates the progress row if needed and locks it
-- for the rest of the transaction.
create or replace function private.lock_progress(p_user_id uuid)
returns public.player_progress language plpgsql volatile set search_path = public, extensions as $$
declare
  v_row public.player_progress;
begin
  perform private.lock_wallet(p_user_id);
  insert into public.player_progress (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into v_row from public.player_progress where user_id = p_user_id for update;
  return v_row;
end $$;

-- The only writer of player_progress and xp_ledger. Adds p_amount (> 0) XP under the locks and appends the ledger
-- row; a level-up pays private.level_coins once per level reached (coin_ledger reason 'level', ref = the level) and
-- broadcasts a 'level' event. Returns the XP awarded: 0 when p_amount is 0 / null or (user, reason, ref) was already
-- applied.
create or replace function private.apply_xp(
  p_user_id uuid, p_amount int, p_reason text, p_ref text, p_game_id text default null, p_note text default null
)
returns int language plpgsql volatile set search_path = public, extensions as $$
declare
  v_row public.player_progress;
  v_xp bigint;
  v_level int;
  v_id bigint;
  v_coins int := 0;
  l int;
begin
  if p_user_id is null or p_amount is null or p_amount <= 0 then
    return 0;
  end if;
  v_row := private.lock_progress(p_user_id);
  if exists (select 1 from public.xp_ledger where user_id = p_user_id and reason = p_reason and ref = p_ref) then
    return 0;
  end if;
  v_xp := v_row.xp::bigint + p_amount;
  if v_xp > 2000000000 then
    return 0;                                            -- far beyond any real total: refuse rather than overflow
  end if;
  v_level := private.level_for_xp(v_xp);
  insert into public.xp_ledger (user_id, amount, reason, ref, game_id, note, xp_after, level_after)
    values (p_user_id, p_amount, p_reason, p_ref,
            case when p_game_id is not null and exists (select 1 from public.games where id = p_game_id) then p_game_id end,
            nullif(left(p_note, 80), ''), v_xp, v_level)
  on conflict (user_id, reason, ref) do nothing
  returning id into v_id;
  if v_id is null then
    return 0;
  end if;
  update public.player_progress set xp = v_xp, level = v_level, updated_at = now() where user_id = p_user_id;
  if v_level > v_row.level then
    for l in v_row.level + 1 .. v_level loop
      v_coins := v_coins + private.award_coins(p_user_id, private.level_coins(l), 'level', l::text, null, 'Level ' || l);
    end loop;
    perform private.broadcast_progress(p_user_id,
      jsonb_build_object('type', 'level', 'from', v_row.level, 'coins', v_coins, 'at', private.iso_now())
        || private.progress_of(v_xp));
  end if;
  return p_amount;
end $$;

-- Awards up to p_amount XP for an earn reason. With p_cap, the award is cut so that today's (UTC) XP for p_cap_reasons
-- stays <= p_cap. Returns the XP actually awarded (0 when capped, not configured, or already paid).
create or replace function private.award_xp(
  p_user_id uuid, p_amount int, p_reason text, p_ref text, p_game_id text default null, p_note text default null,
  p_cap int default null, p_cap_reasons text[] default null
)
returns int language plpgsql volatile set search_path = public, extensions as $$
declare
  v_amount int := coalesce(p_amount, 0);
  v_today int;
begin
  if p_user_id is null or v_amount <= 0 then
    return 0;
  end if;
  perform private.lock_progress(p_user_id);
  if p_cap is not null then
    select coalesce(sum(amount), 0)::int into v_today
      from public.xp_ledger
     where user_id = p_user_id and reason = any (coalesce(p_cap_reasons, array[p_reason]))
       and created_at >= private.utc_day_start();
    v_amount := least(v_amount, greatest(p_cap - v_today, 0));
    if v_amount <= 0 then
      return 0;
    end if;
  end if;
  return private.apply_xp(p_user_id, v_amount, p_reason, p_ref, p_game_id, p_note);
end $$;

-- xp_ledger is append-only: rows are never changed (deletes stay possible for account deletion and retention).
create or replace function private.xp_ledger_append_only()
returns trigger language plpgsql set search_path = public, extensions as $$
begin
  raise exception 'IMMUTABLE: xp_ledger rows cannot be changed' using errcode = 'insufficient_privilege';
end $$;
create trigger xp_ledger_append_only before update on public.xp_ledger
  for each row execute function private.xp_ledger_append_only();

-- Realtime: every XP award, with the progress after it ('xp' event).
create or replace function private.broadcast_xp_award()
returns trigger language plpgsql volatile security definer set search_path = public, extensions, realtime as $$
begin
  perform private.broadcast_progress(new.user_id,
    jsonb_build_object(
      'type', 'xp',
      'id', new.id,
      'amount', new.amount,
      'reason', new.reason,
      'game_id', new.game_id,
      'note', new.note,
      'at', to_char(new.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) || private.progress_of(new.xp_after));
  return null;
end $$;
create trigger xp_ledger_broadcast after insert on public.xp_ledger
  for each row execute function private.broadcast_xp_award();

-- Realtime: a challenge's progress, completion or claim ('challenge' event).
create or replace function private.broadcast_challenge_change()
returns trigger language plpgsql volatile security definer set search_path = public, extensions, realtime as $$
begin
  if new.progress is not distinct from old.progress and new.completed_at is not distinct from old.completed_at
     and new.claimed_at is not distinct from old.claimed_at then
    return null;
  end if;
  perform private.broadcast_progress(new.user_id, jsonb_build_object(
    'type', 'challenge',
    'id', new.id,
    'day', to_char(new.day, 'YYYY-MM-DD'),
    'kind', new.kind,
    'title', new.title,
    'progress', new.progress,
    'target', new.target,
    'coins', new.coins,
    'xp', new.xp,
    'completed', new.completed_at is not null,
    'claimed', new.claimed_at is not null,
    'at', private.iso_now()
  ));
  return null;
end $$;
create trigger daily_challenges_broadcast after update on public.daily_challenges
  for each row execute function private.broadcast_challenge_change();

-- The UTC day of now().
create or replace function private.utc_today()
returns date language sql stable set search_path = public, extensions as $$
  select (now() at time zone 'utc')::date;
$$;

-- Picks p_user_id's three challenges for p_day unless that day already has them (see the header for the rules).
-- Serialised per (user, day) with an advisory lock, so concurrent callers (the dashboard and a match) agree.
create or replace function private.ensure_daily_challenges(p_user_id uuid, p_day date)
returns void language plpgsql volatile set search_path = public, extensions as $$
declare
  c_multi constant public.game_mode[] := array['quick', 'browser', 'private', 'party']::public.game_mode[];
  v_pool public.challenge_templates[];
  v_multi boolean;
  v_solo boolean;
  v_games int;
  v_friend boolean;
  v_keys text[] := '{}';
  v_kinds text[] := '{}';
  v_tier int;
  v_found boolean;
  v_t public.challenge_templates;
begin
  if p_user_id is null or p_day is null
     or exists (select 1 from public.daily_challenges where user_id = p_user_id and day = p_day) then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('daily_challenges'), hashtext(p_user_id::text || '/' || p_day::text));
  if exists (select 1 from public.daily_challenges where user_id = p_user_id and day = p_day) then
    return;
  end if;

  select count(*)::int,
         coalesce(bool_or(g.modes && c_multi), false),
         coalesce(bool_or('solo' = any (g.modes)), false)
    into v_games, v_multi, v_solo
    from public.games g
   where g.status = 'published' and public.owns_game(p_user_id, g.id);
  v_friend := exists (select 1 from public.friendships f
                       where f.status = 'accepted' and p_user_id in (f.user_id, f.friend_id));

  -- The eligible templates, in the order seeded by (user, day, key).
  select coalesce(array_agg(ct order by md5(p_user_id::text || '/' || p_day::text || '/' || ct.key), ct.key), '{}')
    into v_pool
    from public.challenge_templates ct
   where ct.active
     and case ct.kind
           when 'play_matches' then v_multi
           when 'win_matches' then v_multi
           when 'friend_match' then v_multi and v_friend
           when 'solo_runs' then v_solo
           when 'play_games' then v_games >= ct.target
           when 'play_game' then exists (
             select 1 from public.games g
              where g.id = ct.game_id and g.status = 'published' and public.owns_game(p_user_id, g.id))
           when 'score' then exists (
             select 1 from public.games g
               join public.leaderboards b on b.game_id = g.id and b.key = ct.board_key and b.mode = 'best' and b.sort = 'desc'
              where g.id = ct.game_id and g.status = 'published' and 'solo' = any (g.modes)
                and public.owns_game(p_user_id, g.id))
           else false
         end;

  -- One per tier: the first template of that tier with a kind not picked yet; if the tier has none, the first
  -- remaining template with a new kind; failing that, the first remaining one.
  for v_tier in 1..3 loop
    v_found := false;
    foreach v_t in array v_pool loop
      if v_t.tier = v_tier and not (v_t.kind = any (v_kinds)) then
        v_keys := v_keys || v_t.key;
        v_kinds := v_kinds || v_t.kind;
        v_found := true;
        exit;
      end if;
    end loop;
    if not v_found then
      foreach v_t in array v_pool loop
        if not (v_t.key = any (v_keys)) and not (v_t.kind = any (v_kinds)) then
          v_keys := v_keys || v_t.key;
          v_kinds := v_kinds || v_t.kind;
          v_found := true;
          exit;
        end if;
      end loop;
    end if;
    if not v_found then
      foreach v_t in array v_pool loop
        if not (v_t.key = any (v_keys)) then
          v_keys := v_keys || v_t.key;
          v_kinds := v_kinds || v_t.kind;
          exit;
        end if;
      end loop;
    end if;
  end loop;

  insert into public.daily_challenges (user_id, day, slot, template_key, kind, game_id, board_key, target, title, tier,
                                       coins, xp)
  select p_user_id, p_day, k.slot, ct.key, ct.kind, ct.game_id, ct.board_key, ct.target,
         left(replace(replace(ct.title, '{game}', coalesce(g.title, ct.game_id, '')), '{target}', ct.target::text), 80),
         ct.tier, ct.coins, ct.xp
    from unnest(v_keys) with ordinality as k(key, slot)
    join public.challenge_templates ct on ct.key = k.key
    left join public.games g on g.id = ct.game_id
   order by k.slot
  on conflict do nothing;
end $$;

-- Counts one event toward p_user_id's open challenges of p_day (today's are generated first if needed; past days are
-- only updated). p_event: 'match' (a counted multiplayer match; ref 'match:<id>', p_won, p_with_friend) or 'solo' (a
-- valid solo run; ref 'solo:<session>', p_board_key, p_score). Idempotent per ref. Returns how many challenges moved.
create or replace function private.challenge_event(
  p_user_id uuid, p_day date, p_event text, p_ref text, p_game_id text,
  p_board_key text default null, p_score double precision default null,
  p_won boolean default false, p_with_friend boolean default false
)
returns int language plpgsql volatile set search_path = public, extensions as $$
declare
  c public.daily_challenges;
  v_progress int;
  v_refs text[];
  v_moved int := 0;
begin
  if p_user_id is null or p_day is null or p_ref is null or coalesce(p_event, '') not in ('match', 'solo') then
    return 0;
  end if;
  if p_day = private.utc_today() then
    perform private.ensure_daily_challenges(p_user_id, p_day);
  end if;
  for c in
    select * from public.daily_challenges
     where user_id = p_user_id and day = p_day and completed_at is null
     order by slot
       for update
  loop
    v_progress := null;
    v_refs := c.refs;
    case c.kind
      when 'play_matches' then
        if p_event = 'match' and not (p_ref = any (c.refs)) then
          v_progress := c.progress + 1;
          v_refs := c.refs || p_ref;
        end if;
      when 'win_matches' then
        if p_event = 'match' and coalesce(p_won, false) and not (p_ref = any (c.refs)) then
          v_progress := c.progress + 1;
          v_refs := c.refs || p_ref;
        end if;
      when 'friend_match' then
        if p_event = 'match' and coalesce(p_with_friend, false) and not (p_ref = any (c.refs)) then
          v_progress := c.progress + 1;
          v_refs := c.refs || p_ref;
        end if;
      when 'solo_runs' then
        if p_event = 'solo' and not (p_ref = any (c.refs)) then
          v_progress := c.progress + 1;
          v_refs := c.refs || p_ref;
        end if;
      when 'play_game' then
        if c.game_id = p_game_id and not (p_ref = any (c.refs)) then
          v_progress := c.progress + 1;
          v_refs := c.refs || p_ref;
        end if;
      when 'play_games' then
        if p_game_id is not null and not (p_game_id = any (c.refs)) then
          v_refs := c.refs || p_game_id;
          v_progress := cardinality(v_refs);
        end if;
      when 'score' then
        if p_event = 'solo' and c.game_id = p_game_id and c.board_key = p_board_key and p_score is not null
           and p_score >= c.progress + 1 then
          v_progress := least(floor(p_score), c.target::double precision)::int;
        end if;
      else
        null;
    end case;
    if v_progress is not null and v_progress > c.progress then
      v_progress := least(v_progress, c.target);
      update public.daily_challenges
         set progress = v_progress,
             refs = v_refs,
             completed_at = case when v_progress >= c.target then now() end,
             updated_at = now()
       where id = c.id;
      v_moved := v_moved + 1;
    end if;
  end loop;
  return v_moved;
end $$;

-- Daily retention (pg_cron job purge-progress, scheduled below): XP rows older than 365 days (player_progress stays
-- authoritative; refs are match ids, session ids, achievement keys and challenge ids, so none can pay again) and
-- daily challenges older than 30 days.
create or replace function private.purge_progress_rows()
returns void language plpgsql volatile set search_path = public, extensions as $$
begin
  delete from public.xp_ledger where created_at < now() - interval '365 days';
  delete from public.daily_challenges where day < private.utc_today() - 30;
end $$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Earning: server_record_match (multiplayer), unlock_achievement and submit_solo_score (solo)
-- ---------------------------------------------------------------------------

-- As in 20261031000400_coins.sql (validation, idempotency, eligibility, stats, boards, achievements, coins and the
-- result are unchanged), plus, for the same players and right after each one's coins:
--   * XP: a counted match pays rule 'match' XP to every eligible player and + rule 'win' to winnerUserId (capped at
--     rule 'match_daily_cap' per player per UTC day); each newly unlocked achievement pays rule 'achievement' XP;
--   * daily challenges: a counted match counts toward each eligible player's challenges of the UTC day it ended
--     (won = the winner; with a friend = another eligible player is an accepted friend).
-- The wallets of everyone about to be paid are still locked first, in user-id order; XP and challenge rows of a
-- player are only touched after that player's wallet. The return value is unchanged.
create or replace function public.server_record_match(p_match jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_max_score constant numeric := 1e9;
  v_match_id text;
  v_game_id text;
  v_room_id text;
  v_private boolean;
  v_started timestamptz;
  v_ended timestamptz;
  v_at timestamptz;
  v_duration real;
  v_minutes numeric;
  v_rounds int;
  v_winner_text text;
  v_winner uuid;
  v_players jsonb;
  v_deltas jsonb;
  v_scores jsonb;
  v_eligible uuid[];
  v_inserted boolean;
  v_unlocked jsonb;
  v_result jsonb;
  v_title text;
  v_counted boolean;
  v_player_count int;
  v_placement numeric;
  v_match_cap int;
  v_xp_cap int;
  v_day date;
  r record;
begin
  if jsonb_typeof(p_match) is distinct from 'object' then
    raise exception 'INVALID: match must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;
  if pg_column_size(p_match) > 65536 then
    raise exception 'INVALID: match is too large' using errcode = 'invalid_parameter_value';
  end if;
  v_match_id := case when jsonb_typeof(p_match -> 'matchId') = 'string' then p_match ->> 'matchId' end;
  v_game_id := case when jsonb_typeof(p_match -> 'gameId') = 'string' then p_match ->> 'gameId' end;
  v_room_id := case when jsonb_typeof(p_match -> 'roomId') = 'string' then p_match ->> 'roomId' end;
  if v_match_id is null or char_length(v_match_id) not between 1 and 200 or v_game_id is null or v_room_id is null then
    raise exception 'INVALID: matchId, gameId and roomId are required strings' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(p_match -> 'private') is distinct from 'boolean' then
    raise exception 'INVALID: private must be a boolean' using errcode = 'invalid_parameter_value';
  end if;
  v_private := (p_match ->> 'private')::boolean;
  v_players := p_match -> 'players';
  if jsonb_typeof(v_players) is distinct from 'array' then
    raise exception 'INVALID: players must be an array' using errcode = 'invalid_parameter_value';
  end if;
  v_deltas := coalesce(p_match -> 'leaderboardDeltas', '{}'::jsonb);
  if jsonb_typeof(v_deltas) = 'null' then
    v_deltas := '{}'::jsonb;
  elsif jsonb_typeof(v_deltas) <> 'object' then
    raise exception 'INVALID: leaderboardDeltas must be an object' using errcode = 'invalid_parameter_value';
  end if;
  v_scores := coalesce(p_match -> 'leaderboardScores', '{}'::jsonb);
  if jsonb_typeof(v_scores) = 'null' then
    v_scores := '{}'::jsonb;
  elsif jsonb_typeof(v_scores) <> 'object' then
    raise exception 'INVALID: leaderboardScores must be an object' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(p_match -> 'durationSec') is distinct from 'number'
     or jsonb_typeof(p_match -> 'startedAt') is distinct from 'string'
     or jsonb_typeof(p_match -> 'endedAt') is distinct from 'string'
     or jsonb_typeof(coalesce(p_match -> 'rounds', '0'::jsonb)) is distinct from 'number' then
    raise exception 'INVALID: startedAt, endedAt, durationSec and rounds have the wrong type' using errcode = 'invalid_parameter_value';
  end if;
  begin
    v_started := (p_match ->> 'startedAt')::timestamptz;
    v_ended := (p_match ->> 'endedAt')::timestamptz;
    v_duration := (p_match ->> 'durationSec')::real;
    v_rounds := coalesce((p_match ->> 'rounds')::int, 0);
  exception when others then
    raise exception 'INVALID: startedAt, endedAt, durationSec or rounds is malformed (%)', sqlerrm
      using errcode = 'invalid_parameter_value';
  end;
  if v_started is null or v_ended is null or v_duration < 0 or v_started > v_ended
     or v_ended in ('infinity', '-infinity') or v_started in ('infinity', '-infinity') then
    raise exception 'INVALID: startedAt / endedAt / durationSec out of range' using errcode = 'invalid_parameter_value';
  end if;
  v_winner_text := case when jsonb_typeof(p_match -> 'winnerUserId') = 'string' then p_match ->> 'winnerUserId' end;
  v_winner := case when v_winner_text ~* c_uuid then v_winner_text::uuid end;
  if not exists (select 1 from public.games where id = v_game_id) then
    raise exception 'NOT_FOUND: game %', v_game_id using errcode = 'no_data_found';
  end if;

  -- 1. Idempotency.
  insert into public.match_results (match_id, game_id, room_id, private, started_at, ended_at, duration_s, rounds,
                                    winner_id, payload)
    values (v_match_id, v_game_id, v_room_id, v_private, v_started, v_ended, v_duration, v_rounds, v_winner, p_match)
  on conflict (match_id) do nothing
  returning true into v_inserted;
  if v_inserted is null then
    return jsonb_build_object('duplicate', true);
  end if;

  -- 2. Eligible players: first 64 distinct linked, unbanned profiles, in the order sent.
  select coalesce(array_agg(x.u order by x.ord), '{}') into v_eligible
    from (
      select d.u, d.ord
        from (
          select distinct on (e.u) e.u, e.ord
            from (
              select case when jsonb_typeof(t.p -> 'userId') = 'string' and (t.p ->> 'userId') ~* c_uuid
                          then (t.p ->> 'userId')::uuid end as u,
                     t.ord
                from jsonb_array_elements(v_players) with ordinality as t(p, ord)
               where jsonb_typeof(t.p) = 'object' and t.p -> 'guest' = 'false'::jsonb
            ) e
           where e.u is not null
           order by e.u, e.ord
        ) d
       where exists (select 1 from public.profiles pr where pr.id = d.u)
         and exists (select 1 from auth.users au where au.id = d.u and au.is_anonymous is not true)
         and private.active_sanction(d.u, 'ban') is null
       order by d.ord
       limit 64
    ) x;

  v_at := least(v_ended, now());

  -- 3. game_stats.
  insert into public.game_stats as s (user_id, game_id, plays, wins, losses, playtime_s, last_played_at)
  select u, v_game_id, 1,
         case when u = v_winner then 1 else 0 end,
         case when v_winner_text is not null and v_winner is distinct from u then 1 else 0 end,
         round(least(greatest(v_duration, 0), 7200))::int,
         v_at
    from unnest(v_eligible) as u
  on conflict (user_id, game_id) do update
    set plays = s.plays + 1,
        wins = s.wins + excluded.wins,
        losses = s.losses + excluded.losses,
        playtime_s = s.playtime_s + excluded.playtime_s,
        last_played_at = greatest(coalesce(s.last_played_at, excluded.last_played_at), excluded.last_played_at);

  -- 4. Server leaderboards (anti-boosting: no short matches, no private matches with fewer than 2 eligible players).
  --    Deltas go to 'total' boards, scores to 'best' boards; the other pairings never match the join.
  v_minutes := greatest(1, ceil(v_duration::numeric / 60));
  if v_duration >= 20 and (not v_private or cardinality(v_eligible) >= 2) then
    for r in
      select q.board_id, q.period, q.sort, q.mode, q.uid::uuid as uid, q.value
        from (
          select b.id as board_id, b.period, b.sort, b.mode, b.key as board_key, b.max_score_per_minute,
                 lower(d.key) as uid,
                 case when jsonb_typeof(d.value) = 'number' then (d.value::text)::numeric end as value
            from (
              select 'total'::text as mode, x.key, x.value as users from jsonb_each(v_deltas) as x
              union all
              select 'best'::text, x.key, x.value from jsonb_each(v_scores) as x
            ) k
            join public.leaderboards b on b.game_id = v_game_id and b.key = k.key and b.mode = k.mode
            cross join lateral jsonb_each(case when jsonb_typeof(k.users) = 'object' then k.users else '{}'::jsonb end)
                    as d(key, value)
        ) q
       where q.uid = any (v_eligible::text[])
         and case q.mode
               when 'total' then q.value between 1 and 10 and q.value = trunc(q.value)
               else q.value > 0
                    and q.value <= coalesce(q.max_score_per_minute::numeric * v_minutes, c_max_score)
             end
       order by q.board_key, q.uid
    loop
      if public.take_rate_limit_token(r.uid, 'server_board', 60, 1.0 / 60) then
        if r.mode = 'total' then
          insert into public.leaderboard_entries as e (leaderboard_id, period_key, user_id, score, source, updated_at)
            values (r.board_id, public.period_key(r.period, v_at), r.uid, r.value::int, 'server', now())
          on conflict (leaderboard_id, period_key, user_id) do update
            set score = e.score + excluded.score, source = 'server', updated_at = now();
        else
          -- Only a strictly better score replaces the entry; the condition is re-checked against the row as locked,
          -- so concurrent matches cannot lower it.
          insert into public.leaderboard_entries as e (leaderboard_id, period_key, user_id, score, source, updated_at)
            values (r.board_id, public.period_key(r.period, v_at), r.uid, r.value::double precision, 'server', now())
          on conflict (leaderboard_id, period_key, user_id) do update
            set score = excluded.score, source = 'server', updated_at = now()
            where (r.sort = 'desc' and excluded.score > e.score) or (r.sort = 'asc' and excluded.score < e.score);
        end if;
      end if;
    end loop;
  end if;

  -- 5. Achievements.
  with wanted as (
    select distinct (t.p ->> 'userId')::uuid as uid, k.key
      from jsonb_array_elements(v_players) as t(p)
      cross join lateral jsonb_array_elements_text(
        case when jsonb_typeof(t.p -> 'achievements') = 'array' then t.p -> 'achievements' else '[]'::jsonb end
      ) as k(key)
     where jsonb_typeof(t.p) = 'object' and t.p -> 'guest' = 'false'::jsonb
       and jsonb_typeof(t.p -> 'userId') = 'string' and (t.p ->> 'userId') ~* c_uuid
  ), ins as (
    insert into public.user_achievements (user_id, achievement_id)
    select w.uid, a.id
      from wanted w
      join public.achievements a on a.game_id = v_game_id and a.key = w.key
     where w.uid = any (v_eligible)
    on conflict (user_id, achievement_id) do nothing
    returning user_id, achievement_id
  )
  select coalesce(jsonb_object_agg(q.user_id::text, q.list), '{}'::jsonb) into v_unlocked
    from (
      select ins.user_id,
             jsonb_agg(jsonb_build_object('key', a.key, 'title', a.title, 'icon', a.icon) order by a.key) as list
        from ins join public.achievements a on a.id = ins.achievement_id
       group by ins.user_id
    ) q;

  -- 6. Result.
  select coalesce(jsonb_object_agg(u::text, jsonb_build_object(
           'wins', s.wins,
           'losses', s.losses,
           'boards', coalesce((
             select jsonb_object_agg(b.key, jsonb_build_object(
                      'score', e.score,
                      'rank', 1 + (select count(*) from public.leaderboard_entries e2
                                    where e2.leaderboard_id = b.id and e2.period_key = e.period_key
                                      and case when b.sort = 'desc' then e2.score > e.score else e2.score < e.score end)))
               from public.leaderboards b
               join public.leaderboard_entries e
                 on e.leaderboard_id = b.id and e.period_key = public.period_key(b.period, v_at) and e.user_id = u
              where b.game_id = v_game_id), '{}'::jsonb),
           'unlocked', coalesce(v_unlocked -> u::text, '[]'::jsonb))), '{}'::jsonb)
    into v_result
    from unnest(v_eligible) as u
    join public.game_stats s on s.user_id = u and s.game_id = v_game_id;

  -- 7. Coins, then XP and daily challenges (eligible players only). The wallets of everyone about to be paid are locked
  --    first, in user-id order (private.lock_wallets), so matches recording overlapping players cannot deadlock.
  v_counted := v_duration >= private.coin_rule('match_min_duration_s') and (not v_private or cardinality(v_eligible) >= 2);
  if cardinality(v_eligible) > 0 and (v_counted or v_unlocked <> '{}'::jsonb) then
    perform private.lock_wallets(
      case when v_counted then v_eligible
           else array(select k::uuid from jsonb_object_keys(v_unlocked) as k) end);
    select title into v_title from public.games where id = v_game_id;
    if v_counted then
      v_match_cap := private.coin_rule('match_daily_cap');
      v_xp_cap := private.progress_rule('match_daily_cap');
      v_day := (v_at at time zone 'utc')::date;
      select count(*)::int into v_player_count from jsonb_array_elements(v_players) as t(p) where jsonb_typeof(t.p) = 'object';
      for r in select u from unnest(v_eligible) as u order by u loop
        perform private.award_coins(r.u, private.coin_rule('match'), 'match', v_match_id, v_game_id, v_title,
                                    v_match_cap, array['match', 'win', 'podium']);
        if r.u = v_winner then
          perform private.award_coins(r.u, private.coin_rule('win'), 'win', v_match_id, v_game_id, v_title,
                                      v_match_cap, array['match', 'win', 'podium']);
        elsif v_winner_text is not null and v_player_count >= private.coin_rule('podium_min_players') then
          select case when jsonb_typeof(t.p -> 'placement') = 'number' then (t.p ->> 'placement')::numeric end
            into v_placement
            from jsonb_array_elements(v_players) with ordinality as t(p, ord)
           where jsonb_typeof(t.p) = 'object' and lower(t.p ->> 'userId') = r.u::text
           order by t.ord
           limit 1;
          if v_placement in (2, 3) then
            perform private.award_coins(r.u, private.coin_rule('podium'), 'podium', v_match_id, v_game_id, v_title,
                                        v_match_cap, array['match', 'win', 'podium']);
          end if;
        end if;
        perform private.award_daily_bonus(r.u);
        -- XP and challenges (20261101000100_progress.sql).
        perform private.award_xp(r.u, private.progress_rule('match'), 'match', v_match_id, v_game_id, v_title,
                                 v_xp_cap, array['match', 'win']);
        if r.u = v_winner then
          perform private.award_xp(r.u, private.progress_rule('win'), 'win', v_match_id, v_game_id, v_title,
                                   v_xp_cap, array['match', 'win']);
        end if;
        perform private.challenge_event(
          r.u, v_day, 'match', 'match:' || v_match_id, v_game_id, null, null,
          coalesce(r.u = v_winner, false),
          exists (select 1 from unnest(v_eligible) as f where f <> r.u and private.is_friend(r.u, f)));
      end loop;
    end if;
    for r in
      select (q.key)::uuid as uid, a.game_id, a.key, a.title, coalesce(a.coins, private.coin_rule('achievement')) as coins
        from jsonb_each(v_unlocked) as q(key, list)
        cross join lateral jsonb_array_elements(q.list) as l(item)
        join public.achievements a on a.game_id = v_game_id and a.key = l.item ->> 'key'
       order by 1, a.key
    loop
      perform private.award_coins(r.uid, r.coins, 'achievement', r.game_id || ':' || r.key, r.game_id, r.title);
      perform private.award_xp(r.uid, private.progress_rule('achievement'), 'achievement', r.game_id || ':' || r.key,
                               r.game_id, r.title);
    end loop;
  end if;

  return jsonb_build_object('duplicate', false, 'players', v_result);
end $$;

-- As in 20261031000400_coins.sql, plus rule 'achievement' XP on a new unlock (ref '<game_id>:<key>'), right after its
-- coins. The answer is unchanged.
create or replace function public.unlock_achievement(p_game_id text, p_key text)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_achievement public.achievements;
  v_inserted boolean;
begin
  if exists (select 1 from public.games where id = p_game_id and status = 'published' and not ('solo' = any (modes))) then
    raise exception 'INVALID: % is not a solo game', p_game_id using errcode = 'invalid_parameter_value';
  end if;
  select a.* into v_achievement
    from public.achievements a join public.games g on g.id = a.game_id
   where a.game_id = p_game_id and a.key = p_key and g.status = 'published';
  if v_achievement.id is null then
    raise exception 'NOT_FOUND: achievement %', coalesce(p_key, 'null') using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.user_achievements where user_id = v_uid and achievement_id = v_achievement.id) then
    return jsonb_build_object('unlocked', true, 'alreadyHad', true);
  end if;
  if not exists (select 1 from public.play_sessions s
                  where s.user_id = v_uid and s.game_id = p_game_id
                    and s.started_at > now() - interval '24 hours'
                    and (s.ended_at is null or s.ended_at > now() - interval '5 minutes')) then
    raise exception 'NOT_FOUND: no active play session for this game' using errcode = 'no_data_found';
  end if;
  if not public.take_rate_limit_token(v_uid, 'unlock_achievement', 60, 60.0 / 3600) then
    raise exception 'RATE_LIMITED: too many achievements unlocked, try again later';
  end if;
  insert into public.user_achievements (user_id, achievement_id)
    values (v_uid, v_achievement.id)
  on conflict (user_id, achievement_id) do nothing
  returning true into v_inserted;
  if v_inserted then
    perform private.award_coins(v_uid, coalesce(v_achievement.coins, private.coin_rule('achievement')), 'achievement',
                                v_achievement.game_id || ':' || v_achievement.key, v_achievement.game_id,
                                v_achievement.title);
    perform private.award_xp(v_uid, private.progress_rule('achievement'), 'achievement',
                             v_achievement.game_id || ':' || v_achievement.key, v_achievement.game_id,
                             v_achievement.title);
  end if;
  return jsonb_build_object('unlocked', true, 'alreadyHad', v_inserted is null);
end $$;

-- As in 20261031000400_coins.sql, plus, for a valid run (accepted or 'not_best'), right after its coins: rule 'solo'
-- XP once per play session (ref = the session id), capped at rule 'solo_daily_cap' per UTC day, and the run counts
-- toward today's daily challenges (ref 'solo:<session id>'; 'score' challenges read p_score). Refused runs earn
-- nothing and count for nothing. The answer is unchanged.
create or replace function public.submit_solo_score(
  p_game_id text, p_board_key text, p_score double precision, p_session_id uuid
)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_board public.leaderboards;
  v_session public.play_sessions;
  v_pk text;
  v_elapsed_s double precision;
  v_played_s double precision;
  v_current double precision;
  v_reason text;
  v_written boolean;
  v_primary uuid;
  v_rank int;
  v_title text;
begin
  if not exists (select 1 from public.games where id = p_game_id and status = 'published') then
    raise exception 'NOT_FOUND: game %', coalesce(p_game_id, 'null') using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from public.games where id = p_game_id and 'solo' = any (modes)) then
    raise exception 'INVALID: % is not a solo game', p_game_id using errcode = 'invalid_parameter_value';
  end if;
  select * into v_board from public.leaderboards where game_id = p_game_id and key = p_board_key;
  if not found then
    raise exception 'NOT_FOUND: leaderboard %', coalesce(p_board_key, 'null') using errcode = 'no_data_found';
  end if;
  if v_board.mode <> 'best' then
    raise exception 'INVALID: leaderboard % is not a best-score board', p_board_key using errcode = 'invalid_parameter_value';
  end if;
  if p_score is null or p_score in ('NaN', 'Infinity', '-Infinity') or p_score < 0 then
    raise exception 'INVALID: score must be a finite number >= 0' using errcode = 'invalid_parameter_value';
  end if;
  if v_board.sort = 'asc' and p_score <= 0 then
    raise exception 'INVALID: score must be > 0 on an ascending board' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_session from public.play_sessions where id = p_session_id and user_id = v_uid;
  if not found then
    raise exception 'NOT_FOUND: play session' using errcode = 'no_data_found';
  end if;
  if v_session.game_id <> p_game_id then
    raise exception 'INVALID: the play session is for another game' using errcode = 'invalid_parameter_value';
  end if;

  v_pk := public.period_key(v_board.period, now());
  select score into v_current from public.leaderboard_entries
    where leaderboard_id = v_board.id and period_key = v_pk and user_id = v_uid
    for update;

  v_elapsed_s := extract(epoch from now() - v_session.started_at);
  v_played_s := least(extract(epoch from coalesce(v_session.ended_at, now()) - v_session.started_at), 7200);
  if not public.take_rate_limit_token(v_uid, 'submit_solo_score', 30, 0.5) then
    v_reason := 'rate_limited';
  elsif v_elapsed_s < 3 then
    v_reason := 'session_too_new';
  elsif v_elapsed_s >= 86400 or v_session.ended_at < now() - interval '5 minutes' then
    v_reason := 'session_expired';
  elsif v_board.max_score_per_minute is not null
        and p_score > v_board.max_score_per_minute * greatest(1, ceil(v_played_s / 60)) then
    v_reason := 'bounds';
  elsif v_current is not null
        and ((v_board.sort = 'desc' and p_score <= v_current) or (v_board.sort = 'asc' and p_score >= v_current)) then
    v_reason := 'not_best';
  end if;

  if v_reason is null then
    insert into public.leaderboard_entries as e (leaderboard_id, period_key, user_id, score, source, updated_at)
      values (v_board.id, v_pk, v_uid, p_score, 'client', now())
    on conflict (leaderboard_id, period_key, user_id) do update
      set score = excluded.score, source = 'client', updated_at = now()
      where (v_board.sort = 'desc' and excluded.score > e.score) or (v_board.sort = 'asc' and excluded.score < e.score)
    returning true into v_written;

    if v_written then
      v_current := p_score;
      -- game_stats.best_score mirrors the all-time best on the game's primary (oldest) board.
      select id into v_primary from public.leaderboards where game_id = p_game_id order by created_at, id limit 1;
      if v_primary = v_board.id then
        insert into public.game_stats (user_id, game_id, best_score)
          values (v_uid, p_game_id, p_score)
        on conflict (user_id, game_id) do update
          set best_score = case
            when game_stats.best_score is null then excluded.best_score
            when v_board.sort = 'desc' then greatest(game_stats.best_score, excluded.best_score)
            else least(game_stats.best_score, excluded.best_score)
          end;
      end if;
    else
      -- A concurrent submit stored a better score first.
      v_reason := 'not_best';
      select score into v_current from public.leaderboard_entries
        where leaderboard_id = v_board.id and period_key = v_pk and user_id = v_uid;
    end if;
  end if;

  -- Coins for a valid run (once per session; the daily bonus only when this run actually paid), then XP and the
  -- daily challenges (20261101000100_progress.sql).
  if v_reason is null or v_reason = 'not_best' then
    select title into v_title from public.games where id = p_game_id;
    if private.award_coins(v_uid, private.coin_rule('solo'), 'solo', v_session.id::text, p_game_id, v_title,
                           private.coin_rule('solo_daily_cap'), array['solo']) > 0 then
      perform private.award_daily_bonus(v_uid);
    end if;
    perform private.award_xp(v_uid, private.progress_rule('solo'), 'solo', v_session.id::text, p_game_id, v_title,
                             private.progress_rule('solo_daily_cap'), array['solo']);
    perform private.lock_wallet(v_uid);                  -- lock order: wallet before the challenge rows
    perform private.challenge_event(v_uid, private.utc_today(), 'solo', 'solo:' || v_session.id::text, p_game_id,
                                    p_board_key, p_score);
  end if;

  if v_current is not null then
    select 1 + count(*) into v_rank from public.leaderboard_entries e
      where e.leaderboard_id = v_board.id and e.period_key = v_pk
        and case when v_board.sort = 'desc' then e.score > v_current else e.score < v_current end;
  end if;

  return jsonb_build_object('accepted', v_reason is null, 'best', v_current, 'rank', v_rank, 'reason', v_reason);
end $$;

-- ---------------------------------------------------------------------------
-- Client RPCs
-- ---------------------------------------------------------------------------

-- The caller's level: {level, xp_into_level, xp_for_next, total_xp, next_level_coins}. xp_into_level counts from the
-- start of the current level; xp_for_next is the size of the level (so the bar is xp_into_level / xp_for_next);
-- next_level_coins is what reaching the next level pays. Level 1 with 0 XP for a user without progress (anonymous
-- sessions included); signed out raises UNAUTHENTICATED.
create or replace function public.my_progress()
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_xp int;
  v_progress jsonb;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  select xp into v_xp from public.player_progress where user_id = v_uid;
  v_progress := private.progress_of(v_xp);
  return v_progress || jsonb_build_object('next_level_coins', private.level_coins((v_progress ->> 'level')::int + 1));
end $$;

-- A player's level for their profile: {level, xp_into_level, xp_for_next, total_xp}, or null when the caller may not
-- see their games (profiles.privacy.games: public / friends / private; a block either way hides it) or the user does
-- not exist. Callable signed out (strangers see what public_profile_games shows them).
create or replace function public.public_progress(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if p_user_id is null or not exists (select 1 from public.profiles where id = p_user_id)
     or not private.can_view(p_user_id, private.viewer(), 'games') then
    return null;
  end if;
  return private.progress_of((select xp from public.player_progress where user_id = p_user_id));
end $$;

-- The caller's daily challenges: today's three (picked on the first call of the UTC day), plus yesterday's completed
-- ones that are still unclaimed (claimable until today's reset), yesterday's first, each day by slot (easiest first).
-- resets_at = the end of the challenge's day (00:00 UTC); expires_at = the claim deadline (the end of the next day).
-- Anonymous sessions get no rows (guests earn nothing); signed out raises UNAUTHENTICATED.
create or replace function public.my_daily_challenges()
returns table (
  id uuid, day date, slot int, kind text, game_id text, title text, target int, progress int, coins int, xp int,
  completed_at timestamptz, claimed_at timestamptz, resets_at timestamptz, expires_at timestamptz
)
language plpgsql volatile security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_today date := private.utc_today();
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  if (auth.jwt() ->> 'is_anonymous')::boolean is true then
    return;
  end if;
  perform private.ensure_daily_challenges(v_uid, v_today);
  return query
    select c.id, c.day, c.slot::int, c.kind, c.game_id, c.title, c.target, c.progress, c.coins, c.xp, c.completed_at,
           c.claimed_at, (c.day + 1)::timestamp at time zone 'utc', (c.day + 2)::timestamp at time zone 'utc'
      from public.daily_challenges c
     where c.user_id = v_uid
       and (c.day = v_today or (c.day = v_today - 1 and c.completed_at is not null and c.claimed_at is null))
     order by c.day, c.slot;
end $$;

-- Claims the caller's completed challenge p_id: its coins and XP through the ledgers (reason 'challenge', ref = the
-- challenge id), once. Returns {id, coins, xp, balance, level, xp_into_level, xp_for_next, total_xp} (coins / xp =
-- what was paid). Raises NOT_FOUND (unknown, or not the caller's), ALREADY_CLAIMED, NOT_COMPLETE, EXPIRED (its day
-- and the next have passed), RATE_LIMITED (20 per minute), UNAUTHENTICATED / ANONYMOUS_FORBIDDEN. The wallet is
-- locked first (lock order), then the challenge row, so concurrent claims of one challenge pay once.
create or replace function public.claim_daily_challenge(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_challenge public.daily_challenges;
  v_coins int;
  v_xp int;
begin
  if not public.take_rate_limit_token(v_uid, 'claim_daily_challenge', 20, 20.0 / 60) then
    raise exception 'RATE_LIMITED: too many claims, try again later';
  end if;
  perform private.lock_wallet(v_uid);
  select * into v_challenge from public.daily_challenges where id = p_id and user_id = v_uid for update;
  if v_challenge.id is null then
    raise exception 'NOT_FOUND: challenge' using errcode = 'no_data_found';
  end if;
  if v_challenge.claimed_at is not null then
    raise exception 'ALREADY_CLAIMED: this challenge was already claimed';
  end if;
  if v_challenge.completed_at is null then
    raise exception 'NOT_COMPLETE: % of % so far', v_challenge.progress, v_challenge.target;
  end if;
  if v_challenge.day < private.utc_today() - 1 then
    raise exception 'EXPIRED: challenges can be claimed until the end of the next day';
  end if;
  update public.daily_challenges set claimed_at = now(), updated_at = now() where id = v_challenge.id;
  v_coins := private.award_coins(v_uid, v_challenge.coins, 'challenge', v_challenge.id::text, v_challenge.game_id,
                                 v_challenge.title);
  v_xp := private.apply_xp(v_uid, v_challenge.xp, 'challenge', v_challenge.id::text, v_challenge.game_id,
                           v_challenge.title);
  return jsonb_build_object(
    'id', v_challenge.id,
    'coins', v_coins,
    'xp', v_xp,
    'balance', (select balance from public.wallets where user_id = v_uid)
  ) || private.progress_of((select xp from public.player_progress where user_id = v_uid));
end $$;

-- ---------------------------------------------------------------------------
-- Retention: pg_cron job purge-progress. Same pattern as 20261030000400_hardening.sql: where pg_cron is unavailable
-- (PGlite, some plans) only a NOTICE is raised; cron.schedule with a job name is an upsert, so re-running is safe.
-- ---------------------------------------------------------------------------

do $outer$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available: old XP rows and daily challenges will not be purged automatically';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    execute format('select cron.schedule(%L, %L, %L)', 'purge-progress', '7 5 * * *', 'select private.purge_progress_rows()');
  exception when others then
    raise notice 'could not schedule the purge-progress job (%): %', sqlstate, sqlerrm;
  end;
end $outer$;

-- ---------------------------------------------------------------------------
-- Privileges (explicit, as in 20261029000100_m1_grants.sql)
-- ---------------------------------------------------------------------------

revoke all on public.progress_rules, public.player_progress, public.xp_ledger, public.challenge_templates,
  public.daily_challenges from anon, authenticated;
grant select on public.progress_rules, public.challenge_templates to anon, authenticated;
grant select on public.player_progress, public.xp_ledger, public.daily_challenges to authenticated;
grant all on public.progress_rules, public.player_progress, public.xp_ledger, public.challenge_templates,
  public.daily_challenges to service_role;
revoke all on sequence public.xp_ledger_id_seq from anon, authenticated;
grant usage, select on sequence public.xp_ledger_id_seq to service_role;

revoke all on function
  public.my_progress(),
  public.public_progress(uuid),
  public.my_daily_challenges(),
  public.claim_daily_challenge(uuid)
from public, anon, authenticated;
grant execute on function public.public_progress(uuid) to anon, authenticated, service_role;
grant execute on function public.my_progress(), public.my_daily_challenges(), public.claim_daily_challenge(uuid)
  to authenticated, service_role;

-- create or replace kept these grants; restated so this file stands on its own.
revoke all on function public.server_record_match(jsonb) from public, anon, authenticated;
grant execute on function public.server_record_match(jsonb) to service_role;
revoke all on function public.submit_solo_score(text, text, double precision, uuid) from public, anon;
grant execute on function public.submit_solo_score(text, text, double precision, uuid) to authenticated, service_role;
revoke all on function public.unlock_achievement(text, text) from public, anon;
grant execute on function public.unlock_achievement(text, text) to authenticated, service_role;
