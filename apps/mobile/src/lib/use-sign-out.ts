import { useState } from 'react';
import { describeAuthError } from '@/lib/auth/errors';
import { signOut } from '@/lib/auth/providers';

/**
 * Sign out with a busy flag and an error line, shared by the drawer, Profile and Settings. Success needs nothing
 * else: the session gate in `(app)/_layout.tsx` swaps to the welcome screen. A second tap while one is running is
 * ignored.
 */
export function useSignOut() {
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (signingOut) return;
    setSigningOut(true);
    setError(null);
    try {
      await signOut();
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setSigningOut(false);
    }
  }

  return { signingOut, error, signOut: () => void run() };
}
