import { buildReportArgs, type ReportInput } from '@/lib/report-model';
import { supabase } from '@/lib/supabase';

/**
 * Reports a player (`report_user`, 20261102000100_moderation.sql): a reason, an optional note and the game / room it
 * came from. The answer is the same whoever the target is (an unknown or blocking player included), so there is
 * nothing to read back; it throws only for the caller's own problems (rate limit, anonymous session, network). Blocking
 * is a separate step, the existing `block_user` (lib/friends.ts `useFriendshipAction`).
 */
export async function reportPlayer(input: ReportInput): Promise<void> {
  const args = buildReportArgs(input);
  if (!args) throw new Error('INVALID: pick a reason');
  const { error } = await supabase.rpc('report_user', args);
  if (error) throw error;
}
