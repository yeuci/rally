import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { useSession } from '@/lib/auth/session';
import { progressKeys } from '@/lib/game-progress';
import { socialErrorKind } from '@/lib/social';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';
import {
  afterVote,
  applyVote,
  parseVotePromptState,
  parseVoteSummary,
  type VotePromptState,
  type VoteSummary,
} from '@/lib/votes-model';

/**
 * Thumbs up / down on games (20261101000200_social_discovery.sql): the game page's summary and vote buttons, the vote
 * mutation, the post-match prompt's device memory and the "a match just ended" signal from the play route. Rules live
 * in lib/votes-model.ts; the prompt sheet is components/rally/vote-prompt.tsx.
 *
 * The summary sits under the game's progress key (`['progress', uid, gameId, 'votes']`): `invalidateAfterPlay` and the
 * game page's pull to refresh already refetch that prefix, and `can_vote` flips once the first match is recorded.
 */
export const voteKeys = {
  summary: (uid: string | null, gameId: string) => [...progressKeys.game(uid, gameId), 'votes'] as const,
};

export async function fetchVoteSummary(gameId: string): Promise<VoteSummary> {
  const { data, error } = await supabase.rpc('game_vote_summary', { p_game_id: gameId });
  if (error) throw error;
  const s = parseVoteSummary(data, gameId);
  if (!s) throw new Error('unexpected game_vote_summary answer');
  return s;
}

/** `game_vote_summary` for the game page ("94% liked · 128 votes", your vote, whether you may vote). */
export function useGameVotes(gameId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: voteKeys.summary(userId, gameId ?? ''),
    enabled: !!gameId,
    staleTime: 60_000,
    retry: 1,
    queryFn: () => fetchVoteSummary(gameId!),
  });
}

/**
 * Vote (true / false) or take the vote back (null) on `gameId`: optimistic on the summary, the server's summary when it
 * answers, rolled back with a toast on failure. A vote also tells the prompt never to ask about this game again.
 */
export function useVoteGame(gameId: string) {
  const { userId } = useSession();
  const qc = useQueryClient();
  const key = voteKeys.summary(userId, gameId);
  return useMutation({
    mutationFn: async (liked: boolean | null): Promise<VoteSummary> => {
      const { data, error } = await supabase.rpc(
        'vote_game',
        liked === null ? { p_game_id: gameId } : { p_game_id: gameId, p_liked: liked },
      );
      if (error) throw error;
      return parseVoteSummary(data, gameId) ?? (await fetchVoteSummary(gameId));
    },
    onMutate: async (liked) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<VoteSummary>(key);
      if (previous) qc.setQueryData<VoteSummary>(key, applyVote(previous, liked));
      if (userId && liked !== null) void votePromptStore.update(userId, (s) => afterVote(s, gameId));
      return { previous };
    },
    onSuccess: (summary) => qc.setQueryData(key, summary),
    onError: (err, _liked, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
      const kind = socialErrorKind(err);
      // The server's reason goes to the log (shake-to-report keeps it) and, in dev builds, onto the toast.
      const reason = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
      console.warn(`[votes] vote_game failed for ${gameId}: ${reason}`);
      const text =
        kind === 'rate-limited'
          ? 'Too many votes. Try again in a few minutes.'
          : kind === 'network'
            ? "You're offline. Your vote wasn't saved."
            : "Couldn't save your vote. Try again.";
      showToast(__DEV__ && kind === 'other' ? `${text} (${reason.slice(0, 120)})` : text);
    },
  });
}

// --- the post-match prompt's memory (per account, on the device) ---------------------------------------------------

const promptKey = (uid: string) => `rally.vote-prompt.${uid}`;

export const votePromptStore = {
  async get(uid: string): Promise<VotePromptState> {
    try {
      return parseVotePromptState(await AsyncStorage.getItem(promptKey(uid)));
    } catch {
      return {};
    }
  },
  async update(uid: string, fn: (s: VotePromptState) => VotePromptState): Promise<void> {
    try {
      const next = fn(await votePromptStore.get(uid));
      await AsyncStorage.setItem(promptKey(uid), JSON.stringify(next));
    } catch {
      // Best effort: the worst case is one more ask.
    }
  },
};

// --- "a match of this game just ended" (the play route → the prompt) ----------------------------------------------

export interface PlayedSignal {
  gameId: string;
  at: number;
}

let played: PlayedSignal | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/**
 * The play route's exit (`GameHostResult`): a game that became ready (`played`) and closed normally queues the vote
 * prompt for when the game screen is gone. An unmount (sign-out, navigation from outside) never prompts.
 */
export function notePlayed(gameId: string | undefined, result: { played: boolean; reason: string }): void {
  if (!gameId || !result.played || result.reason === 'unmount') return;
  played = { gameId, at: Date.now() };
  emit();
}

/** The prompt host is done with `signal` (a newer one, from another game, stays). */
export function takePlayed(signal: PlayedSignal): void {
  if (played !== signal) return;
  played = null;
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function usePlayedSignal(): PlayedSignal | null {
  return useSyncExternalStore(
    subscribe,
    () => played,
    () => null,
  );
}
