import { useQuery } from '@tanstack/react-query';
import { config } from '@/config';
import { useSession } from '@/lib/auth/session';
import { supabase } from '@/lib/supabase';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { usernameFormatError } from './username';

export type UsernameStatus = 'empty' | 'invalid' | 'checking' | 'available' | 'unavailable' | 'unchanged' | 'error';

/**
 * The answer depends on the caller: `username_available` ignores the caller's own profile, so a name held by the
 * anonymous user of an Apple/Google signup in progress (or the signed-in user's current name) reads as available.
 */
export const usernameAvailabilityKey = (userId: string | null, username: string) =>
  ['username-available', userId, username.toLowerCase()] as const;

/** Live availability via the `username_available` RPC (format + uniqueness + word filter), debounced. */
export function useUsernameAvailability(username: string, current?: string | null): { status: UsernameStatus; message: string | null } {
  const { userId } = useSession();
  const debounced = useDebouncedValue(username, 350);
  const formatError = usernameFormatError(username);
  const unchanged = !!current && username.toLowerCase() === current.toLowerCase();
  const enabled = username.length > 0 && !formatError && !unchanged && config.supabaseConfigured;

  const q = useQuery({
    queryKey: usernameAvailabilityKey(userId, debounced),
    enabled: enabled && debounced === username,
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('username_available', { p_username: debounced });
      if (error) throw error;
      return data;
    },
  });

  if (username.length === 0) return { status: 'empty', message: null };
  if (formatError) return { status: 'invalid', message: formatError };
  if (unchanged) return { status: 'unchanged', message: null };
  if (debounced !== username || q.isFetching) return { status: 'checking', message: 'Checking…' };
  if (q.isError) return { status: 'error', message: "Couldn't check right now." };
  if (q.data === true) return { status: 'available', message: 'Available' };
  if (q.data === false) return { status: 'unavailable', message: "That username isn't available." };
  return { status: 'checking', message: 'Checking…' };
}
