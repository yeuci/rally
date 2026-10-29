-- Fixes for the M1 code review (mobile app + database):
--   1. profiles.birth_date / privacy were readable by every signed-in user (table-level select).
--   2. Anonymous sessions (signInAnonymously, before linkIdentity) had the same rights as real accounts.
--   3. username_available counted the caller's own profile as taken; release_username() frees a name
--      reserved by an abandoned anonymous signup.
--   4. Abandoned anonymous users are purged daily (pg_cron, where available).
--
-- "Anonymous" below means the access token says so: (auth.jwt() ->> 'is_anonymous')::boolean is true.
-- A token without the claim (or false) is a linked/regular account.

-- ---------------------------------------------------------------------------
-- 1. Column-level select on profiles: birth_date and privacy are never readable by clients.
--    Clients must select explicit columns (select('*') is refused with "permission denied").
--    Updates stay limited to the columns granted in 20261029000100_m1_grants.sql.
-- ---------------------------------------------------------------------------

revoke select on public.profiles from anon, authenticated;
grant select (id, username, display_name, avatar_url, bio, created_at, updated_at) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Fence anonymous sessions. RESTRICTIVE policies are ANDed with the permissive ones.
-- ---------------------------------------------------------------------------

-- Profiles: an anonymous session sees only its own row (it may still update it: the signup flow can
-- change the username before linking).
create policy "anonymous sessions read only their own profile" on public.profiles
  as restrictive for select to authenticated
  using (((select auth.jwt()) ->> 'is_anonymous')::boolean is not true or id = (select auth.uid()));

-- Consents and favorites: no writes from anonymous sessions (reads of own rows are harmless: there are none).
create policy "anonymous sessions cannot add consents" on public.game_consents
  as restrictive for insert to authenticated
  with check (((select auth.jwt()) ->> 'is_anonymous')::boolean is not true);
create policy "anonymous sessions cannot change consents" on public.game_consents
  as restrictive for update to authenticated
  using (((select auth.jwt()) ->> 'is_anonymous')::boolean is not true)
  with check (((select auth.jwt()) ->> 'is_anonymous')::boolean is not true);
create policy "anonymous sessions cannot remove consents" on public.game_consents
  as restrictive for delete to authenticated
  using (((select auth.jwt()) ->> 'is_anonymous')::boolean is not true);

create policy "anonymous sessions cannot add favorites" on public.favorites
  as restrictive for insert to authenticated
  with check (((select auth.jwt()) ->> 'is_anonymous')::boolean is not true);
create policy "anonymous sessions cannot change favorites" on public.favorites
  as restrictive for update to authenticated
  using (((select auth.jwt()) ->> 'is_anonymous')::boolean is not true)
  with check (((select auth.jwt()) ->> 'is_anonymous')::boolean is not true);
create policy "anonymous sessions cannot remove favorites" on public.favorites
  as restrictive for delete to authenticated
  using (((select auth.jwt()) ->> 'is_anonymous')::boolean is not true);

-- Write RPCs: same bodies as in the init migration plus the anonymous check. create or replace keeps the
-- existing grants (authenticated, service_role; not anon).
create or replace function public.save_put(p_game_id text, p_slot text, p_data jsonb, p_if_version int default null)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_current int;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  if (auth.jwt() ->> 'is_anonymous')::boolean is true then
    raise exception 'ANONYMOUS_FORBIDDEN: link an account first' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_data) is null then
    raise exception 'INVALID: data must be JSON' using errcode = 'check_violation';
  end if;
  select version into v_current from public.game_saves
    where user_id = v_uid and game_id = p_game_id and slot = p_slot for update;
  if p_if_version is not null and coalesce(v_current, 0) <> p_if_version then
    raise exception 'CONFLICT: slot is at version %', coalesce(v_current, 0) using errcode = 'serialization_failure';
  end if;
  if v_current is null then
    insert into public.game_saves (user_id, game_id, slot, data, version)
      values (v_uid, p_game_id, p_slot, p_data, 1);
    return 1;
  else
    update public.game_saves set data = p_data, version = v_current + 1, updated_at = now()
      where user_id = v_uid and game_id = p_game_id and slot = p_slot;
    return v_current + 1;
  end if;
end $$;

create or replace function public.record_play(p_game_id text, p_playtime_s int default 0)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  if (auth.jwt() ->> 'is_anonymous')::boolean is true then
    raise exception 'ANONYMOUS_FORBIDDEN: link an account first' using errcode = 'insufficient_privilege';
  end if;
  insert into public.game_stats (user_id, game_id, plays, playtime_s, last_played_at)
    values (v_uid, p_game_id, 1, greatest(0, least(p_playtime_s, 86400)), now())
  on conflict (user_id, game_id) do update
    set plays = game_stats.plays + 1,
        playtime_s = game_stats.playtime_s + excluded.playtime_s,
        last_played_at = now();
end $$;

-- ---------------------------------------------------------------------------
-- 3. Usernames: the caller's own profile does not count as taken; anonymous signups can release theirs.
-- ---------------------------------------------------------------------------

create or replace function public.username_available(p_username text)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select not exists (
           select 1 from public.profiles
            where username = p_username::citext and id is distinct from auth.uid()
         )
     and p_username ~ '^[A-Za-z0-9_]{3,20}$'
     and not public.contains_banned_word(p_username);
$$;

-- Called by the app before abandoning an anonymous signup (cancel, retry with another date of birth,
-- "already has an account"). Renames the caller's profile to user_<first 12 hex of its id>, which passes
-- profiles_validate (format, word filter) like any other update. No-op for non-anonymous callers.
-- If that name is somehow taken (someone registered it by hand), a random user_<15 hex> is used instead.
create or replace function public.release_username()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or (auth.jwt() ->> 'is_anonymous')::boolean is not true then
    return;
  end if;
  begin
    update public.profiles
       set username = 'user_' || substr(replace(v_uid::text, '-', ''), 1, 12)
     where id = v_uid;
  exception when unique_violation then
    update public.profiles
       set username = 'user_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 15)
     where id = v_uid;
  end;
end $$;
revoke all on function public.release_username() from public, anon;
grant execute on function public.release_username() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Purge anonymous users abandoned for more than a day (profiles and per-user rows cascade).
--    pg_cron is not available everywhere (PGlite in the test suite, some Supabase plans): skip with a
--    NOTICE instead of failing the migration. cron.schedule with a job name is an upsert, so re-running
--    this block is safe. Where it was skipped, enable pg_cron later and run the block again.
-- ---------------------------------------------------------------------------

do $outer$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available: abandoned anonymous users will not be purged automatically';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    execute format(
      'select cron.schedule(%L, %L, %L)',
      'purge-abandoned-anonymous-users',
      '17 3 * * *',
      $cmd$delete from auth.users where is_anonymous and created_at < now() - interval '1 day'$cmd$
    );
  exception when others then
    raise notice 'could not schedule the anonymous-user purge (%): %', sqlstate, sqlerrm;
  end;
end $outer$;
