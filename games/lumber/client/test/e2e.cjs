/* eslint-disable @typescript-eslint/no-require-imports */
// End-to-end check of Lumber Camp through the dev harness (fake Rally host) in a real browser.
//
//   pnpm --filter @rally/game-lumber test:e2e
//
// Starts the Vite dev server (:5195, harness plugin on) unless it is already running, drives Chromium with Playwright
// and asserts: boot → ready(), a joystick drag starts the shift and walks the player, the greedy bot (dev probe) earns
// money and buys upgrades, skipping to the whistle shows the results card with earnings / best / leaderboard rank,
// leaderboard.submit + achievement.unlock('first_sale') + save.put reached the harness, the shift's stars unlock Rush Hour
// and a Rush Hour shift (2:00) goes to its own board, pause/resume freeze/continue the shift clock,
// exitRequested → save → exit("host"), and ?nohost plays standalone.
// Every page runs the dev-only ?lowfx=1 mode (≤ 15 fps, DPR 1, no MSAA or shadows): CI renders WebGL in software on a
// small runner, and at full quality the shift clock crawls.
// Env: LUMBER_URL, E2E_SCREENSHOT=<png path> (default <tmp>/lumber.png).
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../../../..');
const LUMBER_URL = process.env.LUMBER_URL || 'http://localhost:5195/';
const SCREENSHOT = process.env.E2E_SCREENSHOT || path.join(os.tmpdir(), 'lumber.png');

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
const lumber = (page, expr) => page.evaluate(`window.__lumber.${expr}`);
const local = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key);

/** Hold a joystick drag from (x, y) by (dx, dy) CSS px for `ms`, then release. */
/**
 * Press at (x, y), drag by (dx, dy) and hold the stick there until `until` (a page function, given `arg`) holds, then
 * let go. Holding until something happened rather than for a fixed time: on a slow runner the first frames after boot
 * can take seconds (shaders compile in software), and a frame's game time is capped, so a fixed hold may cover too
 * little game time to walk anywhere.
 */
async function drag(page, x, y, dx, dy, until, arg) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(x + (dx * i) / 5, y + (dy * i) / 5);
  try {
    await page.waitForFunction(until, arg, { timeout: 30_000 });
  } finally {
    await page.mouse.up();
  }
}

async function main() {
  await ensureServer('lumber dev server', LUMBER_URL, '@rally/game-lumber');

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
    await page.goto(`${LUMBER_URL}?lowfx=1`);
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('rally-harness:')) localStorage.removeItem(k);
    });
    await page.reload();

    // 1. Boot through the fake host.
    assert.equal(await lumber(page, 'lowfx'), true, '?lowfx=1 in effect');
    await page.waitForSelector('#loading', { state: 'hidden', timeout: 30_000 });
    await page.waitForSelector('#prompt:not([hidden])');
    assert.equal(await page.textContent('#clock'), '4:00');
    let log = await panelLog(page);
    assert.match(log, /ready\(\) after \d+ ms/);
    assert.match(log, /← save\.get ok/);
    assert.match(log, /boards earnings, rush, 6 achievement\(s\)/);
    assert.equal(await lumber(page, 'phase'), 'ready');
    console.log('✓ boot: ui.loading → save.get → ready(); "Drag anywhere to walk"');

    // 2. A drag starts the shift and walks the player (down-left on screen = +z, -x in the camp).
    const before = await lumber(page, 'player');
    await drag(
      page,
      200,
      420,
      -40,
      40,
      (b) => {
        const p = window.__lumber.player;
        return p.x < b.x - 0.5 && p.z > b.z + 0.5;
      },
      before,
    );
    assert.equal(await lumber(page, 'phase'), 'playing');
    assert.ok(await page.isHidden('#prompt'));
    const after = await lumber(page, 'player');
    assert.ok(
      after.x < before.x - 0.5 && after.z > before.z + 0.5,
      `walked ${JSON.stringify(before)} → ${JSON.stringify(after)}`,
    );
    await page.waitForSelector('#hint:not([hidden])');
    assert.equal(await page.textContent('#hint'), 'Grab planks at the sawmill');
    console.log(
      `✓ joystick drag starts the shift and walks (${before.x.toFixed(2)},${before.z.toFixed(2)}) → (${after.x.toFixed(2)},${after.z.toFixed(2)}); tutorial hint shown`,
    );

    // 3. The bot plays: money comes in, the first upgrade gets bought.
    await page.evaluate(() => window.__lumber.autoplay(true));
    await page.waitForFunction(() => window.__lumber.unlocked.length >= 1, null, { timeout: 60_000 });
    const earned = await lumber(page, 'earned');
    assert.ok(earned > 0);
    assert.match(await page.textContent('#earned-amount'), /^\$\d/);
    console.log(
      `✓ bot earns $${earned} and buys ${(await lumber(page, 'unlocked')).join(', ')} by ${(await lumber(page, 'time')).toFixed(1)} s`,
    );
    const playing = SCREENSHOT.replace(/\.png$/, '-playing.png');
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = 'none'));
    await page.screenshot({ path: playing });
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = ''));

    // 4. Pause / resume from the harness panel freeze and continue the shift clock.
    await page.click('#rally-dev-harness >> button[data-action="pause"]');
    await page.waitForSelector('#paused:not([hidden])');
    assert.equal(await lumber(page, 'paused'), true);
    const t0 = await lumber(page, 'time');
    await page.waitForTimeout(600);
    assert.equal(await lumber(page, 'time'), t0, 'shift frozen while paused');
    await page.click('#rally-dev-harness >> button[data-action="resume"]');
    await page.waitForSelector('#paused', { state: 'hidden' });
    // Game time, not wall time: under software rendering frames are slow and PlayCanvas clamps dt.
    await page.waitForFunction((t) => window.__lumber.time > t + 0.1, t0, { timeout: 5_000 });
    const t1 = await lumber(page, 'time');
    console.log(`✓ pause freezes the shift clock (${t0.toFixed(2)} s), resume continues (${t1.toFixed(2)} s)`);

    // 5. lowMemory is handled without disrupting play.
    await page.click('#rally-dev-harness >> button[data-action="lowMemory"]');
    await page.waitForFunction((t) => window.__lumber.time > t + 0.5, t1, { timeout: 5_000 });
    console.log('✓ lowMemory → trimmed, still running');

    // 6. Skip to the whistle → results card.
    await page.evaluate(() => window.__lumber.skip(400));
    assert.equal(await lumber(page, 'phase'), 'over');
    const score = await lumber(page, 'earned');
    await page.waitForSelector('#over:not([hidden])', { timeout: 5_000 });
    assert.equal(await page.textContent('#over-score'), `$${score.toLocaleString('en-US')}`);
    assert.equal(await page.textContent('#over-best'), 'New best!');
    assert.match(await page.textContent('#over-stats'), /^Served \d+ · Walked out \d+ · Upgrades \d\/8$/);
    const stars = await page.evaluate(() => document.querySelectorAll('#over-stars i.on').length);
    assert.ok(stars >= 2, `stars ${stars}`);
    const news = await page.textContent('#over-mode');
    assert.match(news, /^New mode: Rush Hour · New outfits?: Viking/);
    await page.waitForFunction(
      () => /#\d+ global/.test(document.querySelector('#over-board')?.textContent ?? ''),
      null,
      {
        timeout: 10_000,
      },
    );
    const board = await page.textContent('#over-board');
    assert.match(await page.textContent('#over-unlocked'), /Open for Business/);
    console.log(
      `✓ whistle → results: ${await page.textContent('#over-score')}, ${'★'.repeat(stars)}, "${await page.textContent('#over-stats')}", "${board}", ${news}`,
    );

    // 7. Harness side: leaderboard.submit / achievement.unlock / save.put went through the bridge.
    const entries = await local(page, 'rally-harness:board:lumber:earnings');
    const mine = entries.find((e) => e.userId === 'dev-user');
    assert.equal(mine?.score, score, 'dev user on the harness board');
    const achievements = await local(page, 'rally-harness:ach:lumber:dev-user');
    assert.ok(achievements.includes('first_sale'), `achievements ${JSON.stringify(achievements)}`);
    log = await panelLog(page);
    assert.match(log, /← leaderboard\.submit ok/);
    assert.match(log, /← leaderboard\.top ok/);
    await page.waitForFunction(
      (s) =>
        JSON.parse(localStorage.getItem('rally-harness:save:lumber:progress') || 'null')?.data?.bests?.classic === s,
      score,
      { timeout: 10_000 },
    );
    const saved = await local(page, 'rally-harness:save:lumber:progress');
    assert.deepEqual(saved.data, {
      bests: { classic: score, rush: 0 },
      played: 1,
      mode: 'classic',
      outfit: 'cowboy',
      version: 2,
    });
    console.log(
      `✓ harness: board ${mine.username}=$${mine.score}, achievements [${achievements.join(', ')}], save ${JSON.stringify(saved.data)}`,
    );

    await page.waitForTimeout(800); // let the camera settle into the overview
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = 'none'));
    await page.screenshot({ path: SCREENSHOT });
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = ''));
    console.log(`  screenshots: ${SCREENSHOT}, ${playing}`);

    // 8. Next shift: a fresh camp, no tutorial the second time; pick Rush Hour (now unlocked) in the mode picker.
    await page.evaluate(() => window.__lumber.autoplay(false));
    const togglePanel = () => page.click('#rally-dev-harness >> [data-role="head"]');
    await togglePanel();
    await page.click('#again');
    await page.waitForSelector('#modes:not([hidden])');
    await page.click('#modes [data-outfit]');
    assert.equal(await lumber(page, 'outfit'), 'viking');
    assert.match(await page.textContent('#modes [data-outfit]'), /Viking/);
    await page.click('#modes [data-mode="rush"]');
    assert.equal(await lumber(page, 'outfit'), 'viking', 'the outfit stays on for the next shift');
    await togglePanel();
    await page.waitForSelector('#prompt:not([hidden])');
    assert.equal(await lumber(page, 'phase'), 'ready');
    assert.equal(await lumber(page, 'mode'), 'rush');
    assert.equal(await lumber(page, 'earned'), 0);
    assert.equal(await page.textContent('#clock'), '2:00');
    await drag(page, 200, 420, 0, -40, () => window.__lumber.phase === 'playing');
    assert.equal(await lumber(page, 'phase'), 'playing');
    assert.ok(await page.isHidden('#hint'), 'no tutorial on the second shift');
    assert.ok(await page.isHidden('#modes'), 'the mode picker goes once the shift starts');
    console.log('✓ next shift starts fresh (no tutorial), as the Viking, in Rush Hour (2:00)');

    // 8b. The Rush Hour shift ends at 2:00 and goes to its own board.
    await page.evaluate(() => window.__lumber.autoplay(true));
    await page.evaluate(() => window.__lumber.skip(200));
    assert.equal(await lumber(page, 'phase'), 'over');
    assert.equal(await lumber(page, 'time'), 120);
    const rushScore = await lumber(page, 'earned');
    await page.waitForSelector('#over:not([hidden])', { timeout: 5_000 });
    assert.equal(await page.textContent('#over-label'), 'Rush Hour over');
    await page.waitForFunction(
      (s) =>
        (JSON.parse(localStorage.getItem('rally-harness:board:lumber:rush') || '[]') || []).some(
          (e) => e.userId === 'dev-user' && e.score === s,
        ),
      rushScore,
      { timeout: 10_000 },
    );
    await page.evaluate(() => window.__lumber.autoplay(false));
    console.log(`✓ Rush Hour → over at 2:00, $${rushScore} on the rush board`);

    // 9. exitRequested → the game saves and calls exit("host").
    await page.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await page.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    const overlay = await page.textContent('#rally-dev-harness >> [data-role="exit-overlay"]');
    assert.match(overlay, /game exited \(host\)/);
    console.log(`✓ exitRequested → exit() → overlay "${overlay.replace('reload', '').trim()}"`);

    // 10. Standalone (?nohost): plays with localStorage fallbacks, no bridge.
    const standalone = await context.newPage();
    standalone.on('pageerror', (e) => errors.push(e.message));
    await standalone.goto(`${LUMBER_URL}?nohost&lowfx=1`);
    assert.equal(await standalone.evaluate(() => typeof window.__rally), 'undefined');
    await standalone.waitForSelector('#loading', { state: 'hidden', timeout: 30_000 });
    await standalone.evaluate(() => window.__lumber.autoplay(true));
    await standalone.waitForFunction(() => window.__lumber.phase === 'playing');
    await standalone.evaluate(() => window.__lumber.skip(400));
    await standalone.waitForSelector('#over:not([hidden])');
    await standalone.waitForFunction(() =>
      /Offline · best \$/.test(document.querySelector('#over-board')?.textContent ?? ''),
    );
    console.log(`✓ ?nohost → standalone shift: "${await standalone.textContent('#over-board')}"`);

    const unexpected = errors.filter((e) => !/WebGPU|GPU stall|favicon/i.test(e));
    assert.deepEqual(unexpected, [], 'no page errors');
    console.log('\nPASS lumber e2e');
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
    console.error('\nFAIL lumber e2e:', err);
    stopServers();
    process.exit(1);
  });
