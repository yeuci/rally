-- Moderation and account deletion, the two App Store review essentials (guidelines 1.2 / 4.7.1: users can report other
-- users, blocking already exists; 5.1.1(v): deleting the account starts in the app). Pinned by test/moderation.test.ts;
-- the moderator's side is described in docs/moderation.md.
--
--   * reports        one row per report of a player: reporter, target, a reason from a fixed set, an optional note
--                    (<= 500 characters), optional context (the game and room it came from) and a snapshot of the
--                    target's public profile when it was first reported (a renamed account keeps the evidence). Status
--                    for moderators: open | actioned | dismissed; changing it stamps reviewed_at (trigger). No client
--                    grants at all: clients neither read nor write the table; moderators work in Supabase Studio.
--   * report_user(p_user_id, p_reason, p_note?, p_game_id?, p_room_id?) is the only writer. Linked accounts only
--     (UNAUTHENTICATED / ANONYMOUS_FORBIDDEN); INVALID for yourself, an unknown reason, a note over 500 characters or a
--     room id over 128; RATE_LIMITED past 10 reports in a burst (token bucket in rate_limits, refilling 10 an hour,
--     like send_friend_request). It never reveals anything about the target: an unknown or deleted user, someone the
--     caller blocked and someone who blocked the caller all get the same empty answer as any report (unknown users
--     simply write nothing; blocks do not stop a report). Reporting the same player again within a day, while the
--     first report is still open, updates that row (the latest reason, the new note and context when given,
--     last_reported_at) instead of adding one. An unknown game id is dropped from the context rather than refused.
--
--   * delete_my_account() permanently deletes the caller's account: it scrubs the rows that outlive the account (below),
--     then deletes the auth.users row, which cascades to public.profiles (20261029000000_m1_init.sql) and from there to
--     every per-user table. The username is free again at once. Any signed-in session may call it, anonymous ones
--     included (their throwaway account goes, as the daily purge would do); signed out has no grant. Idempotent: a retry
--     after a lost response finds nothing left and succeeds. The friendships cascade runs with the caller's token, so
--     friends get the usual friend_removed / friend_request_cancelled / friend_declined events
--     (20261031000200_social_realtime.sql) and their lists refresh.
--     Storage cannot be emptied from SQL: the app deletes the caller's files under avatars/<uid>/ through the Storage
--     API (the owner-delete policy in 20261029000200_m1_avatars.sql) before calling this. Bug-report screenshots
--     (private bug-reports bucket, developer-only) stay with their reports.
--
-- Foreign keys to profiles / auth.users, audited across every migration up to this one, and what deleting a user does:
--   cascade (personal data, gone with the account):
--     game_consents, favorites, game_saves, game_stats (20261029000000); rate_limits, leaderboard_entries,
--     user_achievements, play_sessions (20261030000100); friendships and blocks, both sides (20261030000300); presence,
--     user_sanctions (20261031000000); wallets, coin_ledger, user_items, equipped_items (20261031000400);
--     player_progress, xp_ledger, daily_challenges (20261101000100); game_votes (20261101000200); reports as the target
--     (below: nothing is left to moderate). Leaderboards re-rank without the player; vote totals drop their vote.
--   set null (the row survives for someone else):
--     bug_reports.user_id (20261101000200: the developer keeps the report). Its screenshot check required a reporter, so
--     the set null failed and blocked the delete for anyone with a screenshot; the check now allows a null reporter.
--     reports.reporter_id (below: moderators keep a report about another player).
--   no foreign key (a user id inside a row other players need), scrubbed by delete_my_account:
--     match_results (20261031000000; service-only, purged after 180 days, read for other players by
--     recently_played_with): winner_id is set null; in the payload the player's entry loses its userId and username
--     (marked deleted: true), winnerUserId is nulled, their leaderboardDeltas / leaderboardScores entries are removed and
--     the free-form details (keyed by player names) are dropped. Everyone else's history stays intact.
--     game_rooms.player_ids (20261031000000): the user is removed from the live mirror.
--     user_sanctions.created_by (20261031000000): the admin who issued a sanction, set null.
--   GoTrue's own tables (identities, sessions, refresh tokens, MFA factors) cascade from auth.users.
--
-- Errors as in m2: UNAUTHENTICATED / ANONYMOUS_FORBIDDEN (42501), INVALID (22023), RATE_LIMITED (P0001).

-- ---------------------------------------------------------------------------
-- reports
-- ---------------------------------------------------------------------------

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  -- Null once the reporter deleted their account: the report about someone else stays for moderators.
  reporter_id uuid references public.profiles (id) on delete set null,
  -- A deleted target takes its reports along (nothing left to moderate, and the note is about them).
  target_id uuid not null references public.profiles (id) on delete cascade,
  reason text not null,
  note text,                                             -- what the reporter typed, trimmed; null when empty
  game_id text references public.games (id) on delete set null,   -- context: the game it was reported from
  room_id text,                                          -- context: the Colyseus room, when known
  -- username, display_name, avatar_url and bio of the target when first reported.
  target_snapshot jsonb not null default '{}'::jsonb,
  status text not null default 'open',
  moderator_note text,                                   -- for moderators, in Studio
  reviewed_at timestamptz,                               -- set when status leaves 'open' (trigger)
  created_at timestamptz not null default now(),
  last_reported_at timestamptz not null default now(),   -- a repeat within the day moves this, not created_at
  constraint reports_reason check (reason in (
    'harassment', 'hate', 'cheating', 'inappropriate_profile', 'spam', 'other'
  )),
  constraint reports_status check (status in ('open', 'actioned', 'dismissed')),
  constraint reports_not_self check (reporter_id <> target_id),
  constraint reports_note check (note is null or char_length(note) between 1 and 500),
  constraint reports_room_id check (room_id is null or char_length(room_id) between 1 and 128),
  constraint reports_moderator_note check (moderator_note is null or char_length(moderator_note) <= 2000),
  constraint reports_target_snapshot check (jsonb_typeof(target_snapshot) = 'object')
);
alter table public.reports enable row level security;
-- No policies: no client role reads or writes reports (moderators use Studio, which bypasses RLS).
-- The moderation queue (open first, oldest first), one player's history, and report_user's repeat lookup.
create index reports_queue_idx on public.reports (status, created_at);
create index reports_target_idx on public.reports (target_id, created_at desc);
create index reports_reporter_idx on public.reports (reporter_id, target_id, created_at desc);

-- A moderator moving a report out of 'open' (or back) stamps reviewed_at, so Studio edits need nothing else.
create or replace function private.reports_before_update()
returns trigger language plpgsql set search_path = public, extensions as $$
begin
  if new.status is distinct from old.status then
    new.reviewed_at := case when new.status = 'open' then null else now() end;
  end if;
  return new;
end $$;
create trigger reports_before_update before update on public.reports
  for each row execute function private.reports_before_update();

-- ---------------------------------------------------------------------------
-- bug_reports: the screenshot check allows a reporter deleted since (the user_id foreign key is on delete set null)
-- ---------------------------------------------------------------------------

alter table public.bug_reports drop constraint bug_reports_screenshot;
alter table public.bug_reports add constraint bug_reports_screenshot check (
  screenshot_path is null
  or (char_length(screenshot_path) <= 200 and (user_id is null or screenshot_path like user_id::text || '/%'))
);

-- ---------------------------------------------------------------------------
-- report_user
-- ---------------------------------------------------------------------------

-- Files (or refreshes) the caller's report of p_user_id; see the header for the rules. Returns nothing, whatever the
-- target, so the answer says nothing about them.
create or replace function public.report_user(
  p_user_id uuid, p_reason text, p_note text default null, p_game_id text default null, p_room_id text default null
)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  -- Blank (spaces, tabs, line breaks) counts as no note.
  v_note text := nullif(btrim(p_note, E' \t\r\n'), '');
  v_room text := nullif(btrim(p_room_id, E' \t\r\n'), '');
  v_game text;
  v_id uuid;
begin
  if p_user_id is null or p_user_id = v_uid then
    raise exception 'INVALID: cannot report yourself' using errcode = 'invalid_parameter_value';
  end if;
  if p_reason is null or p_reason not in ('harassment', 'hate', 'cheating', 'inappropriate_profile', 'spam', 'other') then
    raise exception 'INVALID: unknown reason %', coalesce(p_reason, 'null') using errcode = 'invalid_parameter_value';
  end if;
  if char_length(v_note) > 500 then
    raise exception 'INVALID: note is longer than 500 characters' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(v_room) > 128 then
    raise exception 'INVALID: room id is too long' using errcode = 'invalid_parameter_value';
  end if;
  -- Every call takes a token, whoever the target is: probing ids costs the same as reporting.
  if not public.take_rate_limit_token(v_uid, 'report_user', 10, 10.0 / 3600) then
    raise exception 'RATE_LIMITED: too many reports, try again later';
  end if;
  -- Unknown (or deleted) target: the same answer as a recorded report.
  if not exists (select 1 from public.profiles where id = p_user_id) then
    return;
  end if;
  select g.id into v_game from public.games g where g.id = p_game_id;

  -- One reporter and target at a time, so two quick taps cannot both insert. Its own key space (lock_pair's keys are
  -- the two halves of the pair; this is one 64-bit hash).
  perform pg_advisory_xact_lock(hashtextextended('report_user:' || v_uid::text || ':' || p_user_id::text, 0));
  select r.id into v_id
    from public.reports r
   where r.reporter_id = v_uid and r.target_id = p_user_id and r.status = 'open'
     and r.created_at > now() - interval '1 day'
   order by r.created_at desc
   limit 1;
  if v_id is not null then
    -- The first snapshot stays: it is the evidence from when the player was first reported.
    update public.reports
       set reason = p_reason,
           note = coalesce(v_note, note),
           game_id = coalesce(v_game, game_id),
           room_id = coalesce(v_room, room_id),
           last_reported_at = now()
     where id = v_id;
    return;
  end if;
  insert into public.reports (reporter_id, target_id, reason, note, game_id, room_id, target_snapshot)
  select v_uid, p.id, p_reason, v_note, v_game, v_room,
         jsonb_build_object('username', p.username::text, 'display_name', p.display_name,
                            'avatar_url', p.avatar_url, 'bio', p.bio)
    from public.profiles p
   where p.id = p_user_id;
end $$;

-- ---------------------------------------------------------------------------
-- delete_my_account
-- ---------------------------------------------------------------------------

-- p_payload (a match_results.payload) without p_user_id: their players[] entry loses userId and username and is marked
-- deleted (placement and score stay, so the match still reads right for the others), winnerUserId is nulled when it was
-- them, their entries in leaderboardDeltas / leaderboardScores go, and the free-form details (keyed by player names)
-- are dropped. Ids are compared case-insensitively, as server_record_match reads them.
create or replace function private.scrub_match_payload(p_payload jsonb, p_user_id uuid)
returns jsonb language plpgsql immutable set search_path = public, extensions as $$
declare
  v_id text := p_user_id::text;
  v jsonb := p_payload;
  k text;
begin
  if jsonb_typeof(v) is distinct from 'object' then
    return v;
  end if;
  v := v - 'details';
  if lower(v ->> 'winnerUserId') = v_id then
    v := jsonb_set(v, '{winnerUserId}', 'null'::jsonb);
  end if;
  if jsonb_typeof(v -> 'players') = 'array' then
    v := jsonb_set(v, '{players}', (
      select coalesce(jsonb_agg(
               case when jsonb_typeof(t.e) = 'object' and lower(t.e ->> 'userId') = v_id
                    then (t.e - 'userId' - 'username') || '{"deleted": true}'::jsonb
                    else t.e end
               order by t.i), '[]'::jsonb)
        from jsonb_array_elements(v -> 'players') with ordinality as t(e, i)));
  end if;
  foreach k in array array['leaderboardDeltas', 'leaderboardScores'] loop
    if jsonb_typeof(v -> k) = 'object' then
      v := jsonb_set(v, array[k], (
        select coalesce(jsonb_object_agg(b.key,
                 case when jsonb_typeof(b.value) = 'object'
                      then (select coalesce(jsonb_object_agg(u.key, u.value), '{}'::jsonb)
                              from jsonb_each(b.value) as u where lower(u.key) <> v_id)
                      else b.value end), '{}'::jsonb)
          from jsonb_each(v -> k) as b));
    end if;
  end loop;
  return v;
end $$;

-- Deletes the caller's account; see the header. The order matters only for the scrubs, which need the id while the
-- rows still name it; the auth.users delete cascades everything else.
create or replace function public.delete_my_account()
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;

  -- Matches the others played in stay, without this player. The winner is always one of the match's players, so the
  -- containment test (served by match_results_players_idx, no scan of 180 days of matches) finds winner_id too.
  update public.match_results m
     set winner_id = case when m.winner_id = v_uid then null else m.winner_id end,
         payload = private.scrub_match_payload(m.payload, v_uid)
   where m.payload -> 'players' @> jsonb_build_array(jsonb_build_object('userId', v_uid::text));
  update public.game_rooms set player_ids = array_remove(player_ids, v_uid) where player_ids @> array[v_uid];
  update public.user_sanctions set created_by = null where created_by = v_uid;

  -- Cascades to public.profiles and from there to every per-user row (header); a second call finds no row.
  delete from auth.users where id = v_uid;
end $$;

-- ---------------------------------------------------------------------------
-- Privileges (explicit, as in 20261029000100_m1_grants.sql)
-- ---------------------------------------------------------------------------

revoke all on public.reports from anon, authenticated;
grant all on public.reports to service_role;

revoke all on function
  public.report_user(uuid, text, text, text, text),
  public.delete_my_account()
from public, anon, authenticated;
grant execute on function
  public.report_user(uuid, text, text, text, text),
  public.delete_my_account()
to authenticated, service_role;

revoke all on function
  private.reports_before_update(),
  private.scrub_match_payload(jsonb, uuid)
from public, anon, authenticated;
