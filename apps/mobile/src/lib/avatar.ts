/**
 * `avatar_url` is either an absolute URL (OAuth providers, future uploads) or a path inside the public
 * `avatars` bucket (the bundled defaults, e.g. `defaults/avatar-03.webp`). Pure so it can be unit-tested;
 * `resolveAvatarUrl` in profile.ts binds it to the Supabase client.
 */
export function resolveAvatarPath(value: string | null | undefined, publicBaseUrl: string): string | null {
  if (!value) return null;
  if (/^(https?:)?\/\//i.test(value) || value.startsWith('data:') || value.startsWith('file:')) return value;
  return `${publicBaseUrl.replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`;
}
