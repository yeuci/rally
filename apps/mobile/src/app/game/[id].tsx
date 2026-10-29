import { router, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { GameHost, type GameHostResult } from '@/game-host/GameHost';
import { launchStore, useLaunchStore } from '@/launch-store';
import { toWsUrl } from '@/config';

/**
 * Full-screen game route. M0 knows one game (the spike) and takes its URLs from the launcher.
 * M1 resolves `id` against the `games` / `game_versions` catalog instead.
 */
export default function GameScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { settings } = useLaunchStore();

  const onExit = useCallback((result: GameHostResult) => {
    launchStore.setLastRun({ endedAt: Date.now(), ...result });
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, []);

  return (
    <GameHost
      gameId={id ?? 'spike'}
      gameVersion="0.1.0"
      bundleUrl={settings.bundleUrl}
      colyseusHttpUrl={settings.colyseusUrl}
      colyseusWsUrl={toWsUrl(settings.colyseusUrl)}
      roomName="hello"
      orientation="landscape"
      onExit={onExit}
    />
  );
}
