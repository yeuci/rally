import { GameManifestSchema, type GameManifest } from '@rally/protocol';
import type { Tables } from '@rally/db';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { config } from '@/config';
import { isAnonymousForbidden } from '@/lib/auth/errors';
import { useSession } from '@/lib/auth/session';
import { supabase } from '@/lib/supabase';
import { satisfiesMinVersion } from '@/lib/semver';

/**
 * Play flow (architecture §2–§3): resolve `current_version_id` → `game_versions.entry_url` + manifest, gate on
 * `min_app_version`, and check the per-game consent (App Store 4.7.3) stored in `game_consents`.
 */
export type LaunchPlan =
  | {
      status: 'ready';
      game: Tables<'games'>;
      version: string;
      entryUrl: string;
      manifest: GameManifest;
      orientation: 'portrait' | 'landscape' | 'any';
      /** Colyseus room from `manifest.server.room`; null for solo-only games. */
      room: string | null;
    }
  | { status: 'unavailable'; message: string }
  | { status: 'update-required'; minAppVersion: string };

export const launchKeys = {
  plan: (gameId: string) => ['launch', gameId] as const,
  /** The play screen's own copy, never refetched while it is mounted (see usePlaySessionPlan). */
  session: (gameId: string) => ['launch-session', gameId] as const,
  consent: (uid: string | null, gameId: string) => ['me', uid, 'consent', gameId] as const,
};

export async function fetchLaunchPlan(gameId: string): Promise<LaunchPlan> {
  const { data: game, error } = await supabase.from('games').select('*').eq('id', gameId).maybeSingle();
  if (error) throw error;
  if (!game) return { status: 'unavailable', message: 'This game is not available.' };
  if (!game.current_version_id) return { status: 'unavailable', message: 'This game has not been published yet.' };

  const { data: version, error: vErr } = await supabase
    .from('game_versions')
    .select('version, entry_url, manifest')
    .eq('id', game.current_version_id)
    .maybeSingle();
  if (vErr) throw vErr;
  if (!version) return { status: 'unavailable', message: 'This game has not been published yet.' };

  const parsed = GameManifestSchema.safeParse(version.manifest);
  if (!parsed.success) return { status: 'unavailable', message: 'This version of the game cannot be loaded.' };
  const manifest = parsed.data;

  const required = [game.min_app_version, manifest.minAppVersion];
  if (!satisfiesMinVersion(config.appVersion, ...required)) {
    const minAppVersion = required.reduce((a, b) => (satisfiesMinVersion(a, b) ? a : b));
    return { status: 'update-required', minAppVersion };
  }
  if (!/^https?:\/\//.test(version.entry_url)) {
    return { status: 'unavailable', message: 'This version of the game cannot be loaded.' };
  }

  return {
    status: 'ready',
    game,
    version: version.version,
    entryUrl: version.entry_url,
    manifest,
    orientation: manifest.orientation,
    room: manifest.server?.room ?? null,
  };
}

export function useLaunchPlan(gameId: string | undefined) {
  return useQuery({
    queryKey: launchKeys.plan(gameId ?? ''),
    enabled: !!gameId,
    staleTime: 30_000,
    queryFn: () => fetchLaunchPlan(gameId!),
  });
}

/**
 * The plan a play session runs on, snapshotted when the play screen mounts. A separate cache entry from
 * `useLaunchPlan`, because the game page underneath keeps refetching that one (focus, staleness): a publish or a
 * hidden game mid-session must not remount or redirect a running game. Seeded from the game page's copy (which
 * the user just consented on), never refetched while mounted, and dropped on unmount so the next session reads
 * the current version.
 */
export function usePlaySessionPlan(gameId: string | undefined) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: launchKeys.session(gameId ?? ''),
    enabled: !!gameId,
    queryFn: () => fetchLaunchPlan(gameId!),
    initialData: () => (gameId ? qc.getQueryData<LaunchPlan>(launchKeys.plan(gameId)) : undefined),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });
}

export async function fetchConsent(userId: string, gameId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('game_consents')
    .select('granted_at')
    .eq('user_id', userId)
    .eq('game_id', gameId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export function useGameConsent(gameId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: launchKeys.consent(userId, gameId ?? ''),
    enabled: !!userId && !!gameId,
    queryFn: () => fetchConsent(userId!, gameId!),
  });
}

export function useGrantConsent() {
  const { userId } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (gameId: string) => {
      if (!userId) throw new Error('Not signed in');
      const { error } = await supabase
        .from('game_consents')
        .upsert({ user_id: userId, game_id: gameId }, { ignoreDuplicates: true });
      if (error) throw error;
      return gameId;
    },
    onSuccess: (gameId) => qc.setQueryData(launchKeys.consent(userId, gameId), true),
  });
}

/** Host-recorded play for "recently played" (solo path; multiplayer results come from the room in M3). */
export async function recordPlay(gameId: string, playtimeS: number): Promise<void> {
  const args = { p_game_id: gameId, p_playtime_s: Math.max(0, Math.round(playtimeS)) };
  let { error } = await supabase.rpc('record_play', args);
  // A token minted before linkIdentity still says is_anonymous (the session gate normally prevents this): refresh once.
  if (error && isAnonymousForbidden(error) && !(await supabase.auth.refreshSession()).error) {
    ({ error } = await supabase.rpc('record_play', args));
  }
  if (error) console.warn('[record_play]', error.message);
}
