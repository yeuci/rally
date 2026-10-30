import assert from 'node:assert/strict';
import {
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  generateJoinCode,
  normalizeJoinCode,
  uniqueJoinCode,
} from '../src/joinCode.js';

describe('join codes', () => {
  it('are 6 characters from an alphabet without look-alikes', () => {
    assert.equal(JOIN_CODE_LENGTH, 6);
    for (const c of '01OIL') assert.ok(!JOIN_CODE_ALPHABET.includes(c), c);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const code = generateJoinCode();
      assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
      seen.add(code);
    }
    assert.ok(seen.size > 1990, 'random enough not to repeat in a small sample');
  });

  it('maps rand(alphabet length) onto the alphabet', () => {
    let i = 0;
    const code = generateJoinCode((n) => {
      assert.equal(n, JOIN_CODE_ALPHABET.length);
      return (i++ * 7) % n;
    });
    assert.equal(code, 'AHRY7E'); // indices 0, 7, 14, 21, 28, 4
  });

  it('normalizes what people type', () => {
    assert.equal(normalizeJoinCode(' abc-def '), 'ABCDEF');
    assert.equal(normalizeJoinCode('k7m 2pq'), 'K7M2PQ');
    assert.equal(normalizeJoinCode('ABCDE'), null);
    assert.equal(normalizeJoinCode('ABCDE0'), null, '0 is not in the alphabet');
    assert.equal(normalizeJoinCode(123456), null);
  });

  it('retries until a free code is found, and gives up eventually', async () => {
    const taken = new Set(['AAAAAA', 'BBBBBB']);
    const seq = ['A', 'B', 'C'];
    let call = 0;
    const rand = (n: number) => JOIN_CODE_ALPHABET.indexOf(seq[Math.floor(call++ / JOIN_CODE_LENGTH)]!) % n;
    assert.equal(await uniqueJoinCode((c) => taken.has(c), rand), 'CCCCCC');
    await assert.rejects(
      uniqueJoinCode(() => true, undefined, 3),
      /3 attempts/,
    );
  });
});
