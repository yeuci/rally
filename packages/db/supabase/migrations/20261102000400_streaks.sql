-- Rally daily play streak (M6 "Progression"; docs/progress.md "Daily play streak"): consecutive UTC days with at least
-- one counted game, a climbing coin bonus and a little XP on each day the streak grows. Built on the coin economy
-- (20261031000400_coins.sql) and account progress (20261101000100_progress.sql). Pinned by test/streaks.test.ts.
--
--   * progress_rules     eight more rows: streak_coins_1 .. streak_coins_7, the coins paid on days 1-7 of a streak (day 8
--                        and on pay streak_coins_7), and streak_xp, the XP paid with each of them. Read with
--                        private.streak_coins(day) / private.progress_rule('streak_xp'); tune with an UPDATE in Studio.
--   * player_streaks     one row per user who ever played a counted game: current (consecutive days up to
--                        last_played_on), longest (ever), last_played_on (the UTC day of the latest counted game) and
--                        bonus_paid_on (the UTC day the latest bonus was paid). Owner-read only; written only by
--                        private.count_streak_day.
--   * What counts: exactly the games that pay XP for playing, an xp_ledger row with reason 'match' (an eligible player
--     of a counted multiplayer match) or 'solo' (a valid solo run). Those rows are written by server_record_match and
--     submit_solo_score (20261101000100_progress.sql); this migration touches neither function. A trigger on xp_ledger
--     counts the row's UTC day toward the earner's streak instead. The daily XP caps do not matter: a capped player
--     already played, and was counted, earlier that day. Guests, anonymous sessions, short and private-alone matches
--     and refused solo runs never get such a row, so they never count.
--   * Days: the UTC day of the ledger row (created_at = now() of the recording transaction), the boundary of the daily
--     bonus and the daily challenges. The first counted game of a day grows the streak: current + 1 when
--     last_played_on is yesterday, else 1 (a missed day resets it; longest is kept). Later games that day change
--     nothing.
--   * The bonus: each day the streak grows pays private.streak_coins(current) coins (coin_ledger reason 'streak') and
--     rule 'streak_xp' XP (xp_ledger reason 'streak'), both with ref = the UTC date, so a day pays once whatever
--     happens (the ledgers' UNIQUE (user_id, reason, ref)). The XP goes through private.apply_xp like any other award,
--     so a level-up it causes pays its coins and sends its 'level' event as usual.
--   * Trigger timing and LOCK ORDER. xp_ledger_streak is a DEFERRABLE INITIALLY DEFERRED constraint trigger (AFTER
--     INSERT, FOR EACH ROW, WHEN reason in ('match', 'solo')): it runs at COMMIT of the transaction that wrote the row,
--     after server_record_match / submit_solo_score have returned, never in the middle of private.apply_xp. (An
--     immediate AFTER INSERT trigger would run between apply_xp's ledger insert and its player_progress update, and a
--     nested apply_xp there would have its XP overwritten by the outer update.) At commit the transaction still holds
--     every lock it took, in particular the earner's WALLET lock (private.lock_wallet, which every coin, XP and
--     challenge write takes first), so paying through private.apply_coins / private.apply_xp re-enters locks the
--     transaction already owns. private.count_streak_day itself takes the wallet lock first, then the player_streaks
--     row: the economy keeps its one order, wallet, then progress / challenge / streak rows, and server_record_match
--     still locks its players' wallets in user-id order before anything else, so nothing deadlocks. A failure in the
--     trigger rolls the whole match or run back, as a failing coin or XP write does today.
--   * Realtime: event 'streak' on the private topic user:<uid> (same delivery rules as 'coins' and 'progress'), once per
--     day the streak grows: {type: 'streak', current, longest, last_played_on, coins, xp, at}. The bonus is also
--     announced as 'coins' and 'progress' events with reason 'streak'.
--   * my_streak(): {current, longest, last_played_on, today_done, next_coins, next_xp} for the caller. current reads 0
--     once a day was missed (the stored row is reset by the next counted game); next_* is what the next day's first
--     game pays. Zeros for an anonymous session or a user without a row; signed out raises UNAUTHENTICATED.
--   * Account deletion: player_streaks.user_id cascades from profiles (delete_my_account, 20261102000100_moderation.sql:
--     personal data, nobody else needs it). Retention: 'streak' ledger rows are purged with the other earn rows after
--     365 days; refs are past dates, so none can pay again, and player_streaks stays authoritative.
--
-- Signatures and results of every existing function are unchanged. Errors as in m2: UNAUTHENTICATED (42501).

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------

insert into public.progress_rules (key, value, description) values
  ('streak_coins_1', 10, 'Coins for day 1 of a play streak: the first counted game after a missed day (or ever).'),
  ('streak_coins_2', 15, 'Coins for day 2 of a play streak.'),
  ('streak_coins_3', 20, 'Coins for day 3 of a play streak.'),
  ('streak_coins_4', 30, 'Coins for day 4 of a play streak.'),
  ('streak_coins_5', 40, 'Coins for day 5 of a play streak.'),
  ('streak_coins_6', 50, 'Coins for day 6 of a play streak.'),
  ('streak_coins_7', 75, 'Coins for day 7 of a play streak, and for every day after it.'),
  ('streak_xp', 10, 'XP paid with each day''s streak bonus.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The streak row and the new ledger reason
-- ---------------------------------------------------------------------------

create table public.player_streaks (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  current int not null default 0,                        -- consecutive UTC days ending on last_played_on
  longest int not null default 0,
  last_played_on date,                                   -- the UTC day of the latest counted game
  bonus_paid_on date,                                    -- the UTC day the latest streak bonus was paid
  updated_at timestamptz not null default now(),
  constraint player_streaks_current check (current >= 0),
  constraint player_streaks_longest check (longest >= current),
  constraint player_streaks_played check ((current = 0) = (last_played_on is null))
);
alter table public.player_streaks enable row level security;
create policy "users read their own streak" on public.player_streaks
  for select to authenticated using (user_id = (select auth.uid()));
create trigger player_streaks_updated_at before update on public.player_streaks
  for each row execute function public.set_updated_at();

-- The streak bonus pays through both ledgers (ref = the UTC date).
alter table public.coin_ledger drop constraint coin_ledger_reason;
alter table public.coin_ledger add constraint coin_ledger_reason check (reason in (
  'match', 'win', 'podium', 'achievement', 'solo', 'daily', 'purchase', 'adjustment', 'level', 'challenge', 'streak'
));
alter table public.xp_ledger drop constraint xp_ledger_reason;
alter table public.xp_ledger add constraint xp_ledger_reason check (reason in (
  'match', 'win', 'solo', 'achievement', 'challenge', 'adjustment', 'streak'
));

-- ---------------------------------------------------------------------------
-- Internal helpers (schema private: no client access)
-- ---------------------------------------------------------------------------

-- Coins for day p_day of a streak: rule 'streak_coins_<day>' for days 1-7, 'streak_coins_7' from day 7 on; 0 below day 1.
create or replace function private.streak_coins(p_day int)
returns int language sql stable set search_path = public, extensions as $$
  select case when coalesce(p_day, 0) < 1 then 0
              else private.progress_rule('streak_coins_' || least(p_day, 7)::text) end;
$$;

-- Realtime: p_payload to the user's private topic user:<uid>, event 'streak'. Same delivery rules as
-- private.broadcast_progress: no-op without realtime.send (PGlite, a stack without Realtime); a failing send raises a
-- WARNING and never fails the award (the app also refetches on focus).
create or replace function private.broadcast_streak(p_user_id uuid, p_payload jsonb)
returns void language plpgsql volatile security definer set search_path = public, extensions, realtime as $$
begin
  if p_user_id is null or to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then
    return;
  end if;
  begin
    perform realtime.send(p_payload, 'streak', 'user:' || p_user_id::text, true);
  exception when others then
    raise warning 'realtime.send failed for streak to user:% (%): %', p_user_id, sqlstate, sqlerrm;
  end;
end $$;

-- Counts a game played on p_day (UTC) toward p_user_id's streak: the first game of a day grows it (current + 1 after
-- yesterday, else 1), keeps the longest, pays the day's bonus once (coins per private.streak_coins, XP per rule
-- 'streak_xp'; refs = the date) and sends the 'streak' event. A later game the same day (or an older day) changes
-- nothing. Lock order: the wallet first (private.lock_wallet), then the player_streaks row.
create or replace function private.count_streak_day(p_user_id uuid, p_day date)
returns void language plpgsql volatile set search_path = public, extensions as $$
declare
  v public.player_streaks;
  v_current int;
  v_ref text;
  v_coins int := 0;
  v_xp int := 0;
begin
  if p_user_id is null or p_day is null then
    return;
  end if;
  perform private.lock_wallet(p_user_id);
  insert into public.player_streaks (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into v from public.player_streaks where user_id = p_user_id for update;
  if v.last_played_on is not null and v.last_played_on >= p_day then
    return;
  end if;
  v_current := case when v.last_played_on = p_day - 1 then v.current + 1 else 1 end;
  update public.player_streaks
     set current = v_current,
         longest = greatest(longest, v_current),
         last_played_on = p_day
   where user_id = p_user_id;
  if v.bonus_paid_on is null or v.bonus_paid_on < p_day then
    v_ref := to_char(p_day, 'YYYY-MM-DD');
    v_coins := private.award_coins(p_user_id, private.streak_coins(v_current), 'streak', v_ref, null, 'Day ' || v_current);
    v_xp := private.apply_xp(p_user_id, private.progress_rule('streak_xp'), 'streak', v_ref, null, 'Day ' || v_current);
    if v_coins > 0 or v_xp > 0 then
      update public.player_streaks set bonus_paid_on = p_day where user_id = p_user_id;
    end if;
  end if;
  perform private.broadcast_streak(p_user_id, jsonb_build_object(
    'type', 'streak',
    'current', v_current,
    'longest', greatest(v.longest, v_current),
    'last_played_on', to_char(p_day, 'YYYY-MM-DD'),
    'coins', v_coins,
    'xp', v_xp,
    'at', private.iso_now()
  ));
end $$;

-- The trigger body: the row's UTC day counts toward the earner's streak. Security definer, like the broadcast
-- triggers: a deferred trigger fires at commit, outside the security definer RPC that queued it, and the private
-- helpers it calls are not executable by the request's role.
create or replace function private.xp_ledger_count_streak()
returns trigger language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  perform private.count_streak_day(new.user_id, (new.created_at at time zone 'utc')::date);
  return null;
end $$;
-- Deferred to commit: see the header (never inside private.apply_xp; the wallet lock is still held).
create constraint trigger xp_ledger_streak after insert on public.xp_ledger
  deferrable initially deferred
  for each row when (new.reason in ('match', 'solo'))
  execute function private.xp_ledger_count_streak();

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Client RPC
-- ---------------------------------------------------------------------------

-- The caller's streak: {current, longest, last_played_on, today_done, next_coins, next_xp}. current is 0 once a day was
-- missed (last_played_on before yesterday); today_done says a counted game was played today (UTC); next_coins /
-- next_xp are what the next day's first game pays (today's, or tomorrow's when today is done). Zeros for a user
-- without a row (anonymous sessions included); signed out raises UNAUTHENTICATED.
create or replace function public.my_streak()
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v public.player_streaks;
  v_today date := private.utc_today();
  v_current int;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  select * into v from public.player_streaks where user_id = v_uid;
  v_current := case when v.last_played_on >= v_today - 1 then v.current else 0 end;
  return jsonb_build_object(
    'current', v_current,
    'longest', coalesce(v.longest, 0),
    'last_played_on', case when v.last_played_on is not null then to_char(v.last_played_on, 'YYYY-MM-DD') end,
    'today_done', coalesce(v.last_played_on = v_today, false),
    'next_coins', private.streak_coins(v_current + 1),
    'next_xp', private.progress_rule('streak_xp')
  );
end $$;

-- ---------------------------------------------------------------------------
-- Privileges (explicit, as in 20261029000100_m1_grants.sql)
-- ---------------------------------------------------------------------------

revoke all on public.player_streaks from anon, authenticated;
grant select on public.player_streaks to authenticated;
grant all on public.player_streaks to service_role;

revoke all on function public.my_streak() from public, anon, authenticated;
grant execute on function public.my_streak() to authenticated, service_role;
