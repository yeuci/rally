/* eslint-disable @typescript-eslint/no-require-imports */
// Remote-puck smoothness measurement (not part of `pnpm test`: it needs both servers and a browser).
//
//   NODE_PATH=/usr/local/lib/node_modules_global pnpm --filter @rally/game-sumo test:jitter
//
// A scripted "mover" (a plain Colyseus client in Node, so its stick is exact) and an "observer" (Chromium through
// the dev harness) play a 2-player match. Once round 1 is playing, the mover holds a constant stick until its puck is at
// terminal velocity on the server; then the observer records where it DRAWS the mover's puck every animation frame
// for TRACE_MS (window.__sumo.traceStart/traceStop, dev only). Prints:
//   - jitter: standard deviation of the per-frame displacement (and as a % of its mean);
//   - speed jitter: standard deviation of displacement / frame dt, as a % of the server speed (frame-time free);
//   - stalls (frames the puck did not move) and jumps (displacement > 2× the median);
//   - what the patches looked like at the mover (inter-arrival times, sim ticks per patch).
// Env: COLYSEUS_URL (default http://localhost:2577: started here unless up), SUMO_URL (default :5182),
// TRACE_MS (3000), STICK (0.2: terminal speed = 10 × STICK units/s), JITTER_JSON=<path> to dump the raw trace,
// MAX_JITTER_PCT: fail (exit 1) if the speed jitter is above this percentage.
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { Client } = require('@colyseus/sdk');

const ROOT = path.resolve(__dirname, '../../../..');
const SUMO_URL = (process.env.SUMO_URL || 'http://localhost:5182/').replace(/\/?$/, '/');
const COLYSEUS_URL = (process.env.COLYSEUS_URL || 'http://localhost:2577').replace(/\/+$/, '');
const COLYSEUS_PORT = new URL(COLYSEUS_URL).port || '80';
const TRACE_MS = Number(process.env.TRACE_MS || 3000);
const STICK = Number(process.env.STICK || 0.2);
const MAX_JITTER_PCT = process.env.MAX_JITTER_PCT ? Number(process.env.MAX_JITTER_PCT) : null;

const started = [];

async function isUp(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function ensureServer(name, url, filter, env = {}) {
  if (await isUp(url)) return console.log(`· ${name} already running at ${url}`);
  console.log(`· starting ${name} (pnpm --filter ${filter} dev)`);
  const child = spawn('pnpm', ['--filter', filter, 'dev'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  started.push(child);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited early:\n${output}`);
    if (await isUp(url)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${name} did not come up at ${url} within 60 s:\n${output}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
};
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const hist = (a) => {
  const h = {};
  for (const v of a) h[v] = (h[v] || 0) + 1;
  return h;
};

async function waitFor(fn, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  await ensureServer('game server', `${COLYSEUS_URL}/healthz`, '@rally/game-server', { PORT: COLYSEUS_PORT });
  await ensureServer('sumo dev server', SUMO_URL, '@rally/game-sumo');
  await waitFor(
    async () => (await (await fetch(`${COLYSEUS_URL}/rooms/sumo`)).json()).rooms.length === 0,
    75_000,
    'leftover public sumo rooms to close',
  );

  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let mover;
  try {
    const context = await browser.newContext({ viewport: { width: 160, height: 90 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    // Through the dev harness (fake host matchmaking), like the e2e.
    await page.goto(`${SUMO_URL}?name=Obs&colyseus=${encodeURIComponent(COLYSEUS_URL)}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => window.__sumo && window.__sumo.joined, null, { timeout: 30_000 });

    // The mover: a plain client, so its stick is exactly constant. It also logs every patch it receives.
    mover = await new Client(COLYSEUS_URL).joinOrCreate('sumo', { username: 'Mover' });
    const patches = [];
    mover.onStateChange((st) => {
      const p = st.players && st.players.get(mover.sessionId);
      if (p) patches.push({ t: performance.now(), tick: st.tick, x: p.x, y: p.y, vx: p.vx, vy: p.vy, phase: st.phase });
    });
    await waitFor(() => mover.state.phase === 'playing', 15_000, 'round 1');
    await page.waitForFunction(() => window.__sumo.phase === 'playing', null, { timeout: 5_000 });

    // Head 53° off the inward radial: a long chord that stays on the platform and well clear of the other puck.
    const me = mover.state.players.get(mover.sessionId);
    const r = Math.hypot(me.x, me.y);
    const ix = -me.x / r;
    const iy = -me.y / r;
    const dir = { x: 0.6 * ix - 0.8 * iy, y: 0.6 * iy + 0.8 * ix };
    mover.send('input', { x: dir.x * STICK, y: dir.y * STICK, s: 1 });
    await sleep(2000); // 1 - e^(-2·2) = 98 % of terminal speed
    const from = patches.length;
    await page.evaluate(() => window.__sumo.traceStart('guest-Mover'));
    await sleep(TRACE_MS);
    const trace = await page.evaluate(() => window.__sumo.traceStop());
    const seen = patches.slice(from);
    mover.send('input', { x: 0, y: 0, s: 2 });

    // --- what the observer drew ---
    const disp = [];
    const speed = [];
    const dts = [];
    for (let i = 1; i < trace.length; i++) {
      const d = Math.hypot(trace[i].x - trace[i - 1].x, trace[i].y - trace[i - 1].y);
      const dt = trace[i].t - trace[i - 1].t;
      disp.push(d);
      dts.push(dt);
      speed.push((d / dt) * 1000);
    }
    const serverSpeed = mean(seen.map((p) => Math.hypot(p.vx, p.vy)));
    const med = median(disp);
    const stalls = disp.filter((d) => d < 1e-6).length;
    const jumps = disp.filter((d) => d > 2 * med).length;
    const result = {
      frames: trace.length,
      frameMs: { mean: +mean(dts).toFixed(2), std: +std(dts).toFixed(2) },
      serverSpeed: +serverSpeed.toFixed(3),
      dispMean: +mean(disp).toFixed(5),
      dispStd: +std(disp).toFixed(5),
      dispCvPct: +((std(disp) / mean(disp)) * 100).toFixed(1),
      speedStdPct: +((std(speed) / serverSpeed) * 100).toFixed(1),
      stalls,
      jumps,
    };
    // --- what the network delivered (to the mover; the observer gets the same broadcast) ---
    const gaps = seen.slice(1).map((p, i) => p.t - seen[i].t);
    const ticks = seen.slice(1).map((p, i) => p.tick - seen[i].tick);
    console.log(
      `patches: ${seen.length} in ${TRACE_MS} ms; inter-arrival ${mean(gaps).toFixed(1)} ± ${std(gaps).toFixed(1)} ms ` +
        `(min ${Math.min(...gaps).toFixed(1)}, max ${Math.max(...gaps).toFixed(1)}); sim ticks per patch ${JSON.stringify(hist(ticks))}`,
    );
    console.log(
      `observer: ${result.frames} frames (${result.frameMs.mean} ± ${result.frameMs.std} ms), server speed ${result.serverSpeed} u/s`,
    );
    console.log(
      `jitter: per-frame displacement ${result.dispMean} ± ${result.dispStd} u (CV ${result.dispCvPct} %), ` +
        `speed std ${result.speedStdPct} % of server speed, stalls ${stalls}, jumps >2× median ${jumps}`,
    );
    console.log(`JITTER_RESULT ${JSON.stringify(result)}`);
    if (process.env.JITTER_JSON) fs.writeFileSync(process.env.JITTER_JSON, JSON.stringify({ result, trace, patches: seen }));
    if (MAX_JITTER_PCT !== null && result.speedStdPct > MAX_JITTER_PCT) {
      throw new Error(`speed jitter ${result.speedStdPct} % > ${MAX_JITTER_PCT} %`);
    }
  } finally {
    await mover?.leave(true).catch(() => {});
    await browser.close();
    for (const child of started.reverse()) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
