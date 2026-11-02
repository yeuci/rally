# Account progress: levels, daily challenges and the play streak

Part of M6 "Progression" (docs/architecture.md §10), next to [coins](coins.md). Players gain XP by playing, which
raises an account level; each level reached pays coins once. Three optional daily challenges pay coins and XP when
claimed. A daily play streak counts consecutive days with a game and pays a climbing bonus. Schema, RPCs and rules:
`packages/db/supabase/migrations/20261101000100_progress.sql`, pinned by `packages/db/test/progress.test.ts`, and
`20261102000400_streaks.sql`, pinned by `packages/db/test/streaks.test.ts`. The level curve also lives in
`packages/db/src/progress.ts`, the one formula the app uses.

## Rules

- **Only the server awards XP**, in the same trusted paths as coins. `xp_ledger` and `player_progress` have no client
  write grants; the only writer is the internal `private.apply_xp`.
- **Every award is a ledger row** (`xp_ledger`: user, amount > 0, reason, ref, the total and level after it), unique on
  `(user_id, reason, ref)`: the same match, solo session, achievement or challenge can never pay twice, even when a call
  is retried or replayed. XP never goes down.
- **The total is stored** in `player_progress` (`xp`, `level`), so reading a level is one primary-key lookup.
- **Guests and anonymous sessions earn nothing**, exactly as with coins (the same eligible players).
- **Lock order:** every XP or challenge write takes the user's wallet lock first (`private.lock_wallet`), then the
  progress row or the challenge row. Coins, XP and challenges of one user serialise on one lock, and
  `server_record_match` still locks its players' wallets in user-id order before anything else, so nothing deadlocks.

### Where XP comes from

| Reason        | Paid by                                                                                                                          | Amount (rule key)                   | Limits                                                    | Ledger `ref`      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------- | ----------------- |
| `match`       | `server_record_match`, each eligible player of a _counted_ match (the coins' definition: ≥ 20 s, public or ≥ 2 eligible players) | 20 (`match`)                        | `match_daily_cap` (600) per UTC day, shared with `win`    | match id          |
| `win`         | same, the `winnerUserId`                                                                                                         | +10 (`win`)                         | shares the match cap                                      | match id          |
| `solo`        | `submit_solo_score`, a valid run (accepted or `not_best`)                                                                        | 10 (`solo`)                         | once per play session; `solo_daily_cap` (100) per UTC day | play session id   |
| `achievement` | `unlock_achievement` and `server_record_match`, on a new unlock                                                                  | 25 (`achievement`)                  | once per achievement                                      | `<game_id>:<key>` |
| `challenge`   | `claim_daily_challenge`                                                                                                          | the challenge's `xp` (30 / 50 / 70) | once per challenge                                        | challenge id      |
| `streak`      | the first counted match or valid solo run of a UTC day, when it grows the play streak (see below)                                | 10 (`streak_xp`)                    | once per UTC day                                          | `YYYY-MM-DD`      |
| `adjustment`  | support, with the service role (see below)                                                                                       | any > 0                             | unique ref                                                | a ticket id       |

**Why these numbers.** A 2-3 minute match is 20 XP (30 for a win), so a 15-20 minute session of five or six matches
plus the day's challenges is roughly 250-300 XP: level 2 in the first session, level 5 after about two, level 10 after
about a week of evenings. The caps (about 30 matches, or 10 solo runs, a day) keep farming with a guest alt or spoofed
solo scores from turning into levels, and so into level-up coins.

### The level curve

Going from level L to L + 1 takes **100 + 25 · (L − 1) XP**, growing gently until it reaches **500 at level 17** and
staying there (capped growth: a level never takes more than about two evenings).

| Level                 | 1   | 2   | 3   | 4   | 5   | 10    | 17    | 18    | 20    |
| --------------------- | --- | --- | --- | --- | --- | ----- | ----- | ----- | ----- |
| XP to the next level  | 100 | 125 | 150 | 175 | 200 | 325   | 500   | 500   | 500   |
| Total XP at the start | 0   | 100 | 225 | 375 | 550 | 1,800 | 4,600 | 5,100 | 6,100 |

Total XP for level L: `100 (L−1) + 12.5 (L−1)(L−2)` up to level 17, then `4,600 + 500 (L − 17)`. SQL:
`private.xp_to_next_level`, `private.xp_for_level`, `private.level_for_xp`, `private.progress_of`; TypeScript:
`xpToNextLevel`, `xpForLevel`, `levelForXp`, `progressForXp` from `@rally/db`. The db tests compare the two over
thousands of totals and every level boundary; the app re-derives every level it shows from `total_xp`, so the ring,
the badge and the toasts always agree. The curve is fixed: changing it needs a migration **and** an app release.

### Level-up coins

Reaching a level pays coins once per level (coin ledger reason `level`, ref = the level; a jump over several levels
pays each one): **50 at level 2, +10 per level after it, at most 250** (rules `level_coins`, `level_coins_step`,
`level_coins_max`). Level 5 pays 80, level 10 pays 130, level 22 and up pay 250.

### Tuning

Every XP amount, cap and the level-up coins are rows in `progress_rules` (readable by clients). Change one in the
Supabase SQL editor; no migration or release:

```sql
update public.progress_rules set value = 15 where key = 'win';
update public.progress_rules set value = 300 where key = 'level_coins_max';
```

A missing rule pays 0. Support grants: `select private.apply_xp('<user uuid>', 200, 'adjustment', 'ticket-123', null, 'Sorry about that');`
(a level-up it causes pays its coins as usual).

## Daily challenges

Three challenges per player per UTC day, optional: no notifications, nothing nags. They reset at 00:00 UTC.

### The pick

`my_daily_challenges()` picks the day's set on its first call of the day (`private.ensure_daily_challenges`), and so
do the progress paths, so a match played before opening the app still counts. The set is **one template per tier**
(easy, medium, harder; rewards 20 / 35 / 50 coins and 30 / 50 / 70 XP, so every day pays 105 coins and 150 XP), each
the first eligible template of its tier in an order seeded by `md5(user, date, template key)`, with distinct kinds
where possible. That makes it:

- **stable**: stored once picked (a template edited or retired later does not change today's set);
- **deterministic**: the same user and day always give the same set (the tests re-implement the pick and compare);
- **varied**: different per user and per day;
- **fair**: every set has one challenge of each tier, so every player's day is worth the same.

Templates that name a game are picked only when the game is published and the player can play it (`owns_game`);
"Play a match with a friend" only for players with an accepted friend; "Play N different games" only when N games are
published. Yesterday's completed but unclaimed challenges stay listed and claimable until today's reset, so finishing
one at 23:59 UTC loses nothing.

### The templates (`challenge_templates`, seeded)

27 templates: 15 from `20261101000100_progress.sql` and 12 from `20261102000300_more_content.sql` (marked +), pinned by
`packages/db/test/progress.test.ts` and `packages/db/test/more-content.test.ts`.

| Tier | Key             | Challenge                       | Counts                                        |
| ---- | --------------- | ------------------------------- | --------------------------------------------- |
| 1    | `play_2`        | Play 2 matches                  | counted multiplayer matches                   |
| 1    | `sumo_1`        | Play a round of Sumo            | counted Sumo matches                          |
| 1    | `gunrun_1`      | Play a round of Gun Run         | counted Gun Run matches                       |
| 1    | `stack_2`       | Play Stack twice                | valid Stack runs (one per session)            |
| 1    | `solo_2` +      | Finish 2 solo runs              | valid solo runs of any game (one per session) |
| 1    | `stack_10` +    | Build a 10-block tower in Stack | best valid `height` score today               |
| 1    | `topple_1` +    | Play a game of Topple           | valid Topple runs                             |
| 1    | `lumber_1` +    | Work a shift at Lumber Camp     | valid Lumber Camp runs                        |
| 1    | `sawline_1` +   | Work a shift in Sawline         | valid Sawline runs                            |
| 2    | `play_3`        | Play 3 matches                  | counted multiplayer matches                   |
| 2    | `variety_2`     | Play 2 different games          | distinct games (matches or solo runs)         |
| 2    | `sumo_2`        | Play Sumo twice                 | counted Sumo matches                          |
| 2    | `gunrun_2`      | Play Gun Run twice              | counted Gun Run matches                       |
| 2    | `overrun_1`     | Play a round of Overrun         | counted Overrun matches                       |
| 2    | `stack_15`      | Build a 15-block tower in Stack | best valid `height` score today               |
| 2    | `play_4` +      | Play 4 matches                  | counted multiplayer matches                   |
| 2    | `solo_3` +      | Finish 3 solo runs              | valid solo runs of any game                   |
| 2    | `sushi_1` +     | Play a round of Sushi Shift     | counted Sushi Shift matches                   |
| 2    | `northdale_1` + | Play a round of Northdale       | counted Northdale matches                     |
| 3    | `win_1`         | Win a match                     | wins in counted matches                       |
| 3    | `play_5`        | Play 5 matches                  | counted multiplayer matches                   |
| 3    | `friend_1`      | Play a match with a friend      | counted matches with an accepted friend       |
| 3    | `variety_3`     | Play 3 different games          | distinct games                                |
| 3    | `stack_20`      | Build a 20-block tower in Stack | best valid `height` score today               |
| 3    | `solo_5` +      | Finish 5 solo runs              | valid solo runs of any game                   |
| 3    | `variety_4` +   | Play 4 different games          | distinct games (needs 4 published)            |
| 3    | `friend_2` +    | Play 2 matches with a friend    | counted matches with an accepted friend       |

Kinds: `play_matches`, `win_matches`, `friend_match`, `play_games`, `play_game`, `score` (a solo `best` board with
`desc` sort; progress is the best valid score today) and `solo_runs` (valid runs of any solo game, one per play
session). These are exactly the kinds `private.challenge_event` counts; a new template must use one of them. Every
target is at most 5 of anything, reachable in a 15-20 minute session, and every template pays its tier's reward
(20 / 35 / 50 coins, 30 / 50 / 70 XP). With 9 / 10 / 8 templates per tier, a player sees a given template every week or
two. Add or retire templates with an insert / `active = false`:

```sql
insert into public.challenge_templates (key, kind, game_id, target, title, tier, coins, xp)
values ('gunrun_win', 'play_game', 'gunrun', 3, 'Play {game} three times', 2, 35, 50);
```

`{game}` and `{target}` are filled in when picked.

### Progress and claiming

- `server_record_match` counts a counted match toward each eligible player's challenges of the UTC day it ended;
  `submit_solo_score` counts a valid run toward today's. Both are idempotent per match / session (each challenge keeps
  the refs that counted), and a replayed match counts nothing.
- `claim_daily_challenge(id)` pays the challenge's coins and XP through both ledgers (reason `challenge`, ref = the
  challenge id) and marks it claimed. Errors: `NOT_FOUND` (unknown, or someone else's: the same answer), `ALREADY_CLAIMED`,
  `NOT_COMPLETE`, `EXPIRED` (older than yesterday), `RATE_LIMITED` (20 a minute). Returns `{id, coins, xp, balance}` plus
  the progress after it.
- Retention: the `purge-progress` cron job (`private.purge_progress_rows`) deletes XP rows older than 365 days
  (`player_progress` stays authoritative; no ref can pay again) and challenges older than 30 days.

## Daily play streak

`20261102000400_streaks.sql`, pinned by `packages/db/test/streaks.test.ts`. A player's streak is the number of
consecutive UTC days (the daily challenges' day boundary) on which they played at least one **counted** game: a
counted multiplayer match or a valid solo run, exactly the events that pay `match` / `solo` XP above. Missing a day
resets it to 0 and the next game starts it at 1 again; the longest streak is kept.

### What counts, and how it is counted

- **The source of truth is the XP ledger.** An `xp_ledger` row with reason `match` or `solo` already means "a counted
  match" / "a valid solo run" for an eligible (linked, unbanned) player; guests, anonymous sessions, short and
  private-alone matches and refused runs never get one, so they never count. The daily XP caps do not matter: a capped
  player already played, and was counted, earlier that day.
- **A trigger, not a rewrite of the earning paths.** `server_record_match` and `submit_solo_score` are untouched. A
  constraint trigger on `xp_ledger` (`xp_ledger_streak`: AFTER INSERT, FOR EACH ROW, `WHEN reason in ('match',
'solo')`, **DEFERRABLE INITIALLY DEFERRED**) calls `private.count_streak_day(user, day)` at commit of the transaction
  that wrote the row. Deferring matters: an immediate trigger would run between `private.apply_xp`'s ledger insert and
  its `player_progress` update, and a nested `apply_xp` there would have its XP overwritten. At commit the RPC has
  returned and the stored total is exact (the tests check `player_progress.xp` = the sum of the ledger after a streak
  bonus, and a level-up the bonus causes).
- **Lock order.** At commit the transaction still holds every lock it took, in particular the earner's wallet lock
  (`private.lock_wallet`, which every coin, XP and challenge write takes first), so paying the bonus through
  `private.apply_coins` / `private.apply_xp` re-enters locks the transaction already owns. `count_streak_day` itself
  takes the wallet lock first, then the `player_streaks` row: the economy keeps its one order (wallet, then progress /
  challenge / streak rows), `server_record_match` still locks its players' wallets in user-id order before anything
  else, and nothing deadlocks. A failure in the trigger rolls the whole match or run back, like any failing award.
- **The day** is the UTC day of the ledger row (`created_at`, the recording transaction's `now()`), as for the daily
  coin bonus. The first counted game of a day sets `current` to `current + 1` when `last_played_on` is yesterday, else
  to 1, keeps `longest` and sets `last_played_on`; later games that day change nothing.
- **`player_streaks`:** one row per user who ever played a counted game: `current`, `longest`, `last_played_on` and
  `bonus_paid_on` (the UTC day the latest bonus was paid). Owner-read only; written only by `count_streak_day`; cascades
  from `profiles` on account deletion ([moderation.md](moderation.md)).

### The bonus

Each day the streak grows pays coins (coin ledger reason `streak`) and XP (`xp_ledger` reason `streak`), both with
ref = the UTC date, so a day pays once whatever happens (the ledgers' unique `(user_id, reason, ref)`; a replayed match
pays nothing twice). The coins climb over the first week, then stay; every amount is a `progress_rules` row:

| Streak day | Coins (rule)          | XP (rule)        |
| ---------- | --------------------- | ---------------- |
| 1          | 10 (`streak_coins_1`) | 10 (`streak_xp`) |
| 2          | 15 (`streak_coins_2`) | 10               |
| 3          | 20 (`streak_coins_3`) | 10               |
| 4          | 30 (`streak_coins_4`) | 10               |
| 5          | 40 (`streak_coins_5`) | 10               |
| 6          | 50 (`streak_coins_6`) | 10               |
| 7 and on   | 75 (`streak_coins_7`) | 10               |

**Why these numbers.** A week of daily play is worth 240 coins on top of the daily bonuses: enough that keeping the
streak feels like something (a cheap cosmetic a week), small next to a session's match coins, so nobody plays only to
tick the box. The XP is a nudge, not a level: ten days of streak are one match's worth.

Tune in the SQL editor, no migration or release (`private.streak_coins(day)` reads day 7's rule for every later day):

```sql
update public.progress_rules set value = 100 where key = 'streak_coins_7';
update public.progress_rules set value = 0 where key = 'streak_xp';   -- coins only
```

A rule at 0 pays nothing, and the day still counts. Retention: `streak` rows leave both ledgers with the other earn rows
after 365 days (refs are past dates, so none can pay again); `player_streaks` stays authoritative.

## RPCs

| RPC                         | Who                            | Returns                                                                                                                                                                                                           |
| --------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `my_progress()`             | signed in (anonymous: level 1) | `{level, xp_into_level, xp_for_next, total_xp, next_level_coins}`                                                                                                                                                 |
| `public_progress(user_id)`  | anyone                         | `{level, xp_into_level, xp_for_next, total_xp}`, or null when the viewer may not see the player's games (`profiles.privacy.games`: public / friends / private) or a block hides them, like `public_profile_games` |
| `my_daily_challenges()`     | signed in (anonymous: none)    | rows `id, day, slot, kind, game_id, title, target, progress, coins, xp, completed_at, claimed_at, resets_at, expires_at`                                                                                          |
| `claim_daily_challenge(id)` | linked accounts                | see above                                                                                                                                                                                                         |
| `my_streak()`               | signed in (anonymous: zeros)   | `{current, longest, last_played_on, today_done, next_coins, next_xp}`: `current` reads 0 once a day was missed (the row is reset by the next game); `next_*` is what the next day's first game pays               |

RLS: `progress_rules` and `challenge_templates` are public; `player_progress`, `xp_ledger`, `daily_challenges` and
`player_streaks` are owner-read only; nobody but the internal functions writes them.

## Realtime

Event `progress` on the private topic `user:<uid>` (the same channel and delivery rules as `coins`; a failing send
never fails an award):

- `{type: 'xp', id, amount, reason, game_id, note, at}` plus the progress after it, for every XP award;
- `{type: 'level', from, coins, at}` plus the progress after it, on a level-up (its coins also arrive as a `coins`
  event with reason `level`);
- `{type: 'challenge', id, day, kind, title, progress, target, coins, xp, completed, claimed, at}` whenever a challenge
  moves, completes or is claimed.

Event `streak` on the same topic, once per day the streak grows: `{type: 'streak', current, longest, last_played_on,
coins, xp, at}` (its bonus also arrives as `coins` and `progress` events with reason `streak`).

## App

- **Level ring:** `ProfileAvatar`'s opt-in `progress` prop draws the XP into the level as a monochrome ring (eased in,
  instant with Reduce motion) with the level on a small inverted badge; an equipped frame moves to the disc's edge.
  Your profile and public profiles show it, with "Level 5 · Member since …" under the name. A level hidden by privacy
  draws the plain ring.
- **Daily challenges card** (`components/rally/daily-challenges.tsx`) on the dashboard and on the coin history: each
  challenge with its bar and "1/3", its reward, a Claim button when done, yesterday's unclaimed ones, "2 of 3 done" and
  the time to the reset. Skeleton, empty and error states as elsewhere.
- **Daily streak card** (`components/rally/streak-card.tsx`, above the challenges on the dashboard): the current
  streak with a flame (lit once today's game is in), "Done for today" / "Play today to keep it" / "Play a game to start
  one", the longest streak, and the next bonus ("Tomorrow" or "Today", its coins and XP). The day turns at 00:00 UTC
  without a refetch (`lib/streak-model.ts` re-derives the state from `last_played_on`) and the card asks the server
  again shortly after. Live through the `streak` event (`lib/streak.ts`).
- **Celebrations:** a level-up ("Level 5 · +80 coins"), a finished challenge or a new streak day ("3-day streak · Streak
  kept up · +20 coins", with a flame) shows a card under the coin toast, in the shell and over games (Settings → Coin
  popups turns them all off; enter and exit follow Reduce Motion). Level-up and streak coins do not pop a second coin
  toast. A streak day is celebrated once: only when the event's day is newer than the one the app had. The Developer
  page previews it ("Streak day 3").
- **Coin history:** each award shows the XP that came with it ("+10 XP"); level-ups, claimed challenges and streak days
  ("Daily streak · Day 3") have their own rows.

Screenshots: `docs/screenshots/progress/`.

## Owner steps

Apply the migration to the hosted project:

```
cd packages\db
npx supabase db push
```

Nothing else: the rules and the 27 templates are seeded (`20261101000100_progress.sql` and
`20261102000300_more_content.sql`), existing players start at level 1 with 0 XP, and the purge job schedules itself
where pg_cron is enabled. The streak (`20261102000400_streaks.sql`) seeds its rules the same way and starts every player
at 0: the first counted game after the push is day 1 (the app's card and celebration need the build from the same
change).
