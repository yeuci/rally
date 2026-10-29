import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { toWsUrl } from '@/config';
import { GameHost, type GameHostResult } from '@/game-host/GameHost';
import type { MatchmakingTarget } from '@/game-host/handlers';
import { createMemorySaveStore } from '@/game-host/saves';
import { launchStore, useLaunchStore } from '@/launch-store';
import { useProfile } from '@/lib/profile';

/** Full-screen host for the Developer launcher: bundle and Colyseus URLs from the launcher, in-memory saves. */
export default function DevPlayScreen() {
  const { settings } = useLaunchStore();
  const profile = useProfile();
  const [saves] = useState(createMemorySaveStore);

  const matchmaking = useMemo<MatchmakingTarget>(
    () => ({ httpUrl: settings.colyseusUrl, wsUrl: toWsUrl(settings.colyseusUrl), roomName: 'hello' }),
    [settings.colyseusUrl],
  );

  const onExit = useCallback((result: GameHostResult) => {
    launchStore.setLastRun({ endedAt: Date.now(), ...result });
    if (router.canGoBack()) router.back();
    else router.replace('/dev');
  }, []);

  const me = profile.data;
  return (
    <GameHost
      bundleUrl={settings.bundleUrl}
      game={{ id: 'spike', version: '0.1.0' }}
      user={me ? { id: me.id, username: me.username, avatarUrl: me.avatar_url } : { id: 'spike-tester', username: 'spike-tester', avatarUrl: null }}
      intent="quick"
      orientation="landscape"
      saves={saves}
      matchmaking={matchmaking}
      onExit={onExit}
    />
  );
}
