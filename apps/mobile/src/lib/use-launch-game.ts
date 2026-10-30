import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { useSession } from '@/lib/auth/session';
import { joinTargetParams, type JoinKind, type JoinTarget } from '@/lib/join-target';
import { fetchConsent, fetchLaunchPlan, launchKeys, useGrantConsent } from '@/lib/launch';

/** What a launch needs to know about the game (a `GameCard`, a `Game`, or an id and title). */
export interface LaunchableGame {
  id: string;
  title: string;
}

/**
 * Every "Play" in the shell (m3-phase2 §1 `useLaunchGame`): the dashboard hero, the game page (Play, or Quick play /
 * Create room for multiplayer games), the rooms screen, the join-code sheet and the rejoin sheet. Resolve the launch
 * plan (published version, app version gate), then the 4.7.3 consent: granted → the full-screen host with the join
 * target in its search params, otherwise the caller shows `LaunchConsentDialog` (or `ConsentDialog` for
 * `consentGame`). A plan that cannot start leaves a `notice` for that game. The play route re-checks everything
 * itself. Without a target the route matchmakes `quick` (solo games ignore it).
 */
export function useLaunchGame() {
  const qc = useQueryClient();
  const { userId } = useSession();
  const grantConsent = useGrantConsent();
  const [pending, setPending] = useState<{ gameId: string; join: JoinKind } | null>(null);
  const [notice, setNotice] = useState<{ gameId: string; message: string } | null>(null);
  const [consent, setConsent] = useState<{ game: LaunchableGame; target?: JoinTarget } | null>(null);

  const openHost = (id: string, target?: JoinTarget) =>
    router.push({ pathname: '/game/[id]/play', params: target ? { id, ...joinTargetParams(target) } : { id } });

  async function launch(game: LaunchableGame, target?: JoinTarget) {
    if (!userId || pending) return;
    // No haptic here: every Play is a Button, whose press already gives the shell's one light tap.
    setNotice(null);
    setPending({ gameId: game.id, join: target?.join ?? 'quick' });
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
      if (consented) openHost(game.id, target);
      else setConsent({ game, target });
    } catch {
      setNotice({ gameId: game.id, message: "Couldn't start the game. Check your connection and try again." });
    } finally {
      setPending(null);
    }
  }

  async function allow() {
    const c = consent;
    if (!c) return;
    try {
      await grantConsent.mutateAsync(c.game.id);
      setConsent(null);
      openHost(c.game.id, c.target);
    } catch {
      setConsent(null);
      setNotice({ gameId: c.game.id, message: "Couldn't save your choice. Try again." });
    }
  }

  return {
    launch: (game: LaunchableGame, target?: JoinTarget) => void launch(game, target),
    allow: () => void allow(),
    decline: () => setConsent(null),
    /** The launch being resolved (its button shows a spinner): the game and the join kind (`quick` without a target). */
    pending,
    /** Game whose plan is being resolved. */
    resolvingId: pending?.gameId ?? null,
    notice,
    clearNotice: () => setNotice(null),
    /** Game waiting for the consent answer. */
    consentGame: consent?.game ?? null,
    granting: grantConsent.isPending,
  };
}

export type GameLauncher = ReturnType<typeof useLaunchGame>;

/** The launcher's notice for one game (the game page, the rooms screen), else null. */
export const noticeFor = (launcher: GameLauncher, gameId: string | undefined) =>
  launcher.notice && launcher.notice.gameId === gameId ? launcher.notice.message : null;
