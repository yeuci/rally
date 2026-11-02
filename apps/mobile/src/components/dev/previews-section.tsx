import {
  CircleCheckIcon,
  CoinsIcon,
  HandIcon,
  MessageSquareIcon,
  SparklesIcon,
  ThumbsUpIcon,
  TrophyIcon,
  UserPlusIcon,
  WifiOffIcon,
} from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Modal } from 'react-native';
import { IntroOverlay } from '@/components/rally/intro-overlay';
import { SettingsGroup, SettingsRow } from '@/components/rally/settings-rows';
import { VotePromptSheet } from '@/components/rally/vote-prompt';
import { Separator } from '@/components/ui/separator';
import { SHEET_ORIENTATIONS } from '@/game-host/orientation';
import { useLaunchStore } from '@/launch-store';
import { useSession } from '@/lib/auth/session';
import { pushCoinAward } from '@/lib/coin-toast';
import { effectiveGameId, presetById } from '@/lib/dev-launch-model';
import { devPreviews } from '@/lib/dev-previews';
import { nextCelebrationKey, pushCelebration } from '@/lib/level-toast';
import { showToast } from '@/lib/toast';
import { DevSection } from './dev-section';

/** Coin awards from previews count down from -1: real ledger ids are positive, so the toast never merges them away. */
let previewCoinId = 0;

function previewCoins() {
  previewCoinId -= 1;
  pushCoinAward({
    id: previewCoinId,
    amount: 250,
    reason: 'adjustment',
    balance: 0,
    note: null,
    at: new Date().toISOString(),
  });
}

function previewChallenge() {
  const key = nextCelebrationKey();
  pushCelebration({ key, kind: 'challenge', id: `preview-${key}`, title: 'Play 3 matches', coins: 35, xp: 50 });
}

/**
 * UI previews: the app's real UI with made-up data, without playing. The toast, the "+250 coins" pill and the
 * level-up and challenge celebrations go through their own stores (lib/toast.ts, lib/coin-toast.ts,
 * lib/level-toast.ts) into the hosts the dev layout mounts; the friend-request banner and the offline pill go through
 * lib/dev-previews.ts (never the real request queue); the vote prompt (the presentational VotePromptSheet) and the
 * intro play in their own modals. Nothing here calls the server, except the first-run welcome: that is the real
 * screen with the signed-in account (its avatar picker and Add buttons work), shown without a new account and without
 * marking the account as welcomed.
 */
export function PreviewsSection() {
  const { settings } = useLaunchStore();
  const { signedIn } = useSession();
  const [voteGame, setVoteGame] = useState<{ id: string; title: string; art: null } | null>(null);
  const [intro, setIntro] = useState(false);
  const closeIntro = useCallback(() => setIntro(false), []);

  // The vote prompt asks about the launcher's game (Sumo when that is not one of the presets).
  const votePreset = presetById(effectiveGameId(settings)) ?? presetById('sumo')!;

  return (
    <DevSection id="previews" title="UI previews">
      <SettingsGroup title="Notices" footer="Coin and level previews show even with Settings → Coin popups off.">
        <SettingsRow
          icon={MessageSquareIcon}
          label="Toast"
          chevron={false}
          onPress={() => showToast('This is a toast. Tap it, or wait 3.5 seconds.')}
        />
        <Separator className="ml-16" />
        <SettingsRow icon={CoinsIcon} label="+250 coins" chevron={false} onPress={previewCoins} />
        <Separator className="ml-16" />
        <SettingsRow
          icon={TrophyIcon}
          label="Level up"
          chevron={false}
          onPress={() => pushCelebration({ key: nextCelebrationKey(), kind: 'level', level: 5, coins: 80 })}
        />
        <Separator className="ml-16" />
        <SettingsRow icon={CircleCheckIcon} label="Challenge complete" chevron={false} onPress={previewChallenge} />
        <Separator className="ml-16" />
        <SettingsRow icon={WifiOffIcon} label="Offline banner" chevron={false} onPress={devPreviews.showOffline} />
      </SettingsGroup>

      <SettingsGroup
        title="Prompts"
        footer={`The friend request comes from "preview" and the vote asks about ${votePreset.title}, the launcher's game. Their buttons only close them: nothing is sent.`}
      >
        <SettingsRow
          icon={UserPlusIcon}
          label="Friend request banner"
          chevron={false}
          onPress={devPreviews.showBanner}
        />
        <Separator className="ml-16" />
        <SettingsRow
          icon={ThumbsUpIcon}
          label="Vote prompt"
          value={votePreset.title}
          chevron={false}
          onPress={() => setVoteGame({ id: votePreset.id, title: votePreset.title, art: null })}
        />
        <Separator className="ml-16" />
        <SettingsRow icon={SparklesIcon} label="Intro animation" chevron={false} onPress={() => setIntro(true)} />
      </SettingsGroup>

      <SettingsGroup
        title="First run"
        footer={
          signedIn
            ? 'The welcome new players see after signup, with your account: avatar changes and friend requests are real. It does not mark you as welcomed (Reset and storage clears that flag).'
            : 'The welcome new players see after signup. It needs a signed-in account: it edits that account’s avatar and searches real players.'
        }
      >
        <SettingsRow
          icon={HandIcon}
          label="Show welcome"
          chevron={false}
          disabled={!signedIn}
          onPress={devPreviews.showWelcome}
        />
      </SettingsGroup>

      <VotePromptSheet
        game={voteGame}
        onVote={(liked) => {
          setVoteGame(null);
          showToast(`${liked ? 'Liked it' : 'Not for me'}. Preview only: nothing was sent.`);
        }}
        onNotNow={() => setVoteGame(null)}
      />

      {/* The cold-start intro, full screen in a modal; it says when it has finished. */}
      <Modal
        visible={intro}
        transparent
        animationType="none"
        statusBarTranslucent
        navigationBarTranslucent
        supportedOrientations={SHEET_ORIENTATIONS}
        onRequestClose={closeIntro}
      >
        {intro ? <IntroOverlay onDone={closeIntro} /> : null}
      </Modal>
    </DevSection>
  );
}
