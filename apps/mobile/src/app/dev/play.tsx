import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { toWsUrl } from '@/config';
import { GameHost, type GameHostResult } from '@/game-host/GameHost';
import type { MatchmakingTarget } from '@/game-host/handlers';
import { createMemorySaveStore } from '@/game-host/saves';
import { launchStore, useLaunchStore } from '@/launch-store';

/**
 * The launcher loads an arbitrary bundle URL, so the game never gets the real account: a fixed dev identity,
 * in-memory saves, and the M0 hello room without a Supabase token.
 */
const DEV_USER = { id: 'dev-user', username: 'dev-user', avatarUrl: null };

/** Full-screen host for the Developer launcher: bundle and Colyseus URLs from the launcher, in-memory saves. */
export default function DevPlayScreen() {
  const { settings } = useLaunchStore();
  const [saves] = useState(createMemorySaveStore);

  const matchmaking = useMemo<MatchmakingTarget>(
    () => ({ httpUrl: settings.colyseusUrl, wsUrl: toWsUrl(settings.colyseusUrl), roomName: 'hello' }),
    [settings.colyseusUrl],
  );

  const onExit = useCallback((result: GameHostResult) => {
    launchStore.setLastRun({ endedAt: Date.now(), ...result });
    if (result.reason === 'unmount') return;
    if (router.canGoBack()) router.back();
    else router.replace('/dev');
  }, []);

  return (
    <GameHost
      bundleUrl={settings.bundleUrl}
      game={{ id: 'spike', version: '0.1.0' }}
      user={DEV_USER}
      intent="quick"
      orientation="landscape"
      saves={saves}
      matchmaking={matchmaking}
      onExit={onExit}
    />
  );
}
