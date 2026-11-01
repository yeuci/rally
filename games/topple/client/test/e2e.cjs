/* eslint-disable @typescript-eslint/no-require-imports */
// End-to-end check of Topple through the dev harness (fake Rally host) in a real browser.
//
//   pnpm --filter @rally/game-topple test:e2e
//
// Starts the Vite dev server (:5197, harness plugin on) unless it is already running, drives Chromium with Playwright
// and asserts: boot → ready() with the seat setup; a two-person pass-and-play match where "You" drag, turn, flip and
// drop a piece that lands on the pedestal, pause/resume freeze/continue the turn timer, Player 2 drops off the edge,
// topples and is out, and "You win!" shows the places, the tallest tower on the leaderboard and the unlocked
// achievement (leaderboard.submit, achievement.unlock('first_win') and save.put reached the harness); then a match
// with a bot, whose planned drop lands; exitRequested → save → exit("host"); and ?nohost plays standalone.
// Every page runs the dev-only ?lowfx=1 mode (≤ 15 fps, DPR 1, no MSAA or shadows): CI renders WebGL in software.
// Env: TOPPLE_URL, E2E_SCREENSHOT=<png path> (default <tmp>/topple.png).
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../../../..');
const TOPPLE_URL = process.env.TOPPLE_URL || 'http://localhost:5197/';
const SCREENSHOT = process.env.E2E_SCREENSHOT || path.join(os.tmpdir(), 'topple.png');

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
  const child = spawn('pnpm', ['--filter', filter, 'dev'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
const topple = (page, expr) => page.evaluate(`window.__topple.${expr}`);
const local = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key);

/** The aim of the held piece, from the dev probe. */
const aim = (page) => page.evaluate(() => ({ ...window.__topple.sim.aim }));

async function main() {
  await ensureServer('topple dev server', TOPPLE_URL, '@rally/game-topple');

  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto(`${TOPPLE_URL}?lowfx=1`);
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('rally-harness:')) localStorage.removeItem(k);
    });
    await page.reload();

    // 1. Boot through the fake host: the seat setup, You + two normal bots by default.
    await page.waitForSelector('#loading', { state: 'hidden', timeout: 60_000 });
    assert.equal(await topple(page, 'lowfx'), true, '?lowfx=1 in effect');
    await page.waitForSelector('#setup:not([hidden])');
    assert.deepEqual(await topple(page, 'seats'), ['human', 'normal', 'normal']);
    let log = await panelLog(page);
    assert.match(log, /ready\(\) after \d+ ms/);
    assert.match(log, /← save\.get ok/);
    assert.match(log, /boards tower, 5 achievement\(s\)/);
    console.log('✓ boot: ui.loading → save.get → ready(); seat setup with You + 2 bots');

    // 2. Set up pass-and-play for two: seat 2 becomes a person (normal → hard → pass & play), seat 3 is removed.
    // At phone width the expanded harness panel covers the cards and controls: collapse it while playing.
    const togglePanel = () => page.click('#rally-dev-harness >> [data-role="head"]');
    await togglePanel();
    await page.click('[data-seat="1"]');
    await page.click('[data-seat="1"]');
    await page.click('[data-remove="2"]');
    assert.deepEqual(await topple(page, 'seats'), ['human', 'human']);
    assert.match(await page.textContent('#seats'), /Player 2\s*Pass & play/);
    await page.click('#start');
    await page.waitForSelector('#controls:not([hidden])');
    assert.equal(await page.textContent('#turn-name'), 'Your turn');
    console.log('✓ pass-and-play for two; "Your turn" with the controls');

    // 3. Your turn: a drag moves the piece, Turn / Flip change it, Drop lets go; it lands and Player 2 is up.
    const before = await aim(page);
    await page.mouse.move(195, 420);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(195 + i * 8, 420 + i * 4);
    await page.mouse.up();
    const moved = await aim(page);
    assert.ok(
      Math.hypot(moved.x - before.x, moved.z - before.z) > 0.1,
      `drag moved the piece ${JSON.stringify(moved)}`,
    );
    await page.click('#rotate');
    await page.click('#flip');
    await page.click('#flip');
    const turned = await aim(page);
    assert.equal(turned.yaw, 1);
    assert.equal(turned.flip, false);
    // Back near the middle so it lands safely, then drop.
    await page.evaluate(() => window.__topple.aim(0.05, 0));
    await page.click('#drop');
    await page.waitForFunction(() => window.__topple.current === 1 && window.__topple.phase === 'aim', null, {
      timeout: 30_000,
    });
    assert.equal(await topple(page, 'pieces'), 1);
    assert.ok(
      await page.evaluate(() => window.__topple.sim.pieces[0].body.translation().y > 0),
      'landed on the pedestal',
    );
    assert.equal(await page.textContent('#turn-name'), "Player 2's turn");
    console.log(
      `✓ drag → aim (${moved.x.toFixed(2)}, ${moved.z.toFixed(2)}), turn, flip, drop; it lands and Player 2 is up`,
    );

    // 4. Pause / resume from the harness panel freeze and continue the turn timer.
    await togglePanel();
    await page.click('#rally-dev-harness >> button[data-action="pause"]');
    await page.waitForSelector('#paused:not([hidden])');
    const t0 = await page.evaluate(() => window.__topple.sim.turnLeft);
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => window.__topple.sim.turnLeft), t0, 'turn timer frozen while paused');
    await page.click('#rally-dev-harness >> button[data-action="resume"]');
    await page.waitForSelector('#paused', { state: 'hidden' });
    await page.waitForFunction((t) => window.__topple.sim.turnLeft < t - 0.1, t0, { timeout: 5_000 });
    console.log(`✓ pause freezes the turn timer (${t0.toFixed(2)} s left), resume continues`);
    await togglePanel();

    // 5. Player 2 drops off the edge: the tower topples, they are out, and You win.
    await page.evaluate(() => window.__topple.aim(2.2, 2.2));
    await page.click('#drop');
    await page.waitForFunction(() => window.__topple.winner !== null, null, { timeout: 30_000 });
    assert.equal(await topple(page, 'winner'), 0);
    await page.waitForSelector('#over:not([hidden])', { timeout: 10_000 });
    assert.equal(await page.textContent('#over-title'), 'You win!');
    assert.match(await page.textContent('#over-places'), /1\s*You\s*2\s*Player 2/);
    assert.match(await page.textContent('#over-stats'), /^Tallest tower \d+ pieces? · 1 round\b/);
    await page.waitForFunction(
      () => /#\d+ global/.test(document.querySelector('#over-board')?.textContent ?? ''),
      null,
      {
        timeout: 10_000,
      },
    );
    assert.match(await page.textContent('#over-unlocked'), /Last One Standing/);
    console.log(`✓ Player 2 drops off the edge → topple → "You win!", "${await page.textContent('#over-board')}"`);

    // 6. Harness side: leaderboard.submit / achievement.unlock / save.put went through the bridge.
    const entries = await local(page, 'rally-harness:board:topple:tower');
    const mine = entries.find((e) => e.userId === 'dev-user');
    assert.ok(mine && mine.score >= 1, `board entry ${JSON.stringify(mine)}`);
    const achievements = await local(page, 'rally-harness:ach:topple:dev-user');
    assert.ok(achievements.includes('first_win'), `achievements ${JSON.stringify(achievements)}`);
    log = await panelLog(page);
    assert.match(log, /← leaderboard\.submit ok/);
    await page.waitForFunction(
      () => JSON.parse(localStorage.getItem('rally-harness:save:topple:progress') || 'null')?.data?.played === 1,
      null,
      { timeout: 10_000 },
    );
    const saved = await local(page, 'rally-harness:save:topple:progress');
    assert.deepEqual(saved.data, { best: mine.score, played: 1, wins: 1, version: 1 });
    console.log(
      `✓ harness: board ${mine.username}=${mine.score}, achievements [${achievements.join(', ')}], save ${JSON.stringify(saved.data)}`,
    );
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = 'none'));
    await page.screenshot({ path: SCREENSHOT });
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = ''));

    // 7. Change players: You + a bot. Drop safely; the bot plans its drop and it lands too.
    await page.click('#change');
    await page.waitForSelector('#setup:not([hidden])');
    await page.click('[data-seat="1"]'); // pass & play → easy bot
    assert.deepEqual(await topple(page, 'seats'), ['human', 'easy']);
    await page.click('#start');
    await page.waitForSelector('#controls:not([hidden])');
    await page.evaluate(() => window.__topple.aim(0, 0));
    await page.click('#drop');
    await page.waitForFunction(() => window.__topple.current === 1, null, { timeout: 30_000 });
    assert.match(await page.textContent('#turn-name'), /Bot 1 is thinking/);
    await page.waitForFunction(() => window.__topple.pieces >= 2 && window.__topple.current === 0, null, {
      timeout: 60_000,
    });
    const playing = SCREENSHOT.replace(/\.png$/, '-playing.png');
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = 'none'));
    await page.screenshot({ path: playing });
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = ''));
    console.log(
      `✓ You vs a bot: the bot planned and dropped (${await topple(page, 'pieces')} pieces); screenshots ${SCREENSHOT}, ${playing}`,
    );

    // 8. exitRequested → the game saves and calls exit("host").
    await togglePanel();
    await page.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await page.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    assert.match(await page.textContent('#rally-dev-harness >> [data-role="exit-overlay"]'), /game exited \(host\)/);
    console.log('✓ exitRequested → exit() → overlay');

    // 9. Standalone (?nohost): boots without the bridge and starts a match.
    const standalone = await context.newPage();
    standalone.on('pageerror', (e) => errors.push(e.message));
    await standalone.goto(`${TOPPLE_URL}?nohost&lowfx=1`);
    assert.equal(await standalone.evaluate(() => typeof window.__rally), 'undefined');
    await standalone.waitForSelector('#loading', { state: 'hidden', timeout: 60_000 });
    await standalone.evaluate(() => (document.getElementById('rally-dev-harness').style.display = 'none'));
    await standalone.click('#start');
    await standalone.waitForSelector('#controls:not([hidden])');
    console.log('✓ ?nohost → standalone match starts');

    const unexpected = errors.filter((e) => !/WebGPU|GPU stall|favicon/i.test(e));
    assert.deepEqual(unexpected, [], 'no page errors');
    console.log('\nPASS topple e2e');
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
    console.error('\nFAIL topple e2e:', err);
    stopServers();
    process.exit(1);
  });
