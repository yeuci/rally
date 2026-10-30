-- Rally social Realtime: friend requests and their outcomes are pushed to the two people concerned through Supabase
-- Realtime Broadcast-from-database into one private channel per user (docs/architecture.md, "Realtime"; ADR 0004).
-- Pinned by test/social-realtime.test.ts.
--
-- public.friendships is NOT in the supabase_realtime publication: postgres_changes cannot filter DELETE events nor
-- apply RLS to them, so every subscriber would learn which pairs had a request or friendship removed.
--
--   * Topic `user:<uid>`, private channel. Event 'social', payload
--       { type, from: <uid of the actor>, to: <uid of the recipient = owner of the topic>, at: <ISO 8601 UTC> }
--     with no usernames (the app looks the profile up). Each change is sent to ONE topic, the recipient's:
--       type                       when                                                   from        to
--       friend_request             INSERT, status pending                                 requester   recipient
--       friend_accepted            UPDATE pending -> accepted (respond_friend_request,    recipient   requester
--                                  or send_friend_request back = mutual auto-accept)
--       friend_declined            DELETE pending, by the recipient (respond(.., false))  recipient   requester
--       friend_request_cancelled   DELETE pending, by the requester (remove_friend)       requester   recipient
--       friend_removed             DELETE accepted, by either side (remove_friend)        remover     other side
--     block_user deletes the row too and sends the same event as the matching decline / cancel / remove, so a
--     block is indistinguishable from them (nobody learns who blocked whom, as in 20261030000300). A request to
--     someone who blocked you creates no row and sends nothing.
--     Nothing is sent when nothing relevant changed (an UPDATE that keeps the status, an INSERT already
--     'accepted'), nor for a DELETE whose actor (auth.uid()) is not one of the two users: service-role deletes
--     and deletes without a user JWT (purge jobs, the cascade of an account deletion).
--   * Delivery: private.broadcast_friendship_change(), an AFTER INSERT / UPDATE / DELETE row trigger, calls
--     realtime.send(payload, 'social', 'user:<to>', true). It no-ops where realtime.send does not exist (PGlite
--     tests, a local stack without Realtime). A failing send raises a WARNING and never fails the friendship
--     change (the app also refetches on focus).
--   * Who may listen: RLS on realtime.messages. Policy "users receive their own user channel": SELECT only, to
--     authenticated, realtime.topic() = 'user:' || auth.uid(). There is no INSERT policy, so clients cannot
--     broadcast or track presence on user:* topics; only the trigger (as the function owner) sends. Skipped with a
--     NOTICE where realtime.messages does not exist.

-- ---------------------------------------------------------------------------
-- Trigger
-- ---------------------------------------------------------------------------

create or replace function private.broadcast_friendship_change()
returns trigger language plpgsql volatile security definer set search_path = public, extensions, realtime as $$
declare
  v_actor uuid := auth.uid();
  v_type text;
  v_from uuid;
  v_to uuid;
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending' then
      v_type := 'friend_request'; v_from := new.user_id; v_to := new.friend_id;
    end if;
  elsif tg_op = 'UPDATE' then
    if old.status = 'pending' and new.status = 'accepted'
       and new.user_id = old.user_id and new.friend_id = old.friend_id then
      v_type := 'friend_accepted'; v_from := new.friend_id; v_to := new.user_id;
    end if;
  elsif tg_op = 'DELETE' and v_actor in (old.user_id, old.friend_id) then
    v_from := v_actor;
    v_to := case when v_actor = old.user_id then old.friend_id else old.user_id end;
    v_type := case
      when old.status = 'accepted' then 'friend_removed'
      when v_actor = old.friend_id then 'friend_declined'
      else 'friend_request_cancelled'
    end;
  end if;

  if v_type is null or to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then
    return null;
  end if;
  begin
    perform realtime.send(
      jsonb_build_object(
        'type', v_type,
        'from', v_from,
        'to', v_to,
        'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ),
      'social',
      'user:' || v_to::text,
      true
    );
  exception when others then
    raise warning 'realtime.send failed for % to user:% (%): %', v_type, v_to, sqlstate, sqlerrm;
  end;
  return null;
end $$;

revoke all on function private.broadcast_friendship_change() from public, anon, authenticated;

create or replace trigger friendships_broadcast after insert or update or delete on public.friendships
  for each row execute function private.broadcast_friendship_change();

-- ---------------------------------------------------------------------------
-- Private channel authorization: a user receives only user:<own uid>
-- ---------------------------------------------------------------------------

do $outer$
begin
  if to_regclass('realtime.messages') is null or to_regprocedure('realtime.topic()') is null then
    raise notice 'realtime.messages does not exist: no policy for the private user:<uid> channels';
    return;
  end if;
  drop policy if exists "users receive their own user channel" on realtime.messages;
  create policy "users receive their own user channel" on realtime.messages
    for select to authenticated
    using ((select realtime.topic()) = 'user:' || (select auth.uid())::text);
end $outer$;
