import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DELETED_DATA,
  DeleteAccountError,
  chunk,
  confirmsUsername,
  deleteAccountErrorMessage,
  ownAvatarPaths,
  splitListing,
} from '../src/lib/delete-account-model';

const UID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

test('confirmsUsername: the username, any case, an @ allowed, spaces around ignored', () => {
  assert.equal(confirmsUsername('sloth', 'sloth'), true);
  assert.equal(confirmsUsername('  Sloth ', 'sloth'), true);
  assert.equal(confirmsUsername('@sloth', 'Sloth'), true);
  assert.equal(confirmsUsername('slot', 'sloth'), false);
  assert.equal(confirmsUsername('sloth2', 'sloth'), false);
  assert.equal(confirmsUsername('s l o t h', 'sloth'), false);
  assert.equal(confirmsUsername('', 'sloth'), false);
  // An unknown username never confirms (the button stays off until the profile has loaded).
  assert.equal(confirmsUsername('', null), false);
  assert.equal(confirmsUsername('sloth', undefined), false);
  assert.equal(confirmsUsername('', ''), false);
});

test('the sheet says what goes', () => {
  assert.equal(DELETED_DATA.length, 4);
  assert.match(DELETED_DATA.join(' '), /username/);
  assert.match(DELETED_DATA.join(' '), /photos/);
  assert.match(DELETED_DATA.join(' '), /Friends/);
  assert.match(DELETED_DATA.join(' '), /Coins/);
});

test('splitListing: objects to remove, folders to list; no empty names', () => {
  assert.deepEqual(
    splitListing(UID, [
      { name: 'avatar-1.jpg', id: 'a' },
      { name: 'old', id: null },
      { name: '.emptyFolderPlaceholder', id: 'p' },
      { name: '', id: 'x' },
    ]),
    { files: [`${UID}/avatar-1.jpg`, `${UID}/.emptyFolderPlaceholder`], folders: [`${UID}/old`] },
  );
  assert.deepEqual(splitListing(`${UID}/old/`, [{ name: 'a.webp', id: 'b' }]), {
    files: [`${UID}/old/a.webp`],
    folders: [],
  });
  assert.deepEqual(splitListing(UID, []), { files: [], folders: [] });
});

test('ownAvatarPaths: only the user folder, never the defaults, another user or a climb out', () => {
  assert.deepEqual(
    ownAvatarPaths(UID, [
      `${UID}/a.jpg`,
      `${UID}/old/b.jpg`,
      `${UID}/a.jpg`,
      'defaults/avatar-01.webp',
      `${OTHER}/c.jpg`,
      `${UID}`,
      `${UID}/`,
      `${UID}/../${OTHER}/d.jpg`,
      `${UID}x/e.jpg`,
    ]),
    [`${UID}/a.jpg`, `${UID}/old/b.jpg`],
  );
  assert.deepEqual(ownAvatarPaths('', [`/a.jpg`]), []);
});

test('chunk: runs of at most n', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 100), []);
  assert.deepEqual(chunk([1, 2], 0), [[1], [2]]);
});

test('deleteAccountErrorMessage: says which step failed; offline and expired sessions in plain words', () => {
  const photos = new DeleteAccountError('photos', { message: 'The resource was not found' });
  assert.equal(photos.step, 'photos');
  assert.equal(photos.message, 'The resource was not found');
  assert.match(deleteAccountErrorMessage(photos), /photos, so your account wasn't deleted/);
  assert.equal(
    deleteAccountErrorMessage(new DeleteAccountError('account', { message: 'boom' })),
    "Couldn't delete your account. Try again.",
  );
  assert.match(
    deleteAccountErrorMessage(new DeleteAccountError('photos', new TypeError('Network request failed'))),
    /offline/,
  );
  assert.match(
    deleteAccountErrorMessage(new DeleteAccountError('account', { message: 'UNAUTHENTICATED' })),
    /Sign in again/,
  );
  // Anything untagged is treated as the account step.
  assert.equal(deleteAccountErrorMessage(new Error('x')), "Couldn't delete your account. Try again.");
  assert.equal(new DeleteAccountError('account', 'plain').message, 'plain');
});
