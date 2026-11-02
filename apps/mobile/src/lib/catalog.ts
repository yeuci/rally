import type { Tables } from '@rally/db';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useSession } from '@/lib/auth/session';
import {
  LIVE_COUNTS_REFRESH_MS,
  toLiveCounts,
  toVisitsDaily,
  visitsDailyRange,
  type LiveCount,
  type VisitsDay,
} from '@/lib/dashboard';
import { supabase } from '@/lib/supabase';

/**
 * Catalog reads over `games` / `game_versions` (public, published only via RLS) and the user's own
 * `game_stats` / `favorites`. Architecture §3 "Catalog".
 */
export type Game = Tables<'games'>;

/**
 * Columns a card needs (art: lib/game-art.ts; `visits` for Browse's Popular order and the "12.4K visits" lines); the
 * game page selects `*`.
 */
const CARD =
  'id, title, description, genres, icon_url, cover_url, screenshots, min_players, max_players, age_rating, featured_rank, created_at, visits' as const;
export type GameCard = Pick<
  Game,
  | 'id'
  | 'title'
  | 'description'
  | 'genres'
  | 'icon_url'
  | 'cover_url'
  | 'screenshots'
  | 'min_players'
  | 'max_players'
  | 'age_rating'
  | 'featured_rank'
  | 'created_at'
  | 'visits'
>;

export const catalogKeys = {
  trending: ['catalog', 'trending'] as const,
  newest: ['catalog', 'new'] as const,
  all: ['catalog', 'all'] as const,
  game: (id: string) => ['catalog', 'game', id] as const,
  recent: (uid: string | null) => ['me', uid, 'recent'] as const,
  favorites: (uid: string | null) => ['me', uid, 'favorites'] as const,
  liveCounts: ['catalog', 'live-counts'] as const,
  visitsDaily: (id: string) => ['catalog', 'game', id, 'visits-daily'] as const,
};

/**
 * Players and public rooms per multiplayer game right now (`game_live_counts`, m3-phase2 §2), for "12 playing" on
 * tiles and the featured hero. Polled every 30 s while `live` (the dashboard is in front; React Query also pauses in
 * the background). A failure just hides the counts.
 */
export function useLiveCounts(live = true) {
  return useQuery({
    queryKey: catalogKeys.liveCounts,
    staleTime: 15_000,
    retry: 1,
    refetchInterval: live ? LIVE_COUNTS_REFRESH_MS : false,
    queryFn: async (): Promise<Map<string, LiveCount>> => {
      const { data, error } = await supabase.rpc('game_live_counts');
      if (error) throw error;
      return toLiveCounts(data);
    },
  });
}

/** A hero game: a card plus its launches over the trending window (`trending_games`, 20261102000600_trending.sql). */
export type TrendingGame = GameCard & { recent_visits: number };

/** Days of launches the hero ranks on ("visits this week"): the server's default window. */
export const TRENDING_DAYS = 7;
/** How many games the hero pages through. */
export const TRENDING_COUNT = 3;

/**
 * The dashboard hero's games: the published games with the most launches over the last `TRENDING_DAYS` UTC days,
 * then all-time visits, then newest (`trending_games`), so the hero follows what players actually open instead of a
 * hand-set `featured_rank`. Refetched with the dashboard (focus, pull to refresh); the order moves slowly, so a
 * five-minute stale time keeps the pager still while the player is on the screen.
 */
export function useTrendingGames() {
  return useQuery({
    queryKey: catalogKeys.trending,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<TrendingGame[]> => {
      const { data, error } = await supabase.rpc('trending_games', { p_days: TRENDING_DAYS, p_limit: TRENDING_COUNT });
      if (error) throw error;
      return data;
    },
  });
}

export function useNewGames() {
  return useQuery({
    queryKey: catalogKeys.newest,
    queryFn: async (): Promise<GameCard[]> => {
      const { data, error } = await supabase
        .from('games')
        .select(CARD)
        .eq('status', 'published')
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data;
    },
  });
}

/** Whole published catalog for search. M1 catalogs are small; search filters client-side. */
export function useAllGames(enabled = true) {
  return useQuery({
    queryKey: catalogKeys.all,
    enabled,
    queryFn: async (): Promise<GameCard[]> => {
      const { data, error } = await supabase.from('games').select(CARD).eq('status', 'published').order('title').limit(500);
      if (error) throw error;
      return data;
    },
  });
}

export function useGame(id: string | undefined) {
  return useQuery({
    queryKey: catalogKeys.game(id ?? ''),
    enabled: !!id,
    queryFn: async (): Promise<Game | null> => {
      const { data, error } = await supabase.from('games').select('*').eq('id', id!).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/**
 * Visits per UTC day over the last `VISITS_DAILY_DAYS` days (today included) from `game_visits_daily`, oldest first,
 * missing days as 0 (lib/dashboard.ts `toVisitsDaily`). For a per-game trend line; nothing renders it yet. Keyed
 * under the game's catalog entry, so `invalidateAfterPlay` refreshes it with the total.
 */
export function useVisitsDaily(gameId: string | undefined) {
  return useQuery({
    queryKey: catalogKeys.visitsDaily(gameId ?? ''),
    enabled: !!gameId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<VisitsDay[]> => {
      const now = Date.now();
      const { from, to } = visitsDailyRange(now);
      const { data, error } = await supabase
        .from('game_visits_daily')
        .select('day, visits')
        .eq('game_id', gameId!)
        .gte('day', from)
        .lte('day', to)
        .order('day', { ascending: true });
      if (error) throw error;
      return toVisitsDaily(data, now);
    },
  });
}

export function useRecentlyPlayed() {
  const { userId } = useSession();
  return useQuery({
    queryKey: catalogKeys.recent(userId),
    enabled: !!userId,
    queryFn: async (): Promise<(GameCard & { last_played_at: string | null })[]> => {
      const { data, error } = await supabase
        .from('game_stats')
        .select(`last_played_at, game:games(${CARD})`)
        .eq('user_id', userId!)
        .not('last_played_at', 'is', null)
        .order('last_played_at', { ascending: false })
        .limit(12);
      if (error) throw error;
      return data.flatMap((row) => (row.game ? [{ ...row.game, last_played_at: row.last_played_at }] : []));
    },
  });
}

export function useFavorites() {
  const { userId } = useSession();
  return useQuery({
    queryKey: catalogKeys.favorites(userId),
    enabled: !!userId,
    queryFn: async (): Promise<GameCard[]> => {
      const { data, error } = await supabase
        .from('favorites')
        .select(`created_at, game:games(${CARD})`)
        .eq('user_id', userId!)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data.flatMap((row) => (row.game ? [row.game] : []));
    },
  });
}

/** Optimistic favorite toggle on the `favorites` table (owner-only RLS). */
export function useToggleFavorite() {
  const { userId } = useSession();
  const qc = useQueryClient();
  const key = catalogKeys.favorites(userId);

  return useMutation({
    mutationFn: async ({ game, favorite }: { game: GameCard; favorite: boolean }) => {
      if (!userId) throw new Error('Not signed in');
      const { error } = favorite
        ? await supabase.from('favorites').upsert({ user_id: userId, game_id: game.id }, { ignoreDuplicates: true })
        : await supabase.from('favorites').delete().eq('user_id', userId).eq('game_id', game.id);
      if (error) throw error;
    },
    onMutate: async ({ game, favorite }) => {
      void Haptics.selectionAsync().catch(() => {});
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<GameCard[]>(key);
      qc.setQueryData<GameCard[]>(key, (list = []) =>
        favorite ? [game, ...list.filter((g) => g.id !== game.id)] : list.filter((g) => g.id !== game.id),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function playersLabel(g: Pick<Game, 'min_players' | 'max_players'>): string {
  if (g.max_players <= 1) return 'Solo';
  if (g.min_players === g.max_players) return `${g.min_players} players`;
  return `${g.min_players}–${g.max_players} players`;
}
