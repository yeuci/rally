import { router } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { FriendRequestBanner } from '@/components/rally/friend-request-banner';
import { OfflinePill } from '@/components/rally/offline-banner';
import { WelcomeTour } from '@/components/rally/welcome-tour';
import type { GameCard } from '@/lib/catalog';
import { devPreviews, useDevPreviews } from '@/lib/dev-previews';
import { bannerCountdown } from '@/lib/social-realtime';
import type { RequestProfile } from '@/lib/social-realtime-model';
import { showToast } from '@/lib/toast';
import type { WelcomeEnd } from '@/lib/welcome-model';

/** How long the offline pill preview stays up. */
const OFFLINE_PREVIEW_MS = 4000;
/** However the banner preview goes, it is gone by then. */
const BANNER_PREVIEW_MAX_MS = 30_000;

/**
 * The previewed requester. The empty user id keeps ProfileAvatar from looking up cosmetics for a player who does not
 * exist.
 */
const PREVIEW_PROFILE: RequestProfile = { userId: '', username: 'preview', displayName: 'Preview', avatarUrl: null };

/**
 * Draws the Developer page's previews (lib/dev-previews.ts) where the real ones sit: the friend-request banner (the
 * real FriendRequestBanner; Accept and a tap only close it) and the offline pill at the top of the screen, and the
 * first-run welcome over the whole window. Mounted by the dev layout, over the page and its header.
 */
export function DevPreviewHost() {
  const { banner, offlineSince, welcome } = useDevPreviews();

  // The banner leaves by itself (5 s, held while touched) or with a swipe up, and both stop the shared countdown
  // (lib/social-realtime.ts `bannerCountdown`): the preview ends once its countdown has started and stopped again.
  // The countdown is shared with the shell's banner; a real one counting under this page restarts when it next shows.
  const bannerKey = banner?.key ?? null;
  useEffect(() => {
    if (!bannerKey) return;
    let started = false;
    const poll = setInterval(() => {
      const { key } = bannerCountdown.state();
      if (key === bannerKey) started = true;
      else if (started) devPreviews.endBanner(bannerKey);
    }, 250);
    const cap = setTimeout(() => devPreviews.endBanner(bannerKey), BANNER_PREVIEW_MAX_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(cap);
    };
  }, [bannerKey]);

  useEffect(() => {
    if (offlineSince === null) return;
    const timer = setTimeout(() => devPreviews.hideOffline(offlineSince), OFFLINE_PREVIEW_MS);
    return () => clearTimeout(timer);
  }, [offlineSince]);

  const answer = () => {
    if (bannerKey) devPreviews.endBanner(bannerKey);
    showToast('Preview only: nothing was sent.');
  };

  // The real welcome, minus the flag: it comes back on the next tap. "Play something" opens the game page, as it does
  // for a new player.
  const endWelcome = (how: WelcomeEnd, game?: GameCard) => {
    devPreviews.hideWelcome();
    if (how === 'play' && game) router.push({ pathname: '/game/[id]', params: { id: game.id } });
    else showToast('Preview only: the welcome was not marked as seen.');
  };

  return (
    <>
      <FriendRequestBanner request={banner} profile={PREVIEW_PROFILE} onAccept={answer} onOpen={answer} />
      {offlineSince !== null ? <OfflinePill /> : null}
      {/* A plain view over the page, not a Modal, so the dialogs the avatar picker may open (the root PortalHost)
          still rise above it. It covers the whole window, so the top inset applies (`sheet={false}`). */}
      {welcome ? (
        <View style={StyleSheet.absoluteFill} className="bg-background">
          <WelcomeTour sheet={false} onEnd={endWelcome} />
        </View>
      ) : null}
    </>
  );
}
