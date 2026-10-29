import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ErrorText, FormField } from '@/components/rally/form-field';
import { ProfileAvatar } from '@/components/rally/profile-avatar';
import { UsernameField } from '@/components/rally/username-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { Textarea } from '@/components/ui/textarea';
import { describeAuthError } from '@/lib/auth/errors';
import { useUsernameAvailability } from '@/lib/auth/use-username-availability';
import { useProfile, useUpdateProfile, type Profile, type ProfileUpdate } from '@/lib/profile';

const DISPLAY_NAME_MAX = 32; // profiles_display_name_len
const BIO_MAX = 280; // profiles_bio_len

export default function EditProfileScreen() {
  const profile = useProfile();
  if (!profile.data) {
    return (
      <View className="bg-background flex-1 items-center justify-center">
        <ActivityIndicator />
      </View>
    );
  }
  return <EditProfileForm profile={profile.data} />;
}

function EditProfileForm({ profile }: { profile: Profile }) {
  const insets = useSafeAreaInsets();
  const update = useUpdateProfile();
  const [username, setUsername] = useState(profile.username);
  const [displayName, setDisplayName] = useState(profile.display_name ?? '');
  const [bio, setBio] = useState(profile.bio ?? '');
  const [error, setError] = useState<string | null>(null);
  const availability = useUsernameAvailability(username, profile.username);

  const patch: ProfileUpdate = {};
  if (username !== profile.username) patch.username = username;
  if (displayName.trim() !== (profile.display_name ?? '')) patch.display_name = displayName.trim() || null;
  if (bio.trim() !== (profile.bio ?? '')) patch.bio = bio.trim() || null;

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
    <KeyboardAvoidingView className="bg-background flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerClassName="gap-5 px-4 pt-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="items-center">
          <ProfileAvatar profile={{ ...profile, display_name: displayName || null, username }} size="xl" />
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
        <ErrorText>{error}</ErrorText>
        <Button size="lg" disabled={!canSave} onPress={() => void save()}>
          <Text>{update.isPending ? 'Saving…' : 'Save'}</Text>
        </Button>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
