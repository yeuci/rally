import { useQueryClient } from '@tanstack/react-query';
import { Redirect, Stack } from 'expo-router';
import { useEffect } from 'react';
import { useUniwind } from 'uniwind';
import { AppDrawer } from '@/components/rally/app-drawer';
import { CoinToastHost } from '@/components/rally/coins';
import { FriendRequestPrompt } from '@/components/rally/friend-request-sheet';
import { RejoinPrompt } from '@/components/rally/rejoin-sheet';
import { ToastHost } from '@/components/rally/toast';
import { VotePrompt } from '@/components/rally/vote-prompt';
import { WelcomePrompt } from '@/components/rally/welcome-tour';
import { useSession } from '@/lib/auth/session';
import { recoverPlaySession } from '@/lib/launch';
import { usePresenceHeartbeat } from '@/lib/presence';
import { useSocialRealtime } from '@/lib/social-realtime';
import { NAV_THEME } from '@/lib/theme';
import { PLAY_SCREEN_ORIENTATION } from '@/game-host/orientation';

export const unstable_settings = { anchor: 'index' };

export default function AppLayout() {
  const { signedIn, userId } = useSession();
  const { theme } = useUniwind();
  const qc = useQueryClient();
  // A play session an earlier run left open (app killed while a game was in the background) is closed now.
  useEffect(() => {
    if (signedIn && userId) void recoverPlaySession(qc, userId);
  }, [signedIn, userId, qc]);
  // Presence (m3-phase2 §2): 'online' every 45 s while the app is active; never for anonymous sessions.
  usePresenceHeartbeat();
  // Friend requests in real time (lib/social-realtime.ts): one private `user:<uid>` channel per linked account.
  useSocialRealtime();
  const nav = NAV_THEME[theme ?? 'dark'];
  // Signed out (or an unlinked anonymous session) never sees the app: back to the welcome screen.
  if (!signedIn) return <Redirect href="/welcome" />;
  // The left drawer wraps the whole stack; it swipes open only on the dashboard (never over the game host).
  return (
    <AppDrawer>
      <Stack
        screenOptions={{
          // Opaque header: the native stack's default is translucent on recent iOS and content slides under it.
          headerStyle: { backgroundColor: nav.colors.background },
          headerTintColor: nav.colors.text,
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
          contentStyle: { backgroundColor: nav.colors.background },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="game/[id]/index" options={{ headerShown: false }} />
        {/* A full-screen modal. On an iPhone nothing ever rotates: the screen declares portrait (so iOS never turns
            it when the phone is held sideways) and a landscape game is turned inside it (game-host/game-frame.tsx).
            On tablets and Android the system turns only this modal to the game's orientation, and leaving turns the
            screen back before it closes (game-host/orientation.ts). The home indicator fades out during a game. */}
        <Stack.Screen
          name="game/[id]/play"
          options={{
            headerShown: false,
            presentation: 'fullScreenModal',
            animation: 'fade',
            gestureEnabled: false,
            autoHideHomeIndicator: true,
            orientation: PLAY_SCREEN_ORIENTATION,
            contentStyle: { backgroundColor: '#0A0A0A' },
          }}
        />
        <Stack.Screen name="profile/index" options={{ title: 'Profile' }} />
        <Stack.Screen name="profile/edit" options={{ title: 'Edit profile' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="u/[username]" options={{ title: 'Player' }} />
        {/* Pushed from the dashboard pill; draws its own bar (search field + Cancel). */}
        <Stack.Screen name="search" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="friends" options={{ title: 'Friends' }} />
        {/* The dashboard's "Friend activity" row's See all (docs/activity.md). */}
        <Stack.Screen name="activity" options={{ title: 'Friend activity' }} />
        {/* The screen sets the genre's name as its title; the drawer's edge swipe is off here (lib/drawer.ts). */}
        <Stack.Screen name="browse" options={{ title: 'Browse' }} />
        <Stack.Screen name="game/[id]/rooms" options={{ title: 'Rooms' }} />
        <Stack.Screen name="shop" options={{ title: 'Shop' }} />
        <Stack.Screen name="coins" options={{ title: 'Coin history' }} />
        <Stack.Screen name="bug-reports" options={{ title: 'Bug reports' }} />
        {/* The first-run welcome, pushed once over the dashboard by WelcomePrompt (below): a sheet on iOS, the whole
            window on Android. Its own Skip / Done close it, so no swipe-down; a flag write marks it seen either way. */}
        <Stack.Screen
          name="get-started"
          options={{ headerShown: false, presentation: 'modal', gestureEnabled: false }}
        />
      </Stack>
      {/* Over the stack: the toast ("That match has ended") and the rejoin sheet (a match left within its grace,
          m3-phase2 §4; a modal, so it also covers the drawer). Not over a running game: the play route is a native
          full-screen modal above all of this, so it mounts its own toast and friend-request hosts. */}
      <ToastHost />
      {/* "+25 coins · Win" when coins are awarded (Settings → Coin popups); the play route mounts its own. */}
      <CoinToastHost />
      <RejoinPrompt />
      {/* "sloth wants to be your friend" while no game is open (the play route's own host covers the game). */}
      <FriendRequestPrompt placement="shell" />
      {/* "Did you enjoy Sumo?" after a match, once the game screen has closed (lib/votes-model.ts has the rules). */}
      <VotePrompt />
      {/* Opens `/get-started` once for an account created in the last ten minutes (lib/welcome-model.ts). */}
      <WelcomePrompt />
    </AppDrawer>
  );
}
