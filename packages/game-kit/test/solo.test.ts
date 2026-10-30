import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLifecycle } from '../src/lifecycle.ts';
import { createSolo } from '../src/solo.ts';
import { fakeRally, tick } from './helpers.ts';
import { FrameMetrics } from '../src/metrics.ts';

test('solo: host results pass through; unlocked keys are not re-sent', async () => {
  const h = fakeRally();
  const solo = createSolo(h.rally);
  assert.deepEqual(await solo.submit('height', 5), { accepted: true, best: 5, source: 'host' });
  assert.equal((await solo.top('height')).entries[0]!.username, 'ada');
  assert.deepEqual(h.calls.find((c) => c.method === 'leaderboard.top')!.args, ['height', { scope: 'global', limit: 10 }]);
  assert.equal((await solo.unlock('first_drop')).alreadyHad, false);
  assert.equal((await solo.unlock('first_drop')).alreadyHad, true);
  assert.equal(h.count('achievement.unlock'), 1);
});

test('solo: NOT_SUPPORTED falls back to a local board once and never retries', async () => {
  const h = fakeRally({ unsupported: ['leaderboard.submit', 'leaderboard.top', 'achievement.unlock'] });
  const solo = createSolo(h.rally, { user: () => ({ id: 'me', username: 'dev' }) });
  assert.deepEqual(await solo.submit('height', 5), { accepted: true, best: 5, source: 'local' });
  assert.deepEqual(await solo.submit('height', 3), { accepted: false, best: 5, source: 'local' });
  const top = await solo.top('height');
  assert.deepEqual(top, { entries: [{ rank: 1, userId: 'me', username: 'dev', score: 5 }], source: 'local' });
  assert.equal(solo.findMe(top.entries)?.score, 5);
  assert.deepEqual(await solo.unlock('x'), { unlocked: true, alreadyHad: false, source: 'local' });
  assert.equal(h.count('leaderboard.submit'), 1);
  assert.equal(h.count('leaderboard.top'), 1);
});

test('solo: other errors are reported, not thrown; asc boards keep the lowest', async () => {
  const h = fakeRally();
  const solo = createSolo(h.rally, { sort: { time: 'asc' } });
  h.failNext.push({ method: 'leaderboard.submit', code: 'RATE_LIMITED' });
  assert.deepEqual(await solo.submit('time', 30), { accepted: true, best: 30, source: 'local', error: 'RATE_LIMITED' });
  const off = createSolo(fakeRally({ hosted: false }).rally, { sort: { time: 'asc' } });
  await off.submit('time', 30);
  assert.equal((await off.submit('time', 20)).best, 20);
  assert.equal((await off.submit('time', 25)).best, 20);
});

test('lifecycle: pause/resume drive timeScale; reasons stack; exitRequested awaits the callback then exits', async () => {
  const h = fakeRally();
  const app = { timeScale: 1 };
  const seen: string[] = [];
  const lc = createLifecycle(h.rally, app, {
    onPause: () => seen.push('pause'),
    onResume: () => seen.push('resume'),
    onLowMemory: () => seen.push('lowMemory'),
    onExitRequested: async () => {
      await tick(5);
      seen.push('saved');
    },
  });
  h.emit('pause');
  assert.equal(app.timeScale, 0);
  assert.equal(lc.isPaused, true);
  lc.pause('menu');
  h.emit('resume');
  assert.equal(lc.isPaused, true, 'menu pause still held');
  lc.resume('menu');
  assert.equal(app.timeScale, 1);
  h.emit('lowMemory');
  h.emit('exitRequested');
  h.emit('exitRequested');
  await lc.exit();
  assert.deepEqual(seen, ['pause', 'resume', 'lowMemory', 'saved']);
  assert.deepEqual(
    h.calls.filter((c) => c.method === 'exit').map((c) => c.args),
    [['host']],
  );
  lc.destroy();
  h.emit('pause');
  assert.equal(app.timeScale, 1, 'no listeners after destroy');
});

test('frame metrics: fps and percentiles over the window', () => {
  const m = new FrameMetrics(1000, 0);
  let t = 0;
  for (let i = 0; i < 120; i++) m.tick((t += i % 10 === 9 ? 33.3 : 16.7));
  const s = m.snapshot();
  assert.ok(s.fps >= 50 && s.fps <= 56, `fps ${s.fps}`);
  assert.equal(s.worstMs, 33.3);
  assert.ok(s.frameMs > 16.7 && s.frameMs < 20);
  m.reset(t);
  assert.equal(m.snapshot().fps, 0);
});
