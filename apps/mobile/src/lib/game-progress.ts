import { PROFILE_COLUMNS } from '@rally/db';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth/session';
import { resolveAvatarUrl, type Profile } from '@/lib/profile';
import {
  LEADERBOARD_ROWS,
  parseMyRank,
  parsePublicStats,
  toAchievementTile,
  toLeaderboardRows,
  type AchievementTile,
  type LeaderboardRow,
} from '@/lib/progress-format';
import { supabase } from '@/lib/supabase';

/**
 * Leaderboards, achievements and public profiles (architecture §3 "Progression"). Reads only: scores and unlocks
 * are written by the game through the bridge (game-host/supabase-progress.ts). Everything per game sits under
 * `progressKeys.game(uid, gameId)` so the play route can refresh it all when a session ends.
 */
export type Scope = 'global' | 'friends';

export interface Board {
  id: string;
  key: string;
  sort: string;
  period: string;
}

export const progressKeys = {
  game: (uid: string | null, gameId: string) => ['progress', uid, gameId] as const,
  boards: (uid: string | null, gameId: string) => ['progress', uid, gameId, 'boards'] as const,
  top: (uid: string | null, gameId: string, board: string, scope: Scope) =>
    ['progress', uid, gameId, 'top', board, scope] as const,
  myRank: (uid: string | null, gameId: string, board: string) => ['progress', uid, gameId, 'rank', board] as const,
  achievements: (uid: string | null, gameId: string) => ['progress', uid, gameId, 'achievements'] as const,
  user: (username: string) => ['user', username.toLowerCase()] as const,
  userStats: (userId: string) => ['user-stats', userId] as const,
  userAchievements: (userId: string) => ['user-achievements', userId] as const,
};

/** The game's leaderboards (readable for published games). Ordered by the caller (`orderBoards`). */
export function useGameBoards(gameId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: progressKeys.boards(userId, gameId ?? ''),
    enabled: !!gameId,
    queryFn: async (): Promise<Board[]> => {
      const { data, error } = await supabase
        .from('leaderboards')
        .select('id, key, sort, period')
        .eq('game_id', gameId!)
        .order('key');
      if (error) throw error;
      return data;
    },
  });
}

/** Top rows of a board (`leaderboard_top`, 'friends' returns only the caller's row until M4). */
export function useLeaderboardTop(gameId: string | undefined, board: string | undefined, scope: Scope) {
  const { userId } = useSession();
  return useQuery({
    queryKey: progressKeys.top(userId, gameId ?? '', board ?? '', scope),
    enabled: !!gameId && !!board,
    queryFn: async (): Promise<LeaderboardRow[]> => {
      const { data, error } = await supabase.rpc('leaderboard_top', {
        p_game_id: gameId!,
        p_board_key: board!,
        p_scope: scope,
        p_limit: LEADERBOARD_ROWS,
      });
      if (error) throw error;
      return toLeaderboardRows(data, resolveAvatarUrl);
    },
  });
}

/** The caller's best and rank on a board (`my_leaderboard_rank`); null without a score. */
export function useMyRank(gameId: string | undefined, board: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: progressKeys.myRank(userId, gameId ?? '', board ?? ''),
    enabled: !!userId && !!gameId && !!board,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('my_leaderboard_rank', { p_game_id: gameId!, p_board_key: board! });
      if (error) throw error;
      return parseMyRank(data);
    },
  });
}

/** The game's achievements with the caller's unlocks (`achievements` + own `user_achievements` rows). */
export function useGameAchievements(gameId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: progressKeys.achievements(userId, gameId ?? ''),
    enabled: !!userId && !!gameId,
    queryFn: async (): Promise<AchievementTile[]> => {
      const { data: defs, error } = await supabase
        .from('achievements')
        .select('id, key, title, description, icon, hidden')
        .eq('game_id', gameId!)
        .order('key');
      if (error) throw error;
      if (defs.length === 0) return [];
      const { data: mine, error: uErr } = await supabase
        .from('user_achievements')
        .select('achievement_id')
        .eq('user_id', userId!)
        .in(
          'achievement_id',
          defs.map((d) => d.id),
        );
      if (uErr) throw uErr;
      const unlocked = new Set(mine.map((u) => u.achievement_id));
      return defs.map((d) => toAchievementTile(d, unlocked.has(d.id)));
    },
  });
}

// --- public profiles --------------------------------------------------------------------------------------------

/** Another player's profile by username (citext: case-insensitive). Null when there is no such user. */
export function usePublicProfile(username: string | undefined) {
  return useQuery({
    queryKey: progressKeys.user(username ?? ''),
    enabled: !!username,
    queryFn: async (): Promise<Profile | null> => {
      const { data, error } = await supabase
        .from('profiles')
        .select(PROFILE_COLUMNS)
        .eq('username', username!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/** `public_profile_stats`: unlocked achievements and games played. */
export function usePublicStats(userId: string | undefined) {
  return useQuery({
    queryKey: progressKeys.userStats(userId ?? ''),
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('public_profile_stats', { p_user_id: userId! });
      if (error) throw error;
      return parsePublicStats(data);
    },
  });
}

export interface UnlockedAchievement {
  id: string;
  title: string;
  description: string | null;
  icon: AchievementTile['icon'];
  unlockedAt: string;
  game: { id: string; title: string } | null;
}

/** What a player has unlocked across games, newest first. */
export function useUserAchievements(userId: string | undefined) {
  return useQuery({
    queryKey: progressKeys.userAchievements(userId ?? ''),
    enabled: !!userId,
    queryFn: async (): Promise<UnlockedAchievement[]> => {
      const { data, error } = await supabase
        .from('user_achievements')
        .select(
          'unlocked_at, achievement:achievements(id, key, title, description, icon, hidden, game:games(id, title))',
        )
        .eq('user_id', userId!)
        .order('unlocked_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data.flatMap((row) => {
        const a = row.achievement;
        if (!a) return [];
        const tile = toAchievementTile(a, true);
        return [
          {
            id: a.id,
            title: tile.title,
            description: tile.description,
            icon: tile.icon,
            unlockedAt: row.unlocked_at,
            game: a.game ?? null,
          },
        ];
      });
    },
  });
}
