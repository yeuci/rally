import { PROFILE_COLUMNS } from '@rally/db';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as Device from 'expo-device';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useRef, useState } from 'react';
import { AccessibilityInfo, Linking, Platform } from 'react-native';
import { useSession } from '@/lib/auth/session';
import { decodeBase64 } from '@/lib/bug-report-model';
import { socialKeys } from '@/lib/friends';
import { progressKeys } from '@/lib/game-progress';
import { successHaptic } from '@/lib/haptics';
import { profileKey, type Profile } from '@/lib/profile';
import {
  AVATARS_BUCKET,
  CAMERA_DECLINED_TEXT,
  PHOTO_CACHE_SECONDS,
  PHOTO_DECODE_MAX,
  PHOTO_QUALITY,
  PHOTO_SIZE,
  PhotoTooLargeError,
  avatarObjectPath,
  avatarUrlOk,
  cameraPermissionStep,
  centerSquare,
  isDefaultAvatar,
  isOwnPhoto,
  photoBytesOk,
  photoErrorKind,
  photoErrorText,
  photoPath,
  photosToDelete,
  type PhotoStep,
} from '@/lib/profile-photo-model';
import { supabase } from '@/lib/supabase';

/**
 * Photo avatars (Edit profile → Choose photo / Take photo, and picking a default again): the picker with its square
 * crop, a 512×512 JPEG from expo-image-manipulator, the upload to `avatars/<user id>/<timestamp>.jpg`, `avatar_url`,
 * the clean-up of older uploads and every cache that shows the avatar. The rules live in lib/profile-photo-model.ts.
 * Both modules ship in Expo Go, so this works there too.
 */

export type PhotoSource = 'library' | 'camera';

/**
 * Whether "Take photo" is offered: phones and tablets, not web, and not the iOS Simulator. Its UIKit picker has no
 * camera and throws a native exception (an app crash, not a rejected promise) when asked for one.
 */
export const CAMERA_AVAILABLE = Platform.OS === 'android' || (Platform.OS === 'ios' && Device.isDevice);

const bucket = () => supabase.storage.from(AVATARS_BUCKET);
const publicBaseUrl = () => bucket().getPublicUrl('').data.publicUrl;

/** The object an `avatar_url` names in the avatars bucket (bucket-relative, or this bucket's public URL), else null. */
export function avatarObject(value: string | null | undefined): string | null {
  return avatarObjectPath(value, publicBaseUrl());
}

type Picked = { uri: string } | 'cancelled' | 'declined' | 'settings';

/**
 * The system photo picker or the camera, each with its square crop (iOS always crops square; Android follows
 * `aspect`). The camera asks for its permission first: refused just now says so in a line, refused for good offers
 * Settings. The photo picker runs outside the app and needs no permission.
 */
async function pickSquare(source: PhotoSource): Promise<Picked> {
  // Full quality out of the picker: the one lossy step is the 512 px JPEG.
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: 'images',
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  };
  if (source === 'camera') {
    let step = cameraPermissionStep(await ImagePicker.getCameraPermissionsAsync());
    if (step === 'ask') {
      step = cameraPermissionStep(await ImagePicker.requestCameraPermissionsAsync());
      if (step !== 'granted') return 'declined';
    }
    if (step === 'settings') return 'settings';
  }
  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync({ ...options, cameraType: ImagePicker.CameraType.front })
      : await ImagePicker.launchImageLibraryAsync(options);
  const asset = result.canceled ? null : result.assets[0];
  return asset ? { uri: asset.uri } : 'cancelled';
}

/**
 * The picked image as a 512×512 JPEG: decoded at most 2048 px on its longer edge, centre-cropped when the crop UI left
 * it not quite square, resized, compressed. The native images are released as soon as the bytes are out.
 */
async function squareJpeg(uri: string): Promise<Uint8Array> {
  const native: { release(): void }[] = [];
  try {
    const decode = ImageManipulator.manipulate(uri, { maxWidth: PHOTO_DECODE_MAX, maxHeight: PHOTO_DECODE_MAX });
    native.push(decode);
    const loaded = await decode.renderAsync();
    native.push(loaded);
    const context = ImageManipulator.manipulate(loaded);
    native.push(context);
    const crop = centerSquare(loaded.width, loaded.height);
    if (crop) context.crop(crop);
    const square = await context.resize({ width: PHOTO_SIZE, height: PHOTO_SIZE }).renderAsync();
    native.push(square);
    const saved = await square.saveAsync({ format: SaveFormat.JPEG, compress: PHOTO_QUALITY, base64: true });
    if (!saved.base64) throw new Error('The photo could not be read');
    return decodeBase64(saved.base64);
  } finally {
    for (const n of native) n.release();
  }
}

/** Writes `avatar_url` (RLS: own row only; the check constraint is `avatarUrlOk`) and returns the updated row. */
async function writeAvatarUrl(userId: string, value: string): Promise<Profile> {
  if (!avatarUrlOk(value)) throw new Error(`INVALID avatar_url ${value}`);
  const { data, error } = await supabase
    .from('profiles')
    .update({ avatar_url: value })
    .eq('id', userId)
    .select(PROFILE_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

/** Storage `remove`, best effort: a file left behind goes with the next change, or with the account. */
async function removeQuietly(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await bucket().remove(paths);
  } catch {
    // Offline: see above.
  }
}

/**
 * Deletes the user's other uploads once `avatar_url` is `current`: whatever is listed in their folder, else the
 * previous photo alone (lib/profile-photo-model.ts `photosToDelete`: only ever `<user id>/<file>`).
 */
async function removeOldPhotos(userId: string, current: string, previous: string | null): Promise<void> {
  let listed: string[] | null = null;
  try {
    const { data } = await bucket().list(userId, { limit: 100 });
    if (data) listed = data.filter((f) => f.id !== null).map((f) => f.name);
  } catch {
    // Offline or refused: the previous photo is still known.
  }
  await removeQuietly(photosToDelete({ userId, current, previous, listed }));
}

/**
 * Every cache showing this player's avatar: their profile (top bar, drawer, Profile, Edit profile, a game's launch
 * context) and the lists they appear in (a friend's friends list, search, leaderboards, their public profile, the
 * in-game peek). A new photo has a new path, so expo-image never shows the old one from its cache.
 */
function refreshAvatarEverywhere(qc: QueryClient, profile: Profile): void {
  qc.setQueryData(profileKey(profile.id), profile);
  void qc.invalidateQueries({ queryKey: profileKey(profile.id) });
  void qc.invalidateQueries({ queryKey: socialKeys.all(profile.id) });
  // Everything under progressKeys.game(uid, …): leaderboard rows carry avatar_url.
  void qc.invalidateQueries({ queryKey: ['progress', profile.id] });
  void qc.invalidateQueries({ queryKey: progressKeys.user(profile.username) });
  void qc.invalidateQueries({ queryKey: ['menu-peek', profile.id] });
}

export interface AvatarChange {
  /** Uploads are open to signed-in accounts; Storage refuses an anonymous session's (hardening §10). */
  canUpload: boolean;
  /** `avatar_url` is one of the user's own uploads (choosing a default deletes it). */
  hasPhoto: boolean;
  /** The upload's stage while a photo is on its way, else null. */
  step: PhotoStep | null;
  /** The default being applied, else null. */
  applying: string | null;
  busy: boolean;
  error: string | null;
  /** The permission a standing refusal blocks (the Settings dialog is open), else null. */
  settingsFor: PhotoSource | null;
  choosePhoto: (source: PhotoSource) => void;
  chooseDefault: (path: string) => void;
  openSettings: () => void;
  closeSettings: () => void;
}

/** Edit profile's avatar actions for `profile` (the saved row). One change at a time; a second tap is ignored. */
export function useAvatarChange(profile: Profile): AvatarChange {
  const { signedIn } = useSession();
  const qc = useQueryClient();
  const [step, setStep] = useState<PhotoStep | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsFor, setSettingsFor] = useState<PhotoSource | null>(null);
  const running = useRef(false);
  const userId = profile.id;
  const current = avatarObject(profile.avatar_url);

  async function run(source: PhotoSource | null, work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setError(null);
    try {
      await work();
    } catch (err) {
      const kind = photoErrorKind(err);
      if (kind === 'permission' && source) setSettingsFor(source);
      else setError(photoErrorText(kind));
    } finally {
      running.current = false;
      setStep(null);
      setApplying(null);
    }
  }

  const choosePhoto = (source: PhotoSource) => {
    if (!signedIn) return;
    void run(source, async () => {
      const picked = await pickSquare(source);
      if (picked === 'settings') {
        setSettingsFor(source);
        return;
      }
      // Android may refuse without showing a prompt (asked twice before), so a refusal always says something.
      if (picked === 'declined') setError(CAMERA_DECLINED_TEXT);
      if (picked === 'cancelled' || picked === 'declined') return;
      setStep('preparing');
      const bytes = await squareJpeg(picked.uri);
      if (!photoBytesOk(bytes.byteLength)) throw new PhotoTooLargeError();
      setStep('uploading');
      const path = photoPath(userId, Date.now());
      const upload = await bucket().upload(path, bytes, {
        contentType: 'image/jpeg',
        cacheControl: String(PHOTO_CACHE_SECONDS),
        upsert: false,
      });
      if (upload.error) throw upload.error;
      setStep('saving');
      let saved: Profile;
      try {
        saved = await writeAvatarUrl(userId, path);
      } catch (err) {
        // No row points at it: don't leave it in the bucket.
        void removeQuietly([path]);
        throw err;
      }
      refreshAvatarEverywhere(qc, saved);
      successHaptic();
      AccessibilityInfo.announceForAccessibility('Profile photo updated');
      void removeOldPhotos(userId, path, current);
    });
  };

  const chooseDefault = (path: string) => {
    if (!isDefaultAvatar(path) || path === profile.avatar_url) return;
    void run(null, async () => {
      setApplying(path);
      const saved = await writeAvatarUrl(userId, path);
      refreshAvatarEverywhere(qc, saved);
      AccessibilityInfo.announceForAccessibility('Avatar updated');
      void removeOldPhotos(userId, path, current);
    });
  };

  return {
    canUpload: signedIn,
    hasPhoto: isOwnPhoto(current, userId),
    step,
    applying,
    busy: step !== null || applying !== null,
    error,
    settingsFor,
    choosePhoto,
    chooseDefault,
    openSettings: () => {
      setSettingsFor(null);
      void Linking.openSettings().catch(() => {});
    },
    closeSettings: () => setSettingsFor(null),
  };
}
