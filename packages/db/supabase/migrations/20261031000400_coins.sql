-- Rally coins (M6 "Progression"; docs/coins.md): players earn coins by playing and spend them in a shop. Earn-only:
-- there is no way to buy coins with money. Pinned by test/coins.test.ts.
--
--   * coin_rules       every amount, cap and threshold of the economy, one row each (key -> value). Read with
--                      private.coin_rule(key); tune with an UPDATE in Studio, no migration needed. Readable by clients
--                      (the shop explains how to earn), written only by the service role / Studio.
--   * wallets          one row per user who ever earned or spent: the balance (never negative, check constraint) and
--                      lifetime earnings. Owner-read only; written only by private.apply_coins.
--   * coin_ledger      append-only history of every change: signed amount, reason, ref, the balance after it. UNIQUE
--                      (user_id, reason, ref), so the same match, achievement, solo run, UTC day or item can never pay
--                      (or charge) twice. Owner-read only; written only by private.apply_coins; UPDATE is refused by a
--                      trigger. Earn rows older than 365 days are purged daily (purchases are kept); the wallet stays
--                      authoritative and every remaining row carries its balance_after.
--   * private.apply_coins is the single writer: it locks the wallet row (SELECT ... FOR UPDATE), skips a (reason, ref)
--     already applied, refuses to go below zero (INSUFFICIENT_FUNDS), appends the ledger row and updates the balance in
--     the same transaction. Every award or purchase serialises on that row lock; server_record_match locks its players'
--     wallets in user-id order first, so two matches with overlapping players cannot deadlock.
--   * Earning happens only inside trusted paths (clients can never grant themselves coins):
--       match        server_record_match (service role), per eligible player of a counted match: rule 'match'.
--                    Counted = durationSec >= 'match_min_duration_s' and (public, or private with >= 2 eligible
--                    players), the same anti-boost rule as the server leaderboards. ref = matchId.
--       win          + rule 'win' for winnerUserId (exactly the player game_stats counts a win for). ref = matchId.
--       podium       + rule 'podium' for placement 2 or 3 in a competitive match (one with a declared winner, guest
--                    included) of at least 'podium_min_players' players. Co-op runs (Overrun: winnerUserId null) pay
--                    participation only. ref = matchId.
--                    match + win + podium together are capped at 'match_daily_cap' per player per UTC day.
--       achievement  a one-time bonus per newly unlocked achievement (unlock_achievement for solo games,
--                    server_record_match for multiplayer): achievements.coins, or rule 'achievement' when null.
--                    ref = '<game_id>:<key>'.
--       solo         submit_solo_score, when the run passes the server's checks (accepted, or 'not_best': a valid run
--                    that did not beat the stored best): rule 'solo', once per play session (ref = session id), capped
--                    at 'solo_daily_cap' per UTC day because solo scores are client-reported.
--       daily        the first counted match or paid-for solo run of the UTC day: rule 'daily'. ref = 'YYYY-MM-DD'.
--     Guests and anonymous sessions never earn (server_record_match skips them; the solo RPCs refuse them).
--   * Realtime: every award (amount > 0, never a purchase) is broadcast by an AFTER INSERT trigger on coin_ledger to the
--     private topic user:<uid>, event 'coins', like the friend-request events (20261031000200_social_realtime.sql):
--     { type: 'coins', id, amount, reason, balance, game_id, note, at }.
--   * Shop: shop_items (kind name_color | avatar_frame | profile_banner | badge | game_unlock; data jsonb checked per
--     kind; v1 seeds cosmetics only, no game_unlock), user_items (ownership, permanent) and equipped_items (one per
--     equippable kind; foreign keys guarantee the user owns the item and the kind matches). Writes only through
--     buy_item / equip_item. Equipped cosmetics are public through public_cosmetics(uuid[]) (blocks hide them both
--     ways); balances, ledgers and inventories are owner-only.
--   * owns_game(user, game): true when no available game_unlock item points at the game (free games stay free),
--     otherwise only when the user owns a game_unlock item for it. Nothing calls it yet (enforcement is a follow-up).
--
-- Function signatures that existed before are unchanged, and so are their results (coins are reported through
-- Realtime and read from wallets / coin_ledger, not added to server_record_match or submit_solo_score answers).
-- Errors as in m2: UNAUTHENTICATED / ANONYMOUS_FORBIDDEN (42501), NOT_FOUND (P0002), INVALID (22023),
-- RATE_LIMITED (P0001), plus INSUFFICIENT_FUNDS (P0001) from buy_item.

-- ---------------------------------------------------------------------------
-- Economy rules
-- ---------------------------------------------------------------------------

create table public.coin_rules (
  key text primary key,
  value int not null,
  description text not null default '',
  updated_at timestamptz not null default now(),
  constraint coin_rules_key check (key ~ '^[a-z][a-z0-9_]{0,47}$'),
  constraint coin_rules_value check (value between 0 and 1000000)
);
alter table public.coin_rules enable row level security;
create policy "coin rules are public" on public.coin_rules for select to anon, authenticated using (true);
create trigger coin_rules_updated_at before update on public.coin_rules
  for each row execute function public.set_updated_at();

insert into public.coin_rules (key, value, description) values
  ('match', 10, 'Every counted multiplayer match (participation), per eligible player.'),
  ('win', 25, 'Extra for the winner of a counted match (the player game_stats counts a win for).'),
  ('podium', 10, 'Extra for placement 2 or 3 in a counted competitive match (one with a declared winner).'),
  ('podium_min_players', 4, 'Players a match needs (guests included) before 2nd and 3rd place pay the podium bonus.'),
  ('match_min_duration_s', 20, 'Matches shorter than this many seconds pay nothing (same floor as the server boards).'),
  ('match_daily_cap', 500, 'Most coins one player earns from match + win + podium per UTC day.'),
  ('achievement', 25, 'One-time bonus per unlocked achievement unless achievements.coins overrides it.'),
  ('solo', 5, 'Each valid solo run (a score submit_solo_score accepts), once per play session.'),
  ('solo_daily_cap', 50, 'Most coins one player earns from solo runs per UTC day.'),
  ('daily', 50, 'Bonus for the first counted match or paid solo run of the UTC day.');

-- Per-achievement override of the 'achievement' rule (null = the rule). tooling/publish-game does not send it, so its
-- upserts keep working and leave a value set in Studio alone.
alter table public.achievements add column coins int;
alter table public.achievements add constraint achievements_coins check (coins is null or coins between 0 and 10000);
comment on column public.achievements.coins is 'One-time coin bonus on unlock; null = coin_rules.achievement.';

-- ---------------------------------------------------------------------------
-- Wallets and the ledger
-- ---------------------------------------------------------------------------

create table public.wallets (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  balance int not null default 0,
  lifetime_earned int not null default 0,
  updated_at timestamptz not null default now(),
  constraint wallets_balance_nonnegative check (balance >= 0),
  constraint wallets_lifetime_nonnegative check (lifetime_earned >= 0)
);
alter table public.wallets enable row level security;
create policy "users read their own wallet" on public.wallets
  for select to authenticated using (user_id = (select auth.uid()));

create table public.coin_ledger (
  id bigserial primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  amount int not null,
  reason text not null,
  ref text not null,                                     -- idempotency key within (user, reason)
  game_id text references public.games (id) on delete set null,
  note text,                                             -- display text: game title, achievement title, item name
  balance_after int not null,
  created_at timestamptz not null default now(),
  constraint coin_ledger_once unique (user_id, reason, ref),
  constraint coin_ledger_amount check (amount <> 0),
  constraint coin_ledger_reason check (reason in ('match', 'win', 'podium', 'achievement', 'solo', 'daily', 'purchase', 'adjustment')),
  constraint coin_ledger_sign check (reason = 'adjustment' or (reason = 'purchase') = (amount < 0)),
  constraint coin_ledger_ref check (char_length(ref) between 1 and 200),
  constraint coin_ledger_note check (note is null or char_length(note) <= 80),
  constraint coin_ledger_balance check (balance_after >= 0)
);
alter table public.coin_ledger enable row level security;
create policy "users read their own coin history" on public.coin_ledger
  for select to authenticated using (user_id = (select auth.uid()));
-- History pages (newest first) and the daily caps (today's rows of one user).
create index coin_ledger_user_idx on public.coin_ledger (user_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Shop
-- ---------------------------------------------------------------------------

create table public.shop_items (
  id text primary key,                                   -- stable slug ('frame-ember')
  kind text not null,
  name text not null,
  description text not null default '',
  price int not null,
  data jsonb not null default '{}'::jsonb,               -- per kind, checked by private.shop_items_validate
  available boolean not null default true,               -- false = retired: no longer sold, owners keep it
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (id, kind),                                     -- target of equipped_items' (item_id, kind) foreign key
  constraint shop_items_id check (id ~ '^[a-z0-9][a-z0-9_-]{1,47}$'),
  constraint shop_items_kind check (kind in ('name_color', 'avatar_frame', 'profile_banner', 'badge', 'game_unlock')),
  constraint shop_items_name check (char_length(name) between 1 and 40),
  constraint shop_items_description check (char_length(description) <= 200),
  constraint shop_items_price check (price between 0 and 1000000),
  constraint shop_items_data check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 2048)
);
alter table public.shop_items enable row level security;
-- At most one game_unlock item on sale per game (owns_game reads "the" item; a price change retires the old one).
create unique index shop_items_game_unlock_idx on public.shop_items ((data ->> 'game_id'))
  where kind = 'game_unlock' and available;
create index shop_items_sort_idx on public.shop_items (kind, sort, price, id);

create table public.user_items (
  user_id uuid not null references public.profiles (id) on delete cascade,
  item_id text not null references public.shop_items (id) on delete restrict,   -- retire items, never delete owned ones
  price_paid int not null default 0,
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id),
  constraint user_items_price_paid check (price_paid >= 0)
);
alter table public.user_items enable row level security;
create index user_items_item_idx on public.user_items (item_id);
create policy "users read their own items" on public.user_items
  for select to authenticated using (user_id = (select auth.uid()));

-- Items on sale, plus retired ones the caller owns (so an inventory never loses its rows).
create policy "shop items on sale or owned are readable" on public.shop_items
  for select to authenticated
  using (available or exists (select 1 from public.user_items u where u.item_id = shop_items.id and u.user_id = (select auth.uid())));

create table public.equipped_items (
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  item_id text not null,
  equipped_at timestamptz not null default now(),
  primary key (user_id, kind),
  constraint equipped_items_kind check (kind in ('name_color', 'avatar_frame', 'profile_banner', 'badge')),
  -- Only owned items, and only in their own kind's slot.
  constraint equipped_items_owned foreign key (user_id, item_id) references public.user_items (user_id, item_id) on delete cascade,
  constraint equipped_items_kind_fkey foreign key (item_id, kind) references public.shop_items (id, kind)
);
alter table public.equipped_items enable row level security;
create index equipped_items_item_idx on public.equipped_items (item_id, kind);
create policy "users read their own equipped items" on public.equipped_items
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Internal helpers (schema private: no client access)
-- ---------------------------------------------------------------------------

-- A coin_rules value; 0 for a missing key (an award that is not configured pays nothing rather than failing the RPC).
create or replace function private.coin_rule(p_key text)
returns int language sql stable set search_path = public, extensions as $$
  select coalesce((select value from public.coin_rules where key = p_key), 0);
$$;

-- 00:00 UTC of the current transaction's day: the daily caps and the daily bonus roll over there.
create or replace function private.utc_day_start()
returns timestamptz language sql stable set search_path = public, extensions as $$
  select ((now() at time zone 'utc')::date)::timestamp at time zone 'utc';
$$;

-- Creates the user's wallet if needed and locks it for the rest of the transaction; returns the balance.
create or replace function private.lock_wallet(p_user_id uuid)
returns int language plpgsql volatile set search_path = public, extensions as $$
declare
  v_balance int;
begin
  insert into public.wallets (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select balance into v_balance from public.wallets where user_id = p_user_id for update;
  return v_balance;
end $$;

-- Locks several wallets in user-id order (callers that award more than one user: no lock-order deadlocks).
create or replace function private.lock_wallets(p_user_ids uuid[])
returns void language plpgsql volatile set search_path = public, extensions as $$
declare
  u uuid;
begin
  for u in select distinct x from unnest(coalesce(p_user_ids, '{}')) as x where x is not null order by x loop
    perform private.lock_wallet(u);
  end loop;
end $$;

-- The only writer of wallets and coin_ledger. Applies p_amount (signed, non-zero) to p_user_id's wallet under its row
-- lock and appends the ledger row. Returns the new balance, or null when nothing changed: p_amount is 0 / null, or
-- (p_user_id, p_reason, p_ref) was already applied. Raises INSUFFICIENT_FUNDS when the balance would go below zero.
create or replace function private.apply_coins(
  p_user_id uuid, p_amount int, p_reason text, p_ref text, p_game_id text default null, p_note text default null
)
returns int language plpgsql volatile set search_path = public, extensions as $$
declare
  v_balance int;
  v_id bigint;
begin
  if p_user_id is null or p_amount is null or p_amount = 0 then
    return null;
  end if;
  v_balance := private.lock_wallet(p_user_id);
  if exists (select 1 from public.coin_ledger where user_id = p_user_id and reason = p_reason and ref = p_ref) then
    return null;
  end if;
  if v_balance + p_amount < 0 then
    raise exception 'INSUFFICIENT_FUNDS: needs % coins, the balance is %', -p_amount, v_balance;
  end if;
  insert into public.coin_ledger (user_id, amount, reason, ref, game_id, note, balance_after)
    values (p_user_id, p_amount, p_reason, p_ref,
            case when p_game_id is not null and exists (select 1 from public.games where id = p_game_id) then p_game_id end,
            nullif(left(p_note, 80), ''), v_balance + p_amount)
  on conflict (user_id, reason, ref) do nothing
  returning id into v_id;
  if v_id is null then
    return null;
  end if;
  update public.wallets
     set balance = v_balance + p_amount,
         lifetime_earned = lifetime_earned + case when p_amount > 0 and p_reason <> 'purchase' then p_amount else 0 end,
         updated_at = now()
   where user_id = p_user_id;
  return v_balance + p_amount;
end $$;

-- Awards up to p_amount (> 0) coins for an earn reason. With p_cap, the award is cut so that today's (UTC) earnings
-- for p_cap_reasons stay <= p_cap (nothing at all once the cap is reached). Returns the coins actually awarded: 0 when
-- capped, not configured, or (user, reason, ref) was already paid.
create or replace function private.award_coins(
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
  perform private.lock_wallet(p_user_id);
  if p_cap is not null then
    select coalesce(sum(amount), 0)::int into v_today
      from public.coin_ledger
     where user_id = p_user_id and reason = any (coalesce(p_cap_reasons, array[p_reason]))
       and created_at >= private.utc_day_start();
    v_amount := least(v_amount, greatest(p_cap - v_today, 0));
    if v_amount <= 0 then
      return 0;
    end if;
  end if;
  if private.apply_coins(p_user_id, v_amount, p_reason, p_ref, p_game_id, p_note) is null then
    return 0;
  end if;
  return v_amount;
end $$;

-- The daily bonus: rule 'daily' once per user per UTC day (ref = the date). Returns the coins awarded (0 if already).
create or replace function private.award_daily_bonus(p_user_id uuid)
returns int language sql volatile set search_path = public, extensions as $$
  select private.award_coins(p_user_id, private.coin_rule('daily'), 'daily',
                             to_char(now() at time zone 'utc', 'YYYY-MM-DD'));
$$;

-- shop_items.data per kind (unknown extra keys are allowed and ignored by the app):
--   name_color      {color: '#RRGGBB', light?: '#RRGGBB'}            light = the colour on the light theme
--   avatar_frame    {colors: ['#RRGGBB', ...]} (1..4)                a ring, a sweep through the colours
--   profile_banner  {colors: ['#RRGGBB', ...]} (2..3)                a gradient behind the profile header
--   badge           {icon: 'lucide-name', color: '#RRGGBB', light?}  an icon next to the name
--   game_unlock     {game_id: '<games.id>'}                          an existing game
create or replace function private.shop_items_validate()
returns trigger language plpgsql set search_path = public, extensions as $$
declare
  c_hex constant text := '^#[0-9A-Fa-f]{6}$';
  d jsonb := new.data;
  n int;
  lo int;
  hi int;
begin
  if jsonb_typeof(d) is distinct from 'object' then
    raise exception 'INVALID: data must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;
  if new.kind in ('name_color', 'badge') then
    if jsonb_typeof(d -> 'color') is distinct from 'string' or d ->> 'color' !~ c_hex
       or (d ? 'light' and (jsonb_typeof(d -> 'light') is distinct from 'string' or d ->> 'light' !~ c_hex)) then
      raise exception 'INVALID: % needs data.color (and optional data.light) as #RRGGBB', new.kind
        using errcode = 'invalid_parameter_value';
    end if;
  end if;
  if new.kind = 'badge'
     and (jsonb_typeof(d -> 'icon') is distinct from 'string' or d ->> 'icon' !~ '^[a-z][a-z0-9-]{1,31}$') then
    raise exception 'INVALID: badge needs data.icon, a lucide icon name' using errcode = 'invalid_parameter_value';
  end if;
  if new.kind in ('avatar_frame', 'profile_banner') then
    -- (A CASE inside an IF condition would end the condition at its THEN: bounds go through variables.)
    n := case when jsonb_typeof(d -> 'colors') = 'array' then jsonb_array_length(d -> 'colors') else 0 end;
    lo := case when new.kind = 'avatar_frame' then 1 else 2 end;
    hi := case when new.kind = 'avatar_frame' then 4 else 3 end;
    if n < lo or n > hi
       or exists (select 1 from jsonb_array_elements(d -> 'colors') c
                   where jsonb_typeof(c) is distinct from 'string' or c #>> '{}' !~ c_hex) then
      raise exception 'INVALID: % needs data.colors, % to % #RRGGBB strings', new.kind, lo, hi
        using errcode = 'invalid_parameter_value';
    end if;
  end if;
  if new.kind = 'game_unlock'
     and (jsonb_typeof(d -> 'game_id') is distinct from 'string'
          or not exists (select 1 from public.games g where g.id = d ->> 'game_id')) then
    raise exception 'INVALID: game_unlock needs data.game_id, an existing game' using errcode = 'invalid_parameter_value';
  end if;
  return new;
end $$;
create trigger shop_items_validate before insert or update of kind, data on public.shop_items
  for each row execute function private.shop_items_validate();

-- coin_ledger is append-only: rows are never changed (deletes stay possible for account deletion and retention).
create or replace function private.coin_ledger_append_only()
returns trigger language plpgsql set search_path = public, extensions as $$
begin
  raise exception 'IMMUTABLE: coin_ledger rows cannot be changed' using errcode = 'insufficient_privilege';
end $$;
create trigger coin_ledger_append_only before update on public.coin_ledger
  for each row execute function private.coin_ledger_append_only();

-- Realtime: an award (amount > 0, never a purchase) goes to the earner's private topic user:<uid>, event 'coins'.
-- Same delivery rules as private.broadcast_friendship_change: no-op without realtime.send (PGlite, a stack without
-- Realtime); a failing send raises a WARNING and never fails the award (the app also refetches on focus).
create or replace function private.broadcast_coin_award()
returns trigger language plpgsql volatile security definer set search_path = public, extensions, realtime as $$
begin
  if new.amount <= 0 or new.reason = 'purchase'
     or to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then
    return null;
  end if;
  begin
    perform realtime.send(
      jsonb_build_object(
        'type', 'coins',
        'id', new.id,
        'amount', new.amount,
        'reason', new.reason,
        'balance', new.balance_after,
        'game_id', new.game_id,
        'note', new.note,
        'at', to_char(new.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ),
      'coins',
      'user:' || new.user_id::text,
      true
    );
  exception when others then
    raise warning 'realtime.send failed for coins to user:% (%): %', new.user_id, sqlstate, sqlerrm;
  end;
  return null;
end $$;
create trigger coin_ledger_broadcast after insert on public.coin_ledger
  for each row execute function private.broadcast_coin_award();

-- Daily retention (pg_cron job purge-stale-play-sessions, scheduled in 20261030000400_hardening.sql). As in
-- 20261031000100_visits.sql, plus coin_ledger earn rows older than 365 days. Purchases stay (one per owned item, so
-- they are few); wallets keep the balance either way. Re-paying a purged ref is impossible in practice: refs are match
-- ids, session ids and past dates, and achievements only pay on a new user_achievements row.
create or replace function private.purge_stale_rows()
returns void language plpgsql volatile set search_path = public, extensions as $$
begin
  delete from public.play_sessions
   where ended_at < now() - interval '90 days'
      or (ended_at is null and started_at < now() - interval '24 hours');
  delete from public.rate_limits where refilled_at < now() - interval '1 day';
  delete from public.presence where updated_at < now() - interval '1 day';
  delete from public.game_rooms where updated_at < now() - interval '10 minutes';
  delete from public.match_results where recorded_at < now() - interval '180 days';
  delete from public.game_visits_daily where day < (now() at time zone 'utc')::date - 90;
  delete from public.coin_ledger where created_at < now() - interval '365 days' and reason <> 'purchase';
end $$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Earning: server_record_match (multiplayer), unlock_achievement and submit_solo_score (solo)
-- ---------------------------------------------------------------------------

-- As in 20261031000300_board_modes.sql (validation, idempotency, eligibility, stats, boards, achievements and the
-- result are unchanged), plus step 7, coins, for eligible players only:
--   * a counted match (durationSec >= rule 'match_min_duration_s', and public or >= 2 eligible players) pays rule
--     'match' to everyone, + rule 'win' to winnerUserId, or + rule 'podium' to placement 2 or 3 when the match has a
--     declared winner (winnerUserId not null, a guest included) and >= rule 'podium_min_players' players; match + win
--     + podium are capped at rule 'match_daily_cap' per player per UTC day; the player's first counted match of the
--     UTC day also pays the daily bonus. placement is read from the player's first players[] entry (a number).
--   * every achievement this match newly unlocked pays its one-time bonus, counted match or not.
-- The return value is unchanged.
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

  -- 7. Coins (eligible players only). The wallets of everyone about to be paid are locked first, in user-id order
  --    (private.lock_wallets), so matches recording overlapping players cannot deadlock.
  v_counted := v_duration >= private.coin_rule('match_min_duration_s') and (not v_private or cardinality(v_eligible) >= 2);
  if cardinality(v_eligible) > 0 and (v_counted or v_unlocked <> '{}'::jsonb) then
    perform private.lock_wallets(
      case when v_counted then v_eligible
           else array(select k::uuid from jsonb_object_keys(v_unlocked) as k) end);
    select title into v_title from public.games where id = v_game_id;
    if v_counted then
      v_match_cap := private.coin_rule('match_daily_cap');
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
    end loop;
  end if;

  return jsonb_build_object('duplicate', false, 'players', v_result);
end $$;

-- As in 20261031000000_m3_phase2.sql, plus the achievement's one-time coin bonus on a new unlock (achievements.coins,
-- else rule 'achievement'; ref '<game_id>:<key>'). The answer is unchanged.
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
  end if;
  return jsonb_build_object('unlocked', true, 'alreadyHad', v_inserted is null);
end $$;

-- As in 20261031000300_board_modes.sql, plus coins for a valid run: when the result is accepted, or 'not_best' (the
-- run passed every check but did not beat the stored best), rule 'solo' once per play session (ref = the session id),
-- capped at rule 'solo_daily_cap' per UTC day, and the daily bonus on the first such run of the day. Refused runs
-- (rate_limited, session_too_new, session_expired, bounds) earn nothing. The answer is unchanged.
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

  -- Coins for a valid run (once per session; the daily bonus only when this run actually paid).
  if v_reason is null or v_reason = 'not_best' then
    select title into v_title from public.games where id = p_game_id;
    if private.award_coins(v_uid, private.coin_rule('solo'), 'solo', v_session.id::text, p_game_id, v_title,
                           private.coin_rule('solo_daily_cap'), array['solo']) > 0 then
      perform private.award_daily_bonus(v_uid);
    end if;
  end if;

  if v_current is not null then
    select 1 + count(*) into v_rank from public.leaderboard_entries e
      where e.leaderboard_id = v_board.id and e.period_key = v_pk
        and case when v_board.sort = 'desc' then e.score > v_current else e.score < v_current end;
  end if;

  return jsonb_build_object('accepted', v_reason is null, 'best', v_current, 'rank', v_rank, 'reason', v_reason);
end $$;

-- ---------------------------------------------------------------------------
-- Shop RPCs
-- ---------------------------------------------------------------------------

-- The caller's coins: {balance, lifetime_earned, daily_claimed, solo_today, solo_cap, match_today, match_cap}.
-- *_today are today's (UTC) earnings toward each cap; daily_claimed: the daily bonus was paid today. Zeros for a user
-- without a wallet (anonymous sessions included); signed out raises UNAUTHENTICATED.
create or replace function public.my_wallet()
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_wallet public.wallets;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  select * into v_wallet from public.wallets where user_id = v_uid;
  return jsonb_build_object(
    'balance', coalesce(v_wallet.balance, 0),
    'lifetime_earned', coalesce(v_wallet.lifetime_earned, 0),
    'daily_claimed', exists (select 1 from public.coin_ledger
                              where user_id = v_uid and reason = 'daily'
                                and ref = to_char(now() at time zone 'utc', 'YYYY-MM-DD')),
    'solo_today', (select coalesce(sum(amount), 0)::int from public.coin_ledger
                    where user_id = v_uid and reason = 'solo' and created_at >= private.utc_day_start()),
    'solo_cap', private.coin_rule('solo_daily_cap'),
    'match_today', (select coalesce(sum(amount), 0)::int from public.coin_ledger
                     where user_id = v_uid and reason in ('match', 'win', 'podium')
                       and created_at >= private.utc_day_start()),
    'match_cap', private.coin_rule('match_daily_cap')
  );
end $$;

-- Buys shop item p_item_id for the caller: {status: 'purchased' | 'owned', item_id, balance}. Idempotent: an item the
-- caller already owns answers 'owned' and charges nothing (also when it was bought concurrently). The balance check,
-- the ledger entry (reason 'purchase', ref = the item id, amount = -price; none for a free item) and the ownership row
-- happen under the wallet's row lock, so concurrent purchases can never take the balance below zero.
-- Raises NOT_FOUND (unknown item, or not on sale), INSUFFICIENT_FUNDS (P0001: balance < price), RATE_LIMITED (20 per
-- minute), UNAUTHENTICATED / ANONYMOUS_FORBIDDEN.
create or replace function public.buy_item(p_item_id text)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_item public.shop_items;
  v_balance int;
  v_after int;
begin
  if not public.take_rate_limit_token(v_uid, 'buy_item', 20, 20.0 / 60) then
    raise exception 'RATE_LIMITED: too many purchases, try again later';
  end if;
  v_balance := private.lock_wallet(v_uid);
  if exists (select 1 from public.user_items where user_id = v_uid and item_id = p_item_id) then
    return jsonb_build_object('status', 'owned', 'item_id', p_item_id, 'balance', v_balance);
  end if;
  select * into v_item from public.shop_items where id = p_item_id and available;
  if v_item.id is null then
    raise exception 'NOT_FOUND: item %', coalesce(p_item_id, 'null') using errcode = 'no_data_found';
  end if;
  if v_balance < v_item.price then
    raise exception 'INSUFFICIENT_FUNDS: % costs % coins, the balance is %', v_item.name, v_item.price, v_balance;
  end if;
  v_after := v_balance;
  if v_item.price > 0 then
    v_after := coalesce(
      private.apply_coins(v_uid, -v_item.price, 'purchase', v_item.id,
                          case when v_item.kind = 'game_unlock' then v_item.data ->> 'game_id' end, v_item.name),
      v_balance);
  end if;
  insert into public.user_items (user_id, item_id, price_paid) values (v_uid, v_item.id, v_item.price);
  return jsonb_build_object('status', 'purchased', 'item_id', v_item.id, 'balance', v_after);
end $$;

-- Equips owned item p_item_id in slot p_kind, or empties the slot when p_item_id is null. Returns the caller's
-- equipped items {<kind>: <item id>}. p_kind: name_color | avatar_frame | profile_banner | badge (INVALID otherwise,
-- game_unlock included); the item must be the caller's (NOT_FOUND) and of that kind (INVALID). Retired items the
-- caller owns can be equipped. 30 changes per minute (RATE_LIMITED).
create or replace function public.equip_item(p_kind text, p_item_id text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_kind text;
begin
  if p_kind is null or p_kind not in ('name_color', 'avatar_frame', 'profile_banner', 'badge') then
    raise exception 'INVALID: % cannot be equipped', coalesce(p_kind, 'null') using errcode = 'invalid_parameter_value';
  end if;
  if not public.take_rate_limit_token(v_uid, 'equip_item', 30, 0.5) then
    raise exception 'RATE_LIMITED: too many changes, try again later';
  end if;
  if p_item_id is null then
    delete from public.equipped_items where user_id = v_uid and kind = p_kind;
  else
    select i.kind into v_kind
      from public.user_items u join public.shop_items i on i.id = u.item_id
     where u.user_id = v_uid and u.item_id = p_item_id;
    if v_kind is null then
      raise exception 'NOT_FOUND: you do not own %', p_item_id using errcode = 'no_data_found';
    end if;
    if v_kind <> p_kind then
      raise exception 'INVALID: % is a %, not a %', p_item_id, v_kind, p_kind using errcode = 'invalid_parameter_value';
    end if;
    insert into public.equipped_items as e (user_id, kind, item_id)
      values (v_uid, p_kind, p_item_id)
    on conflict (user_id, kind) do update set item_id = excluded.item_id, equipped_at = now();
  end if;
  return coalesce((select jsonb_object_agg(kind, item_id) from public.equipped_items where user_id = v_uid), '{}'::jsonb);
end $$;

-- Equipped cosmetics of up to 200 users, for profiles, leaderboards and friends lists (one row per equipped item):
-- user_id, kind, item_id, name, data (shop_items.data). Users with a block either way with the caller are left out, so
-- they show the default look; unknown ids and users without cosmetics have no rows. Callable signed out (strangers
-- see what any player sees, like the names on leaderboard_top). INVALID for more than 200 ids.
create or replace function public.public_cosmetics(p_user_ids uuid[])
returns table (user_id uuid, kind text, item_id text, name text, data jsonb)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_viewer uuid := private.viewer();
begin
  if cardinality(p_user_ids) > 200 then
    raise exception 'INVALID: at most 200 users per call' using errcode = 'invalid_parameter_value';
  end if;
  return query
    select e.user_id, e.kind, e.item_id, i.name, i.data
      from public.equipped_items e
      join public.shop_items i on i.id = e.item_id
     where e.user_id = any (coalesce(p_user_ids, '{}'))
       and not private.is_blocked(e.user_id, v_viewer)
     order by e.user_id, e.kind;
end $$;

-- Whether p_user_id may play p_game_id as far as purchases go: true when no available game_unlock item points at the
-- game (free games stay free, unknown games included), otherwise true only when the user owns a game_unlock item for
-- it (a retired one counts too, so replacing an item never locks out its buyers). A null user owns only free games.
-- Clients may ask only about themselves (auth.uid(); signed out: null); the service role and security definer callers
-- may ask about anyone. Not used anywhere yet: catalog, launch, record_play and game-server joins are not gated.
create or replace function public.owns_game(p_user_id uuid, p_game_id text)
returns boolean language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if auth.role() in ('anon', 'authenticated') and p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN: owns_game answers only about the caller' using errcode = 'insufficient_privilege';
  end if;
  return not exists (select 1 from public.shop_items i
                      where i.kind = 'game_unlock' and i.available and i.data ->> 'game_id' = p_game_id)
      or exists (select 1 from public.user_items u join public.shop_items i on i.id = u.item_id
                  where u.user_id = p_user_id and i.kind = 'game_unlock' and i.data ->> 'game_id' = p_game_id);
end $$;

-- ---------------------------------------------------------------------------
-- Seed: v1 cosmetics (data-drawn, no image assets). Prices in four tiers; the 100-coin items are a day's daily bonus
-- plus a few matches away. Re-running is safe (existing rows are left alone).
-- ---------------------------------------------------------------------------

insert into public.shop_items (id, kind, name, description, price, data, sort) values
  ('name-mint', 'name_color', 'Mint', 'A fresh green name.', 100, '{"color": "#34D399", "light": "#047857"}', 10),
  ('name-sky', 'name_color', 'Sky', 'A clear blue name.', 100, '{"color": "#38BDF8", "light": "#0369A1"}', 20),
  ('name-rose', 'name_color', 'Rose', 'A warm pink name.', 250, '{"color": "#FB7185", "light": "#BE123C"}', 30),
  ('name-violet', 'name_color', 'Violet', 'A deep purple name.', 250, '{"color": "#A78BFA", "light": "#6D28D9"}', 40),
  ('name-gold', 'name_color', 'Gold', 'A name that shines.', 600, '{"color": "#FACC15", "light": "#A16207"}', 50),
  ('frame-ember', 'avatar_frame', 'Ember', 'A glowing orange ring.', 250, '{"colors": ["#F97316", "#EF4444"]}', 10),
  ('frame-ocean', 'avatar_frame', 'Ocean', 'A cool blue ring.', 250, '{"colors": ["#22D3EE", "#3B82F6"]}', 20),
  ('frame-aurora', 'avatar_frame', 'Aurora', 'Northern lights around your avatar.', 1000, '{"colors": ["#34D399", "#22D3EE", "#A78BFA"]}', 30),
  ('frame-gilded', 'avatar_frame', 'Gilded', 'Solid gold, for the dedicated.', 2000, '{"colors": ["#FDE68A", "#F59E0B", "#B45309", "#FDE68A"]}', 40),
  ('banner-dusk', 'profile_banner', 'Dusk', 'Indigo fading into pink.', 250, '{"colors": ["#6366F1", "#EC4899"]}', 10),
  ('banner-lagoon', 'profile_banner', 'Lagoon', 'Teal water, blue sky.', 600, '{"colors": ["#14B8A6", "#3B82F6"]}', 20),
  ('banner-sunset', 'profile_banner', 'Sunset', 'Amber into red, end of the day.', 1000, '{"colors": ["#F59E0B", "#EF4444", "#BE185D"]}', 30),
  ('badge-star', 'badge', 'Star', 'A small star by your name.', 150, '{"icon": "star", "color": "#FACC15", "light": "#CA8A04"}', 10),
  ('badge-flame', 'badge', 'Flame', 'You are on fire.', 600, '{"icon": "flame", "color": "#FB923C", "light": "#EA580C"}', 20),
  ('badge-crown', 'badge', 'Crown', 'Rally royalty.', 2000, '{"icon": "crown", "color": "#FACC15", "light": "#A16207"}', 30)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Privileges (explicit, as in 20261029000100_m1_grants.sql)
-- ---------------------------------------------------------------------------

revoke all on public.coin_rules, public.wallets, public.coin_ledger, public.shop_items, public.user_items,
  public.equipped_items from anon, authenticated;
grant select on public.coin_rules to anon, authenticated;
grant select on public.wallets, public.coin_ledger, public.shop_items, public.user_items, public.equipped_items
  to authenticated;
grant all on public.coin_rules, public.wallets, public.coin_ledger, public.shop_items, public.user_items,
  public.equipped_items to service_role;
revoke all on sequence public.coin_ledger_id_seq from anon, authenticated;
grant usage, select on sequence public.coin_ledger_id_seq to service_role;

revoke all on function
  public.my_wallet(),
  public.buy_item(text),
  public.equip_item(text, text),
  public.public_cosmetics(uuid[]),
  public.owns_game(uuid, text)
from public, anon, authenticated;
grant execute on function public.public_cosmetics(uuid[]), public.owns_game(uuid, text) to anon, authenticated, service_role;
grant execute on function public.my_wallet(), public.buy_item(text), public.equip_item(text, text)
  to authenticated, service_role;

-- create or replace kept these grants; restated so this file stands on its own.
revoke all on function public.server_record_match(jsonb) from public, anon, authenticated;
grant execute on function public.server_record_match(jsonb) to service_role;
revoke all on function public.submit_solo_score(text, text, double precision, uuid) from public, anon;
grant execute on function public.submit_solo_score(text, text, double precision, uuid) to authenticated, service_role;
revoke all on function public.unlock_achievement(text, text) from public, anon;
grant execute on function public.unlock_achievement(text, text) to authenticated, service_role;

revoke execute on function public.set_updated_at() from public, anon, authenticated;
