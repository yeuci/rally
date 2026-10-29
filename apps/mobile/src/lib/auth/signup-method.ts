export type SignupMethod = 'email' | 'apple' | 'google';

export function parseSignupMethod(v: string | string[] | undefined): SignupMethod {
  const s = Array.isArray(v) ? v[0] : v;
  return s === 'apple' || s === 'google' ? s : 'email';
}
