import { Trash2Icon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Keyboard, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { deleteMyAccount } from '@/lib/delete-account';
import { confirmsUsername, DELETED_DATA, deleteAccountErrorMessage } from '@/lib/delete-account-model';
import { useViewport } from '@/lib/viewport';
import { BottomSheet, SheetScrollView } from './bottom-sheet';
import { ErrorText, FormField } from './form-field';

/** Height kept free around the scrolling part: title and description, the two buttons, padding, the status bar. */
const RESERVED_HEIGHT = 300;

/** After the sign-out, long enough for the sheet and the profile to leave before the alert presents. */
const ALERT_DELAY_MS = 600;

/**
 * "Delete your account?" (App Store 5.1.1(v); docs/moderation.md), from Profile → Delete account: what goes, that it
 * cannot be undone, and a field where the username must be typed before the destructive button enables. The button
 * runs lib/delete-account.ts (photos, then `delete_my_account()`, then a local sign-out) with a spinner; the session
 * gate then shows the welcome screen and an alert confirms it. A failure keeps the sheet open with a message saying
 * what happened (retrying is safe).
 */
export function DeleteAccountSheet({
  open,
  onClose,
  userId,
  username,
}: {
  open: boolean;
  onClose: () => void;
  userId: string | null;
  username: string | null;
}) {
  // While deleting, the sheet cannot be dismissed (the backdrop and Android back do nothing).
  const [busy, setBusy] = useState(false);
  return (
    <BottomSheet
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Delete your account?"
      description="This permanently deletes your Rally account. It can't be undone."
    >
      {/* Mounted per opening: the confirmation field starts empty every time. */}
      {open && userId && username ? (
        <DeleteForm userId={userId} username={username} onBusyChange={setBusy} onCancel={onClose} />
      ) : null}
    </BottomSheet>
  );
}

function DeleteForm({
  userId,
  username,
  onBusyChange,
  onCancel,
}: {
  userId: string;
  username: string;
  onBusyChange: (busy: boolean) => void;
  onCancel: () => void;
}) {
  const { height, insets } = useViewport();
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = confirmsUsername(typed, username);

  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  const run = async () => {
    if (!confirmed || deleting) return;
    Keyboard.dismiss();
    setDeleting(true);
    onBusyChange(true);
    setError(null);
    try {
      await deleteMyAccount(userId);
    } catch (err) {
      setError(deleteAccountErrorMessage(err));
      setDeleting(false);
      onBusyChange(false);
      return;
    }
    // Signed out: the session gate swaps to the welcome screen, and this sheet leaves with the profile.
    setTimeout(
      () => Alert.alert('Account deleted', 'Your Rally account and its data have been deleted. Thanks for playing.'),
      ALERT_DELAY_MS,
    );
  };

  return (
    <View className="gap-4">
      <SheetScrollView
        style={{ maxHeight: Math.max(180, height - insets.top - RESERVED_HEIGHT) }}
        contentContainerClassName="gap-4"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className="bg-card border-border gap-2.5 rounded-2xl border px-4 py-3.5" accessible>
          {DELETED_DATA.map((line) => (
            <View key={line} className="flex-row items-start gap-2.5">
              <Icon as={Trash2Icon} className="text-destructive mt-0.5 size-4" />
              <Text className="shrink text-[15px] leading-5">{line}</Text>
            </View>
          ))}
        </View>
        <Text variant="muted" className="px-1 text-[13px] leading-[18px]">
          Your username becomes free for others to take. Matches you played stay in the other players&apos; history,
          without your name.
        </Text>
        <FormField id="delete-account-confirm" label={`Type ${username} to confirm`}>
          <Input
            value={typed}
            onChangeText={setTyped}
            placeholder={username}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            textContentType="none"
            importantForAutofill="no"
            returnKeyType="done"
            onSubmitEditing={() => void run()}
            editable={!deleting}
            aria-labelledby="delete-account-confirm"
          />
        </FormField>
        <ErrorText>{error}</ErrorText>
      </SheetScrollView>
      <View className="gap-2">
        <Button
          variant="destructive"
          size="lg"
          className="h-14 rounded-2xl"
          disabled={!confirmed || deleting}
          onPress={() => void run()}
        >
          {deleting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Icon as={Trash2Icon} className="size-[18px] text-white" />
          )}
          <Text className="text-[17px] font-bold">{deleting ? 'Deleting…' : 'Delete my account'}</Text>
        </Button>
        <Button variant="ghost" size="lg" className="h-11 rounded-2xl" disabled={deleting} onPress={onCancel}>
          <Text>Cancel</Text>
        </Button>
      </View>
    </View>
  );
}
