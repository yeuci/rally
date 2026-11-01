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
| `level` | reaching a new account level ([progress.md](progress.md)) | 50, +10 per level, at most 250 (`progress_rules`) | once per level | the level |
| `challenge` | `claim_daily_challenge` ([progress.md](progress.md)) | the challenge's coins (20 / 35 / 50) | once per challenge | challenge id |

Match coins (`match` + `win` + `podium`) are capped at `match_daily_cap` (500) per player per UTC day. The daily
bonus and achievements are outside the caps. Days roll over at 00:00 UTC, like the daily leaderboards.

**Why these numbers.** A 2-3 minute match pays 10 (35 for a win), so an evening of play earns a few hundred coins
with the daily bonus; the cheapest cosmetics (100-500) are a day's bonus plus a handful of matches away, mid-tier items
(600-2,000) take a few sessions to a couple of weeks, and the prestige items (5,000-25,000) are long goals for
regulars: at a few hundred coins a day, the top one is a couple of months of play. The win bonus is large enough to
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

Cosmetics are drawn from data, no image assets (colours are `#RRGGBB`; `light` is the variant for the light theme).
The optional `glow`, `spin`, `dotted`, `pattern`, `shine` and `fill` keys and the icons from `leaf` on came with
`20261102000300_more_content.sql`: app builds before it ignore the keys (and draw a star for the new icons), and the
database trigger allows them (it checks the base keys only).

| Kind | `data` | Drawn as |
|---|---|---|
| `name_color` | `{color, light?, glow?: true}` | the player's name, wherever it appears; `glow` adds a soft halo in its colour (a text shadow) |
| `avatar_frame` | `{colors: [1-4], spin?: true, dotted?: true}` | a gradient ring on `ProfileAvatar`; `spin` turns it slowly (one turn in 9 s, still under Reduce Motion), `dotted` draws it as beads |
| `profile_banner` | `{colors: [2-3], pattern?, shine?: true}` | a gradient band behind the profile header; `pattern` (`stripes`, `dots`, `grid`, `stars`) lays a faint white texture over it, `shine` sweeps a sheen across every few seconds (none under Reduce Motion) |
| `badge` | `{icon, color, light?, fill?}` | a lucide icon after the name; `fill` is a second colour inside it (two-tone). Icons: `star`, `flame`, `crown`, `zap`, `gem`, `heart`, `rocket`, `ghost`, `skull`, `trophy`, `sparkles`, `medal`, `award`, `leaf`, `moon`, `shield`, `swords`, `sun`, `snowflake`, `feather`, `anchor`, `mountain`, `target`, `infinity`, `clover`, `music`, `compass`, `puzzle`, `gamepad-2` (`BADGE_ICON_NAMES` in `lib/coins-model.ts`); others fall back to a star |
| `game_unlock` | `{game_id}` | not shown yet (see below) |

Keep motion and glow (`spin`, `shine`, `glow`) for prestige items (5,000 coins and up): it is what makes them read as
special, and `packages/db/test/more-content.test.ts` holds the catalog to it. `pattern`, `dotted` and `fill` are fine
at any price.

**The catalog: 41 cosmetics.** `20261031000400_coins.sql` seeds 15 (v1); `20261102000300_more_content.sql` adds 26,
the batch the shop tags "New". Inside each kind `sort` follows the price, so the shop's Featured order is a ladder
from the cheapest item to the prestige ones.

| Kind | v1 (`20261031000400`) | Added (`20261102000300`) |
|---|---|---|
| Name colours | Mint 100, Sky 100, Rose 250, Violet 250, Gold 600 | Coral 150, Lime 150, Silver 300, Orchid 900, Copper 1,500, **Moonlit 5,000** (glow) |
| Avatar frames | Ember 250, Ocean 250, Aurora 1,000, Gilded 2,000 | Graphite 150, Citrus 300, Beads 400 (dotted), Iris 900, Twilight 1,800, **Prism 12,000** (spin), **Eclipse 25,000** (spin) |
| Profile banners | Dusk 250, Lagoon 600, Sunset 1,000 | Slate 150, Peach 300, Pinstripe 500 (stripes), Confetti 800 (dots), Blueprint 1,200 (grid), **Obsidian 8,000** (stripes, shine), **Nebula 15,000** (stars, shine) |
| Badges | Star 150, Flame 600, Crown 2,000 | Leaf 100, Spark 250, Moon 300, Shield 1,000 (two-tone), Duel 2,000 (two-tone), **Diamond 6,000** (two-tone) |

Prestige items in bold. The batch is 12 cheap items (100-500), 8 mid (800-2,000) and 6 prestige (5,000-25,000).

Add more with an insert (a trigger checks `data` for the kind); retire one with `available = false` (owners keep it;
never delete an owned item, the foreign key refuses). Give it a `sort` between its neighbours by price:

```sql
insert into public.shop_items (id, kind, name, description, price, data, sort)
values ('frame-neon', 'avatar_frame', 'Neon', 'Electric pink and cyan.', 800, '{"colors": ["#F0ABFC", "#22D3EE"]}', 25);
```

**"New".** The app tags the latest batch on sale "New" for 30 days: the items created within an hour of the newest
item (one migration, or one sitting in the SQL editor). Inserting items later makes them the new batch. When every item
on sale arrived together (a project that applies both migrations in one push, or a fresh local database), nothing is
tagged.

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
  it too. The pill is compact from 10,000 (`formatCoinsShort`: "12.3K", "1M"; screen readers hear the exact amount);
  the shop, the drawer's Shop item and the coin history show full numbers.
- **Shop** (`/shop`): balance with today's progress (daily bonus, solo and match caps), cosmetics grouped by kind with
  price / Owned / Equipped ("3 of 11 owned" per kind), an item sheet that previews you wearing it with Buy (the
  confirmation), a "not enough coins" state, Equip and Unequip, and "How to earn" from the live rules. Browsing: a
  filter (All, New while a batch is new, Names, Frames, Banners, Badges), the order (Featured, Low to high, High to
  low) and a count ("41 items · 5 owned"); tiles of the latest batch carry a "New" tag and prestige items (5,000+) a
  gold sparkle. The tiles draw the extras (a turning ring, a shining banner, a glowing name).
- **Coin history** (`/coins`): balance, lifetime earnings and every ledger row with its reason, 30 at a time.
- **Cosmetics everywhere a player appears**, through shared components: `ProfileAvatar` (frame), `PlayerName` (colour
  and badge), `ProfileHeader` (banner). Leaderboard rows, person rows (search, friends, requests), the friends row on
  profiles, the drawer and the friend-request prompts use them. `useCosmetics(userId)` batches every avatar and name
  on screen into one `public_cosmetics` call.

## Owner steps

Apply the migrations to the hosted project (`20261031000400_coins.sql`, and `20261102000300_more_content.sql` for the
second batch of cosmetics and challenge templates):

```
cd packages\db
npx supabase db push
```

Nothing else is required: the economy starts with the values above, the 41 cosmetics are seeded by the migrations, and
the app reads everything at runtime (the new looks and badge icons need the app build from the same change). The ledger purge runs in the existing `purge-stale-play-sessions` cron job.
