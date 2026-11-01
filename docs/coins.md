# Coins and the shop

Part of M6 "Progression" (docs/architecture.md §10). Players earn coins by playing and spend them in a shop on
profile cosmetics. Schema, RPCs and rules: `packages/db/supabase/migrations/20261031000400_coins.sql`, pinned by
`packages/db/test/coins.test.ts`.

## Rules of the economy

- **Earn-only.** Coins cannot be bought with money (that would need Apple in-app purchase). Guests and anonymous
  sessions never earn.
- **Only the server awards coins**, inside paths that are already trusted. No RPC lets a client grant itself coins:
  `wallets` and `coin_ledger` have no client write grants, and the only writer is the internal
  `private.apply_coins`.
- **Every change is a ledger row** (`coin_ledger`: user, signed amount, reason, ref, the balance after it) with a
  unique `(user_id, reason, ref)`, so the same match, achievement, solo run, UTC day or item can never pay (or charge)
  twice, even when a call is retried or replayed.
- **The balance can never go negative.** A check constraint on `wallets.balance` enforces it. Every change takes the
  wallet's row lock first (`SELECT … FOR UPDATE`), then checks, appends and updates in one transaction.
  `server_record_match` locks its players' wallets in user-id order, so two matches with overlapping players cannot
  deadlock.

### Where coins come from

| Reason | Paid by | Amount (rule key) | Limits | Ledger `ref` |
|---|---|---|---|---|
| `match` | `server_record_match` (game server, service role), each eligible player of a *counted* match | 10 (`match`) | counted = `durationSec ≥ match_min_duration_s` (20) and public, or private with ≥ 2 eligible players | match id |
| `win` | same, the `winnerUserId` (the player `game_stats` counts a win for) | +25 (`win`) | shares the daily match cap | match id |
| `podium` | same, placement 2 or 3 when the match has a declared winner (a guest winner counts) and ≥ `podium_min_players` (4) players | +10 (`podium`) | shares the daily match cap; never in co-op runs (Overrun reports no winner) | match id |
| `achievement` | `unlock_achievement` (solo) and `server_record_match` (multiplayer), on a *new* unlock | `achievements.coins`, else 25 (`achievement`) | once per achievement, ever | `<game_id>:<key>` |
| `solo` | `submit_solo_score`, when the run passes the server's checks (accepted, or `not_best`: a valid run that did not beat the best) | 5 (`solo`) | once per play session; `solo_daily_cap` (50) per UTC day | play session id |
| `daily` | the first counted match or paying solo run of the UTC day | 50 (`daily`) | once per UTC day | `YYYY-MM-DD` |

Match coins (`match` + `win` + `podium`) are capped at `match_daily_cap` (500) per player per UTC day. The daily
bonus and achievements are outside the caps. Days roll over at 00:00 UTC, like the daily leaderboards.

**Why these numbers.** A 2-3 minute match pays 10 (35 for a win), so an evening of play earns a few hundred coins
with the daily bonus; the cheapest cosmetics (100) are a day's bonus plus a handful of matches away, mid-tier items
(250-600) take a few sessions, and the top items (2,000) are goals for regulars. The win bonus is large enough to
matter but participation still pays, so losing players keep earning. Solo pays less because solo scores are
client-reported (spoofable, architecture §8): 5 per run and at most 50 a day keeps a cheater's gain to one cheap item
every couple of days. The match cap (500, roughly an hour and a half of play) bounds farming with a guest alt in a public room;
the private-room rule and the 20 s floor are the same anti-boost rules the server leaderboards use.

### Tuning

Every amount, cap and threshold is a row in `coin_rules` (readable by clients: the shop's "How to earn" list is built
from it, so the copy follows). Change one in the Supabase SQL editor; no migration or app release is needed:

```sql
update public.coin_rules set value = 30 where key = 'win';
update public.coin_rules set value = 600 where key = 'match_daily_cap';
-- One achievement worth more than the default:
update public.achievements set coins = 100 where game_id = 'sumo' and key = 'yokozuna';
```

A missing rule pays 0 (it never breaks match recording). `tooling/publish-game` does not send `achievements.coins`,
so republishing a game keeps a value set this way.

Support grants or corrections: reason `adjustment` (either sign) through `private.apply_coins` with the service role
or in the SQL editor, with a unique ref (a ticket id):
`select private.apply_coins('<user uuid>', 100, 'adjustment', 'ticket-123', null, 'Sorry about that');`

### Retention

`coin_ledger` earn rows older than 365 days are deleted by the existing daily purge job (`private.purge_stale_rows`);
purchase rows are kept (one per owned item). The wallet stays authoritative, and every remaining row carries its
`balance_after`, so the history still reads correctly. A purged ref cannot pay again in practice: match ids and
session ids are unique, days are in the past, and achievements pay only on a new `user_achievements` row.

## The shop

- `shop_items` (`id` slug, `kind`, `name`, `description`, `price`, `data` jsonb, `available`, `sort`), `user_items`
  (ownership, permanent), `equipped_items` (one per equippable kind; foreign keys guarantee the user owns the item and
  that its kind matches the slot).
- `buy_item(item_id)` → `{status: 'purchased' | 'owned', item_id, balance}`. Idempotent: an owned item answers
  `owned` and charges nothing. `INSUFFICIENT_FUNDS` when short, `NOT_FOUND` when the item is unknown or retired,
  20 purchases per minute.
- `equip_item(kind, item_id | null)` → the caller's equipped map; null empties the slot. Own items only (`NOT_FOUND`),
  in their own slot (`INVALID`); 30 changes per minute. Retired items you own can still be equipped.
- `public_cosmetics(user_ids[])` → each user's equipped items (up to 200 per call), for profiles, leaderboards and
  friends lists. Equipped cosmetics are public; a block in either direction hides them (the blocked side sees the
  default look). Balances, ledgers and inventories are owner-only (RLS).
- `my_wallet()` → balance, lifetime earnings, and today's progress toward the caps (shown in the shop).

v1 cosmetics are drawn from data, no image assets (colours are `#RRGGBB`; `light` is the variant for the light theme):

| Kind | `data` | Drawn as |
|---|---|---|
| `name_color` | `{color, light?}` | the player's name, wherever it appears |
| `avatar_frame` | `{colors: [1-4]}` | a gradient ring on `ProfileAvatar` |
| `profile_banner` | `{colors: [2-3]}` | a gradient band behind the profile header |
| `badge` | `{icon, color, light?}` | a lucide icon after the name (`star`, `flame`, `crown`, `zap`, `gem`, `heart`, `rocket`, `ghost`, `skull`, `trophy`, `sparkles`, `medal`, `award`; others fall back to a star) |
| `game_unlock` | `{game_id}` | not shown yet (see below) |

The migration seeds 15 cosmetics at 100 / 150 / 250 / 600 / 1,000 / 2,000 coins. Add more with an insert (a trigger
checks `data` for the kind); retire one with `available = false` (owners keep it; never delete an owned item, the
foreign key refuses):

```sql
insert into public.shop_items (id, kind, name, description, price, data, sort)
values ('frame-neon', 'avatar_frame', 'Neon', 'Electric pink and cyan.', 800, '{"colors": ["#F0ABFC", "#22D3EE"]}', 50);
```

### Coin-only games (model ready, not enforced)

`kind = 'game_unlock'` is a real item kind with `data = {"game_id": "<games.id>"}`; `buy_item` sells it like any other
item (the purchase row carries the game id). At most one unlock item per game can be on sale at a time. No unlock items
are seeded, and nothing is gated yet.

`owns_game(user_id, game_id)` answers whether a player may play a game as far as purchases go: true when no available
`game_unlock` item points at the game (free games stay free), otherwise only when the user owns an unlock item for it
(a retired one counts, so replacing an item with a new price never locks out its buyers). Clients may ask only about
themselves; the service role and security definer functions may ask about anyone.

Where enforcement would hook in (follow-up):

- **Catalog / game page:** the app reads `owns_game(auth.uid(), id)` (or a batched variant) to show a price and a Buy
  button instead of Play; the unlock UI reuses the shop's item sheet.
- **Launch (solo):** `start_play_session` and `record_play` (security definer) refuse with a new error when
  `owns_game` is false; `useLaunchGame` maps it to the unlock sheet.
- **Multiplayer joins:** `RallyRoom.onAuth` (`packages/game-kit`, `apps/game-server`) asks a new service RPC (for
  example `server_owns_game`, calling `owns_game`) next to the sanction check, and refuses the seat.
- **Optional hardening:** a policy on `game_versions` so a locked game's `entry_url` is only readable by owners.

## Realtime coin popups

Every award (amount > 0, never a purchase) is broadcast by an AFTER INSERT trigger on `coin_ledger` to the earner's
private topic `user:<uid>`, event `coins`: `{type: 'coins', id, amount, reason, balance, game_id, note, at}`. This is
the friend-request path (Broadcast from the database, RLS on `realtime.messages`); `postgres_changes` is not used.

The app (`apps/mobile/src/lib/social-realtime.ts` → `lib/coins.ts`) refreshes the wallet and history and shows a
"+25 coins · Win" toast; awards arriving together merge into one ("+85 coins · Match · Win · Daily bonus"). The play
route mounts its own toast host, so the popup also shows over a running game. Settings → Notifications → **Coin
popups** turns it off (default on).

## App

- **Balance:** a gold pill in the profile header (opens the shop) and the drawer header; the drawer's Shop item shows
  it too.
- **Shop** (`/shop`): balance with today's progress (daily bonus, solo and match caps), cosmetics grouped by kind with
  price / Owned / Equipped, an item sheet that previews you wearing it with Buy (the confirmation), a "not enough
  coins" state, Equip and Unequip, and "How to earn" from the live rules.
- **Coin history** (`/coins`): balance, lifetime earnings and every ledger row with its reason, 30 at a time.
- **Cosmetics everywhere a player appears**, through shared components: `ProfileAvatar` (frame), `PlayerName` (colour
  and badge), `ProfileHeader` (banner). Leaderboard rows, person rows (search, friends, requests), the friends row on
  profiles, the drawer and the friend-request prompts use them. `useCosmetics(userId)` batches every avatar and name
  on screen into one `public_cosmetics` call.

## Owner steps

Apply the migration to the hosted project:

```
cd packages\db
npx supabase db push
```

Nothing else is required: the economy starts with the values above, the 15 cosmetics are seeded by the migration, and
the app reads everything at runtime. The ledger purge runs in the existing `purge-stale-play-sessions` cron job.
