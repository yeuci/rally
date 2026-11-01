import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveAvatarPath } from '../src/lib/avatar';
import {
  ANONYMOUS_PHOTO_HINT,
  AVATARS_BUCKET,
  CAMERA_DECLINED_TEXT,
  DEFAULT_AVATARS,
  PHOTO_MAX_BYTES,
  PHOTO_STEPS,
  PhotoTooLargeError,
  avatarObjectPath,
  avatarUrlOk,
  cameraPermissionStep,
  centerSquare,
  defaultAvatarGrid,
  isDefaultAvatar,
  isOwnPhoto,
  photoBytesOk,
  photoErrorKind,
  photoErrorText,
  photoPath,
  photosToDelete,
} from '../src/lib/profile-photo-model';

const UID = 'b5f6c1d2-0000-4000-8000-000000000000';
const OTHER = '0c9e7a11-1111-4111-8111-111111111111';
const BASE = 'https://abc.supabase.co/storage/v1/object/public/avatars';
const migration = (name: string) =>
  readFileSync(join(__dirname, '..', '..', '..', 'packages', 'db', 'supabase', 'migrations', name), 'utf8');

test('the defaults match default_avatars, in sort order', () => {
  const sql = migration('20261030000000_default_avatars.sql');
  const rows = [...sql.matchAll(/\('(defaults\/[^']+)',\s*(\d+)\)/g)]
    .sort((a, b) => Number(a[2]) - Number(b[2]))
    .map((m) => m[1]);
  assert.deepEqual([...DEFAULT_AVATARS], rows);
  assert.equal(DEFAULT_AVATARS.length, 10);
  assert.ok(isDefaultAvatar('defaults/avatar-03.webp'));
  assert.ok(!isDefaultAvatar(`${UID}/1.jpg`));
  assert.ok(!isDefaultAvatar('defaults/avatar-99.webp'));
  assert.ok(!isDefaultAvatar(null));
});

test('the bucket is the one the avatars migration creates, with its 2 MB limit', () => {
  const sql = migration('20261029000200_m1_avatars.sql');
  assert.match(sql, new RegExp(`values \\('${AVATARS_BUCKET}', '${AVATARS_BUCKET}', true, ${PHOTO_MAX_BYTES},`));
  assert.match(sql, /'image\/jpeg'/);
});

test('photoPath: <user id>/<ms>.jpg, a valid avatar_url that resolves into the bucket', () => {
  const path = photoPath(UID, 1_793_534_400_123.7);
  assert.equal(path, `${UID}/1793534400123.jpg`);
  assert.ok(avatarUrlOk(path));
  assert.ok(isOwnPhoto(path, UID));
  assert.equal(resolveAvatarPath(path, `${BASE}/`), `${BASE}/${path}`);
  assert.notEqual(photoPath(UID, 1), photoPath(UID, 2));
});

test('avatarUrlOk agrees with the hardening check (the values of packages/db/test/hardening.test.ts)', () => {
  const valid = [
    null,
    'defaults/avatar-01.webp',
    'b5f6c1d2-0000-4000-8000-000000000000/avatar.v2.webp',
    'https://lh3.googleusercontent.com/a/ACg8ocK=s96-c',
    'https://abc.supabase.co/storage/v1/object/public/avatars/u/a.webp?t=1',
    `https://x.io/${'a'.repeat(512 - 'https://x.io/'.length)}`,
  ];
  const invalid = [
    '',
    'javascript:alert(1)',
    'http://tracker.example/pixel.png',
    'data:image/png;base64,AAAA',
    'file:///etc/passwd',
    '//evil.example/a.png',
    '/defaults/avatar-01.webp',
    '../secret.png',
    'defaults/../x.webp',
    'a//b.webp',
    'defaults/avatar 01.webp',
    'https://evil.example/a b.png',
    'https://',
    'HTTPS://x.io/a.png',
    `https://x.io/${'a'.repeat(512 - 'https://x.io/'.length + 1)}`,
  ];
  for (const v of valid) assert.equal(avatarUrlOk(v), true, JSON.stringify(v));
  for (const v of invalid) assert.equal(avatarUrlOk(v), false, JSON.stringify(v));
});

test('avatarObjectPath: bucket-relative values and this bucket’s public URLs; nothing else', () => {
  assert.equal(avatarObjectPath(`${UID}/1.jpg`, BASE), `${UID}/1.jpg`);
  assert.equal(avatarObjectPath('/defaults/avatar-01.webp', BASE), 'defaults/avatar-01.webp');
  assert.equal(avatarObjectPath(`${BASE}/${UID}/1.jpg?t=2`, `${BASE}/`), `${UID}/1.jpg`);
  assert.equal(avatarObjectPath(`${BASE}/${UID}/1.jpg#x`, BASE), `${UID}/1.jpg`);
  assert.equal(avatarObjectPath('https://lh3.googleusercontent.com/a/x', BASE), null);
  assert.equal(avatarObjectPath('https://abc.supabase.co/storage/v1/object/public/games/x.png', BASE), null);
  assert.equal(avatarObjectPath('//evil.example/a.png', BASE), null);
  assert.equal(avatarObjectPath('data:image/png;base64,AAAA', BASE), null);
  assert.equal(avatarObjectPath('file:///tmp/a.jpg', BASE), null);
  assert.equal(avatarObjectPath(`${BASE}/`, BASE), null);
  assert.equal(avatarObjectPath('', BASE), null);
  assert.equal(avatarObjectPath(null, BASE), null);
  assert.equal(avatarObjectPath(undefined, BASE), null);
});

test('isOwnPhoto: exactly <user id>/<file>, never a default or someone else’s', () => {
  assert.ok(isOwnPhoto(`${UID}/1793534400123.jpg`, UID));
  assert.ok(isOwnPhoto(`${UID}/avatar.v2.webp`, UID));
  assert.ok(!isOwnPhoto(`${OTHER}/1.jpg`, UID));
  assert.ok(!isOwnPhoto('defaults/avatar-01.webp', UID));
  assert.ok(!isOwnPhoto(`${UID}x/1.jpg`, UID));
  assert.ok(!isOwnPhoto(`${UID}/sub/1.jpg`, UID));
  assert.ok(!isOwnPhoto(`${UID}/../${OTHER}/1.jpg`, UID));
  assert.ok(!isOwnPhoto(`${UID}/a..jpg`, UID));
  assert.ok(!isOwnPhoto(`${UID}/.emptyFolderPlaceholder`, UID));
  assert.ok(!isOwnPhoto(`${UID}/`, UID));
  assert.ok(!isOwnPhoto(UID, UID));
  assert.ok(!isOwnPhoto(`/${UID}/1.jpg`, UID));
  assert.ok(!isOwnPhoto(null, UID));
  assert.ok(!isOwnPhoto('defaults/1.jpg', 'defaults/..'));
  assert.ok(!isOwnPhoto('/1.jpg', ''));
});

test('photosToDelete: every other own file, the previous photo when unlisted, never the current one', () => {
  const current = `${UID}/3.jpg`;
  assert.deepEqual(
    photosToDelete({ userId: UID, current, previous: `${UID}/2.jpg`, listed: ['1.jpg', '2.jpg', '3.jpg'] }).sort(),
    [`${UID}/1.jpg`, `${UID}/2.jpg`],
  );
  // The listing failed: the previous photo alone.
  assert.deepEqual(photosToDelete({ userId: UID, current, previous: `${UID}/2.jpg`, listed: null }), [`${UID}/2.jpg`]);
  // The listing missed it (eventual consistency): still deleted, once.
  assert.deepEqual(photosToDelete({ userId: UID, current, previous: `${UID}/2.jpg`, listed: ['3.jpg'] }), [
    `${UID}/2.jpg`,
  ]);
  // Back to a default: every upload goes.
  assert.deepEqual(
    photosToDelete({ userId: UID, current: 'defaults/avatar-02.webp', previous: `${UID}/3.jpg`, listed: ['3.jpg'] }),
    [`${UID}/3.jpg`],
  );
  // Default to default, an OAuth URL, nothing uploaded: nothing to do.
  assert.deepEqual(
    photosToDelete({
      userId: UID,
      current: 'defaults/avatar-02.webp',
      previous: 'defaults/avatar-01.webp',
      listed: [],
    }),
    [],
  );
  assert.deepEqual(
    photosToDelete({ userId: UID, current, previous: 'https://lh3.googleusercontent.com/a/x', listed: null }),
    [],
  );
});

test('photosToDelete never reaches outside the user’s folder', () => {
  const doomed = photosToDelete({
    userId: UID,
    current: `${UID}/9.jpg`,
    previous: `${OTHER}/1.jpg`,
    listed: ['.emptyFolderPlaceholder', '../x.jpg', 'sub/1.jpg', '', '8.jpg', '9.jpg'],
  });
  assert.deepEqual(doomed, [`${UID}/8.jpg`]);
  assert.deepEqual(
    photosToDelete({ userId: UID, current: null, previous: 'defaults/avatar-01.webp', listed: null }),
    [],
  );
});

test('centerSquare crops the middle of a non-square image; square or unknown sizes are left alone', () => {
  assert.deepEqual(centerSquare(4032, 3024), { originX: 504, originY: 0, width: 3024, height: 3024 });
  assert.deepEqual(centerSquare(1080, 1921), { originX: 0, originY: 420, width: 1080, height: 1080 });
  assert.deepEqual(centerSquare(1001, 1000), { originX: 0, originY: 0, width: 1000, height: 1000 });
  assert.equal(centerSquare(2048, 2048), null);
  assert.equal(centerSquare(0, 512), null);
  assert.equal(centerSquare(512, Number.NaN), null);
});

test('cameraPermissionStep: open, ask, or Settings after a standing refusal', () => {
  assert.equal(cameraPermissionStep({ granted: true, canAskAgain: true }), 'granted');
  assert.equal(cameraPermissionStep({ granted: true, canAskAgain: false }), 'granted');
  assert.equal(cameraPermissionStep({ granted: false, canAskAgain: true }), 'ask');
  assert.equal(cameraPermissionStep({ granted: false, canAskAgain: false }), 'settings');
});

test('photoBytesOk: within the bucket limit and not empty', () => {
  assert.ok(photoBytesOk(120_000));
  assert.ok(photoBytesOk(PHOTO_MAX_BYTES));
  assert.ok(!photoBytesOk(PHOTO_MAX_BYTES + 1));
  assert.ok(!photoBytesOk(0));
});

test('photoErrorKind sorts picker, Storage and network failures', () => {
  assert.equal(photoErrorKind(new Error('Missing camera or camera roll permission')), 'permission');
  assert.equal(
    photoErrorKind({ code: 'ERR_USER_REJECTED_PERMISSIONS', message: 'User rejected permissions' }),
    'permission',
  );
  assert.equal(photoErrorKind(new Error("Failed to resolve activity to handle the intent of type 'image'")), 'camera');
  assert.equal(photoErrorKind(new PhotoTooLargeError()), 'too-large');
  assert.equal(
    photoErrorKind({
      statusCode: '413',
      error: 'Payload too large',
      message: 'The object exceeded the maximum allowed size',
    }),
    'too-large',
  );
  assert.equal(photoErrorKind(new TypeError('Network request failed')), 'network');
  assert.equal(photoErrorKind({ message: 'TypeError: Network request failed', details: '' }), 'network');
  assert.equal(
    photoErrorKind({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }),
    'forbidden',
  );
  assert.equal(photoErrorKind(new Error('The photo could not be read')), 'other');
  assert.equal(photoErrorKind(null), 'other');
  assert.equal(photoErrorKind('boom'), 'other');
});

test('photoErrorText: one short line per kind', () => {
  assert.equal(photoErrorText('forbidden'), ANONYMOUS_PHOTO_HINT);
  assert.match(photoErrorText('network'), /connection/);
  assert.match(photoErrorText('too-large'), /too big/);
  assert.match(CAMERA_DECLINED_TEXT, /Take photo/);
  for (const kind of ['permission', 'camera', 'too-large', 'network', 'forbidden', 'other'] as const) {
    assert.ok(photoErrorText(kind).length > 0 && photoErrorText(kind).length <= 80, kind);
  }
});

test('PHOTO_STEPS move forward', () => {
  const p = [PHOTO_STEPS.preparing, PHOTO_STEPS.uploading, PHOTO_STEPS.saving].map((s) => s.progress);
  assert.deepEqual(
    p,
    [...p].sort((a, b) => a - b),
  );
  assert.ok(p.every((v) => v > 0 && v < 1));
});

test('defaultAvatarGrid: two rows of five on phones, one row of ten in a tablet column, never wider than the column', () => {
  for (const width of [288, 343, 361, 398, 500, 600]) {
    const { columns, size } = defaultAvatarGrid(width, 12);
    assert.ok(columns * size + (columns - 1) * 12 <= width, `width ${width}`);
    assert.ok(size <= 64, `width ${width}`);
  }
  assert.deepEqual(defaultAvatarGrid(361, 12), { columns: 5, size: 62 });
  assert.deepEqual(defaultAvatarGrid(288, 12), { columns: 5, size: 48 });
  assert.deepEqual(defaultAvatarGrid(500, 12), { columns: 5, size: 64 });
  assert.deepEqual(defaultAvatarGrid(600, 12), { columns: 10, size: 49 });
});
