import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { WelcomeTour } from '@/components/rally/welcome-tour';
import { useSession } from '@/lib/auth/session';
import type { GameCard } from '@/lib/catalog';
import { welcomedStore } from '@/lib/welcome';
import type { WelcomeEnd } from '@/lib/welcome-model';

/**
 * The first-run welcome (`/get-started`), pushed over the dashboard once by `WelcomePrompt`
 * (components/rally/welcome-tour.tsx) right after signup. Every way out marks the account as welcomed on this device
 * (lib/welcome.ts), so it never shows twice: Done and Skip close it, "Play something" closes it and opens the featured
 * game's page, and a close the welcome did not start (Android back, a sign-out while it was up) counts as well.
 * On iOS the route is a sheet (`presentation: 'modal'` in the (app) layout), so the window's top inset does not apply.
 */
export default function GetStartedScreen() {
  const { userId } = useSession();
  // Set by the welcome's own buttons, so the unmount below does not record a second, wrong ending.
  const ended = useRef(false);

  const end = (how: WelcomeEnd, game?: GameCard) => {
    ended.current = true;
    if (userId) void welcomedStore.set(userId, how);
    if (router.canGoBack()) router.back();
    else router.replace('/');
    if (how === 'play' && game) router.push({ pathname: '/game/[id]', params: { id: game.id } });
  };

  // Closed some other way: seen all the same. The account the screen opened for, even when it is signed out by then.
  useEffect(() => {
    if (!userId) return;
    return () => {
      if (!ended.current) void welcomedStore.set(userId, 'closed');
    };
  }, [userId]);

  return <WelcomeTour sheet={Platform.OS === 'ios'} onEnd={end} />;
}
