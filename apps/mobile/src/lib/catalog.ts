import type { Tables } from '@rally/db';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useSession } from '@/lib/auth/session';
import { supabase } from '@/lib/supabase';

/**
 * Catalog reads over `games` / `game_versions` (public, published only via RLS) and the user's own
 * `game_stats` / `favorites`. Architecture §3 "Catalog".
 */
export type Game = Tables<'games'>;

/** Columns a card needs (art: lib/game-art.ts); the game page selects `*`. */
const CARD =
  'id, title, description, genres, icon_url, cover_url, screenshots, min_players, max_players, age_rating, featured_rank, created_at' as const;
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
>;

export const catalogKeys = {
  featured: ['catalog', 'featured'] as const,
  newest: ['catalog', 'new'] as const,
  all: ['catalog', 'all'] as const,
  game: (id: string) => ['catalog', 'game', id] as const,
  recent: (uid: string | null) => ['me', uid, 'recent'] as const,
  favorites: (uid: string | null) => ['me', uid, 'favorites'] as const,
};

export function useFeaturedGames() {
  return useQuery({
    queryKey: catalogKeys.featured,
    queryFn: async (): Promise<GameCard[]> => {
      const { data, error } = await supabase
        .from('games')
        .select(CARD)
        .eq('status', 'published')
        .not('featured_rank', 'is', null)
        .order('featured_rank', { ascending: true })
        .limit(10);
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
