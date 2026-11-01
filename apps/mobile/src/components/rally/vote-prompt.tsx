import { useQueryClient } from '@tanstack/react-query';
import { usePathname } from 'expo-router';
import { ThumbsDownIcon, ThumbsUpIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { useGame } from '@/lib/catalog';
import { coverUriFor } from '@/lib/game-art';
import { isAnySheetOpen } from '@/lib/open-sheets';
import { isGameScreen } from '@/lib/rejoin';
import { showToast } from '@/lib/toast';
import {
  fetchVoteSummary,
  takePlayed,
  usePlayedSignal,
  useVoteGame,
  voteKeys,
  votePromptStore,
  type PlayedSignal,
} from '@/lib/votes';
import {
  VOTE_PROMPT_DELAY_MS,
  afterAsk,
  afterNotNow,
  afterVote,
  shouldOfferVotePrompt,
  voteQuestion,
} from '@/lib/votes-model';
import { BottomSheet } from './bottom-sheet';
import { GameCover } from './game-cover';

/**
 * "Did you enjoy Sumo?": the game's tile, thumbs up / thumbs down, and Not now. Presentational; `VotePrompt` decides
 * when it shows.
 */
export function VotePromptSheet({
  game,
  onVote,
  onNotNow,
}: {
  /** The game asked about; null = closed. */
  game: { id: string; title: string; art: string | null } | null;
  onVote: (liked: boolean) => void;
  onNotNow: () => void;
}) {
  return (
    <BottomSheet
      open={!!game}
      onClose={onNotNow}
      title={voteQuestion(game?.title)}
      description={
        game ? (
          <View className="mt-1 flex-row items-center gap-3">
            <VotePromptArt game={game} />
            <Text className="text-muted-foreground shrink text-sm leading-5">
              Your vote helps other players find good games. You can change it on the game page.
            </Text>
          </View>
        ) : undefined
      }
    >
      {game ? (
        <View className="gap-3">
          <View className="flex-row gap-3">
            <VoteChoice icon={ThumbsUpIcon} label="Liked it" onPress={() => onVote(true)} />
            <VoteChoice icon={ThumbsDownIcon} label="Not for me" onPress={() => onVote(false)} />
          </View>
          <Button variant="ghost" className="h-11 rounded-2xl" onPress={onNotNow}>
            <Text className="text-muted-foreground">Not now</Text>
          </Button>
        </View>
      ) : null}
    </BottomSheet>
  );
}

function VoteChoice({ icon, label, onPress }: { icon: typeof ThumbsUpIcon; label: string; onPress: () => void }) {
  return (
    <TapPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="border-input bg-card active:bg-accent flex-1 items-center gap-2 rounded-2xl border py-4"
    >
      <View className="bg-muted size-12 items-center justify-center rounded-full">
        <Icon as={icon} className="text-foreground size-6" />
      </View>
      <Text className="text-[15px] font-semibold">{label}</Text>
    </TapPressable>
  );
}

/**
 * The prompt as `(app)/_layout.tsx` mounts it, over the shell (never over a game). The play route reports a finished
 * session (`notePlayed`: the game became ready and closed normally); once the game screen is gone and has settled,
 * this asks the server whether the player may vote on that game and has not yet (`game_vote_summary`), checks the
 * device's memory (asked before? snoozed? lib/votes-model.ts `shouldOfferVotePrompt`) and shows the sheet unless
 * another sheet is up. Showing it counts as an ask and snoozes the game; a vote ends it for good.
 */
export function VotePrompt() {
  const { userId, signedIn } = useSession();
  const qc = useQueryClient();
  const signal = usePlayedSignal();
  const gameOpen = isGameScreen(usePathname());
  const [gameId, setGameId] = useState<string | null>(null);
  const game = useGame(gameId ?? undefined);
  const vote = useVoteGame(gameId ?? '');

  // The signal stays in the store until this decided about it (a game opened in between just delays the decision).
  useEffect(() => {
    const pending: PlayedSignal | null = signal;
    if (!pending || gameOpen || !userId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        let show = false;
        try {
          const [summary, memory] = await Promise.all([
            qc.fetchQuery({
              queryKey: voteKeys.summary(userId, pending.gameId),
              queryFn: () => fetchVoteSummary(pending.gameId),
              staleTime: 0,
            }),
            votePromptStore.get(userId),
          ]);
          if (cancelled) return;
          const now = Date.now();
          if (summary.myVote !== null && !memory[pending.gameId]?.voted) {
            void votePromptStore.update(userId, (s) => afterVote(s, pending.gameId));
          }
          show =
            shouldOfferVotePrompt({ entry: memory[pending.gameId], now, played: true, guest: !signedIn, summary }) &&
            !isAnySheetOpen();
          if (show) await votePromptStore.update(userId, (s) => afterAsk(s, pending.gameId, now));
        } catch {
          // Offline or the server said no: no prompt this time.
        }
        if (cancelled) return;
        takePlayed(pending);
        if (show) setGameId(pending.gameId);
      })();
    }, VOTE_PROMPT_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [signal, gameOpen, userId, signedIn, qc]);

  const closeAsNotNow = () => {
    if (gameId && userId) void votePromptStore.update(userId, (s) => afterNotNow(s, gameId, Date.now()));
    setGameId(null);
  };
  // A game opened while the prompt was up (a Join from the friend-request banner): put it away. Showing it already
  // snoozed the game, so it does not come back.
  if (gameOpen && gameId) setGameId(null);

  const g = game.data;
  return (
    <VotePromptSheet
      game={gameId && !gameOpen ? { id: gameId, title: g?.title ?? '', art: g ? coverUriFor(g, 'tile') : null } : null}
      onVote={(liked) => {
        vote.mutate(liked);
        setGameId(null);
        showToast(liked ? 'Thanks! Glad you liked it.' : 'Thanks for the feedback.');
      }}
      onNotNow={closeAsNotNow}
    />
  );
}

/** The game's tile in the sheet (kept small: the question is the point). */
function VotePromptArt({ game }: { game: { id: string; title: string; art: string | null } }) {
  return (
    <GameCover
      id={game.id}
      title={game.title}
      uri={game.art}
      showTitle={false}
      className="border-border size-14 rounded-xl border"
    />
  );
}
