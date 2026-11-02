# Moderation and account deletion

Two App Store review essentials: players can **report** other players (guidelines 1.2 and 4.7.1; blocking already
existed), and they can **delete their account from inside the app** (guideline 5.1.1(v)). Schema, RPCs and rules:
`packages/db/supabase/migrations/20261102000100_moderation.sql`, pinned by `packages/db/test/moderation.test.ts`. The
app side: `apps/mobile/src/components/rally/report-sheet.tsx`, `delete-account-sheet.tsx`, and `src/lib/report*.ts`,
`src/lib/delete-account*.ts`.

## Reports

### How a report arrives

- **Where players report:** a public profile's ⋯ menu → **Report @name**, and in a game, menu → **People** → a
  player → **Report**. Both open the same sheet: a reason, an optional note (up to 500 characters), an **Also block
  this player** switch (the existing `block_user`), then a thank-you toast. A report from a game carries the game id
  and the room id.
- **Reasons** (fixed, `REPORT_REASONS` in `@rally/db`): `harassment`, `hate`, `cheating`, `inappropriate_profile`
  (name or photo), `spam`, `other`.
- **`report_user(p_user_id, p_reason, p_note?, p_game_id?, p_room_id?)`** is the only way in. Linked accounts only;
  reporting yourself, an unknown reason or an over-long note is `INVALID`; 10 reports in a burst, refilling 10 an hour
  (`RATE_LIMITED`, the `rate_limits` token bucket `send_friend_request` uses).
- **Nothing about the target leaks:** the answer is always empty. An unknown or deleted account writes nothing; a
  player the reporter blocked, or who blocked the reporter, is reported like anyone else.
- **One row per reporter, target and day:** reporting the same player again within 24 hours of the first report,
  while it is still open, updates that row (latest reason, the new note and context when given, `last_reported_at`).
- **Evidence:** `target_snapshot` keeps the target's username, display name, avatar path and bio from the first
  report, so renaming afterwards does not erase what was reported.
- **Nobody but moderators sees reports.** `public.reports` has RLS on and no client grants (not even for the reporter).
  The target is never told.

There is no notification for new reports yet; check the queue at least daily (4.7.1 expects timely action). A
Database Webhook on `reports` inserts to an e-mail or Slack Edge Function is the natural follow-up, as is hiding a
profile automatically after several open reports (architecture §8).

### Reviewing in Supabase Studio

Studio's SQL editor runs as `postgres`, which reads and writes `reports` and `user_sanctions` directly. The queue,
oldest first, with how many open reports each target has:

```sql
select r.created_at, r.reason, r.note, r.game_id, r.room_id,
       t.username as target, r.target_snapshot, rep.username as reporter,
       count(*) over (partition by r.target_id) as open_on_target,
       r.id, r.target_id
  from public.reports r
  join public.profiles t on t.id = r.target_id
  left join public.profiles rep on rep.id = r.reporter_id   -- null: the reporter deleted their account
 where r.status = 'open'
 order by r.created_at;
```

One player's history, before deciding:

```sql
select created_at, reason, note, status, moderator_note from public.reports
 where target_id = '<target uuid>' order by created_at desc;
select kind, reason, created_at, expires_at, revoked_at from public.user_sanctions
 where user_id = '<target uuid>' order by created_at desc;
```

(The Table Editor works too: `reports`, filter `status = open`, sort by `created_at`.)

### Acting on a report

**Sanctions** are rows in `user_sanctions` (`kind` `ban` or `mute`, `expires_at` null for permanent). A ban refuses
matchmaking (the game server checks at join, cached for 60 s), stops presence, and skips the player's match results;
a mute flags them in rooms for chat. Players can read their own sanctions, so write the reason for them:

```sql
-- 24-hour mute
insert into public.user_sanctions (user_id, kind, reason, expires_at, created_by)
values ('<target uuid>', 'mute', 'Harassment in chat', now() + interval '24 hours', '<your user uuid>');

-- 7-day ban; leave expires_at null for a permanent one
insert into public.user_sanctions (user_id, kind, reason, expires_at, created_by)
values ('<target uuid>', 'ban', 'Cheating', now() + interval '7 days', '<your user uuid>');

-- Lift one early (the row stays as history)
update public.user_sanctions set revoked_at = now() where id = '<sanction uuid>';
```

**An inappropriate name or photo** is fixed on the profile itself (the snapshot in the report keeps the evidence):

```sql
update public.profiles
   set username = 'user_' || substr(replace(id::text, '-', ''), 1, 12), display_name = null, bio = null,
       avatar_url = public.random_default_avatar()
 where id = '<target uuid>';
```

Then delete the uploaded photo in **Storage → avatars → `<target uuid>/`** (SQL cannot delete Storage files).

**Close the report** (changing `status` stamps `reviewed_at`; `moderator_note` is for you):

```sql
update public.reports set status = 'actioned', moderator_note = '7-day ban' where id = '<report uuid>';
update public.reports set status = 'dismissed', moderator_note = 'No evidence' where id = '<report uuid>';
-- Every open report on one player at once
update public.reports set status = 'actioned', moderator_note = 'Renamed' where target_id = '<target uuid>' and status = 'open';
```

A report that is no longer open is left alone: the same reporter reporting again opens a new row.

## Account deletion

### The flow

Settings → **Delete account** (at the bottom) opens a sheet that lists what goes, says it cannot be undone, and enables the
destructive button only once the username is typed (any case, an `@` allowed). With a spinner, the app then:

1. **Deletes the user's photos** under `avatars/<uid>/` through the Storage API (owners may list and delete their
   own objects, `20261029000200_m1_avatars.sql`). SQL cannot remove Storage files, and a photo left behind would stay
   public, so if this step fails nothing else happens.
2. **Calls `delete_my_account()`**, which scrubs the rows that outlive the account (below) and deletes the
   `auth.users` row. That cascades to `public.profiles` and from there to every per-user table; the username is free
   again at once. It is idempotent (a retry after a lost answer succeeds), any signed-in session may call it, and
   signed-out clients have no grant.
3. **Signs out on this device only** (the server's sessions went with the account) and lands on the welcome screen,
   where an alert confirms the deletion.

A failure keeps the sheet open with a message saying which step failed; retrying is always safe. Friends see the
friendship disappear in real time (the cascade sends the usual `friend_removed` / `friend_request_cancelled` /
`friend_declined` events).

### What happens to each table

Every foreign key to `profiles` or `auth.users` was audited; the test `every foreign key to profiles / auth.users is
classified` fails when a new one appears until it is added here and in the migration header.

| Rows                                                                      | On delete | Why                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `game_consents`, `favorites`, `game_saves`, `game_stats`, `play_sessions` | cascade   | personal game data                                                                                                                                                                                                                                                                      |
| `leaderboard_entries`, `user_achievements`                                | cascade   | the player's scores and unlocks; boards re-rank without them                                                                                                                                                                                                                            |
| `friendships`, `blocks` (both sides)                                      | cascade   | the social graph goes with the person                                                                                                                                                                                                                                                   |
| `presence`, `rate_limits`                                                 | cascade   | live and internal state                                                                                                                                                                                                                                                                 |
| `wallets`, `coin_ledger`, `user_items`, `equipped_items`                  | cascade   | the economy is personal                                                                                                                                                                                                                                                                 |
| `player_progress`, `xp_ledger`, `daily_challenges`                        | cascade   | personal progress                                                                                                                                                                                                                                                                       |
| `game_votes`                                                              | cascade   | the vote is personal; totals drop it                                                                                                                                                                                                                                                    |
| `activity.actor_id`                                                       | cascade   | the feed cards about the player go (docs/activity.md); friends' cards about a shared run keep their seat count                                                                                                                                                                          |
| `user_sanctions.user_id`                                                  | cascade   | nothing left to sanction (a new account gets a new id either way)                                                                                                                                                                                                                       |
| `reports.target_id`                                                       | cascade   | nothing left to moderate, and the note is about them                                                                                                                                                                                                                                    |
| `reports.reporter_id`                                                     | set null  | moderators keep a report about someone else                                                                                                                                                                                                                                             |
| `bug_reports.user_id`                                                     | set null  | the developer keeps the report; its screenshot check used to require a reporter and blocked the delete, fixed in this migration                                                                                                                                                         |
| `match_results` (no foreign key)                                          | scrubbed  | the match stays in the other players' history: `winner_id` set null; in the payload the player's entry loses `userId` and `username` (`deleted: true`), `winnerUserId` is nulled, their leaderboard deltas / scores go, and the free-form `details` (keyed by player names) are dropped |
| `game_rooms.player_ids` (no foreign key)                                  | scrubbed  | the user leaves the live room mirror                                                                                                                                                                                                                                                    |
| `user_sanctions.created_by` (no foreign key)                              | set null  | a moderator's own deletion keeps the sanctions they issued                                                                                                                                                                                                                              |
| GoTrue's `auth.*` tables                                                  | cascade   | identities, sessions, refresh tokens, MFA                                                                                                                                                                                                                                               |

**Storage:** the app removes `avatars/<uid>/`. Bug-report screenshots (`bug-reports/<uid>/`, private,
developer-only) stay with their reports. Objects whose owner no longer exists, to clean up by hand in the Storage
browser:

```sql
select bucket_id, name from storage.objects
 where bucket_id in ('avatars', 'bug-reports') and name not like 'defaults/%'
   and not exists (select 1 from public.profiles p where p.id::text = (storage.foldername(name))[1]);
```

## Owner steps

Apply the migration to the hosted project:

```
cd packages\db
npx supabase db push
```

For App Review, the notes can point to **Settings → Delete account**, and to reporting on any profile (⋯ → Report)
and in games (menu → People → a player → Report).
