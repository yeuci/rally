/**
 * Photo avatars, the pure half (Edit profile → Choose photo / Take photo, and the default avatars next to them): where
 * an upload goes, which old files to delete, what `profiles.avatar_url` accepts, the bundled defaults, and the copy for
 * each failure. No React Native imports, so test/profile-photo.test.ts covers it under plain Node; lib/profile-photo.ts
 * picks, resizes, uploads and cleans up.
 *
 * Layout: every upload is `avatars/<user id>/<timestamp>.jpg` (the bucket's owner-folder policies,
 * 20261029000200_m1_avatars.sql) and `avatar_url` stores the bucket-relative `<user id>/<timestamp>.jpg`, resolved like
 * the defaults (lib/avatar.ts). Nothing of a user's ever lives outside `<user id>/`: account deletion empties that
 * folder, and a report of an inappropriate photo points at the one file `avatar_url` names.
 */

export const AVATARS_BUCKET = 'avatars';

/** Edge of the uploaded square, in pixels. */
export const PHOTO_SIZE = 512;
/** expo-image-manipulator's JPEG `compress` (0…1). Even uncompressed, 512×512 RGB is 768 KB; at 0.8 it is far less. */
export const PHOTO_QUALITY = 0.8;
/** The bucket's `file_size_limit` (2 MB). Checked before uploading, so a refusal reads as "too big", not as an error. */
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
/** Longest edge decoded from the picked file: a 48 MP camera photo is downsampled while decoding, never held whole. */
export const PHOTO_DECODE_MAX = 2048;
/** `Cache-Control` max-age of an upload, in seconds. A path is never reused (a new photo gets a new timestamp). */
export const PHOTO_CACHE_SECONDS = 31_536_000;

/**
 * The bundled pictures, in `default_avatars.sort` order (20261030000000_default_avatars.sql). Clients cannot read that
 * table, so the list is repeated here; test/profile-photo.test.ts checks it against the migration.
 */
export const DEFAULT_AVATARS: readonly string[] = [
  'defaults/avatar-01.webp',
  'defaults/avatar-02.webp',
  'defaults/avatar-03.webp',
  'defaults/avatar-04.webp',
  'defaults/avatar-05.webp',
  'defaults/avatar-06.webp',
  'defaults/avatar-07.webp',
  'defaults/avatar-08.webp',
  'defaults/avatar-09.webp',
  'defaults/avatar-10.webp',
];

export function isDefaultAvatar(value: string | null | undefined): boolean {
  return !!value && DEFAULT_AVATARS.includes(value);
}

/** Object name of a new upload inside the bucket, which is also what `avatar_url` stores: `<user id>/<ms>.jpg`. */
export function photoPath(userId: string, now: number): string {
  return `${userId}/${Math.floor(now)}.jpg`;
}

const BUCKET_PATH = /^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?([/?#][!-~]*)?$/;

/**
 * `private.avatar_url_ok` (20261030000400_hardening.sql), the check on `profiles.avatar_url`: null, a bucket-relative
 * path (no leading slash, no `..`, no `//`) or an https URL, at most 512 characters.
 */
export function avatarUrlOk(value: string | null): boolean {
  if (value === null) return true;
  if (value.length > 512) return false;
  return (BUCKET_PATH.test(value) && !value.includes('..') && !value.includes('//')) || HTTPS_URL.test(value);
}

/**
 * The object an `avatar_url` names inside the avatars bucket: the value itself when it is bucket-relative, the part
 * after the bucket's public URL when it is that URL (query dropped); null for anything else (another host, data:, file:).
 */
export function avatarObjectPath(value: string | null | undefined, publicBaseUrl: string): string | null {
  if (!value) return null;
  const base = `${publicBaseUrl.replace(/\/+$/, '')}/`;
  if (value.startsWith(base)) return value.slice(base.length).split(/[?#]/)[0] || null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return null;
  return value.replace(/^\/+/, '') || null;
}

/** Whether `path` is one of the user's own uploads: exactly `<user id>/<file>`. Never a default, never another folder. */
export function isOwnPhoto(path: string | null | undefined, userId: string): path is string {
  if (!path || !/^[A-Za-z0-9-]+$/.test(userId)) return false;
  const prefix = `${userId}/`;
  if (!path.startsWith(prefix)) return false;
  const file = path.slice(prefix.length);
  return /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(file) && !file.includes('..');
}

/**
 * Files to delete after `avatar_url` became `current`: every file listed in the user's folder except the current one,
 * plus the previous avatar when it was an own upload the listing missed (or the listing failed: `listed` null). Only
 * ever `<user id>/<file>` paths, so a default avatar, another user's file or a dot-file placeholder is never touched.
 */
export function photosToDelete({
  userId,
  current,
  previous,
  listed,
}: {
  userId: string;
  current: string | null;
  previous: string | null;
  /** File names in `<user id>/` (folders left out), or null when listing failed. */
  listed: readonly string[] | null;
}): string[] {
  const out = new Set<string>();
  for (const name of listed ?? []) {
    const path = `${userId}/${name}`;
    if (isOwnPhoto(path, userId)) out.add(path);
  }
  if (isOwnPhoto(previous, userId)) out.add(previous);
  if (current) out.delete(current);
  return [...out];
}

/** The centred square of a `width`×`height` image as a crop rectangle; null when it is already square (or unknown). */
export function centerSquare(
  width: number,
  height: number,
): { originX: number; originY: number; width: number; height: number } | null {
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (!(w > 0) || !(h > 0) || w === h) return null;
  const side = Math.min(w, h);
  return { originX: Math.floor((w - side) / 2), originY: Math.floor((h - side) / 2), width: side, height: side };
}

/**
 * What "Take photo" does with the camera permission: open the camera, show the system prompt, or (asked before and
 * refused for good) offer Settings. Choose photo needs no permission: the system photo pickers run outside the app.
 */
export function cameraPermissionStep(p: { granted: boolean; canAskAgain: boolean }): 'granted' | 'ask' | 'settings' {
  if (p.granted) return 'granted';
  return p.canAskAgain ? 'ask' : 'settings';
}

/** Whether a finished JPEG fits the bucket (and is not empty). */
export function photoBytesOk(byteLength: number): boolean {
  return byteLength > 0 && byteLength <= PHOTO_MAX_BYTES;
}

/** The stages of an upload, as shown under the avatar. Storage reports no byte progress, so each stage is a step. */
export type PhotoStep = 'preparing' | 'uploading' | 'saving';

export const PHOTO_STEPS: Record<PhotoStep, { label: string; progress: number }> = {
  preparing: { label: 'Preparing photo…', progress: 0.25 },
  uploading: { label: 'Uploading…', progress: 0.6 },
  saving: { label: 'Saving…', progress: 0.9 },
};

/** Shown instead of the photo actions while the session is anonymous (Storage refuses its uploads). */
export const ANONYMOUS_PHOTO_HINT = 'Finish creating your account to use your own photo.';

/**
 * After the camera prompt was just refused. The next tap asks again (Android) or, refused for good, offers Settings
 * (iOS after one refusal, Android after two).
 */
export const CAMERA_DECLINED_TEXT = 'Camera access is off. Tap Take photo again to turn it on.';

/** Thrown when the finished JPEG would not fit the bucket. */
export class PhotoTooLargeError extends Error {
  constructor() {
    super('PHOTO_TOO_LARGE');
    this.name = 'PhotoTooLargeError';
  }
}

export type PhotoErrorKind = 'permission' | 'camera' | 'too-large' | 'network' | 'forbidden' | 'other';

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (!err || typeof err !== 'object') return '';
  const e = err as { message?: unknown; code?: unknown; statusCode?: unknown; status?: unknown; error?: unknown };
  return [e.message, e.code, e.error, e.statusCode, e.status]
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .join(' ');
}

/**
 * Sorts a failure from the picker (iOS "Missing camera or camera roll permission", Android "User rejected
 * permissions", no camera app), Storage (413 too large, 403 row-level security for an anonymous token) or the network.
 */
export function photoErrorKind(err: unknown): PhotoErrorKind {
  if (err instanceof PhotoTooLargeError) return 'too-large';
  const m = errorText(err);
  if (
    /missing camera|rejected permissions|permission denied for (camera|photos)|ERR_MISSING_CAMERA_PERMISSION/i.test(m)
  ) {
    return 'permission';
  }
  if (/resolve activity|camera (is )?not available|source type 1 not available|no camera/i.test(m)) return 'camera';
  if (/PHOTO_TOO_LARGE|exceeded the maximum allowed size|payload too large|\b413\b/i.test(m)) return 'too-large';
  if (/network request failed|failed to fetch|fetch failed|network error|timed? ?out/i.test(m)) return 'network';
  if (/row-level security|ANONYMOUS_FORBIDDEN|unauthorized|\b403\b/i.test(m)) return 'forbidden';
  return 'other';
}

/** One line under the photo actions. `permission` has no line: it opens the Settings dialog instead. */
export function photoErrorText(kind: PhotoErrorKind): string {
  switch (kind) {
    case 'permission':
      return 'Turn on access in Settings to use a photo.';
    case 'camera':
      return "Couldn't open the camera on this device.";
    case 'too-large':
      return 'That photo is too big. Try another one.';
    case 'network':
      return 'No connection. Check your network and try again.';
    case 'forbidden':
      return ANONYMOUS_PHOTO_HINT;
    case 'other':
      return "Couldn't change your avatar. Try again.";
  }
}

/** A default avatar tile on a single row needs at least this edge, in points; no tile grows past the max. */
const TILE_MIN_ONE_ROW = 44;
const TILE_MAX = 64;

/**
 * The default avatars' grid in a column `contentWidth` wide: all of them on one row when each still gets 44 pt (a
 * tablet's column), else two rows (phones); the tile edge fills the row, up to 64 pt.
 */
export function defaultAvatarGrid(
  contentWidth: number,
  gap: number,
  count = DEFAULT_AVATARS.length,
): { columns: number; size: number } {
  const fit = (columns: number) => Math.floor((contentWidth - gap * (columns - 1)) / columns);
  const columns = fit(count) >= TILE_MIN_ONE_ROW ? count : Math.ceil(count / 2);
  return { columns, size: Math.max(0, Math.min(TILE_MAX, fit(columns))) };
}
