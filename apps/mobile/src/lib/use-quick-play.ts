import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { useSession } from '@/lib/auth/session';
import type { GameCard } from '@/lib/catalog';
import { fetchConsent, fetchLaunchPlan, launchKeys, useGrantConsent } from '@/lib/launch';

/**
 * "Play" from outside the game page (the dashboard hero): the same steps as the game page's Play button. Resolve the
 * launch plan (published version, app version gate), then the 4.7.3 consent: granted → the full-screen host,
 * otherwise the caller shows `ConsentDialog` for `consentGame`. A plan that cannot start leaves a `notice` for that
 * game. The play route re-checks everything itself.
 */
export function useQuickPlay() {
  const qc = useQueryClient();
  const { userId } = useSession();
  const grantConsent = useGrantConsent();
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ gameId: string; message: string } | null>(null);
  const [consentGame, setConsentGame] = useState<GameCard | null>(null);

  const openHost = (id: string) => router.push({ pathname: '/game/[id]/play', params: { id } });

  async function play(game: GameCard) {
    if (!userId || resolvingId) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setNotice(null);
    setResolvingId(game.id);
    try {
      const plan = await qc.fetchQuery({
        queryKey: launchKeys.plan(game.id),
        queryFn: () => fetchLaunchPlan(game.id),
        staleTime: 10_000,
      });
      if (plan.status === 'unavailable') return setNotice({ gameId: game.id, message: plan.message });
      if (plan.status === 'update-required') {
        return setNotice({
          gameId: game.id,
          message: `Update Rally to version ${plan.minAppVersion} or later to play this game.`,
        });
      }
      const consented = await qc.fetchQuery({
        queryKey: launchKeys.consent(userId, game.id),
        queryFn: () => fetchConsent(userId, game.id),
      });
      if (consented) openHost(game.id);
      else setConsentGame(game);
    } catch {
      setNotice({ gameId: game.id, message: "Couldn't start the game. Check your connection and try again." });
    } finally {
      setResolvingId(null);
    }
  }

  async function allow() {
    const game = consentGame;
    if (!game) return;
    try {
      await grantConsent.mutateAsync(game.id);
      setConsentGame(null);
      openHost(game.id);
    } catch {
      setConsentGame(null);
      setNotice({ gameId: game.id, message: "Couldn't save your choice. Try again." });
    }
  }

  return {
    play: (game: GameCard) => void play(game),
    allow: () => void allow(),
    decline: () => setConsentGame(null),
    /** Game whose plan is being resolved (its Play button shows a spinner). */
    resolvingId,
    notice,
    /** Game waiting for the consent answer. */
    consentGame,
    granting: grantConsent.isPending,
  };
}
