/* eslint-disable @typescript-eslint/no-require-imports */
// Render-rate check with a full horde (not part of `pnpm test`):
//
//   pnpm --filter @rally/game-overrun perf
//
// Starts (or reuses) the game server on :2569 with RALLY_DEV_RULES=1 and the Vite dev server (:5183), opens one page
// in NORMAL quality (no ?lowfx: shadows, MSAA, decals, effects) at iPhone landscape size (844×390), fills the yard
// with 120 zombies chasing the player (dev commands: `god` keeps the player standing, `spawn` adds the horde), holds
// the trigger, and prints the frame rate and frame times the game's own metrics measure, for DPR 1 and DPR 2.
// Without a GPU Chromium renders WebGL in software (swiftshader), so the numbers are a floor, not a phone's.
// Env: OVERRUN_URL, COLYSEUS_URL, PERF_SECONDS (default 8), PERF_DPR (default "1,2"), PERF_QUERY (extra ?params).
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../../../..');
const GAME_URL = (process.env.OVERRUN_URL || 'http://localhost:5183/').replace(/\/?$/, '/');
const COLYSEUS_URL = (process.env.COLYSEUS_URL || 'http://localhost:2569').replace(/\/+$/, '');
const SECONDS = Number(process.env.PERF_SECONDS || 8);
const DPRS = (process.env.PERF_DPR || '1,2').split(',').map(Number);
/** Extra query parameters (e.g. `&lowfx=1`). */
const QUERY = process.env.PERF_QUERY || '';
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
  await page.waitForFunction(() => window.__overrun && window.__overrun.joined, null, { timeout: 90_000 });
  const dev = (cmd) => page.evaluate((c) => window.__overrun.dev(c), cmd);
  await dev({ cmd: 'rules', rules: { firstBreatherTime: 0.5, waveSize: 400, maxAlive: 120 } });
  await dev({ cmd: 'god', on: true });
  await page.click('#start');
  await page.waitForFunction(() => window.__overrun.phase === 'wave', null, { timeout: 20_000 });
  // The whole horde at once, from all sides.
  for (const [x, y] of [
    [-20, -13],
    [12, -13],
    [-20, 9],
    [12, 9],
  ]) {
    await dev({ cmd: 'spawn', kind: 0, x, y, n: 30 });
  }
  await page.waitForFunction(() => window.__overrun.drawnZombies >= 115, null, { timeout: 20_000 });
  // Hold the trigger (aim at the nearest zombies) while they close in.
  await page.mouse.move(422, 120);
  await page.mouse.down();
  await page.waitForTimeout(2500);
  const samples = [];
  const until = Date.now() + SECONDS * 1000;
  while (Date.now() < until) {
    await page.waitForTimeout(2000);
    samples.push(await page.evaluate(() => ({ ...window.__overrun.fps, zombies: window.__overrun.drawnZombies })));
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
  };
}

async function main() {
  await ensureServer('game server', `${COLYSEUS_URL}/healthz`, '@rally/game-server', {
    PORT: new URL(COLYSEUS_URL).port,
    RALLY_DEV_RULES: '1',
  });
  await ensureServer('overrun dev server', GAME_URL, '@rally/game-overrun', { VITE_NO_HMR: '1' });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    for (const dpr of DPRS) {
      const r = await measure(browser, dpr);
      console.log(
        `844×390 @${r.dpr}x normal quality, ${r.zombies} zombies drawn: ${r.fps} fps (frame ${r.frameMs} ms, p95 ${r.p95Ms} ms)`,
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
  process.exit(1);
});
