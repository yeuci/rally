/* eslint-disable @typescript-eslint/no-require-imports */
// End-to-end check of Stack through the dev harness (fake Rally host) in a real browser.
//
//   pnpm --filter @rally/game-stack test:e2e
//
// Starts Stack's Vite dev server (:5181, harness plugin on) unless it is already running, drives Chromium with
// Playwright and asserts: boot → ready(), taps place blocks and the score increments, a forced miss ends the game,
// the game-over panel shows score / best / leaderboard rank, leaderboard.submit + achievement.unlock('first_drop')
// reached the harness (localStorage + panel log), save.put wrote progress.best, pause/resume from the panel
// freeze/continue the simulation, exitRequested → save → exit("host"), and ?nohost plays standalone.
// Env: STACK_URL, E2E_SCREENSHOT=<png path> (default <tmp>/stack.png).
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../../../..');
const STACK_URL = process.env.STACK_URL || 'http://localhost:5181/';
const SCREENSHOT = process.env.E2E_SCREENSHOT || path.join(os.tmpdir(), 'stack.png');
/** Where to tap: upper middle of the canvas, clear of the harness panel (bottom right) and the game-over card. */
const TAP = { x: 195, y: 330 };

const started = [];

async function isUp(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function ensureServer(name, url, filter) {
  if (await isUp(url)) {
    console.log(`· ${name} already running at ${url}`);
    return;
  }
  console.log(`· starting ${name} (pnpm --filter ${filter} dev)`);
  const child = spawn('pnpm', ['--filter', filter, 'dev'], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  started.push({ name, child });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited early:\n${output}`);
    if (await isUp(url)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${name} did not come up at ${url} within 60 s:\n${output}`);
}

function stopServers() {
  for (const { name, child } of started.reverse()) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      console.log(`· stopped ${name}`);
    } catch {
      /* already gone */
    }
  }
}

const panelLog = (page) => page.textContent('#rally-dev-harness >> [data-role="log"]');
const stack = (page, expr) => page.evaluate(`window.__stack.${expr}`);
const local = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key);

/** Wait until the slider is over the tower (|offset| < max) and tap. Returns the new score. */
async function placeBlock(page, max = 0.5) {
  const before = await stack(page, 'score');
  await page.waitForFunction(
    (m) => {
      const o = window.__stack.offset();
      return o !== null && window.__stack.layerTime > 0.3 && Math.abs(o) < m;
    },
    max,
    { polling: 'raf', timeout: 15_000 },
  );
  await page.mouse.click(TAP.x, TAP.y);
  await page.waitForFunction((b) => window.__stack.score === b + 1, before, { timeout: 5_000 });
  return before + 1;
}

/** Wait until the slider is far off the tower (still on its way in) and tap: a guaranteed miss. */
async function forceMiss(page) {
  await page.waitForFunction(
    () => {
      const o = window.__stack.offset();
      return o !== null && window.__stack.layerTime > 0.3 && o < -3.8;
    },
    null,
    { polling: 'raf', timeout: 15_000 },
  );
  await page.mouse.click(TAP.x, TAP.y);
  await page.waitForFunction(() => window.__stack.phase === 'over', null, { timeout: 5_000 });
}

async function startGame(page) {
  await page.waitForSelector('#prompt:not([hidden])', { timeout: 30_000 });
  await page.mouse.click(TAP.x, TAP.y);
  await page.waitForFunction(() => window.__stack.phase === 'playing', null, { timeout: 5_000 });
}

async function main() {
  await ensureServer('stack dev server', STACK_URL, '@rally/game-stack');

  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    // iPhone 14-sized portrait viewport.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    // Fresh state: no saves, boards or achievements from earlier runs.
    await page.goto(STACK_URL);
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('rally-harness:')) localStorage.removeItem(k);
    });
    await page.reload();

    // 1. Boot through the fake host.
    await page.waitForSelector('#loading', { state: 'hidden', timeout: 30_000 });
    await page.waitForSelector('#prompt:not([hidden])');
    assert.equal(await page.textContent('#prompt'), 'Tap to start');
    let log = await panelLog(page);
    assert.match(log, /ready\(\) after \d+ ms/);
    assert.match(log, /← save\.get ok/);
    assert.match(log, /← ui\.loading ok/);
    assert.match(log, /boards height, 5 achievement\(s\)/);
    console.log('✓ boot: ui.loading → save.get → ready(); "Tap to start"');

    // 2. Tap to start, then place blocks: the score increments.
    await startGame(page);
    assert.equal(await page.textContent('#score'), '0');
    for (let i = 1; i <= 5; i++) {
      const score = await placeBlock(page, i === 1 ? 0.1 : 0.6);
      assert.equal(await page.textContent('#score'), String(score));
    }
    console.log(`✓ taps place blocks; score ${await page.textContent('#score')} (streak ${await stack(page, 'streak')})`);
    const playing = SCREENSHOT.replace(/\.png$/, '-playing.png');
    await page.screenshot({ path: playing });

    // 3. Force a miss → game over panel.
    await forceMiss(page);
    const score = await stack(page, 'score');
    await page.waitForSelector('#over:not([hidden])', { timeout: 5_000 });
    assert.equal(await page.textContent('#over-score'), String(score));
    assert.match(await page.textContent('#over-best'), /New best!|Best \d+/);
    await page.waitForFunction(() => /#\d+ global/.test(document.querySelector('#over-board')?.textContent ?? ''), null, {
      timeout: 10_000,
    });
    const board = await page.textContent('#over-board');
    assert.match(board, new RegExp(`best ${score} · #\\d+ global`));
    assert.match(await page.textContent('#over-unlocked'), /First Drop/);
    console.log(`✓ miss → game over: score ${score}, "${await page.textContent('#over-best')}", "${board}"`);

    // 4. Harness side: leaderboard.submit / achievement.unlock / save.put went through the bridge.
    const entries = await local(page, 'rally-harness:board:stack:height');
    const mine = entries.find((e) => e.userId === 'dev-user');
    assert.equal(mine?.score, score, 'dev user on the harness board');
    const achievements = await local(page, 'rally-harness:ach:stack:dev-user');
    assert.ok(achievements.includes('first_drop'), `achievements ${JSON.stringify(achievements)}`);
    log = await panelLog(page);
    assert.match(log, /← leaderboard\.submit ok/);
    assert.match(log, /← leaderboard\.top ok/);
    assert.match(log, /achievement "First Drop" \(first_drop\) unlocked/);
    assert.match(log, new RegExp(`score ${score} on "height": new best`));
    await page.waitForFunction(
      (s) => JSON.parse(localStorage.getItem('rally-harness:save:stack:progress') || 'null')?.data?.best === s,
      score,
      { timeout: 10_000 },
    );
    const saved = await local(page, 'rally-harness:save:stack:progress');
    assert.deepEqual(saved.data, { best: score, played: 1, version: 1 });
    console.log(
      `✓ harness: board entry ${mine.username}=${mine.score}, achievements [${achievements.join(', ')}], save v${saved.version} ${JSON.stringify(saved.data)}`,
    );

    // Screenshot of the game-over screen (harness panel hidden so the game is unobstructed).
    await page.waitForTimeout(800); // let the camera settle into the overview
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = 'none'));
    await page.screenshot({ path: SCREENSHOT });
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = ''));
    console.log(`  screenshots: ${SCREENSHOT}, ${playing}`);

    // 5. Play again; pause / resume from the harness panel freeze and continue the simulation.
    // At phone width the expanded harness panel covers the card's button: collapse it for the click.
    const togglePanel = () => page.click('#rally-dev-harness >> [data-role="head"]');
    await togglePanel();
    await page.click('#again');
    await togglePanel();
    await startGame(page);
    await page.waitForTimeout(300);
    await page.click('#rally-dev-harness >> button[data-action="pause"]');
    await page.waitForSelector('#paused:not([hidden])');
    assert.equal(await stack(page, 'paused'), true);
    const t0 = await stack(page, 'layerTime');
    await page.waitForTimeout(600);
    const t1 = await stack(page, 'layerTime');
    assert.equal(t1, t0, 'simulation frozen while paused');
    await page.mouse.click(TAP.x, TAP.y); // taps while paused do nothing
    assert.equal(await stack(page, 'score'), 0);
    await page.click('#rally-dev-harness >> button[data-action="resume"]');
    await page.waitForSelector('#paused', { state: 'hidden' });
    await page.waitForTimeout(400);
    const t2 = await stack(page, 'layerTime');
    assert.ok(t2 > t1 + 0.05, `simulation continues after resume (${t1} → ${t2})`);
    console.log(`✓ pause freezes the simulation (layerTime ${t0.toFixed(3)} = ${t1.toFixed(3)}), resume continues (${t2.toFixed(3)})`);

    // 6. lowMemory is handled without disrupting play.
    await page.click('#rally-dev-harness >> button[data-action="lowMemory"]');
    await placeBlock(page, 0.6);
    console.log('✓ lowMemory → trimmed, still playable');

    // 7. exitRequested → the game saves and calls exit("host").
    await page.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await page.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    const overlay = await page.textContent('#rally-dev-harness >> [data-role="exit-overlay"]');
    assert.match(overlay, /game exited \(host\)/);
    log = await panelLog(page);
    assert.match(log, /exit\("host"\)/);
    console.log(`✓ exitRequested → exit() → overlay "${overlay.replace('reload', '').trim()}"`);

    // 8. Standalone (?nohost): plays with in-memory/localStorage fallbacks, no bridge.
    const standalone = await context.newPage();
    standalone.on('pageerror', (e) => errors.push(e.message));
    await standalone.goto(`${STACK_URL}?nohost`);
    assert.equal(await standalone.evaluate(() => typeof window.__rally), 'undefined');
    await standalone.waitForSelector('#loading', { state: 'hidden', timeout: 30_000 });
    await startGame(standalone);
    await placeBlock(standalone, 0.6);
    await forceMiss(standalone);
    await standalone.waitForSelector('#over:not([hidden])');
    await standalone.waitForFunction(() => /Offline · best \d+/.test(document.querySelector('#over-board')?.textContent ?? ''));
    console.log(`✓ ?nohost → standalone game over: "${await standalone.textContent('#over-board')}"`);

    const unexpected = errors.filter((e) => !/WebGPU|GPU stall|favicon/i.test(e));
    assert.deepEqual(unexpected, [], 'no page errors');
    console.log('\nPASS stack e2e');
  } finally {
    await browser.close();
  }
}

main()
  .then(() => {
    stopServers();
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nFAIL stack e2e:', err);
    stopServers();
    process.exit(1);
  });
