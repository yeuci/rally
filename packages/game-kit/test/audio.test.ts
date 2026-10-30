import assert from 'node:assert/strict';
import { test } from 'node:test';

/** Minimal AudioContext: `resume()` reaches `nextState` (WebKit may leave it 'suspended' / 'interrupted'). */
class FakeContext {
  static last: FakeContext | null = null;
  state: string = 'suspended';
  nextState = 'running';
  resumes = 0;
  onstatechange: (() => void) | null = null;
  destination = {};
  constructor() {
    FakeContext.last = this;
  }
  private set(state: string) {
    if (this.state === state) return;
    this.state = state;
    this.onstatechange?.();
  }
  async resume() {
    this.resumes++;
    this.set(this.nextState);
  }
  async suspend() {
    this.set('suspended');
  }
  async close() {
    this.set('closed');
  }
  interrupt() {
    this.set('interrupted');
  }
  createGain() {
    return { gain: { value: 1 }, connect: () => ({}) };
  }
  createBuffer() {
    return {};
  }
  createBufferSource() {
    return { buffer: null, connect: () => ({}), start: () => {} };
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('unlock listeners come back when the context stops running without our suspend()', async () => {
  (globalThis as { window?: unknown }).window = { AudioContext: FakeContext };
  try {
    const { createAudio } = await import('../src/audio.ts');
    const target = new EventTarget();
    const gesture = async () => {
      target.dispatchEvent(new Event('pointerdown'));
      await tick();
    };
    const audio = createAudio({ target });
    await gesture();
    const ctx = FakeContext.last!;
    assert.equal(audio.unlocked, true);
    await gesture();
    assert.equal(ctx.resumes, 1, 'listeners removed once running');

    // Host pause/resume: resume() is not a gesture, WebKit keeps the context suspended → listen again.
    audio.suspend();
    await tick();
    ctx.nextState = 'suspended';
    audio.resume();
    await tick();
    assert.equal(audio.unlocked, false);
    ctx.nextState = 'running';
    await gesture();
    assert.equal(audio.unlocked, true, 'the next gesture starts it');

    // A system interruption while running re-arms too.
    const before = ctx.resumes;
    ctx.interrupt();
    await gesture();
    assert.equal(ctx.resumes, before + 1);
    assert.equal(audio.unlocked, true);

    // Our own suspend() does not (a gesture while paused must not start sound).
    audio.suspend();
    await tick();
    const paused = ctx.resumes;
    await gesture();
    assert.equal(ctx.resumes, paused);
    audio.destroy();
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});
