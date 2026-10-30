-- Explicit Data API privileges for the M1 objects. RLS decides which rows a role sees; these grants
-- decide which statements reach the policies at all.
--
-- Why not rely on Supabase's defaults: the platform's default privileges grant ALL on every new public
-- table and function to anon, authenticated and service_role, so
--   * `revoke all on function ... from public` in the init migration does not stop anon (anon holds its
--     own grant), and
--   * nothing at the privilege level stops a user from updating profiles.id / profiles.birth_date. The
--     init migration guards those with a trigger keyed on `request.jwt.claim.role`, a legacy GUC that
--     current PostgREST no longer sets; the column-level grant below is what actually enforces it.
-- Projects created with "automatically expose new tables" turned off get no default grants at all; this
-- file makes both kinds of project behave the same.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Catalog: read-only for clients; the publish tool writes with the service role.
revoke all on public.games, public.game_versions from anon, authenticated;
grant select on public.games, public.game_versions to anon, authenticated;

-- Profiles: signed-in users read any profile; owners update the editable columns only.
-- Rows are inserted by handle_new_user (security definer), never directly by clients.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (username, display_name, avatar_url, bio, privacy) on public.profiles to authenticated;

-- Owner-managed rows (policy: user_id = auth.uid()).
revoke all on public.game_consents, public.favorites from anon, authenticated;
grant select, insert, update, delete on public.game_consents, public.favorites to authenticated;

-- Owner-read rows; writes go through save_put / record_play (security definer).
revoke all on public.game_saves, public.game_stats from anon, authenticated;
grant select on public.game_saves, public.game_stats to authenticated;

-- Word list: never exposed; read through contains_banned_word().
revoke all on public.banned_words from anon, authenticated;

grant all on public.banned_words, public.profiles, public.games, public.game_versions, public.game_consents,
  public.favorites, public.game_saves, public.game_stats to service_role;

-- ---------------------------------------------------------------------------
-- Functions: match the intent of the init migration's grants.
-- ---------------------------------------------------------------------------

revoke execute on function public.save_put(text, text, jsonb, int) from anon;
revoke execute on function public.record_play(text, int) from anon;
revoke execute on function public.contains_banned_word(text) from anon;
grant execute on function public.save_put(text, text, jsonb, int), public.record_play(text, int) to authenticated, service_role;
grant execute on function public.username_available(text) to anon, authenticated, service_role;

-- Trigger functions are not callable through the API, but they have no business being executable by clients.
revoke execute on function public.set_updated_at(), public.profiles_validate(), public.profiles_protect_immutable(),
  public.handle_new_user() from public, anon, authenticated;
