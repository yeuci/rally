import type { RoomLookupErrorCode } from '../game-host/matchmake';
import {
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  normalizeJoinCode,
  targetForCode,
  type CodeLookupResult,
  type JoinTarget,
} from './join-target';

/**
 * The join-code sheet's input rules (m3-phase2 §1): six cells limited to the code alphabet, upper-cased, shown as
 * `K7M-2PQ`. Pure, unit-tested; the lookup itself is `targetForCode` in join-target.ts.
 */

/** A code somewhere in pasted text ("Join me: k7m-2pq"): the first `XXX-XXX` / `XXX XXX` / `XXXXXX` token that is valid. */
export function extractJoinCode(text: string): string | null {
  for (const m of text.toUpperCase().matchAll(/(?:^|[^A-Z0-9])([A-Z0-9]{3}[\s-]?[A-Z0-9]{3})(?![A-Z0-9])/g)) {
    const code = normalizeJoinCode(m[1]);
    if (code) return code;
  }
  return null;
}

/**
 * What the code field keeps from typed or pasted text: upper-cased symbols of the alphabet only (dashes, spaces and
 * the look-alikes 0/O/1/I/L dropped), at most six. Longer pasted text keeps the code inside it when there is one.
 */
export function codeInputValue(text: string): string {
  if (text.length > JOIN_CODE_LENGTH + 1) {
    const found = extractJoinCode(text);
    if (found) return found;
  }
  let out = '';
  for (const ch of text.toUpperCase()) {
    if (out.length === JOIN_CODE_LENGTH) break;
    if (JOIN_CODE_ALPHABET.includes(ch)) out += ch;
  }
  return out;
}

/** `K7M2PQ` → `K7M-2PQ` (a partial code keeps the dash once the fourth symbol is typed). */
export function formatJoinCode(code: string): string {
  return code.length > 3 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

export interface CodeCell {
  char: string;
  /** Where the next symbol goes (the caret cell); none once all six are typed. */
  active: boolean;
}

/** The six cells for a (partial) value, for rendering. */
export function codeCells(value: string): CodeCell[] {
  return Array.from({ length: JOIN_CODE_LENGTH }, (_, i) => ({ char: value[i] ?? '', active: i === value.length }));
}

/** Screen-reader text for a code: "K 7 M, 2 P Q". */
export function spokenJoinCode(code: string): string {
  return [code.slice(0, 3), code.slice(3)]
    .filter(Boolean)
    .map((part) => part.split('').join(' '))
    .join(', ');
}

export type CodeProblem = 'bad-code' | 'other-game' | RoomLookupErrorCode;

/** The sheet's copy for a refused code or a failed lookup. */
export function codeProblemMessage(problem: CodeProblem): string {
  switch (problem) {
    case 'bad-code':
      return 'Codes are 6 letters and numbers, like K7M-2PQ.';
    case 'other-game':
      return 'That code is for another game.';
    case 'NO_ROOM':
      return 'No room with that code. It may have closed. Check the code and try again.';
    case 'RATE_LIMITED':
      return 'Too many tries. Wait a minute and try again.';
    case 'UNREACHABLE':
      return "Can't reach the game server. Check your connection and try again.";
    case 'FAILED':
      return "Couldn't check that code. Try again.";
  }
}

export type CodeCheck =
  { ok: true; target: Extract<JoinTarget, { join: 'room' }> } | { ok: false; problem: CodeProblem; message: string };

const LOOKUP_CODES: readonly string[] = ['NO_ROOM', 'RATE_LIMITED', 'UNREACHABLE', 'FAILED'];
const lookupCode = (err: unknown): RoomLookupErrorCode => {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  return (LOOKUP_CODES.includes(code) ? code : 'FAILED') as RoomLookupErrorCode;
};

/**
 * A typed code → the `join=room` target, or the problem to show. `targetForCode` with every failure (a malformed
 * code, another game's code, `RoomLookupError`s and anything else the lookup throws) turned into sheet copy.
 */
export async function checkJoinCode(
  input: string,
  expectedRoomName: string,
  lookup: (code: string) => Promise<CodeLookupResult>,
): Promise<CodeCheck> {
  let problem: CodeProblem;
  try {
    const res = await targetForCode(input, expectedRoomName, lookup);
    if (res.ok) return res;
    problem = res.reason;
  } catch (err) {
    problem = lookupCode(err);
  }
  return { ok: false, problem, message: codeProblemMessage(problem) };
}
