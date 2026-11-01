import { chunk, DeleteAccountError, ownAvatarPaths, splitListing } from '@/lib/delete-account-model';
import { supabase } from '@/lib/supabase';

/** Storage `list()` page size, and how many paths one `remove()` call takes. */
const PAGE = 100;
/** Folders under `<uid>/` are followed this deep (uploads are flat today; this only guards against a nested one). */
const MAX_DEPTH = 2;

/**
 * Permanently deletes the signed-in account (App Store 5.1.1(v); docs/moderation.md), in this order:
 *
 * 1. The user's own files in the public `avatars` bucket (`<uid>/…`, uploaded photos), through the Storage API: SQL
 *    cannot remove Storage files, and a photo left behind would stay public. If this fails nothing else happens, so
 *    the account is never deleted with its photos still online.
 * 2. `delete_my_account()`, which deletes the auth user; the profile and every per-user row cascade, the username is
 *    free again, and rows other players need are kept without the user (20261102000100_moderation.sql).
 * 3. Sign out on this device only (the server's sessions went with the account). The session gate in
 *    `(app)/_layout.tsx` then shows the welcome screen.
 *
 * Every step is safe to repeat, so a retry after a failure (or a lost answer) finishes the job. Throws a
 * `DeleteAccountError` naming the step that failed.
 */
export async function deleteMyAccount(userId: string): Promise<void> {
  try {
    await removeOwnAvatarFiles(userId);
  } catch (err) {
    throw new DeleteAccountError('photos', err);
  }
  const { error } = await supabase.rpc('delete_my_account');
  if (error) throw new DeleteAccountError('account', error);
  // auth-js clears the stored session even when the server answers that the session or user is gone.
  const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
  if (signOutError) console.warn('[deleteMyAccount] sign-out', signOutError.message);
}

/** Lists `<userId>/` (and folders inside it) in the avatars bucket and removes every object found. */
async function removeOwnAvatarFiles(userId: string): Promise<void> {
  const bucket = supabase.storage.from('avatars');
  const found: string[] = [];
  const walk = async (prefix: string, depth: number): Promise<void> => {
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await bucket.list(prefix, { limit: PAGE, offset });
      if (error) throw error;
      const { files, folders } = splitListing(prefix, data);
      found.push(...files);
      if (depth < MAX_DEPTH) for (const folder of folders) await walk(folder, depth + 1);
      if (data.length < PAGE) return;
    }
  };
  await walk(userId, 0);
  for (const paths of chunk(ownAvatarPaths(userId, found), PAGE)) {
    const { error } = await bucket.remove(paths);
    if (error) throw error;
  }
}
