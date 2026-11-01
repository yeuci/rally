import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { BugReportHost } from '@/components/rally/bug-report-sheet';
import { CoinToastHost } from '@/components/rally/coins';
import { FriendRequestPrompt } from '@/components/rally/friend-request-sheet';
import { RoomCodePill } from '@/components/rally/room-code-pill';
import { ToastHost } from '@/components/rally/toast';
import { config, toWsUrl } from '@/config';
import { HostError } from '@/game-host/bridge';
import { GameHost, type GameHostResult } from '@/game-host/GameHost';
import { MATCH_ENDED_EXIT, type MatchmakingTarget } from '@/game-host/handlers';
import { pageBytesOf } from '@/game-host/loading-copy';
import { createRejoinJournal } from '@/game-host/rejoin-journal';
import { createSupabaseProgressStore } from '@/game-host/supabase-progress';
import { createSupabaseSaveStore } from '@/game-host/supabase-saves';
import { useSession } from '@/lib/auth/session';
import { coverUriFor } from '@/lib/game-art';
import { progressKeys } from '@/lib/game-progress';
import { intentFor, parseFriendJoinTarget, parseJoinTarget, type FriendJoinTarget } from '@/lib/join-target';
import {
  createPlaySessionService,
  invalidateAfterPlay,
  useGameConsent,
  usePlaySessionPlan,
  withAnonymousRetry,
} from '@/lib/launch';
import { setInGame, setOnline } from '@/lib/presence';
import { useProfile, resolveAvatarUrl } from '@/lib/profile';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';
import { notePlayed } from '@/lib/votes';

/**
 * Full-screen play route. Only renders the host once the version is resolved, the app version is new enough and
 * the 4.7.3 consent exists; anything else (including a deep link straight here) goes back to the game page.
 *
 * The plan is snapshotted for the life of this screen (`usePlaySessionPlan`): a new version or a hidden game
 * takes effect on the next launch, never by remounting or redirecting a running game. Leaving any other way
 * (sign-out, a navigation from outside) unmounts GameHost, which still reports `finish('unmount')`.
 *
 * **Solo games** open a server play session (`start_play_session` at mount → `end_play_session`, or `record_play`
 * if it never started), closed exactly once (a play is recorded only if the game became ready) and journaled on
 * the device so a kill in the background is closed on the next launch. Afterwards the game page's leaderboards,
 * achievements, "Continue playing" and the player's own profile refresh.
 *
 * **Multiplayer games** (`manifest.server`) open no play session: the game server writes their stats, boards and
 * achievements (m3-phase2 §3). `session.join` follows the join target in the search params (`?join=quick|create|
 * room|friend|resume`, see lib/join-target.ts; malformed → back to the game page), and the game's reconnection
 * reports go to the rejoin journal (§4). On exit the same queries refresh. `join=resume` without a live record for
 * this game says "That match has ended" and goes back without loading the game. When a join knows the private
 * room's code (`onJoined` → `code`: the reservation's, or the code joined with), a "Room code · Share" pill shows over
 * the game for 8 s (components/rally/room-code-pill.tsx); the bridge and the game are not involved. Every join also
 * sets the presence heartbeat to `in_game` with the game and room ids (lib/presence.ts); leaving sets `online`.
 */

type PlayParams = { id: string; join?: string; name?: string; room?: string; code?: string; friend?: string };

/** `friend_join_target(friend)` → where to join them; NOT_FOUND (not friends, not joinable) → MATCHMAKE_FAILED. */
async function resolveFriend(friendId: string): Promise<FriendJoinTarget> {
  const { data, error } = await withAnonymousRetry(() => supabase.rpc('friend_join_target', { p_friend_id: friendId }));
  if (error) {
    throw new HostError(
      'MATCHMAKE_FAILED',
      /^NOT_FOUND\b/.test(error.message) ? "your friend's match cannot be joined" : error.message,
    );
  }
  const target = parseFriendJoinTarget(data);
  if (!target) throw new HostError('MATCHMAKE_FAILED', 'unexpected friend_join_target answer');
  return target;
}

function leave(id: string) {
  if (router.canGoBack()) router.back();
  else router.replace({ pathname: '/game/[id]', params: { id } });
}

export default function PlayScreen() {
  const { id, join, name, room: roomParam, code, friend } = useLocalSearchParams<PlayParams>();
  const qc = useQueryClient();
  const { userId } = useSession();
  const plan = usePlaySessionPlan(id);
  const consent = useGameConsent(id);
  const profile = useProfile();
  // The private room's join code, once a join learns it (shown with Share over the game).
  const [roomCode, setRoomCode] = useState<string | null>(null);

  const target = useMemo(
    () => parseJoinTarget({ join, name, room: roomParam, code, friend }),
    [join, name, roomParam, code, friend],
  );
  const rejoin = useMemo(() => (userId ? createRejoinJournal(AsyncStorage, userId) : null), [userId]);
  // `resume`: the record is read once, before the game loads (nothing to resume → no launch at all).
  const resumeRecord = useQuery({
    queryKey: ['rejoin', userId, id ?? ''],
    enabled: target?.join === 'resume' && !!rejoin,
    queryFn: async () => (await rejoin!.get()) ?? null,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const saves = useMemo(() => (userId && id ? createSupabaseSaveStore(userId, id) : null), [userId, id]);
  const progress = useMemo(() => (id ? createSupabaseProgressStore(id) : null), [id]);
  const playSessions = useMemo(() => (userId ? createPlaySessionService(userId) : null), [userId]);
  const ready = plan.data?.status === 'ready' ? plan.data : null;
  const room = ready?.room ?? null;
  const minServerVersion = ready?.manifest.server?.minVersion ?? 0;
  const matchmaking = useMemo<MatchmakingTarget | null>(
    () =>
      room && target
        ? {
            httpUrl: config.colyseusUrl,
            wsUrl: toWsUrl(config.colyseusUrl),
            roomName: room,
            join: target,
            minServerVersion,
            resolveFriend,
            rejoin,
            getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token,
            // The JWT only goes over https/wss; dev builds may also use a LAN game server over http.
            allowPrivateHttp: __DEV__,
            onJoined: ({ roomId, gameId, code: joinedCode }) => {
              setRoomCode(joinedCode ?? null);
              // Presence: friends see "In <game>" (and can join) once the server's mirror confirms the seat.
              setInGame(gameId, roomId);
            },
          }
        : null,
    [room, target, minServerVersion, rejoin],
  );
  const multiplayer = !!ready?.manifest.server;

  // The session is closed (or recorded) after onExit: then scores, unlocks and "Continue playing" are current.
  const onPlayRecorded = useCallback(() => {
    if (id) invalidateAfterPlay(qc, userId, id);
  }, [id, qc, userId]);

  // Presence: back to 'online' when this screen closes, however it closes (in_game is set by onJoined above).
  useEffect(() => setOnline, []);

  const onExit = useCallback(
    (result: GameHostResult) => {
      setOnline();
      // "Did you enjoy <Game>?" once the game screen has closed, if a match happened (components/rally/vote-prompt.tsx).
      notePlayed(id, result);
      if (id) {
        // Multiplayer: the room wrote stats, boards and unlocks (no play session to wait for).
        if (multiplayer) invalidateAfterPlay(qc, userId, id);
        // Scores and unlocks submitted during the game are already stored: refresh the game page underneath now.
        else if (result.played) void qc.invalidateQueries({ queryKey: progressKeys.game(userId, id) });
      }
      // Already leaving: the screen is unmounting (navigation away, sign-out).
      if (result.reason === 'unmount') return;
      if (result.reason === MATCH_ENDED_EXIT) showToast('That match has ended');
      leave(id ?? '');
    },
    [id, qc, userId, multiplayer],
  );

  const resumeEnded =
    target?.join === 'resume' && resumeRecord.isSuccess && (!resumeRecord.data || resumeRecord.data.gameId !== id);
  useEffect(() => {
    if (!resumeEnded) return;
    showToast('That match has ended');
    leave(id ?? '');
  }, [resumeEnded, id]);

  if (plan.isLoading || consent.isLoading || profile.isLoading || resumeRecord.isLoading || resumeEnded) {
    return (
      <View className="flex-1 items-center justify-center bg-[#0A0A0A]">
        {/* The host's chrome is always dark (games draw on it): light status-bar text in both themes. */}
        <StatusBar style="light" />
        <ActivityIndicator size="large" color="#A1A1A1" />
      </View>
    );
  }

  const p = plan.data;
  const me = profile.data;
  if (!id || p?.status !== 'ready' || consent.data !== true || !me || !saves || !progress || !playSessions || !target) {
    return <Redirect href={{ pathname: '/game/[id]', params: { id: id ?? '' } }} />;
  }
  // A resume needs its record (read above); a failed read is treated like a missing one by session.join.
  const record = target.join === 'resume' ? resumeRecord.data : null;

  return (
    <View className="flex-1 bg-[#0A0A0A]">
      <StatusBar style="light" />
      <GameHost
        key={p.game.id}
        bundleUrl={p.entryUrl}
        entrySha256={p.entrySha256}
        game={{ id: p.game.id, version: p.version }}
        // The loading screen: the game's name, its art blurred behind the bar, and the page's download size.
        title={p.game.title}
        artUri={coverUriFor(p.game, 'feature')}
        iconUri={p.game.icon_url}
        pageBytes={pageBytesOf(p.manifest)}
        // The game menu: the private room's code (People → Copy / Share) and what the game may use (haptics).
        roomCode={roomCode}
        capabilities={p.manifest.capabilities}
        user={{ id: me.id, username: me.username, avatarUrl: resolveAvatarUrl(me.avatar_url) }}
        intent={
          !p.room
            ? 'solo'
            : record
              ? intentFor(record.join)
              : target.join === 'resume'
                ? 'quick'
                : intentFor(target.join)
        }
        resume={record ? { reconnectionToken: record.token } : undefined}
        orientation={p.orientation}
        saves={saves}
        progress={progress}
        // Multiplayer results are written by the room (architecture §8), never client-reported.
        soloScores={!p.manifest.server}
        playSessions={p.manifest.server ? null : playSessions}
        matchmaking={matchmaking}
        onExit={onExit}
        onPlayRecorded={onPlayRecorded}
      />
      {roomCode ? <RoomCodePill key={roomCode} code={roomCode} gameTitle={p.game.title} /> : null}
      {/* This screen is a native full-screen modal: the shell's toast and sheets sit underneath it. On iOS a Modal
          presents from the nearest view controller, so the friend-request host must be mounted here to rise over
          the game (components/rally/friend-request-sheet.tsx). It follows Settings → Notifications → While playing:
          a banner overlaid at the top of the game by default (a plain view, no Modal), the sheet, or nothing. */}
      <ToastHost />
      {/* Coins awarded by the match (or a solo run) show over the game too, like the friend-request banner. */}
      <CoinToastHost />
      <FriendRequestPrompt placement="game" />
      {/* Shake to report a bug over the game (playtest builds); the shell's host is under this modal on iOS. */}
      <BugReportHost placement="game" />
    </View>
  );
}
