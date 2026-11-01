/* eslint-disable @typescript-eslint/no-require-imports */
// End-to-end check of Sawline through the dev harness (fake Rally host) in a real browser.
//
//   pnpm --filter @rally/game-sawline test:e2e
//
// Starts the Vite dev server (:5196, harness plugin on) unless it is already running, drives Chromium with Playwright
// and asserts: boot → ready(), holding DEBARK starts the shift and strips the trunk (the line waits with "HOLD" when
// released), a CUT tap on the mark makes a log and shows the verdict, the greedy bot (dev probe) sells planks and buys
// an upgrade from the shop, pause/resume freeze/continue the shift clock, skipping to the whistle shows the results
// card with earnings / best / leaderboard rank, leaderboard.submit + achievement.unlock('first_truck') + save.put
// reached the harness, the results card's stars, the mode picker (Precision locked, then unlocked: its strike pips, three
// untapped rough cuts stop the line, its own board), exitRequested → save → exit("host"), and ?nohost plays standalone.
// Every page runs the dev-only ?lowfx=1 mode (≤ 15 fps, DPR 1, no MSAA or shadows): CI renders WebGL in software on a
// small runner, and at full quality the shift clock crawls.
// Env: SAWLINE_URL, E2E_SCREENSHOT=<png path> (default <tmp>/sawline.png).
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../../../..');
const SAWLINE_URL = process.env.SAWLINE_URL || 'http://localhost:5196/';
const SCREENSHOT = process.env.E2E_SCREENSHOT || path.join(os.tmpdir(), 'sawline.png');

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
const sawline = (page, expr) => page.evaluate(`window.__sawline.${expr}`);
const local = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key);

/** Centre of an element (for holding a button with the mouse). */
async function centre(page, selector) {
  const b = await page.locator(selector).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function main() {
  await ensureServer('sawline dev server', SAWLINE_URL, '@rally/game-sawline');

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
    await page.goto(`${SAWLINE_URL}?lowfx=1`);
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('rally-harness:')) localStorage.removeItem(k);
    });
    await page.reload();

    // 1. Boot through the fake host.
    assert.equal(await sawline(page, 'lowfx'), true, '?lowfx=1 in effect');
    await page.waitForSelector('#loading', { state: 'hidden', timeout: 30_000 });
    await page.waitForSelector('#prompt:not([hidden])');
    assert.equal(await page.textContent('#clock'), '4:00');
    let log = await panelLog(page);
    assert.match(log, /ready\(\) after \d+ ms/);
    assert.match(log, /← save\.get ok/);
    assert.match(log, /boards earnings, precision, 6 achievement\(s\)/);
    assert.equal(await sawline(page, 'phase'), 'ready');
    assert.equal(await page.locator('#shop button').count(), 4);
    console.log('✓ boot: ui.loading → save.get → ready(); prompt, four upgrades on offer');

    // 2. Holding DEBARK starts the shift and strips the trunk; releasing it leaves the line waiting ("HOLD").
    // At phone width the expanded harness panel covers the controls: collapse it while playing by hand.
    const togglePanel = () => page.click('#rally-dev-harness >> [data-role="head"]');
    await togglePanel();
    const debark = await centre(page, '#debark');
    await page.mouse.move(debark.x, debark.y);
    await page.mouse.down();
    assert.equal(await sawline(page, 'phase'), 'playing');
    await page.waitForSelector('#hint:not([hidden])');
    assert.equal(await page.textContent('#hint'), 'Hold DEBARK to strip the trunk');
    await page.waitForFunction(() => window.__sawline.sim.items.some((i) => i.debarked > 1), null, { timeout: 60_000 });
    await page.mouse.up();
    await page.waitForFunction(
      () => window.__sawline.sim.debarkerBlocked || (window.__sawline.sawDepth ?? 0) > 0,
      null,
      {
        timeout: 60_000,
      },
    );
    console.log('✓ holding DEBARK starts the shift and strips bark; the tutorial asks for it');

    // 3. Hold again until a debarked trunk reaches the saw, then tap CUT (Space) near the mark.
    await page.mouse.down();
    await page.waitForFunction(() => (window.__sawline.sawDepth ?? 0) > 1.5, null, { timeout: 60_000 });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => {
      const c = window.__sawline.cuts;
      return c.perfect + c.good + c.off > 0;
    });
    await page.mouse.up();
    const cuts = await sawline(page, 'cuts');
    await page.waitForSelector('#labels .float');
    console.log(`✓ CUT on the mark makes a log (${JSON.stringify(cuts)}) and shows the verdict`);

    // 4. The bot plays: planks reach the trucks, money comes in, an upgrade gets bought.
    await page.evaluate(() => window.__sawline.autoplay(true));
    await page.waitForFunction(() => window.__sawline.earned > 0, null, { timeout: 120_000 });
    await page.waitForFunction(() => window.__sawline.upgrades.length >= 1, null, { timeout: 120_000 });
    assert.match(await page.textContent('#earned-amount'), /^\$\d/);
    console.log(
      `✓ bot sells planks ($${await sawline(page, 'earned')}) and buys ${(await sawline(page, 'upgrades')).join(', ')}`,
    );
    const playing = SCREENSHOT.replace(/\.png$/, '-playing.png');
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = 'none'));
    await page.screenshot({ path: playing });
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = ''));

    // 5. Pause / resume from the harness panel freeze and continue the shift clock.
    await togglePanel();
    await page.click('#rally-dev-harness >> button[data-action="pause"]');
    await page.waitForSelector('#paused:not([hidden])');
    assert.equal(await sawline(page, 'paused'), true);
    const t0 = await sawline(page, 'time');
    await page.waitForTimeout(600);
    assert.equal(await sawline(page, 'time'), t0, 'shift frozen while paused');
    await page.click('#rally-dev-harness >> button[data-action="resume"]');
    await page.waitForSelector('#paused', { state: 'hidden' });
    await page.waitForFunction((t) => window.__sawline.time > t + 0.1, t0, { timeout: 5_000 });
    console.log(`✓ pause freezes the shift clock (${t0.toFixed(2)} s), resume continues`);

    // 6. lowMemory is handled without disrupting play.
    await page.click('#rally-dev-harness >> button[data-action="lowMemory"]');
    await page.waitForFunction((t) => window.__sawline.time > t + 0.5, t0, { timeout: 10_000 });
    console.log('✓ lowMemory → trimmed, still running');

    // 7. Skip to the whistle (bot off, so the score stays a believable one for the harness' rate bound).
    await page.evaluate(() => window.__sawline.autoplay(false));
    await page.evaluate(() => window.__sawline.skip(400));
    assert.equal(await sawline(page, 'phase'), 'over');
    const score = await sawline(page, 'earned');
    await page.waitForSelector('#over:not([hidden])', { timeout: 5_000 });
    assert.equal(await page.textContent('#over-score'), `$${score.toLocaleString('en-US')}`);
    assert.equal(await page.textContent('#over-best'), 'New best!');
    assert.match(await page.textContent('#over-stats'), /^Trucks \d+ · Perfect \d+\/\d+ · Best combo \d+$/);
    const stars = await page.evaluate(() => document.querySelectorAll('#over-stars i.on').length);
    assert.equal(stars, [2000, 3500, 5000].filter((s) => score >= s).length, `stars for $${score}`);
    await page.waitForFunction(
      () => /#\d+ global/.test(document.querySelector('#over-board')?.textContent ?? ''),
      null,
      {
        timeout: 10_000,
      },
    );
    const board = await page.textContent('#over-board');
    assert.match(await page.textContent('#over-unlocked'), /First Delivery/);
    console.log(
      `✓ whistle → results: ${await page.textContent('#over-score')}, "${await page.textContent('#over-stats')}", "${board}"`,
    );

    // 8. Harness side: leaderboard.submit / achievement.unlock / save.put went through the bridge.
    const entries = await local(page, 'rally-harness:board:sawline:earnings');
    const mine = entries.find((e) => e.userId === 'dev-user');
    assert.equal(mine?.score, score, 'dev user on the harness board');
    const achievements = await local(page, 'rally-harness:ach:sawline:dev-user');
    assert.ok(achievements.includes('first_truck'), `achievements ${JSON.stringify(achievements)}`);
    log = await panelLog(page);
    assert.match(log, /← leaderboard\.submit ok/);
    assert.match(log, /← leaderboard\.top ok/);
    await page.waitForFunction(
      (s) =>
        JSON.parse(localStorage.getItem('rally-harness:save:sawline:progress') || 'null')?.data?.bests?.classic === s,
      score,
      { timeout: 10_000 },
    );
    const saved = await local(page, 'rally-harness:save:sawline:progress');
    assert.deepEqual(saved.data, { bests: { classic: score, precision: 0 }, played: 1, mode: 'classic', version: 2 });
    console.log(
      `✓ harness: board ${mine.username}=$${mine.score}, achievements [${achievements.join(', ')}], save ${JSON.stringify(saved.data)}`,
    );

    await page.waitForTimeout(800);
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = 'none'));
    await page.screenshot({ path: SCREENSHOT });
    await page.evaluate(() => (document.getElementById('rally-dev-harness').style.display = ''));
    console.log(`  screenshots: ${SCREENSHOT}, ${playing}`);

    // 9. Next shift: a fresh line, no tutorial the second time.
    await togglePanel();
    await page.click('#again');
    await togglePanel();
    await page.waitForSelector('#prompt:not([hidden])');
    assert.equal(await sawline(page, 'phase'), 'ready');
    assert.equal(await sawline(page, 'earned'), 0);
    await page.keyboard.down('KeyD');
    await page.waitForFunction(() => window.__sawline.phase === 'playing');
    await page.keyboard.up('KeyD');
    assert.ok(await page.isHidden('#hint'), 'no tutorial on the second shift');
    console.log('✓ next shift starts fresh from the keyboard (no tutorial)');
    await page.keyboard.down('KeyD');
    await page.evaluate(() => window.__sawline.skip(400));
    await page.keyboard.up('KeyD');
    await page.waitForSelector('#over:not([hidden])', { timeout: 5_000 });

    // 9b. Modes: Precision is locked until 2 stars; unlocked, it shows strike pips and three untapped (rough) cuts stop
    // the line early, on its own board.
    await togglePanel();
    await page.click('#again');
    await page.waitForSelector('#modes:not([hidden])');
    if ((await sawline(page, 'stars')) < 2) {
      await page.click('#modes [data-mode="precision"]');
      assert.equal(await page.textContent('#hint'), 'Earn 2 ★ to unlock Precision');
      assert.equal(await sawline(page, 'mode'), 'classic');
      await page.evaluate(() => window.__sawline.setBests({ classic: 3500 }));
    }
    await page.click('#modes [data-mode="precision"]');
    await togglePanel();
    assert.equal(await sawline(page, 'mode'), 'precision');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#strikes:not([hidden]) i').length), 3);
    await page.keyboard.down('KeyD');
    // The key starts the shift at once; the hold reaches the sim on the next frame.
    await page.waitForFunction(() => window.__sawline.sim.ringRunning);
    await page.evaluate(() => window.__sawline.skip(400));
    await page.keyboard.up('KeyD');
    assert.equal(await sawline(page, 'phase'), 'over');
    assert.equal(await sawline(page, 'strikes'), 3);
    const stoppedAt = await sawline(page, 'time');
    assert.ok(stoppedAt < 240, `stopped early (${stoppedAt} s)`);
    await page.waitForSelector('#over:not([hidden])', { timeout: 5_000 });
    assert.equal(await page.textContent('#over-label'), 'Line stopped · 3 bad cuts');
    const precisionScore = await sawline(page, 'earned');
    await page.waitForFunction(
      (s) =>
        (JSON.parse(localStorage.getItem('rally-harness:board:sawline:precision') || '[]') || []).some(
          (e) => e.userId === 'dev-user' && e.score === s,
        ),
      precisionScore,
      { timeout: 10_000 },
    );
    console.log(
      `✓ Precision: locked → unlocked, 3 rough cuts stop the line at ${stoppedAt.toFixed(1)} s, $${precisionScore} on its board`,
    );

    // 10. exitRequested → the game saves and calls exit("host").
    await page.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await page.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    const overlay = await page.textContent('#rally-dev-harness >> [data-role="exit-overlay"]');
    assert.match(overlay, /game exited \(host\)/);
    console.log(`✓ exitRequested → exit() → overlay "${overlay.replace('reload', '').trim()}"`);

    // 11. Standalone (?nohost): plays with localStorage fallbacks, no bridge.
    const standalone = await context.newPage();
    standalone.on('pageerror', (e) => errors.push(e.message));
    await standalone.goto(`${SAWLINE_URL}?nohost&lowfx=1`);
    assert.equal(await standalone.evaluate(() => typeof window.__rally), 'undefined');
    await standalone.waitForSelector('#loading', { state: 'hidden', timeout: 30_000 });
    await standalone.evaluate(() => window.__sawline.autoplay(true));
    await standalone.waitForFunction(() => window.__sawline.phase === 'playing');
    await standalone.evaluate(() => {
      window.__sawline.autoplay(false);
      window.__sawline.skip(400);
    });
    await standalone.waitForSelector('#over:not([hidden])');
    await standalone.waitForFunction(() =>
      /Offline · best \$/.test(document.querySelector('#over-board')?.textContent ?? ''),
    );
    console.log(`✓ ?nohost → standalone shift: "${await standalone.textContent('#over-board')}"`);

    const unexpected = errors.filter((e) => !/WebGPU|GPU stall|favicon/i.test(e));
    assert.deepEqual(unexpected, [], 'no page errors');
    console.log('\nPASS sawline e2e');
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
    console.error('\nFAIL sawline e2e:', err);
    stopServers();
    process.exit(1);
  });
