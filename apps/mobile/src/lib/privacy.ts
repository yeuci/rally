import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth/session';
import { parsePrivacy, type PrivacySettings } from '@/lib/social';
import { supabase } from '@/lib/supabase';

/**
 * The signed-in user's `profiles.privacy`. The column is never selectable by clients (not even the owner's own row),
 * so it is read through the `my_privacy` RPC (jsonb with defaults filled in) and written with a plain owner update
 * (lib/profile.ts `useUpdateProfile`, which also refreshes this entry).
 */
export const privacyKey = (uid: string | null) => ['me', uid, 'privacy'] as const;

export function usePrivacy() {
  const { userId } = useSession();
  return useQuery({
    queryKey: privacyKey(userId),
    enabled: !!userId,
    queryFn: async (): Promise<PrivacySettings> => {
      const { data, error } = await supabase.rpc('my_privacy');
      if (error) throw error;
      return parsePrivacy(data);
    },
  });
}
