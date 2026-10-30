import type { Rally } from '@rally/sdk';

/** The parts of the `rally` facade game-kit uses. Tests pass small fakes; games pass `rally` from `@rally/sdk`. */
export type RallyLike = Pick<Rally, 'isHosted' | 'on' | 'exit' | 'save' | 'leaderboard' | 'achievement'>;

/** Bridge error code of a rejected SDK call (`RallyError.code`), or undefined for other errors. */
export function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return undefined;
}

/**
 * Codes meaning "this host cannot do that" rather than "this call failed": the shell may not implement a method
 * yet (NOT_SUPPORTED), there is no shell at all (NO_HOST), or an older shell does not know the method.
 */
export function isUnsupported(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'NOT_SUPPORTED' || code === 'NO_HOST' || code === 'UNKNOWN_METHOD';
}
