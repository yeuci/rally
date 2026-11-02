-- Rally trending games: the dashboard hero pages through the games with the most launches over the last seven UTC
-- days (game_visits_daily, 20261031000100_visits.sql) instead of a hand-set featured_rank. Pinned by
-- test/trending.test.ts.
--
--   * public.trending_games(p_days, p_limit)   the published games in order of launches over the last p_days UTC days
--       (today included; 1..30, default 7), then all-time visits, then newest, then id; the first p_limit of them
--       (1..10, default 3). A game with no launches in the window still ranks (by all-time visits, then newest), so a
--       fresh catalog fills the hero too. Returns the card columns the app's catalog selects, plus recent_visits (the
--       launches in the window) for a "1.2K visits this week" line.
--       Security invoker: games and game_visits_daily are readable by anon and authenticated for published games, and
--       the function reads nothing else, so it adds no access of its own.
--   * games.featured_rank stays: Browse's Popular order breaks ties on it, and it can pin an editor's pick later. The
--       hero no longer reads it.

create or replace function public.trending_games(p_days int default 7, p_limit int default 3)
returns table (
  id text,
  title text,
  description text,
  genres text[],
  icon_url text,
  cover_url text,
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
  select g.id, g.title, g.description, g.genres, g.icon_url, g.cover_url, g.screenshots, g.min_players, g.max_players,
         g.age_rating, g.featured_rank, g.created_at, g.visits, coalesce(d.recent, 0)::bigint as recent_visits
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
