import { PROFILE_COLUMNS, type Tables, type TablesUpdate } from '@rally/db';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/auth/session';
import { resolveAvatarPath } from '@/lib/avatar';
import { privacyKey } from '@/lib/privacy';
import type { PrivacySettings } from '@/lib/social';
import { supabase } from '@/lib/supabase';

/**
 * The columns a client may read. `birth_date` and `privacy` are withheld by a column-level grant, so
 * `select('*')` (or naming either column) fails the whole query with "permission denied".
 */
export type Profile = Pick<Tables<'profiles'>, 'id' | 'username' | 'display_name' | 'avatar_url' | 'bio' | 'created_at' | 'updated_at'>;
export type ProfileUpdate = Pick<TablesUpdate<'profiles'>, 'username' | 'display_name' | 'bio' | 'avatar_url'> & {
  /** Never selectable by clients (read with `my_privacy`, lib/privacy.ts); written whole (lib/social.ts `privacyPatch`). */
  privacy?: PrivacySettings;
};

export const profileKey = (userId: string | null) => ['profile', userId] as const;

/** The signed-in user's profile row (created by the `handle_new_user` trigger at signup). */
export function useProfile() {
  const { userId } = useSession();
  return useQuery({
    queryKey: profileKey(userId),
    enabled: !!userId,
    queryFn: async (): Promise<Profile | null> => {
      const { data, error } = await supabase.from('profiles').select(PROFILE_COLUMNS).eq('id', userId!).maybeSingle();
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
      const { privacy, ...columns } = patch;
      const { data, error } = await supabase
        .from('profiles')
        .update(
          privacy
            ? { ...columns, privacy: { games: privacy.games, friends: privacy.friends, presence: privacy.presence } }
            : columns,
        )
        .eq('id', userId)
        .select(PROFILE_COLUMNS)
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (profile, patch) => {
      qc.setQueryData(profileKey(profile.id), profile);
      if (patch.privacy) {
        qc.setQueryData(privacyKey(profile.id), patch.privacy);
        // What others can see of this profile changed.
        void qc.invalidateQueries({ queryKey: ['social'] });
      }
    },
  });
}

/** Absolute URL for an `avatar_url` value (bucket-relative defaults and photos: the public `avatars` bucket). */
export function resolveAvatarUrl(value: string | null | undefined): string | null {
  return resolveAvatarPath(value, supabase.storage.from('avatars').getPublicUrl('').data.publicUrl);
}

/** Up to two initials for the avatar fallback: display name words, else the username. */
export function initialsFor(profile: Pick<Profile, 'username' | 'display_name'> | null | undefined): string {
  const source = profile?.display_name?.trim() || profile?.username || '?';
  const words = source.split(/[\s_]+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : source.slice(0, 2);
  return letters.toUpperCase();
}
