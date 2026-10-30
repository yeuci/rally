import { router } from 'expo-router';
import { UserXIcon } from 'lucide-react-native';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EmptyState } from '@/components/rally/empty-state';
import { ErrorText, FormField } from '@/components/rally/form-field';
import { ProfileAvatar, ProfileAvatarSkeleton } from '@/components/rally/profile-avatar';
import { Segmented } from '@/components/rally/segmented';
import { UsernameField } from '@/components/rally/username-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { Textarea } from '@/components/ui/textarea';
import { describeAuthError } from '@/lib/auth/errors';
import { useUsernameAvailability } from '@/lib/auth/use-username-availability';
import { usePrivacy } from '@/lib/privacy';
import { useProfile, useUpdateProfile, type Profile, type ProfileUpdate } from '@/lib/profile';
import { privacyPatch, VISIBILITY_OPTIONS, type PrivacySettings, type Visibility } from '@/lib/social';
import { useColumnPadding } from '@/lib/use-layout';

const DISPLAY_NAME_MAX = 32; // profiles_display_name_len
const BIO_MAX = 280; // profiles_bio_len

export default function EditProfileScreen() {
  const profile = useProfile();
  const privacy = usePrivacy();
  const column = useColumnPadding();
  // No profile after the query settled (an error, or no row): say so instead of a skeleton that never resolves.
  if (!profile.data && (profile.isError || profile.isSuccess)) {
    return (
      <View className="bg-background flex-1 justify-center" style={column}>
        <EmptyState
          icon={UserXIcon}
          title="Couldn't load your profile"
          body="Check your connection and try again."
          className="w-full"
          action={
            <Button variant="secondary" disabled={profile.isFetching} onPress={() => void profile.refetch()}>
              <Text>{profile.isFetching ? 'Loading…' : 'Try again'}</Text>
            </Button>
          }
        />
      </View>
    );
  }
  // The form seeds its state once, so it waits for both; a failed privacy read still allows editing the rest.
  if (!profile.data || privacy.isLoading) return <EditProfileSkeleton />;
  return <EditProfileForm profile={profile.data} privacy={privacy.data ?? null} />;
}

function EditProfileForm({ profile, privacy }: { profile: Profile; privacy: PrivacySettings | null }) {
  const insets = useSafeAreaInsets();
  const column = useColumnPadding();
  // The opaque stack header sits above this view; KeyboardAvoidingView measures from its own frame, so tell it.
  const headerHeight = useHeaderHeight();
  const update = useUpdateProfile();
  const [username, setUsername] = useState(profile.username);
  const [displayName, setDisplayName] = useState(profile.display_name ?? '');
  const [bio, setBio] = useState(profile.bio ?? '');
  const [games, setGames] = useState<Visibility>(privacy?.games ?? 'public');
  const [friends, setFriends] = useState<Visibility>(privacy?.friends ?? 'public');
  const [error, setError] = useState<string | null>(null);
  const availability = useUsernameAvailability(username, profile.username);

  const patch: ProfileUpdate = {};
  if (username !== profile.username) patch.username = username;
  if (displayName.trim() !== (profile.display_name ?? '')) patch.display_name = displayName.trim() || null;
  if (bio.trim() !== (profile.bio ?? '')) patch.bio = bio.trim() || null;
  const privacyChange = privacy ? privacyPatch(privacy, { games, friends }) : null;
  if (privacyChange) patch.privacy = privacyChange;

  const usernameOk = availability.status === 'unchanged' || availability.status === 'available';
  const canSave = Object.keys(patch).length > 0 && usernameOk && !update.isPending;

  async function save() {
    setError(null);
    try {
      await update.mutateAsync(patch);
      router.back();
    } catch (err) {
      setError(describeAuthError(err));
    }
  }

  return (
    <KeyboardAvoidingView
      className="bg-background flex-1"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={headerHeight}
    >
      <ScrollView
        contentContainerClassName="gap-5 pt-6"
        contentContainerStyle={[column, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View className="items-center">
          <ProfileAvatar profile={{ ...profile, display_name: displayName || null, username }} size="xl" ring />
        </View>
        <FormField id="display-name" label="Display name" hint={`${displayName.length}/${DISPLAY_NAME_MAX}`}>
          <Input
            aria-labelledby="display-name"
            value={displayName}
            onChangeText={setDisplayName}
            maxLength={DISPLAY_NAME_MAX}
            placeholder={profile.username}
          />
        </FormField>
        <UsernameField
          value={username}
          onChangeText={setUsername}
          current={profile.username}
          status={availability.status}
          message={availability.message}
        />
        <FormField id="bio" label="Bio" hint={`${bio.length}/${BIO_MAX}`}>
          <Textarea
            aria-labelledby="bio"
            value={bio}
            onChangeText={setBio}
            maxLength={BIO_MAX}
            numberOfLines={4}
            placeholder="A line about you"
          />
        </FormField>
        <View className="gap-4 pt-2">
          <View className="gap-1">
            <Text className="text-[17px] font-bold leading-[22px] tracking-tight" role="heading">
              Privacy
            </Text>
            <Text variant="muted" className="leading-5">
              {privacy ? 'Who can see these on your profile.' : "Couldn't load your privacy settings. Try again later."}
            </Text>
          </View>
          {privacy && (
            <>
              <PrivacyField label="Games played" value={games} onChange={setGames} />
              <PrivacyField label="Friends list" value={friends} onChange={setFriends} />
            </>
          )}
        </View>
        <ErrorText>{error}</ErrorText>
        <Button size="lg" disabled={!canSave} onPress={() => void save()}>
          <Text>{update.isPending ? 'Saving…' : 'Save'}</Text>
        </Button>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function PrivacyField({ label, value, onChange }: { label: string; value: Visibility; onChange: (v: Visibility) => void }) {
  return (
    <View className="flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <Text className="text-[15px] font-medium">{label}</Text>
      <Segmented options={VISIBILITY_OPTIONS} value={value} onChange={onChange} accessibilityLabel={`${label}: who can see it`} />
    </View>
  );
}

/** The form's footprint while the profile and privacy settings load. */
function EditProfileSkeleton() {
  const insets = useSafeAreaInsets();
  const column = useColumnPadding();
  const field = (label: number, height: number) => (
    <View className="gap-2">
      <SkeletonText lineHeight={18} width={label} />
      <Skeleton className="w-full rounded-lg" style={{ height }} />
    </View>
  );
  return (
    <ScrollView
      className="bg-background flex-1"
      scrollEnabled={false}
      contentContainerClassName="gap-5 pt-6"
      contentContainerStyle={[column, { paddingBottom: insets.bottom + 24 }]}
    >
      <View className="items-center">
        <ProfileAvatarSkeleton size="xl" ring />
      </View>
      {field(96, 48)}
      {field(72, 48)}
      {field(28, 96)}
      <View className="gap-4 pt-2">
        <SkeletonText lineHeight={22} width={64} />
        {[0, 1].map((i) => (
          <View key={i} className="flex-row items-center justify-between">
            <SkeletonText lineHeight={20} width={96} />
            <Skeleton className="h-[38px] w-56 rounded-full" />
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
