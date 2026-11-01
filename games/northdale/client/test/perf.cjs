/* eslint-disable @typescript-eslint/no-require-imports */
// Render-rate check with a full night horde (not part of `pnpm test`):
//
//   pnpm --filter @rally/game-northdale perf
//
// Starts (or reuses) the game server on :2572 with RALLY_DEV_RULES=1 and the Vite dev server (:5186), opens one page
// in NORMAL quality (no ?lowfx: MSAA, effects, light pools, flashlight) at iPhone landscape size (844×390) in a private
// room, starts the run, skips to night 4 (dev `night`), keeps the survivor standing (`god`) in the middle of a street
// and brings the horde to the concurrent cap (MAX_ZOMBIES: dev `spawn` around the survivor, every kind), holds the
// trigger and prints the frame rate and frame times the game's own metrics measure, with the zombies drawn and the
// town's triangles, for DPR 1 and DPR 2. Without a GPU Chromium renders WebGL in software (swiftshader), so the
// numbers are a floor, not a phone's.
// Env: NORTHDALE_URL, COLYSEUS_URL, PERF_SECONDS (default 8), PERF_DPR (default "1,2"), PERF_QUERY (extra ?params).
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../../../..');
const GAME_URL = (process.env.NORTHDALE_URL || 'http://localhost:5186/').replace(/\/?$/, '/');
const COLYSEUS_URL = (process.env.COLYSEUS_URL || 'http://localhost:2572').replace(/\/+$/, '');
const SECONDS = Number(process.env.PERF_SECONDS || 8);
const DPRS = (process.env.PERF_DPR || '1,2').split(',').map(Number);
/** Extra query parameters (e.g. `&lowfx=1`). */
const QUERY = process.env.PERF_QUERY || '';
/** A long straight street west of the Junction (open on every side). */
const STREET = { x: 0, y: -20 };
const started = [];

async function isUp(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function ensureServer(name, url, filter, env) {
  if (await isUp(url)) return;
  const child = spawn('pnpm', ['--filter', filter, 'dev'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: 'ignore',
  });
  started.push(child);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await isUp(url)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${name} did not come up at ${url}`);
}

async function measure(browser, dpr) {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  await page.goto(`${GAME_URL}?name=Perf${dpr}&private${QUERY}&colyseus=${encodeURIComponent(COLYSEUS_URL)}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.addStyleTag({ content: '#rally-dev-harness { display: none !important; }' });
  await page.waitForFunction(() => window.__northdale && window.__northdale.joined, null, { timeout: 90_000 });
  const dev = (cmd) => page.evaluate((c) => window.__northdale.dev(c), cmd);
  await dev({ cmd: 'start' });
  await page.waitForFunction(() => window.__northdale.phase === 'day', null, { timeout: 20_000 });
  await dev({ cmd: 'god', on: true });
  await dev({ cmd: 'rules', rules: { nightTime: 3600, spawnScale: 0 } });
  await dev({ cmd: 'night', n: 4 });
  await dev({ cmd: 'clear' });
  await dev({ cmd: 'place', x: STREET.x, y: STREET.y });
  await dev({ cmd: 'give', item: 2 });
  await dev({ cmd: 'give', item: 19 });
  // The horde from both ends of the street and the cross streets: every kind, up to the cap.
  const groups = [
    { kind: 0, dx: 0, dy: -14, n: 18 },
    { kind: 0, dx: 0, dy: 14, n: 18 },
    { kind: 1, dx: -14, dy: 0, n: 10 },
    { kind: 2, dx: 14, dy: 0, n: 8 },
    { kind: 0, dx: -12, dy: -10, n: 10 },
    { kind: 3, dx: 12, dy: 12, n: 2 },
    { kind: 0, dx: 12, dy: -10, n: 4 },
  ];
  for (const g of groups) await dev({ cmd: 'spawn', kind: g.kind, x: STREET.x + g.dx, y: STREET.y + g.dy, n: g.n });
  await page.waitForFunction(() => window.__northdale.drawnZombies >= 50, null, { timeout: 20_000 });
  // Hold the trigger up the street while they close in.
  await page.mouse.move(422, 90);
  await page.mouse.down();
  await page.waitForTimeout(2500);
  const samples = [];
  const until = Date.now() + SECONDS * 1000;
  while (Date.now() < until) {
    await page.waitForTimeout(2000);
    samples.push(
      await page.evaluate(() => ({
        ...window.__northdale.fps,
        zombies: window.__northdale.drawnZombies,
        town: window.__northdale.stats.town.triangles,
      })),
    );
  }
  await page.mouse.up();
  await page.close();
  await context.close();
  const avg = (k) => samples.reduce((a, s) => a + s[k], 0) / samples.length;
  return {
    dpr,
    fps: +avg('fps').toFixed(1),
    frameMs: +avg('frameMs').toFixed(1),
    p95Ms: +avg('p95Ms').toFixed(1),
    zombies: Math.round(avg('zombies')),
    town: Math.round(avg('town')),
  };
}

async function main() {
  await ensureServer('game server', `${COLYSEUS_URL}/healthz`, '@rally/game-server', {
    PORT: new URL(COLYSEUS_URL).port,
    RALLY_DEV_RULES: '1',
  });
  await ensureServer('northdale dev server', GAME_URL, '@rally/game-northdale', { VITE_NO_HMR: '1' });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    for (const dpr of DPRS) {
      const r = await measure(browser, dpr);
      console.log(
        `844×390 @${r.dpr}x ${QUERY.includes('lowfx') ? 'lowfx' : 'normal quality'}, night 4, ${r.zombies} zombies ` +
          `drawn: ${r.fps} fps (frame ${r.frameMs} ms, p95 ${r.p95Ms} ms); town ${r.town} triangles`,
      );
    }
  } finally {
    await browser.close();
    for (const c of started) {
      try {
        process.kill(-c.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
