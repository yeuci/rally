import { randomInt } from 'node:crypto';

/** No 0/O, 1/I/L: codes are read aloud and typed on phones. 31 symbols → 31^6 ≈ 887 M codes. */
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_LENGTH = 6;

const CODE_RE = new RegExp(`^[${JOIN_CODE_ALPHABET}]{${JOIN_CODE_LENGTH}}$`);

/** A random private-room code. `rand(n)` must return an integer in [0, n); defaults to `crypto.randomInt`. */
export function generateJoinCode(rand: (n: number) => number = randomInt): string {
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) code += JOIN_CODE_ALPHABET[rand(JOIN_CODE_ALPHABET.length)];
  return code;
}

/**
 * Canonical form of a code typed by a person: trimmed, upper-cased, spaces and dashes removed. Returns null when the
 * result is not a valid code (wrong length, or a character outside the alphabet such as O or 1).
 */
export function normalizeJoinCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.trim().toUpperCase().replace(/[\s-]/g, '');
  return CODE_RE.test(code) ? code : null;
}

/** Draw codes until `taken(code)` is false (bounded; collisions are astronomically rare at Rally's scale). */
export async function uniqueJoinCode(
  taken: (code: string) => boolean | Promise<boolean>,
  rand?: (n: number) => number,
  attempts = 20,
): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const code = generateJoinCode(rand);
    if (!(await taken(code))) return code;
  }
  throw new Error(`could not find a free join code in ${attempts} attempts`);
}
