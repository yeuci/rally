import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameGate, LOWFX_FPS, applyLowFx, throttleRender } from '../src/lowfx.ts';

/** requestAnimationFrame timestamps at `hz` for `seconds`, starting at `start` ms, with ±`jitter` ms. */
function rafTimes(hz: number, seconds: number, start = 0, jitter = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < hz * seconds; i++) out.push(start + (i * 1000) / hz + (i % 2 ? jitter : -jitter));
  return out;
}

test('a 60 Hz display draws every 4th frame at 15 fps (jitter included), the first one at once', () => {
  for (const jitter of [0, 0.4]) {
    const gate = new FrameGate(15);
    const drawn = rafTimes(60, 2, 1000, jitter).filter((t) => gate.due(t));
    assert.equal(drawn.length, 30, `jitter ${jitter}`);
    assert.equal(drawn[0], 1000 - jitter, 'first frame drawn');
    for (let i = 1; i < drawn.length; i++) assert.ok(Math.abs(drawn[i]! - drawn[i - 1]! - 1000 / 15) < 2, 'steady');
  }
});

test('a 120 Hz display still draws 15 fps; a display slower than the cap draws every frame', () => {
  const fast = new FrameGate(15);
  assert.equal(rafTimes(120, 1).filter((t) => fast.due(t)).length, 15);
  const slow = new FrameGate(15);
  assert.equal(rafTimes(10, 1).filter((t) => slow.due(t)).length, 10);
});

test('after a stall the cadence restarts: one frame drawn, no catch-up burst', () => {
  const gate = new FrameGate(15);
  assert.equal(gate.due(0), true);
  assert.equal(gate.due(2000), true, 'first frame after a 2 s stall');
  assert.equal(gate.due(2016.7), false);
  assert.equal(gate.due(2033.3), false);
  assert.equal(gate.due(2050), false);
  assert.equal(gate.due(2066.7), true, 'next one a full interval later');
});

test('rejects a non-positive rate', () => {
  assert.throws(() => new FrameGate(0), /fps must be > 0/);
  assert.throws(() => new FrameGate(Number.NaN), /fps must be > 0/);
});

function fakeApp() {
  const handlers = new Map<string, () => void>();
  const app = {
    autoRender: true,
    renderNextFrame: false,
    scene: { clusteredLightingEnabled: true },
    on(name: string, fn: () => void) {
      handlers.set(name, fn);
      return this;
    },
  };
  /** One second of 60 Hz engine ticks (AppBase.tick: framerender, render if asked, clear the flag); renders drawn. */
  const runSecond = (clock: { now: number }) => {
    const frameRender = handlers.get('framerender');
    assert.ok(frameRender, 'hooked before the engine decides to render');
    let renders = 0;
    for (const t of rafTimes(60, 1)) {
      clock.now = t;
      frameRender();
      if (app.autoRender || app.renderNextFrame) renders++;
      app.renderNextFrame = false;
    }
    return renders;
  };
  return { app, runSecond };
}

test('throttleRender turns autoRender off and requests a render only on due frames', () => {
  const { app, runSecond } = fakeApp();
  const clock = { now: 0 };
  throttleRender(app as never, 20, () => clock.now);
  assert.equal(app.autoRender, false);
  assert.equal(runSecond(clock), 20);
});

test('applyLowFx: clustered lighting off, rendering capped at LOWFX_FPS', () => {
  const { app, runSecond } = fakeApp();
  const clock = { now: 0 };
  applyLowFx(app as never, () => clock.now);
  assert.equal(app.scene.clusteredLightingEnabled, false);
  assert.equal(LOWFX_FPS, 15);
  assert.equal(runSecond(clock), LOWFX_FPS);
});
