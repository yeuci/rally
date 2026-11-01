import { CameraIcon, CheckIcon, ImageIcon, type LucideIcon } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { ConfirmDialog } from '@/components/rally/confirm-dialog';
import { ErrorText, FormField } from '@/components/rally/form-field';
import { Image } from '@/components/rally/image';
import { ProfileAvatar, ProfileAvatarSkeleton } from '@/components/rally/profile-avatar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Progress } from '@/components/ui/progress';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { columnPadding, ROW_GAP } from '@/lib/layout';
import { resolveAvatarUrl, type Profile } from '@/lib/profile';
import { CAMERA_AVAILABLE, useAvatarChange, type PhotoSource } from '@/lib/profile-photo';
import { ANONYMOUS_PHOTO_HINT, DEFAULT_AVATARS, defaultAvatarGrid, PHOTO_STEPS } from '@/lib/profile-photo-model';
import { cn } from '@/lib/utils';
import { useViewport } from '@/lib/viewport';

/** The xl avatar's disc (ProfileAvatar `size="xl"`), which the upload spinner covers. */
const XL_DISC = 96;

const SETTINGS_COPY: Record<PhotoSource, { title: string; body: string }> = {
  camera: { title: 'Allow camera access', body: 'Turn on camera access in Settings to take a photo for your profile.' },
  library: {
    title: 'Allow photo access',
    body: 'Turn on photo access in Settings to choose a photo for your profile.',
  },
};

/** The default avatars' grid in the form's column: two rows on a phone, one on a tablet. */
function useAvatarGrid() {
  const { width, insets } = useViewport();
  const pad = columnPadding(width, insets);
  const grid = defaultAvatarGrid(width - pad.paddingLeft - pad.paddingRight, ROW_GAP);
  return { ...grid, rowWidth: grid.columns * grid.size + (grid.columns - 1) * ROW_GAP };
}

/**
 * Edit profile's avatar block: the big preview (a spinner over it while a photo uploads), Choose photo and Take photo
 * (lib/profile-photo.ts: square crop, a 512 px JPEG in `avatars/<user id>/`) with the upload's stage in their place
 * while it runs, then the bundled defaults as a radio grid. Changes apply at once, outside Save. Anonymous sessions
 * get the defaults, the photo actions disabled and a hint. A default chosen over an uploaded photo asks first, since
 * the photo is deleted. `preview` is what the big avatar draws (the unsaved name edits for its initials).
 */
export function AvatarPicker({ profile, preview }: { profile: Profile; preview: Profile }) {
  const change = useAvatarChange(profile);
  const grid = useAvatarGrid();
  const [replacing, setReplacing] = useState<string | null>(null);
  const settings = change.settingsFor ? SETTINGS_COPY[change.settingsFor] : null;

  const pickDefault = (path: string) => {
    if (change.hasPhoto) setReplacing(path);
    else change.chooseDefault(path);
  };

  return (
    <View className="gap-5">
      <View className="items-center gap-4">
        <View className="items-center justify-center">
          <ProfileAvatar profile={preview} size="xl" ring />
          {change.step ? (
            <View
              className="absolute items-center justify-center rounded-full bg-black/45"
              style={{ width: XL_DISC, height: XL_DISC }}
              pointerEvents="none"
            >
              <ActivityIndicator color="#FFFFFF" />
            </View>
          ) : null}
        </View>
        {/* One height for the actions and the progress that replaces them, so the form does not jump. */}
        <View className="min-h-9 w-full items-center justify-center">
          {change.step ? (
            <View className="w-full max-w-[240px] gap-2" accessibilityLiveRegion="polite">
              <Progress
                value={PHOTO_STEPS[change.step].progress * 100}
                className="h-1.5"
                accessibilityLabel={PHOTO_STEPS[change.step].label}
              />
              <Text variant="muted" className="text-center text-[13px] leading-[18px]">
                {PHOTO_STEPS[change.step].label}
              </Text>
            </View>
          ) : (
            <View className="flex-row flex-wrap justify-center gap-2">
              <PhotoButton
                icon={ImageIcon}
                label="Choose photo"
                disabled={!change.canUpload || change.busy}
                onPress={() => change.choosePhoto('library')}
              />
              {CAMERA_AVAILABLE ? (
                <PhotoButton
                  icon={CameraIcon}
                  label="Take photo"
                  disabled={!change.canUpload || change.busy}
                  onPress={() => change.choosePhoto('camera')}
                />
              ) : null}
            </View>
          )}
        </View>
        {!change.canUpload ? (
          <Text variant="muted" className="text-center text-[13px] leading-[18px]">
            {ANONYMOUS_PHOTO_HINT}
          </Text>
        ) : null}
      </View>
      <ErrorText>{change.error}</ErrorText>
      <FormField id="default-avatars" label="Default avatars">
        <View
          accessibilityRole="radiogroup"
          aria-labelledby="default-avatars"
          className="flex-row flex-wrap"
          style={{ gap: ROW_GAP, width: grid.rowWidth }}
        >
          {DEFAULT_AVATARS.map((path, i) => (
            <DefaultAvatarTile
              key={path}
              path={path}
              label={`Default avatar ${i + 1}`}
              size={grid.size}
              selected={profile.avatar_url === path}
              applying={change.applying === path}
              disabled={change.busy}
              onPress={() => pickDefault(path)}
            />
          ))}
        </View>
      </FormField>
      <ConfirmDialog
        open={replacing !== null}
        onOpenChange={(open) => !open && setReplacing(null)}
        title="Remove your photo?"
        body="Your photo will be deleted and this avatar shown instead."
        action="Use this avatar"
        destructive
        onConfirm={() => {
          const path = replacing;
          setReplacing(null);
          if (path) change.chooseDefault(path);
        }}
      />
      {settings ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && change.closeSettings()}
          title={settings.title}
          body={settings.body}
          action="Open Settings"
          onConfirm={change.openSettings}
        />
      ) : null}
    </View>
  );
}

function PhotoButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Button variant="secondary" size="sm" className="rounded-full px-4" disabled={disabled} onPress={onPress}>
      <Icon as={icon} className="text-secondary-foreground size-3.5" />
      <Text>{label}</Text>
    </Button>
  );
}

/** One bundled picture: a ring and a check when it is the current avatar, a spinner while it is being applied. */
function DefaultAvatarTile({
  path,
  label,
  size,
  selected,
  applying,
  disabled,
  onPress,
}: {
  path: string;
  label: string;
  size: number;
  selected: boolean;
  applying: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const uri = resolveAvatarUrl(path);
  // Ring 2 + gap 2 on each side, like ProfileAvatar's ring.
  const disc = size - 8;
  return (
    <TapPressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, disabled, busy: applying }}
      className={cn(
        'items-center justify-center rounded-full border-2 active:opacity-70',
        selected ? 'border-foreground' : 'border-transparent',
        disabled && !applying && 'opacity-60',
      )}
      style={{ width: size, height: size }}
    >
      <View className="bg-subtle overflow-hidden rounded-full" style={{ width: disc, height: disc }}>
        {uri ? (
          <Image source={{ uri }} className="absolute inset-0" contentFit="cover" placeholderClassName="rounded-full" />
        ) : null}
        {applying ? (
          <View className="absolute inset-0 items-center justify-center bg-black/45">
            <ActivityIndicator size="small" color="#FFFFFF" />
          </View>
        ) : null}
      </View>
      {selected ? (
        <View className="bg-foreground border-background absolute -bottom-0.5 -right-0.5 size-5 items-center justify-center rounded-full border-2">
          <Icon as={CheckIcon} className="text-background size-3" strokeWidth={3} />
        </View>
      ) : null}
    </TapPressable>
  );
}

/** AvatarPicker's footprint while the form loads (Edit profile's skeleton). */
export function AvatarPickerSkeleton() {
  const grid = useAvatarGrid();
  return (
    <View className="gap-5">
      <View className="items-center gap-4">
        <ProfileAvatarSkeleton size="xl" ring />
        <Skeleton className="h-9 w-64 rounded-full" />
      </View>
      <View className="gap-2">
        <SkeletonText lineHeight={18} width={112} />
        <View className="flex-row flex-wrap" style={{ gap: ROW_GAP, width: grid.rowWidth }}>
          {DEFAULT_AVATARS.map((path) => (
            <View key={path} className="items-center justify-center" style={{ width: grid.size, height: grid.size }}>
              <Skeleton className="rounded-full" style={{ width: grid.size - 8, height: grid.size - 8 }} />
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}
