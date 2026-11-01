# Bug reports (shake to report)

Playtesters shake the phone, type what went wrong, and send. The report lands in Supabase with a screenshot, the
app and OS versions, the screen they were on, the game and its version when it came from a game, and the last ~200
warning, error and game host log lines.

- **Schema:** `packages/db/supabase/migrations/20261101000200_social_discovery.sql` (table `bug_reports`, private
  Storage bucket `bug-reports`), pinned by `packages/db/test/social-discovery.test.ts`.
- **App:** `apps/mobile/src/lib/bug-report.ts` (capture and send), `lib/bug-report-model.ts` (rules, limits),
  `lib/shake.ts` (shake detection), `lib/log-buffer.ts` (the log ring buffer),
  `components/rally/bug-report-sheet.tsx` (the sheet and the shake listener), `app/(app)/bug-reports.tsx` (your own
  reports).

## Who gets it

| Build                                                                            | Shake to report                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Dev builds and Expo Go (`__DEV__`)                                               | on                                                           |
| Builds made with `EXPO_PUBLIC_BUG_REPORTS=1` (the EAS `preview` profile sets it) | on                                                           |
| Store builds (neither)                                                           | off: no shake listener, no log capture, no Developer section |

It also needs a signed-in, linked account (the database refuses signed-out clients and anonymous sessions).

## What the tester sees

1. Shake the phone firmly (three hard jolts within a second; walking or setting it down does not count). On a
   simulator, use **Settings → Developer → Report a bug** instead (the iOS simulator's Device → Shake gesture also works
   in Expo Go, but opens Expo's own menu first).
2. A sheet rises: a note field, a preview of the screenshot taken at the moment of the shake with an **Include
   screenshot** switch, a line saying what else goes with it, and **Send report**.
3. "Bug report sent. Thanks!" Their own reports are listed in **Settings → Developer → Bug reports**.

Shaking while another sheet is open (rejoin, friend request) asks to close it first: iOS can only show one at a time.

**Game screenshots may be blank.** Games are WebGL inside a WebView, and a screen capture often draws that area black
(Android especially, sometimes iOS). The report is sent anyway with everything else, the sheet warns about it, and
the row's `context.screenshotNote` says `taken over a WebGL game: the game area may be blank`.

## What a report holds

| Column                    | Content                                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `created_at`        | set by the server                                                                                                                                                                                                      |
| `user_id`                 | the reporter (column default `auth.uid()`; clients cannot set it). Becomes null if the account is deleted, so the report stays                                                                                         |
| `note`                    | what the tester typed (≤ 2000 characters)                                                                                                                                                                              |
| `app_version`             | `app.json` version                                                                                                                                                                                                     |
| `platform`, `os_version`  | `ios` / `android`, and `Platform.Version`                                                                                                                                                                              |
| `route`                   | the expo-router path at the time of the shake, e.g. `/game/sumo/play`                                                                                                                                                  |
| `game_id`, `game_version` | set when the report came from the play screen                                                                                                                                                                          |
| `logs`                    | the last ~200 lines: every `console.warn` / `console.error`, plus the game host's `[game-host]` / `[bridge]` / `[play-session]` / `[game …]` lines, as `HH:MM:SS.mmm W text` (UTC; `W` warn, `E` error, `I` host info) |
| `screenshot_path`         | object name in the `bug-reports` bucket (`<user_id>/<uuid>.jpg`), or null                                                                                                                                              |
| `context`                 | `executionEnvironment` (`storeClient` = Expo Go), `expoSdk`, `device`, `window`, `screenshot` (`attached` / `left out` / `capture failed` / `upload failed`), `screenshotNote`, `screenshotError`                      |

Limits: 10 reports per user per hour (`RATE_LIMITED`); screenshots are JPEGs up to 5 MB (the app sends ~1280 px).

## Access rules

- `bug_reports`: clients may **insert** their own rows (only the content columns) and **read their own** (the
  Developer list). Nobody can update or delete a report from the app, or read anyone else's. The service role (the
  dashboard, the SQL editor) reads everything.
- `bug-reports` bucket: **private**. Clients may only **upload** into their own folder; they cannot list, download,
  replace or delete files, not even their own. Anonymous sessions cannot upload.

## Reading reports

Run these in the Supabase dashboard's **SQL editor** (it runs as `postgres`, so RLS does not hide anything).

Latest reports, newest first:

```sql
select r.created_at,
       p.username,
       r.note,
       r.platform || ' ' || r.os_version as os,
       r.app_version,
       r.route,
       r.game_id,
       r.game_version,
       r.screenshot_path,
       r.context ->> 'executionEnvironment' as env,
       r.id
  from public.bug_reports r
  left join public.profiles p on p.id = r.user_id
 order by r.created_at desc
 limit 50;
```

One report in full, with its log lines one per row:

```sql
select r.*, p.username
  from public.bug_reports r
  left join public.profiles p on p.id = r.user_id
 where r.id = '<report id>';

select n as line, l as text
  from public.bug_reports r,
       unnest(string_to_array(r.logs, E'\n')) with ordinality as t(l, n)
 where r.id = '<report id>'
 order by n;
```

Reports from one game or one tester, last 7 days:

```sql
select created_at, note, game_version, platform, os_version, id
  from public.bug_reports
 where game_id = 'sumo'                       -- or: user_id = (select id from public.profiles where username = 'sloth')
   and created_at > now() - interval '7 days'
 order by created_at desc;
```

Only the errors and warnings of the last day's reports:

```sql
select r.created_at, r.id, t.l as line
  from public.bug_reports r,
       unnest(string_to_array(r.logs, E'\n')) as t(l)
 where r.created_at > now() - interval '1 day'
   and t.l ~ '^\S+ [EW] '
 order by r.created_at desc;
```

**Screenshots.** Open **Storage → bug-reports** in the dashboard and follow `screenshot_path` (`<user id>/<file>.jpg`);
the dashboard previews and downloads private files. From a script with the service-role key, create a signed URL:
`supabase.storage.from('bug-reports').createSignedUrl(path, 3600)`. Never put the service-role key in the app.

**Housekeeping.** Nothing is purged automatically. To clear old reports:

```sql
delete from public.bug_reports where created_at < now() - interval '90 days';
```

Their screenshots stay in the bucket until removed in **Storage** (SQL cannot delete the files behind
`storage.objects`; use the dashboard or the Storage API).

## Setup

1. Apply the migration: `pnpm --filter @rally/db db:push` (or `npx supabase db push --linked` in `packages/db`). It
   creates the table, the policies and the `bug-reports` bucket.
2. For a playtest build outside Expo Go / dev, build with `EXPO_PUBLIC_BUG_REPORTS=1` (`eas build --profile preview`
   already sets it). Store builds leave it unset.
