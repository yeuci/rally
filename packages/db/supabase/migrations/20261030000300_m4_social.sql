-- Rally M4 (part 1): friendships, blocks, people search, profile privacy. See docs/architecture.md §4 and §8.
--
-- Clients read their own `friendships` / `blocks` rows and never write them: every change goes through the
-- security definer RPCs below, which keep the invariants:
--   * a pair of users has at most ONE friendships row, in one direction: user_id = who sent the request,
--     friend_id = who received it; status 'pending' until accepted ('accepted', accepted_at set). A unique index
--     on the unordered pair enforces it in the database too (two users sending at the same time cannot create
--     two rows);
--   * a block (either direction) removes any friendship or request between the two and refuses new requests
--     with the same BLOCKED error both ways, so nobody learns who blocked whom; blocked users are hidden from
--     each other in search, profile lists and friendship_with;
--   * anonymous sessions (signInAnonymously before linkIdentity) cannot write anything or search people.
--
-- profiles.privacy (owner-updatable jsonb, never client-readable) gains two checked keys:
--   games    'public' (default when absent) | 'friends' | 'private'  -> public_profile_games, public_profile_stats.games_played
--   friends  'public' (default when absent) | 'friends' | 'private'  -> public_friends
-- 'friends' means the owner and their accepted friends; 'private' the owner only. Signed-out and anonymous
-- callers are strangers; a block in either direction hides everything.
--
-- Errors follow m2: UNAUTHENTICATED, ANONYMOUS_FORBIDDEN, BLOCKED (SQLSTATE 42501), NOT_FOUND (P0002),
-- INVALID (22023), RATE_LIMITED (P0001).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create type public.friendship_status as enum ('pending', 'accepted');

create table public.friendships (
  user_id uuid not null references public.profiles (id) on delete cascade,      -- requester
  friend_id uuid not null references public.profiles (id) on delete cascade,    -- recipient
  status public.friendship_status not null default 'pending',
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (user_id, friend_id),
  constraint friendships_not_self check (user_id <> friend_id),
  constraint friendships_accepted_at check ((status = 'accepted') = (accepted_at is not null))
);
alter table public.friendships enable row level security;
-- One row per unordered pair: (a, b) and (b, a) cannot both exist. Also serves pair lookups.
create unique index friendships_pair_idx on public.friendships
  (least(user_id, friend_id), greatest(user_id, friend_id));
-- The primary key serves "rows I sent" (user_id first); this serves "rows sent to me".
create index friendships_friend_idx on public.friendships (friend_id, status);

create policy "users read their own friendships and requests" on public.friendships
  for select to authenticated using ((select auth.uid()) in (user_id, friend_id));

create table public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_not_self check (blocker_id <> blocked_id)
);
alter table public.blocks enable row level security;
create index blocks_blocked_idx on public.blocks (blocked_id);

-- Only the blocker sees a block (the blocked user must not learn about it).
create policy "users read the blocks they made" on public.blocks
  for select to authenticated using (blocker_id = (select auth.uid()));

-- Prefix search on usernames (search_profiles).
create index profiles_username_prefix_idx on public.profiles (lower(username::text) text_pattern_ops);

-- ---------------------------------------------------------------------------
-- profiles.privacy: checked keys
-- ---------------------------------------------------------------------------

create or replace function public.profiles_validate_privacy()
returns trigger language plpgsql set search_path = public, extensions as $$
declare
  k text;
begin
  if jsonb_typeof(new.privacy) is distinct from 'object' then
    raise exception 'INVALID: privacy must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;
  foreach k in array array['games', 'friends'] loop
    if new.privacy ? k
       and (jsonb_typeof(new.privacy -> k) <> 'string' or new.privacy ->> k not in ('public', 'friends', 'private')) then
      raise exception 'INVALID: privacy.% must be public, friends or private', k using errcode = 'invalid_parameter_value';
    end if;
  end loop;
  return new;
end $$;
create trigger profiles_validate_privacy before insert or update of privacy on public.profiles
  for each row execute function public.profiles_validate_privacy();

-- ---------------------------------------------------------------------------
-- Internal helpers. Schema `private` is not exposed through the Data API and clients have no usage on it;
-- only the security definer RPCs below call these (they run as the function owner).
-- ---------------------------------------------------------------------------

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- A block exists between a and b, in either direction. False when either is null.
create or replace function private.is_blocked(a uuid, b uuid)
returns boolean language sql stable set search_path = public, extensions as $$
  select exists (
    select 1 from public.blocks
     where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)
  );
$$;

-- a and b are accepted friends (either direction). False when either is null.
create or replace function private.is_friend(a uuid, b uuid)
returns boolean language sql stable set search_path = public, extensions as $$
  select exists (
    select 1 from public.friendships
     where status = 'accepted'
       and ((user_id = a and friend_id = b) or (user_id = b and friend_id = a))
  );
$$;

-- May p_viewer (null = stranger: signed out or anonymous) see p_owner's p_key section ('games' | 'friends')?
-- The owner always may; a block either way hides it; else privacy->>p_key: public (default) | friends | private.
create or replace function private.can_view(p_owner uuid, p_viewer uuid, p_key text)
returns boolean language sql stable set search_path = public, extensions as $$
  select case
    when p_viewer is not null and p_viewer = p_owner then true
    when private.is_blocked(p_owner, p_viewer) then false
    else case coalesce((select p.privacy ->> p_key from public.profiles p where p.id = p_owner), 'public')
      when 'public' then true
      when 'friends' then p_viewer is not null and private.is_friend(p_owner, p_viewer)
      else false
    end
  end;
$$;

-- The caller for read RPCs: auth.uid(), or null for signed-out and anonymous sessions (strangers).
create or replace function private.viewer()
returns uuid language sql stable set search_path = public, extensions as $$
  select case when (auth.jwt() ->> 'is_anonymous')::boolean is true then null else auth.uid() end;
$$;

-- Raises unless the caller is signed in with a linked (non-anonymous) account; returns auth.uid().
create or replace function private.require_member()
returns uuid language plpgsql stable set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  if (auth.jwt() ->> 'is_anonymous')::boolean is true then
    raise exception 'ANONYMOUS_FORBIDDEN: link an account first' using errcode = 'insufficient_privilege';
  end if;
  return v_uid;
end $$;

-- Raises NOT_FOUND unless p_user_id is an existing profile.
create or replace function private.require_profile(p_user_id uuid)
returns void language plpgsql stable set search_path = public, extensions as $$
begin
  if p_user_id is null or not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'NOT_FOUND: user' using errcode = 'no_data_found';
  end if;
end $$;

revoke all on all functions in schema private from public, anon, authenticated;

-- The caller's own privacy settings for the settings screen (profiles.privacy is not client-readable, not even by
-- its owner): the stored object with the checked keys defaulted, so `games` and `friends` are always present
-- ('public' when absent). Other stored keys are returned as they are. Anonymous sessions may call it (they have a
-- profile); signed out raises UNAUTHENTICATED.
create or replace function public.my_privacy()
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_privacy jsonb;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  select privacy into v_privacy from public.profiles where id = v_uid;
  return jsonb_build_object('games', 'public', 'friends', 'public')
      || case when jsonb_typeof(v_privacy) = 'object' then v_privacy else '{}'::jsonb end;
end $$;

-- ---------------------------------------------------------------------------
-- Relationship state
-- ---------------------------------------------------------------------------

-- The caller's relationship with p_user_id:
--   'self'      p_user_id is the caller
--   'friends'   accepted friendship (either direction)
--   'outgoing'  the caller sent a pending request
--   'incoming'  the caller received a pending request
--   'blocked'   the caller blocked them
--   'none'      anything else, including "they blocked the caller" (never revealed) and every
--               signed-out or anonymous caller
-- NOT_FOUND for an unknown user.
create or replace function public.friendship_with(p_user_id uuid)
returns text language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.viewer();
  v_row public.friendships;
begin
  perform private.require_profile(p_user_id);
  if v_uid is null then
    return 'none';
  end if;
  if p_user_id = v_uid then
    return 'self';
  end if;
  if exists (select 1 from public.blocks where blocker_id = v_uid and blocked_id = p_user_id) then
    return 'blocked';
  end if;
  if exists (select 1 from public.blocks where blocker_id = p_user_id and blocked_id = v_uid) then
    return 'none';
  end if;
  select * into v_row from public.friendships f
   where (f.user_id = v_uid and f.friend_id = p_user_id) or (f.user_id = p_user_id and f.friend_id = v_uid);
  if not found then
    return 'none';
  elsif v_row.status = 'accepted' then
    return 'friends';
  elsif v_row.user_id = v_uid then
    return 'outgoing';
  else
    return 'incoming';
  end if;
end $$;

-- People search for linked accounts. p_query is trimmed and must be 1..32 characters; p_limit is clamped to 1..50.
-- Matches usernames starting with p_query and display names containing it (case-insensitive, LIKE wildcards in
-- the query are literal). Username-prefix matches come first, then display-name matches, each by username.
-- Excludes the caller, anonymous (not yet linked) accounts and anyone with a block either way.
create or replace function public.search_profiles(p_query text, p_limit int default 20)
returns table (user_id uuid, username text, display_name text, avatar_url text, friendship text)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := private.require_member();
  v_q text := btrim(p_query);
  v_limit int := greatest(1, least(coalesce(p_limit, 20), 50));
  v_pattern text;
begin
  if v_q is null or char_length(v_q) < 1 or char_length(v_q) > 32 then
    raise exception 'INVALID: query must be 1 to 32 characters' using errcode = 'invalid_parameter_value';
  end if;
  v_pattern := lower(replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_'));
  return query
    select p.id, p.username::text, p.display_name, p.avatar_url, public.friendship_with(p.id)
      from public.profiles p
     where p.id <> v_uid
       and (lower(p.username::text) like v_pattern || '%' or lower(p.display_name) like '%' || v_pattern || '%')
       and not exists (
         select 1 from public.blocks b
          where (b.blocker_id = v_uid and b.blocked_id = p.id) or (b.blocker_id = p.id and b.blocked_id = v_uid)
       )
       and not exists (select 1 from auth.users u where u.id = p.id and u.is_anonymous)
     order by (lower(p.username::text) like v_pattern || '%') desc, p.username
     limit v_limit;
end $$;

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- Sends (or completes) a friend request. Returns the new friendship_with value:
--   'friends'   already friends, or p_user_id had sent the caller a pending request (accepted now)
--   'outgoing'  a request is pending (new or already sent)
-- Raises INVALID (self), NOT_FOUND (unknown or anonymous user), BLOCKED (a block either way),
-- RATE_LIMITED (more than 30 calls per user per hour, token bucket).
create or replace function public.send_friend_request(p_user_id uuid)
returns text language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_row public.friendships;
begin
  if p_user_id = v_uid then
    raise exception 'INVALID: cannot send a friend request to yourself' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_profile(p_user_id);
  if exists (select 1 from auth.users u where u.id = p_user_id and u.is_anonymous) then
    raise exception 'NOT_FOUND: user' using errcode = 'no_data_found';
  end if;
  if private.is_blocked(v_uid, p_user_id) then
    raise exception 'BLOCKED: cannot send a friend request to this user' using errcode = 'insufficient_privilege';
  end if;
  if not public.take_rate_limit_token(v_uid, 'send_friend_request', 30, 30.0 / 3600) then
    raise exception 'RATE_LIMITED: too many friend requests, try again later';
  end if;

  -- At most a few rounds: a concurrent request from the other side makes our insert a no-op (pair index), and
  -- the next round finds and accepts it.
  for i in 1..3 loop
    select * into v_row from public.friendships f
     where (f.user_id = v_uid and f.friend_id = p_user_id) or (f.user_id = p_user_id and f.friend_id = v_uid)
       for update;
    if found then
      if v_row.status = 'accepted' then
        return 'friends';
      elsif v_row.user_id = v_uid then
        return 'outgoing';
      end if;
      update public.friendships set status = 'accepted', accepted_at = now()
       where user_id = p_user_id and friend_id = v_uid;
      return 'friends';
    end if;
    insert into public.friendships (user_id, friend_id) values (v_uid, p_user_id) on conflict do nothing;
    if found then
      return 'outgoing';
    end if;
  end loop;
  raise exception 'CONFLICT: friendship changed concurrently, try again' using errcode = 'serialization_failure';
end $$;

-- Answers a pending request FROM p_user_id TO the caller: accept -> 'friends', decline -> 'none' (the row is
-- deleted, so p_user_id may ask again). NOT_FOUND when there is no such pending request.
create or replace function public.respond_friend_request(p_user_id uuid, p_accept boolean)
returns text language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
begin
  if p_accept is null then
    raise exception 'INVALID: accept must be true or false' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_profile(p_user_id);
  if p_accept then
    update public.friendships set status = 'accepted', accepted_at = now()
     where user_id = p_user_id and friend_id = v_uid and status = 'pending';
  else
    delete from public.friendships where user_id = p_user_id and friend_id = v_uid and status = 'pending';
  end if;
  if not found then
    raise exception 'NOT_FOUND: friend request' using errcode = 'no_data_found';
  end if;
  return case when p_accept then 'friends' else 'none' end;
end $$;

-- Ends an accepted friendship (either direction) or cancels the caller's own pending request. An incoming
-- request is not touched (decline it with respond_friend_request). No error when there is nothing to remove.
create or replace function public.remove_friend(p_user_id uuid)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
begin
  perform private.require_profile(p_user_id);
  delete from public.friendships f
   where (f.status = 'accepted'
          and ((f.user_id = v_uid and f.friend_id = p_user_id) or (f.user_id = p_user_id and f.friend_id = v_uid)))
      or (f.status = 'pending' and f.user_id = v_uid and f.friend_id = p_user_id);
end $$;

-- Blocks p_user_id (idempotent) and removes any friendship or request between the two, in either direction.
create or replace function public.block_user(p_user_id uuid)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
begin
  if p_user_id = v_uid then
    raise exception 'INVALID: cannot block yourself' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_profile(p_user_id);
  insert into public.blocks (blocker_id, blocked_id) values (v_uid, p_user_id) on conflict do nothing;
  delete from public.friendships f
   where (f.user_id = v_uid and f.friend_id = p_user_id) or (f.user_id = p_user_id and f.friend_id = v_uid);
end $$;

-- Removes the caller's block on p_user_id (idempotent). Friendships removed by the block are not restored.
create or replace function public.unblock_user(p_user_id uuid)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
begin
  if p_user_id = v_uid then
    raise exception 'INVALID: cannot unblock yourself' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_profile(p_user_id);
  delete from public.blocks where blocker_id = v_uid and blocked_id = p_user_id;
end $$;

-- ---------------------------------------------------------------------------
-- Lists
-- ---------------------------------------------------------------------------

-- The caller's accepted friends, most recently accepted first (`since` = accepted_at). p_limit clamped to 1..500.
-- Anonymous sessions have no friends (empty); signed out raises UNAUTHENTICATED.
create or replace function public.my_friends(p_limit int default 200)
returns table (user_id uuid, username text, display_name text, avatar_url text, since timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_limit int := greatest(1, least(coalesce(p_limit, 200), 500));
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  return query
    select p.id, p.username::text, p.display_name, p.avatar_url, f.accepted_at
      from public.friendships f
      join public.profiles p on p.id = case when f.user_id = v_uid then f.friend_id else f.user_id end
     where f.status = 'accepted' and (f.user_id = v_uid or f.friend_id = v_uid)
     order by f.accepted_at desc, p.username
     limit v_limit;
end $$;

-- Pending requests involving the caller, newest first. direction: 'incoming' (they sent it) or 'outgoing'.
create or replace function public.my_friend_requests()
returns table (user_id uuid, username text, display_name text, avatar_url text, direction text, created_at timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  return query
    select p.id, p.username::text, p.display_name, p.avatar_url,
           case when f.friend_id = v_uid then 'incoming' else 'outgoing' end, f.created_at
      from public.friendships f
      join public.profiles p on p.id = case when f.user_id = v_uid then f.friend_id else f.user_id end
     where f.status = 'pending' and (f.user_id = v_uid or f.friend_id = v_uid)
     order by f.created_at desc, p.username;
end $$;

-- Accepted friends of p_user_id for their public profile, most recent first; p_limit clamped to 1..200.
-- Empty unless the caller may see the owner's friends (privacy.friends, blocks: see private.can_view). Friends
-- with a block either way with the caller are left out. Callable signed out (stranger).
create or replace function public.public_friends(p_user_id uuid, p_limit int default 50)
returns table (user_id uuid, username text, display_name text, avatar_url text, since timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_viewer uuid := private.viewer();
  v_limit int := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  perform private.require_profile(p_user_id);
  if not private.can_view(p_user_id, v_viewer, 'friends') then
    return;
  end if;
  return query
    select p.id, p.username::text, p.display_name, p.avatar_url, f.accepted_at
      from public.friendships f
      join public.profiles p on p.id = case when f.user_id = p_user_id then f.friend_id else f.user_id end
     where f.status = 'accepted' and (f.user_id = p_user_id or f.friend_id = p_user_id)
       and not private.is_blocked(p.id, v_viewer)
     order by f.accepted_at desc, p.username
     limit v_limit;
end $$;

-- Published games p_user_id has played or scored in, most recently played first; p_limit clamped to 1..100.
-- Empty unless the caller may see the owner's games (privacy.games, blocks). Callable signed out (stranger).
create or replace function public.public_profile_games(p_user_id uuid, p_limit int default 20)
returns table (game_id text, title text, icon_url text, cover_url text, plays int, best_score double precision,
               last_played_at timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 20), 100));
begin
  perform private.require_profile(p_user_id);
  if not private.can_view(p_user_id, private.viewer(), 'games') then
    return;
  end if;
  return query
    select g.id, g.title, g.icon_url, g.cover_url, s.plays, s.best_score, s.last_played_at
      from public.game_stats s
      join public.games g on g.id = s.game_id and g.status = 'published'
     where s.user_id = p_user_id
     order by s.last_played_at desc nulls last, g.title
     limit v_limit;
end $$;

-- ---------------------------------------------------------------------------
-- M2 functions updated for friendships (create or replace keeps their grants)
-- ---------------------------------------------------------------------------

-- Top of a board for its current period, best first per the board's sort; ties share a rank (1, 1, 3) and are
-- listed by who got there first. p_limit is clamped to 1..100.
--   p_scope 'global'  everyone; callable signed out (anon key), the boards of published games are public.
--   p_scope 'friends' the caller and their accepted friends (either direction), ranked among themselves; nothing
--                     when signed out. Blocking removes the friendship, so blocked users never appear here.
create or replace function public.leaderboard_top(
  p_game_id text, p_board_key text, p_scope text default 'global', p_limit int default 25
)
returns table (rank int, user_id uuid, username text, avatar_url text, score double precision, is_me boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_board public.leaderboards;
  v_limit int := greatest(1, least(coalesce(p_limit, 25), 100));
begin
  if p_scope is null or p_scope not in ('global', 'friends') then
    raise exception 'INVALID: scope must be global or friends' using errcode = 'invalid_parameter_value';
  end if;
  select b.* into v_board
    from public.leaderboards b join public.games g on g.id = b.game_id
   where b.game_id = p_game_id and b.key = p_board_key and g.status = 'published';
  if not found then
    raise exception 'NOT_FOUND: leaderboard %', coalesce(p_board_key, 'null') using errcode = 'no_data_found';
  end if;
  if p_scope = 'friends' and v_uid is null then
    return;
  end if;
  -- v_board.sort is 'asc' or 'desc' (check constraint), so it is safe to splice into the ORDER BY; a literal
  -- direction lets the planner walk leaderboard_entries_rank_idx forwards or backwards and stop at the limit.
  return query execute format(
    $q$
      select (rank() over (order by e.score %1$s))::int, e.user_id, p.username::text, p.avatar_url, e.score,
             coalesce(e.user_id = $3, false)
        from public.leaderboard_entries e
        join public.profiles p on p.id = e.user_id
       where e.leaderboard_id = $1 and e.period_key = $2
         and ($4 = 'global' or e.user_id = $3 or exists (
               select 1 from public.friendships f
                where f.status = 'accepted'
                  and ((f.user_id = $3 and f.friend_id = e.user_id) or (f.friend_id = $3 and f.user_id = e.user_id))))
       order by e.score %1$s, e.updated_at, e.user_id
       limit $5
    $q$, v_board.sort)
    using v_board.id, public.period_key(v_board.period, now()), v_uid, p_scope, v_limit;
end $$;

-- Counters for a public profile, computed server-side so clients never read another user's game_stats:
--   achievements  unlocked achievements (always public)
--   games_played  distinct games in game_stats, or null when the caller may not see the owner's games
--                 (privacy.games / blocks, as public_profile_games)
--   friends       accepted friendships
-- Zeros for an unknown user. Linked accounts only (UNAUTHENTICATED / ANONYMOUS_FORBIDDEN otherwise).
create or replace function public.public_profile_stats(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
begin
  return jsonb_build_object(
    'achievements', (select count(*)::int from public.user_achievements where user_id = p_user_id),
    'games_played', case
      when private.can_view(p_user_id, v_uid, 'games')
        then (select count(distinct game_id)::int from public.game_stats where user_id = p_user_id)
    end,
    'friends', (select count(*)::int from public.friendships
                 where status = 'accepted' and (user_id = p_user_id or friend_id = p_user_id))
  );
end $$;

-- ---------------------------------------------------------------------------
-- Privileges (explicit, as in 20261029000100_m1_grants.sql)
-- ---------------------------------------------------------------------------

revoke all on public.friendships, public.blocks from anon, authenticated;
grant select on public.friendships, public.blocks to authenticated;
grant all on public.friendships, public.blocks to service_role;

revoke all on function
  public.friendship_with(uuid),
  public.search_profiles(text, int),
  public.send_friend_request(uuid),
  public.respond_friend_request(uuid, boolean),
  public.remove_friend(uuid),
  public.block_user(uuid),
  public.unblock_user(uuid),
  public.my_friends(int),
  public.my_friend_requests(),
  public.public_friends(uuid, int),
  public.public_profile_games(uuid, int),
  public.my_privacy()
from public, anon, authenticated;

grant execute on function
  public.friendship_with(uuid),
  public.public_friends(uuid, int),
  public.public_profile_games(uuid, int)
to anon, authenticated, service_role;
grant execute on function
  public.search_profiles(text, int),
  public.send_friend_request(uuid),
  public.respond_friend_request(uuid, boolean),
  public.remove_friend(uuid),
  public.block_user(uuid),
  public.unblock_user(uuid),
  public.my_friends(int),
  public.my_friend_requests(),
  public.my_privacy()
to authenticated, service_role;

revoke execute on function public.profiles_validate_privacy() from public, anon, authenticated;
