/* eslint-disable @typescript-eslint/no-require-imports */
// End-to-end check of Fold through the dev harness (fake Rally host) in a real browser.
//
//   pnpm --filter @rally/game-fold test:e2e
//
// Starts the Vite dev server (:5198, harness plugin on) unless it is already running, drives Chromium with Playwright
// and asserts:
// - boot → ready(), the first-run tutorial line, and that a tap, a swipe down and a swipe up start the run and refold the
//   plane (crane, dart, glider);
// - the bot (dev probe) flies past the first room and 100 m, with stamps and a stairwell on the HUD;
// - pause/resume freeze and continue the run, and lowMemory is handled;
// - left to glide on its own the plane crashes, and the results card shows the distance, best, crash line,
//   leaderboard rank and unlocked achievements;
// - leaderboard.submit, achievement.unlock and save.put reached the harness;
// - the next run has no tutorial and starts from the keyboard;
// - exitRequested → save → exit("host"), and ?nohost plays standalone.
// Every page runs the dev-only ?lowfx=1 mode (≤ 15 fps, DPR 1, no MSAA or shadows): CI renders WebGL in software on a
// small runner.
// Env: FOLD_URL, E2E_SCREENSHOT=<png path> (default <tmp>/fold.png).
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../../../..');
const FOLD_URL = process.env.FOLD_URL || 'http://localhost:5198/';
const SCREENSHOT = process.env.E2E_SCREENSHOT || path.join(os.tmpdir(), 'fold.png');

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
const fold = (page, expr) => page.evaluate(`window.__fold.${expr}`);
const local = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key);

/** A tap at (x, y): the crane flaps. */
async function tap(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

/** A vertical swipe from (x, y) by dy CSS px: down = dart, up = glider. */
async function swipe(page, x, y, dy) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(x, y + (dy * i) / 5);
  await page.mouse.up();
}

/** Wait until the sim (game time, not wall time: frames are slow in software rendering) has the plane in `form`. */
const formIs = (page, form) =>
  page.waitForFunction((f) => window.__fold.form === f, form, { timeout: 10_000 }).then(() => true);

async function main() {
  await ensureServer('fold dev server', FOLD_URL, '@rally/game-fold');

  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    // iPhone 14-sized landscape viewport.
    const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    // Fresh state: no saves, boards or achievements from earlier runs.
    await page.goto(`${FOLD_URL}?lowfx=1`);
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('rally-harness:')) localStorage.removeItem(k);
    });
    await page.reload();

    // 1. Boot through the fake host.
    assert.equal(await fold(page, 'lowfx'), true, '?lowfx=1 in effect');
    await page.waitForSelector('#loading', { state: 'hidden', timeout: 30_000 });
    await page.waitForSelector('#prompt:not([hidden])');
    assert.match(await page.textContent('#prompt'), /tap to flap/i);
    assert.equal(await page.textContent('#distance-value'), '0');
    let log = await panelLog(page);
    assert.match(log, /ready\(\) after \d+ ms/);
    assert.match(log, /← save\.get ok/);
    assert.match(log, /boards distance, 5 achievement\(s\)/);
    assert.equal(await fold(page, 'phase'), 'ready');
    assert.equal(await fold(page, 'form'), 'glider');
    console.log(`✓ boot: ui.loading → save.get → ready(); "${await page.textContent('#prompt')}"`);

    // 2. A tap starts the run with a flap (crane); a swipe down folds the dart, a swipe up the glider.
    await tap(page, 220, 200);
    assert.ok(await formIs(page, 'crane'));
    assert.equal(await fold(page, 'phase'), 'playing');
    assert.ok(await page.isHidden('#prompt'));
    assert.equal(await page.getAttribute('#forms [data-form="crane"]', 'class'), 'form on');
    await page.waitForSelector('#hint:not([hidden])');
    assert.equal(await page.textContent('#hint'), 'Tap to flap up over the bookshelf');
    await swipe(page, 220, 150, 60);
    assert.ok(await formIs(page, 'dart'));
    await swipe(page, 220, 250, -60);
    assert.ok(await formIs(page, 'glider'));
    console.log('✓ tap → crane (run starts, tutorial hint), swipe down → dart, swipe up → glider');

    // 3. The bot flies the first room (shelf, lamp, stairwell) and on past 100 m.
    await page.evaluate(() => window.__fold.autoplay(true));
    await page.evaluate(() => window.__fold.skip(30));
    assert.equal(await fold(page, 'phase'), 'playing', `crashed: ${JSON.stringify(await fold(page, 'crash'))}`);
    const flown = await fold(page, 'distance');
    assert.ok(flown > 120, `flew ${flown} m`);
    assert.ok((await fold(page, 'stamps')) > 0);
    assert.ok((await fold(page, 'stairwells')) >= 1);
    await page.waitForFunction(
      () => document.getElementById('distance-value').textContent === Math.floor(window.__fold.distance).toString(),
    );
    assert.ok(await page.isHidden('#hint'), 'the tutorial is done after the first room');
    // Rooms behind the plane are dropped as new ones are built ahead: the scene stays small.
    const entities = await fold(page, 'entities');
    assert.ok(entities > 20 && entities < 400, `${entities} entities`);
    console.log(
      `✓ bot flies ${Math.round(flown)} m (${entities} entities): ${await fold(page, 'stamps')} stamps, ${await fold(page, 'stairwells')} stairwell(s); HUD "${await page.textContent('#distance-value')} m"`,
    );
    const playing = SCREENSHOT.replace(/\.png$/, '-playing.png');
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = 'none'));
    await page.screenshot({ path: playing });
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = ''));

    // 4. Pause / resume from the harness panel freeze and continue the run.
    await page.click('#rally-dev-harness >> button[data-action="pause"]');
    await page.waitForSelector('#paused:not([hidden])');
    assert.equal(await fold(page, 'paused'), true);
    const t0 = await fold(page, 'time');
    await page.waitForTimeout(600);
    assert.equal(await fold(page, 'time'), t0, 'run frozen while paused');
    await page.click('#rally-dev-harness >> button[data-action="resume"]');
    await page.waitForSelector('#paused', { state: 'hidden' });
    await page.waitForFunction((t) => window.__fold.time > t + 0.1, t0, { timeout: 10_000 });
    const t1 = await fold(page, 'time');
    console.log(`✓ pause freezes the run (${t0.toFixed(2)} s), resume continues (${t1.toFixed(2)} s)`);

    // 5. lowMemory is handled without disrupting play.
    await page.click('#rally-dev-harness >> button[data-action="lowMemory"]');
    await page.waitForFunction((t) => window.__fold.time > t + 0.3, t1, { timeout: 10_000 });
    console.log('✓ lowMemory → trimmed, still flying');

    // 6. Hands off: the plane glides into something → the results card.
    await page.evaluate(() => window.__fold.autoplay(false));
    await page.evaluate(() => window.__fold.skip(60));
    assert.equal(await fold(page, 'phase'), 'over');
    const crash = await fold(page, 'crash');
    const score = Math.floor(await fold(page, 'distance'));
    await page.waitForSelector('#over:not([hidden])', { timeout: 10_000 });
    assert.equal(await page.textContent('#over-score'), `${score.toLocaleString('en-US')} m`);
    assert.equal(await page.textContent('#over-best'), 'New best!');
    assert.match(await page.textContent('#over-label'), /^(Hit |Skidded|Fell)/);
    assert.match(await page.textContent('#over-stats'), /^Stamps \d+ · Stairwells \d+ · \d+ s$/);
    await page.waitForFunction(
      () => /#\d+ global/.test(document.querySelector('#over-board')?.textContent ?? ''),
      null,
      {
        timeout: 10_000,
      },
    );
    const board = await page.textContent('#over-board');
    await page.waitForSelector('#over-unlocked:not([hidden])', { timeout: 10_000 });
    const unlocked = await page.textContent('#over-unlocked');
    assert.match(unlocked, /Paper Wings/);
    assert.match(unlocked, /Origami/);
    console.log(
      `✓ crash (${crash.cause}) → results: ${score} m, "${await page.textContent('#over-label')}", "${await page.textContent('#over-stats')}", "${board}", "${unlocked}"`,
    );

    // 7. Harness side: leaderboard.submit / achievement.unlock / save.put went through the bridge.
    const entries = await local(page, 'rally-harness:board:fold:distance');
    const mine = entries.find((e) => e.userId === 'dev-user');
    assert.equal(mine?.score, score, 'dev user on the harness board');
    const achievements = await local(page, 'rally-harness:ach:fold:dev-user');
    assert.ok(achievements.includes('first_100') && achievements.includes('all_folds'), JSON.stringify(achievements));
    log = await panelLog(page);
    assert.match(log, /← leaderboard\.submit ok/);
    assert.match(log, /← leaderboard\.top ok/);
    await page.waitForFunction(
      (s) => JSON.parse(localStorage.getItem('rally-harness:save:fold:progress') || 'null')?.data?.best === s,
      score,
      { timeout: 10_000 },
    );
    const saved = await local(page, 'rally-harness:save:fold:progress');
    assert.deepEqual(saved.data, { best: score, played: 1, version: 1 });
    console.log(
      `✓ harness: board ${mine.username}=${mine.score} m, achievements [${achievements.join(', ')}], save ${JSON.stringify(saved.data)}`,
    );
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = 'none'));
    await page.screenshot({ path: SCREENSHOT });
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = ''));
    console.log(`  screenshots: ${SCREENSHOT}, ${playing}`);

    // 8. Next run: a new house, no tutorial the second time; the keyboard starts it.
    const togglePanel = () => page.click('#rally-dev-harness >> [data-role="head"]');
    await togglePanel();
    await page.click('#again');
    await togglePanel();
    await page.waitForSelector('#prompt:not([hidden])');
    assert.equal(await fold(page, 'phase'), 'ready');
    assert.equal(await fold(page, 'distance'), 0);
    assert.equal(await page.textContent('#best-value'), `${score.toLocaleString('en-US')} m`);
    await page.keyboard.press('Space');
    assert.ok(await formIs(page, 'crane'));
    assert.equal(await fold(page, 'phase'), 'playing');
    await page.keyboard.press('ArrowDown');
    assert.ok(await formIs(page, 'dart'));
    await page.waitForFunction(() => window.__fold.time > 0.5, null, { timeout: 10_000 });
    assert.ok(await page.isHidden('#hint'), 'no tutorial on the second run');
    console.log('✓ next run: fresh house, no tutorial, Space flaps and ↓ dives');

    // 9. exitRequested → the game saves and calls exit("host").
    await page.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await page.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    const overlay = await page.textContent('#rally-dev-harness >> [data-role="exit-overlay"]');
    assert.match(overlay, /game exited \(host\)/);
    console.log(`✓ exitRequested → exit() → overlay "${overlay.replace('reload', '').trim()}"`);

    // 10. Standalone (?nohost): plays with localStorage fallbacks, no bridge.
    const standalone = await context.newPage();
    standalone.on('pageerror', (e) => errors.push(e.message));
    await standalone.goto(`${FOLD_URL}?nohost&lowfx=1`);
    assert.equal(await standalone.evaluate(() => typeof window.__rally), 'undefined');
    await standalone.waitForSelector('#loading', { state: 'hidden', timeout: 30_000 });
    await standalone.evaluate(() => window.__fold.input('flap'));
    await standalone.waitForFunction(() => window.__fold.phase === 'playing');
    await standalone.evaluate(() => window.__fold.skip(60));
    await standalone.waitForSelector('#over:not([hidden])', { timeout: 10_000 });
    await standalone.waitForFunction(() =>
      /Offline · best /.test(document.querySelector('#over-board')?.textContent ?? ''),
    );
    console.log(`✓ ?nohost → standalone run: "${await standalone.textContent('#over-board')}"`);

    const unexpected = errors.filter((e) => !/WebGPU|GPU stall|favicon/i.test(e));
    assert.deepEqual(unexpected, [], 'no page errors');
    console.log('\nPASS fold e2e');
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
    console.error('\nFAIL fold e2e:', err);
    stopServers();
    process.exit(1);
  });
