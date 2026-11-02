import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { toWsUrl } from '@/config';
import { GameFrame } from '@/game-host/game-frame';
import { GameHost, type GameHostResult } from '@/game-host/GameHost';
import type { MatchmakingTarget } from '@/game-host/handlers';
import { createMemoryProgressStore } from '@/game-host/progress';
import { createMemoryStorage, createRejoinJournal } from '@/game-host/rejoin-journal';
import { createMemorySaveStore } from '@/game-host/saves';
import { launchStore, useLaunchStore } from '@/launch-store';
import { effectiveGameId, isSoloLaunch } from '@/lib/dev-launch-model';
import { intentFor, parseJoinTarget } from '@/lib/join-target';

/**
 * The launcher loads an arbitrary bundle URL, so the game never gets the real account: a fixed dev identity,
 * in-memory saves, leaderboards and achievements, no play session, and matchmaking without a Supabase token (a
 * guest; the `profile` room message names it).
 */
const DEV_USER = { id: 'dev-user', username: 'dev-user', avatarUrl: null };
const createDevProgress = () => createMemoryProgressStore(DEV_USER);
/** Rejoin records live as long as the JS context (an in-session reload or crash reconnects through them). */
const DEV_REJOIN = createRejoinJournal(createMemoryStorage(), DEV_USER.id);

type DevPlayParams = { join?: string; name?: string; room?: string; code?: string; friend?: string };

/**
 * Full-screen host for the Developer launcher: bundle and Colyseus URLs, room type, game id, orientation and join
 * target (search params built by the launcher with `joinTargetParams`) from the launcher; in-memory saves. A launch
 * without a room is a solo game: no game server, the `solo` intent.
 */
export default function DevPlayScreen() {
  const { settings } = useLaunchStore();
  const { join, name, room, code, friend } = useLocalSearchParams<DevPlayParams>();
  const [saves] = useState(createMemorySaveStore);
  const [progress] = useState(createDevProgress);

  // Malformed params (only a hand-typed URL) fall back to quick play.
  const target = useMemo(() => parseJoinTarget({ join, name, room, code, friend }) ?? { join: 'quick' as const }, [join, name, room, code, friend]);
  const solo = isSoloLaunch(settings);
  const roomName = settings.roomName.trim() || 'hello';
  const matchmaking = useMemo<MatchmakingTarget>(
    () => ({
      httpUrl: settings.colyseusUrl,
      wsUrl: toWsUrl(settings.colyseusUrl),
      roomName,
      join: target,
      rejoin: DEV_REJOIN,
    }),
    [settings.colyseusUrl, roomName, target],
  );

  const onExit = useCallback((result: GameHostResult) => {
    launchStore.setLastRun({ endedAt: Date.now(), ...result });
    if (result.reason === 'unmount') return;
    if (router.canGoBack()) router.back();
    else router.replace('/dev');
  }, []);

  return (
    // Like the play route: its own safe-area provider (a full-screen modal), and the game's frame, which turns a
    // landscape game inside the app on an iPhone and draws the light status bar (game-host/game-frame.tsx).
    <SafeAreaProvider style={styles.screen}>
      <GameFrame orientation={settings.orientation}>
        <GameHost
          bundleUrl={settings.bundleUrl}
          game={{ id: effectiveGameId(settings), version: '0.1.0' }}
          user={DEV_USER}
          intent={solo ? 'solo' : target.join === 'resume' ? 'quick' : intentFor(target.join)}
          orientation={settings.orientation}
          saves={saves}
          progress={progress}
          soloScores
          playSessions={null}
          matchmaking={solo ? null : matchmaking}
          onExit={onExit}
        />
      </GameFrame>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: '#0A0A0A' } });
