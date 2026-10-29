import type { Tables, TablesUpdate } from '@rally/db';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/auth/session';
import { supabase } from '@/lib/supabase';

export type Profile = Tables<'profiles'>;
export type ProfileUpdate = Pick<TablesUpdate<'profiles'>, 'username' | 'display_name' | 'bio' | 'avatar_url'>;

export const profileKey = (userId: string | null) => ['profile', userId] as const;

/** The signed-in user's profile row (created by the `handle_new_user` trigger at signup). */
export function useProfile() {
  const { userId } = useSession();
  return useQuery({
    queryKey: profileKey(userId),
    enabled: !!userId,
    queryFn: async (): Promise<Profile | null> => {
      const { data, error } = await supabase.from('profiles').select('*').eq('id', userId!).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/** Writes the user's own row (RLS: `id = auth.uid()`); id and birth_date are immutable server-side. */
export function useUpdateProfile() {
  const { userId } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: ProfileUpdate): Promise<Profile> => {
      if (!userId) throw new Error('Not signed in');
      const { data, error } = await supabase.from('profiles').update(patch).eq('id', userId).select('*').single();
      if (error) throw error;
      return data;
    },
    onSuccess: (profile) => qc.setQueryData(profileKey(profile.id), profile),
  });
}

/** Up to two initials for the avatar fallback: display name words, else the username. */
export function initialsFor(profile: Pick<Profile, 'username' | 'display_name'> | null | undefined): string {
  const source = profile?.display_name?.trim() || profile?.username || '?';
  const words = source.split(/[\s_]+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : source.slice(0, 2);
  return letters.toUpperCase();
}
