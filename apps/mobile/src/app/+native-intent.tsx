import { isBrowserAuthInProgress } from '@/lib/auth/providers';
import { isAuthRedirectPath } from '@/lib/auth/redirect';

/**
 * On Android the OAuth redirect (`rally://auth/callback?code=…`) reaches both `openAuthSessionAsync` and the router.
 * While an in-app browser flow is running, the flow itself exchanges the code, so the router ignores the link.
 * Email links (confirmation, password reset) arrive with no flow running and route to `auth/*` normally.
 */
export function redirectSystemPath({ path, initial }: { path: string | null; initial: boolean }): string | null {
  if (path && !initial && isAuthRedirectPath(path) && isBrowserAuthInProgress()) return null;
  return path;
}
