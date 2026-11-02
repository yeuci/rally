-- Feature art: tall key art for the dashboard hero on phones (game.json "feature", uploaded by tooling/publish-game
-- like the icon and the cover). The hero is a tall box on a phone, where a wide cover loses its edges; feature art is
-- composed for it (recommended 1200×1500, the subject in the top two thirds, a calmer bottom-left under the type).
-- Null = none: the app falls back to the cover, then the first screenshot, then generated art.
--
-- Privileges: unchanged. `games` keeps its table-level select grant and the "published games are public" policy, so
-- the column is readable exactly like the rest of the row. trending_games (20261102000600_trending.sql) returns it
-- with the other card columns; its return type changes, so it is dropped and created again with the same grants.

alter table public.games add column feature_url text;
comment on column public.games.feature_url is 'Public URL of the tall feature art (game.json "feature"); null = none';

drop function public.trending_games(int, int);
create function public.trending_games(p_days int default 7, p_limit int default 3)
returns table (
  id text,
  title text,
  description text,
  genres text[],
  icon_url text,
  cover_url text,
  feature_url text,
  screenshots text[],
  min_players int,
  max_players int,
  age_rating public.age_rating,
  featured_rank int,
  created_at timestamptz,
  visits bigint,
  recent_visits bigint
)
language sql stable security invoker set search_path = public, extensions as $$
  select g.id, g.title, g.description, g.genres, g.icon_url, g.cover_url, g.feature_url, g.screenshots, g.min_players,
         g.max_players, g.age_rating, g.featured_rank, g.created_at, g.visits,
         coalesce(d.recent, 0)::bigint as recent_visits
  from public.games g
  left join (
    select v.game_id, sum(v.visits) as recent
    from public.game_visits_daily v
    -- Today and the (p_days - 1) days before it, as UTC days.
    where v.day > (now() at time zone 'utc')::date - least(greatest(coalesce(p_days, 7), 1), 30)
    group by v.game_id
  ) d on d.game_id = g.id
  where g.status = 'published'
  order by coalesce(d.recent, 0) desc, g.visits desc, g.created_at desc, g.id
  limit least(greatest(coalesce(p_limit, 3), 1), 10);
$$;

revoke all on function public.trending_games(int, int) from public;
grant execute on function public.trending_games(int, int) to anon, authenticated, service_role;
