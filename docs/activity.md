# Friends activity feed

Small cards on the dashboard about what friends did lately: "sloth reached level 5", "sloth set a new best in Stack:
216", "sloth unlocked Skyline in Stack", "sloth won a match of Sumo", "sloth and 2 others escaped Northdale". Newest
first, the last few days, with a "See all" screen for the rest. It gives people a reason to open the app when they
are not planning to play. Schema, triggers and the read RPC: `packages/db/supabase/migrations/20261102000500_activity.sql`,
pinned by `packages/db/test/activity.test.ts`. The app side: `apps/mobile/src/lib/activity.ts` (the query),
`lib/activity-model.ts` (cards and copy, tested by `test/activity.test.ts`), `components/rally/activity-feed.tsx` (the
dashboard row and the card) and `app/(app)/activity.tsx` (See all).

## What is recorded

One `activity` row per event: `actor_id`, `kind`, `game_id` (null for a level-up), a small `payload`, `created_at`.
Rows are written only by `AFTER INSERT` triggers on tables the trusted paths already write, never by clients or by
the RPCs themselves (`server_record_match`, `submit_solo_score`, `unlock_achievement` and `private.apply_xp` are
redefined by other migrations; a trigger survives that).

| Kind          | Trigger on                                      | When                                                                                                                                                                                           | Payload                             |
| ------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `level_up`    | `xp_ledger`                                     | the row's `level_after` is above the level before it (the previous row's, else the stored `player_progress.level`, else 1); one row per award, whatever the jump                               | `{level, from}`                     |
| `achievement` | `xp_ledger`                                     | reason `achievement` (a solo unlock or a match unlock); the key comes from `ref` (`<game_id>:<key>`), the title from `note`                                                                    | `{key, title}`                      |
| `new_best`    | `leaderboard_entries` (insert, update of score) | a first or strictly better score on an all-time `best` board (solo submits and the server's `leaderboardScores`). `total` boards accumulate and daily / weekly boards reset, so neither counts | `{board, score, previous?, boards}` |
| `match_win`   | `match_results`                                 | `winner_id` is a linked player of a counted match (the coins' rule: ≥ `coin_rules.match_min_duration_s`, public or ≥ 2 linked players)                                                         | `{match_id, players}`               |
| `coop_escape` | `match_results`                                 | `payload.details.escaped = true` (Northdale): one row per linked player seated; `players` is every seat, guests included                                                                       | `{match_id, players}`               |

Every trigger is wrapped so an error is a `WARNING`, never a failure of the match, score or award it rides on
(`private.record_activity` also catches its own insert). Guests and anonymous accounts can have no friends, so their
rows (if any) are never shown. Retention: the `purge-activity` pg_cron job (`private.purge_activity_rows`, daily)
deletes rows older than 30 days.

## Who sees what

`friends_activity(p_limit, p_before, p_before_id)` (security definer; linked accounts, `authenticated` only) returns
the caller's friends' rows newest first, each with the actor's username, display name and avatar and the game's title
and icon. An actor's rows are listed only while:

- the two are **accepted friends** (a pending request shows nothing; unfriending hides at once);
- **no block** exists in either direction (a block removes the friendship anyway; the check is belt and braces);
- the actor is **not banned**;
- the actor's **`privacy.games`** is `public` or `friends` (`private.can_view`, as `public_profile_games`): `private`
  hides everything, including level-ups.

The caller's own rows are never listed. Anonymous sessions get an empty answer; signed out is refused. Clients have no
grants on `activity` at all (RLS on, no policies). Pages: `p_limit` (clamped to 1..100) rows, then the last row's
`created_at` and `id` as `p_before` / `p_before_id` (rows of one match share a timestamp, so the id breaks the tie).
Equipped cosmetics are not part of the answer: the app's shared `ProfileAvatar` / `PlayerName` fetch them through
`public_cosmetics`, batched for every avatar and name on screen.

## App

- **Dashboard row "Friend activity"** (`ActivityFeed`, under the Daily challenges card): the newest cards of the last
  7 days (at most 6), horizontally, each with the game's art and the friend's avatar on its corner (the avatar alone for
  a level-up), the name (cosmetics apply), the sentence and when. A tap on a card opens the profile, on the art the
  game; "See all" opens `/activity`. Hidden when friends have been quiet; a player without friends sees "Add friends to
  see what they're up to" with **Find players** (search with `@`). Refetches when the dashboard comes back in front
  (when stale) and with the dashboard's pull to refresh; a friendship change refetches it too (the query sits under the
  `['social', uid]` prefix).
- **See all** (`/activity`): the same cards as rows, 30 at a time with "Show more", down to the 30 days the database
  keeps; the same empty states plus "Nothing yet".
- **Cards** (`lib/activity-model.ts`): rows that belong together become one card: everyone who escaped a run ("ann and
  ben escaped Northdale", "sloth and 2 others escaped Northdale": `others` = seats beyond the friends shown), and the
  boards one run improved ("set new bests in Overrun: wave 12 · kills 40"; a game with one best board shows the score
  alone: "set a new best in Stack: 216"). Times are relative (`timeAgo`).

## Owner steps

Apply the migration to the hosted project:

```
cd packages\db
npx supabase db push
```

Nothing else: the triggers start recording with the next award, score or match, and the purge job schedules itself
where pg_cron is enabled. Existing history is not backfilled (the feed is about the last few days).
