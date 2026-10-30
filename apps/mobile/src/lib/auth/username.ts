/** Same rule as the `profiles_username_format` check constraint and `username_available()`. */
export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export function usernameFormatError(username: string): string | null {
  if (username.length === 0) return null;
  if (username.length < 3) return 'At least 3 characters.';
  if (username.length > 20) return 'At most 20 characters.';
  if (!USERNAME_RE.test(username)) return 'Letters, numbers and underscores only.';
  return null;
}
