import { useEffect } from 'react';
import { FriendRequestBanner } from '@/components/rally/friend-request-banner';
import { OfflinePill } from '@/components/rally/offline-banner';
import { devPreviews, useDevPreviews } from '@/lib/dev-previews';
import { bannerCountdown } from '@/lib/social-realtime';
import type { RequestProfile } from '@/lib/social-realtime-model';
import { showToast } from '@/lib/toast';

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
 * Draws the Developer page's top-of-screen previews (lib/dev-previews.ts) where the real ones sit: the friend-request
 * banner (the real FriendRequestBanner; Accept and a tap only close it) and the offline pill. Mounted by the dev
 * layout, over the page and its header.
 */
export function DevPreviewHost() {
  const { banner, offlineSince } = useDevPreviews();

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

  return (
    <>
      <FriendRequestBanner request={banner} profile={PREVIEW_PROFILE} onAccept={answer} onOpen={answer} />
      {offlineSince !== null ? <OfflinePill /> : null}
    </>
  );
}
