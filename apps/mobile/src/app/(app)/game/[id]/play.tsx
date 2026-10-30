import { useQueryClient } from '@tanstack/react-query';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { config, toWsUrl } from '@/config';
import { GameHost, type GameHostResult } from '@/game-host/GameHost';
import type { MatchmakingTarget } from '@/game-host/handlers';
import { createSupabaseSaveStore } from '@/game-host/supabase-saves';
import { useSession } from '@/lib/auth/session';
import { catalogKeys } from '@/lib/catalog';
import { recordPlay, useGameConsent, usePlaySessionPlan } from '@/lib/launch';
import { useProfile } from '@/lib/profile';
import { supabase } from '@/lib/supabase';

/**
 * Full-screen play route. Only renders the host once the version is resolved, the app version is new enough and
 * the 4.7.3 consent exists; anything else (including a deep link straight here) goes back to the game page.
 *
 * The plan is snapshotted for the life of this screen (`usePlaySessionPlan`): a new version or a hidden game
 * takes effect on the next launch, never by remounting or redirecting a running game. Leaving any other way
 * (sign-out, a navigation from outside) unmounts GameHost, which still reports `finish('unmount')`, so
 * `record_play` runs exactly once per session.
 */
export default function PlayScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const { userId } = useSession();
  const plan = usePlaySessionPlan(id);
  const consent = useGameConsent(id);
  const profile = useProfile();

  const saves = useMemo(() => (userId && id ? createSupabaseSaveStore(userId, id) : null), [userId, id]);
  const room = plan.data?.status === 'ready' ? plan.data.room : null;
  const matchmaking = useMemo<MatchmakingTarget | null>(
    () =>
      room
        ? {
            httpUrl: config.colyseusUrl,
            wsUrl: toWsUrl(config.colyseusUrl),
            roomName: room,
            getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token,
          }
        : null,
    [room],
  );

  const onExit = useCallback(
    (result: GameHostResult) => {
      if (result.readyMs !== null && id) {
        void recordPlay(id, result.playtimeS).then(() => qc.invalidateQueries({ queryKey: catalogKeys.recent(userId) }));
      }
      // Already leaving: the screen is unmounting (navigation away, sign-out).
      if (result.reason === 'unmount') return;
      if (router.canGoBack()) router.back();
      else router.replace({ pathname: '/game/[id]', params: { id } });
    },
    [id, qc, userId],
  );

  if (plan.isLoading || consent.isLoading || profile.isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-[#0A0A0A]">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  const p = plan.data;
  const me = profile.data;
  if (!id || p?.status !== 'ready' || consent.data !== true || !me || !saves) {
    return <Redirect href={{ pathname: '/game/[id]', params: { id: id ?? '' } }} />;
  }

  return (
    <GameHost
      key={p.game.id}
      bundleUrl={p.entryUrl}
      game={{ id: p.game.id, version: p.version }}
      user={{ id: me.id, username: me.username, avatarUrl: me.avatar_url }}
      intent={p.room ? 'quick' : 'solo'}
      orientation={p.orientation}
      saves={saves}
      matchmaking={matchmaking}
      onExit={onExit}
    />
  );
}
