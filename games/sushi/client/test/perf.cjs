/* eslint-disable @typescript-eslint/no-require-imports */
// Render-rate check with a full restaurant (not part of `pnpm test`):
//
//   pnpm --filter @rally/game-sushi perf
//
// Starts (or reuses) the game server on :2571 with RALLY_DEV_RULES=1 and the Vite dev server (:5185), opens one page
// at iPhone landscape size (844×390) in a private room, adds three helper bots (four chefs), skips to festival Sunday
// (every zone open: the dining room, the alley and its truck, the terrace) with twice the customers, and prints the
// frame rate and frame times the game's own metrics measure, the draw calls, and the characters drawn, for DPR 1 and
// DPR 2, at the graphics quality given (PERF_GRAPHICS, default high: shadows, MSAA, effects). Without a GPU Chromium
// renders WebGL in software (swiftshader), so the numbers are a floor, not a phone's.
// Env: SUSHI_URL, COLYSEUS_URL, PERF_SECONDS (default 8), PERF_DPR (default "1,2"), PERF_GRAPHICS (low|medium|high),
// PERF_QUERY (extra ?params).
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../../../..');
const GAME_URL = (process.env.SUSHI_URL || 'http://localhost:5185/').replace(/\/?$/, '/');
const COLYSEUS_URL = (process.env.COLYSEUS_URL || 'http://localhost:2571').replace(/\/+$/, '');
const SECONDS = Number(process.env.PERF_SECONDS || 8);
const DPRS = (process.env.PERF_DPR || '1,2').split(',').map(Number);
const GRAPHICS = process.env.PERF_GRAPHICS || 'high';
/** Extra query parameters (dev perf knobs: `&noscroll`, `&nolabels`). */
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
  // The graphics setting is remembered across launches (localStorage): set it before the page boots.
  await context.addInitScript((g) => localStorage.setItem('sushi.graphics', g), GRAPHICS);
  const page = await context.newPage();
  await page.goto(`${GAME_URL}?name=Perf${dpr}&private${QUERY}&colyseus=${encodeURIComponent(COLYSEUS_URL)}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.addStyleTag({ content: '#rally-dev-harness { display: none !important; }' });
  await page.waitForFunction(() => window.__sushi && window.__sushi.joined, null, { timeout: 90_000 });
  const dev = (cmd) => page.evaluate((c) => window.__sushi.dev(c), cmd);
  await dev({ cmd: 'rules', rules: { morningTime: 1, arrivals: 2, dayLength: 600, patience: 3 } });
  await dev({ cmd: 'bots', n: 3 });
  await dev({ cmd: 'start' });
  await dev({ cmd: 'day', day: 7 });
  await page.waitForFunction(() => window.__sushi.phase === 'open', null, { timeout: 30_000 });
  // Let the restaurant fill up.
  await page.waitForFunction(() => window.__sushi.drawn.customers >= 8, null, { timeout: 120_000 });
  await page.waitForTimeout(2000);
  const samples = [];
  const until = Date.now() + SECONDS * 1000;
  while (Date.now() < until) {
    await page.waitForTimeout(2000);
    samples.push(
      await page.evaluate(() => ({ ...window.__sushi.fps, ...window.__sushi.stats, ...window.__sushi.drawn })),
    );
  }
  await page.close();
  await context.close();
  const avg = (k) => samples.reduce((a, s) => a + s[k], 0) / samples.length;
  return {
    dpr,
    fps: +avg('fps').toFixed(1),
    frameMs: +avg('frameMs').toFixed(1),
    p95Ms: +avg('p95Ms').toFixed(1),
    draws: Math.round(avg('draws')),
    shadowDraws: Math.round(avg('shadowDraws')),
    chefs: Math.round(avg('chefs')),
    customers: Math.round(avg('customers')),
  };
}

async function main() {
  await ensureServer('game server', `${COLYSEUS_URL}/healthz`, '@rally/game-server', {
    PORT: new URL(COLYSEUS_URL).port,
    RALLY_DEV_RULES: '1',
  });
  await ensureServer('sushi dev server', GAME_URL, '@rally/game-sushi', { VITE_NO_HMR: '1' });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    for (const dpr of DPRS) {
      const r = await measure(browser, dpr);
      console.log(
        `844×390 @${r.dpr}x ${GRAPHICS}, festival Sunday, ${r.chefs} chefs + ${r.customers} customers: ${r.fps} fps ` +
          `(frame ${r.frameMs} ms, p95 ${r.p95Ms} ms), ${r.draws} draw calls (${r.shadowDraws} shadow)`,
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
