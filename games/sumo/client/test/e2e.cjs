/* eslint-disable @typescript-eslint/no-require-imports */
// End-to-end check of Sumo through the dev harness: two "players" in two Chrome contexts, one room, a real game
// server (not part of `pnpm test`: it needs two servers and a browser).
//
//   pnpm --filter @rally/game-sumo test:e2e
//
// Starts the Colyseus game server (:2567) and Sumo's Vite dev server (:5182) unless they are already running,
// drives Chromium with Playwright and asserts:
//   1. ?name=Alice and ?name=Bob → host matchmaking → both in the same room; each HUD lists both names (guests are
//      always shown as guest-<name> by the server).
//   2. With two players a round starts (3-2-1 countdown → playing); arrow keys move your own puck (seen in the
//      other player's state, so it went through the server).
//   3. Private room: ?private → "Waiting for players" with a 6-character code; ?code=<code> joins that room, not the
//      public one. A long name is ellipsized but "(you)" stays visible; a second finger lifting does not end the
//      joystick drag.
//   4. The harness panel's name field renames the player (reload with ?name=).
//   5. exitRequested from the panel → the game leaves the room → the other player sees one player fewer.
//   6. exitRequested while the room's socket is still connecting → the game leaves as soon as it lands (no ghost).
// Env: SUMO_URL, COLYSEUS_URL, E2E_SCREENSHOT=<png path prefix> (default <tmp>/sumo).
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../../../..');
const SUMO_URL = (process.env.SUMO_URL || 'http://localhost:5182/').replace(/\/?$/, '/');
const COLYSEUS_URL = process.env.COLYSEUS_URL || 'http://localhost:2567';
const SHOT = process.env.E2E_SCREENSHOT || path.join(os.tmpdir(), 'sumo');

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

const sumo = (page, expr) => page.evaluate(`window.__sumo && window.__sumo.${expr}`);
const chipNames = (page) => page.$$eval('#scores .chip', (els) => els.map((e) => e.dataset.name).sort());

async function open(browser, query, errors, { waitForJoin = true, beforeGoto } = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 620 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${query}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${query}: ${m.text()}`);
  });
  if (beforeGoto) await beforeGoto(page);
  // Every page renders WebGL in software (swiftshader); `load` can take a while on a busy machine, and the
  // game's own __sumo probe is what we wait for anyway.
  await page.goto(`${SUMO_URL}?${query}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (waitForJoin) {
    await page.waitForFunction(() => window.__sumo && window.__sumo.joined, null, { timeout: 30_000 });
  }
  return page;
}

/** Synthetic touch pointer events on the canvas (they bubble to window, like real ones). */
function touch(page, type, pointerId, dx = 0) {
  return page.evaluate(
    ({ type, pointerId, dx }) => {
      const c = document.getElementById('stage');
      const r = c.getBoundingClientRect();
      c.dispatchEvent(
        new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: pointerId === 1,
          clientX: r.left + r.width / 2 + dx,
          clientY: r.top + r.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { type, pointerId, dx },
  );
}

async function main() {
  await ensureServer('game server', `${COLYSEUS_URL}/healthz`, '@rally/game-server');
  await ensureServer('sumo dev server', SUMO_URL, '@rally/game-sumo');

  // Seats of an earlier run's tabs are held for the 30 s reconnection grace; quick play would join that room.
  const deadline = Date.now() + 45_000;
  for (;;) {
    const { rooms } = await (await fetch(`${COLYSEUS_URL}/rooms/sumo`)).json();
    if (rooms.length === 0) break;
    if (Date.now() > deadline) throw new Error(`public sumo rooms still open: ${JSON.stringify(rooms)}`);
    if (rooms.length) console.log(`· waiting for ${rooms.length} leftover public room(s) to close…`);
    await new Promise((r) => setTimeout(r, 3000));
  }

  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  try {
    // 1. Two players, one room, each sees both in the HUD.
    const alice = await open(browser, 'name=Alice', errors);
    await alice.waitForFunction(
      () =>
        window.__sumo.phase === 'waiting' &&
        /Waiting for players/.test(document.querySelector('#banner-title').textContent),
      null,
      { timeout: 10_000 },
    );
    const bob = await open(browser, 'name=Bob', errors);
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => window.__sumo.names().join() === 'guest-Alice,guest-Bob', null, {
        timeout: 10_000,
      });
      await page.waitForFunction(() => document.querySelectorAll('#scores .chip').length === 2, null, {
        timeout: 5_000,
      });
      assert.deepEqual(await chipNames(page), ['guest-Alice', 'guest-Bob']);
    }
    assert.equal(await alice.textContent('#scores .chip.me .name'), 'guest-Alice');
    assert.equal(await alice.textContent('#scores .chip.me .tag'), '(you)');
    assert.equal(await bob.textContent('#scores .chip.me .name'), 'guest-Bob');
    const panel = await alice.textContent('#rally-dev-harness >> [data-role="log"]');
    assert.match(panel, /matchmade sumo via http:\/\/localhost:2567 \(quick, as "Alice"\)/);
    console.log('✓ Alice and Bob matchmade through the harness into one room; both HUDs list both players');

    // 2. A round starts; keyboard input moves Alice's puck on the server.
    await alice.waitForFunction(() => window.__sumo.phase === 'countdown', null, { timeout: 10_000 });
    assert.match(await alice.textContent('#banner-title'), /^[123]$/);
    await Promise.all(
      [alice, bob].map((p) => p.waitForFunction(() => window.__sumo.phase === 'playing', null, { timeout: 10_000 })),
    );
    assert.equal(await sumo(alice, 'round'), 1);
    console.log('✓ countdown 3-2-1 → round 1 playing on both clients');
    const before = await bob.evaluate(() => window.__sumo.position('guest-Alice'));
    await alice.bringToFront();
    await alice.keyboard.down('ArrowLeft');
    await alice.waitForTimeout(450);
    await alice.keyboard.up('ArrowLeft');
    await bob.waitForFunction((x0) => window.__sumo.position('guest-Alice').x < x0 - 0.5, before.x, {
      timeout: 5_000,
    });
    const after = await bob.evaluate(() => window.__sumo.position('guest-Alice'));
    console.log(
      `✓ ArrowLeft on Alice's tab moved her puck on the server (x ${before.x.toFixed(2)} → ${after.x.toFixed(2)}, seen by Bob)`,
    );
    const rtt = await sumo(alice, 'rtt');
    assert.ok(typeof rtt === 'number', 'ping measured');
    assert.match(await alice.textContent('#ping'), /ping \d+ ms/);
    await alice.screenshot({ path: `${SHOT}-alice.png` });
    await bob.screenshot({ path: `${SHOT}-bob.png` });
    console.log(`  screenshots: ${SHOT}-alice.png, ${SHOT}-bob.png`);

    // 3. Private room by code. Cleo has a long name (guest-Cleopatra_VI).
    const cleo = await open(browser, 'name=Cleopatra_VII&private', errors);
    await cleo.waitForFunction(() => /^[A-Z2-9]{6}$/.test(window.__sumo.code), null, { timeout: 10_000 });
    const code = await sumo(cleo, 'code');
    await cleo.waitForFunction(
      (c) =>
        /Waiting for players/.test(document.querySelector('#banner-title').textContent) &&
        document.querySelector('[data-role="code"]')?.textContent === c,
      code,
      { timeout: 5_000 },
    );
    // The name is ellipsized, the "(you)" tag next to it is not clipped.
    await cleo.waitForSelector('#scores .chip.me .tag', { timeout: 5_000 });
    const chip = await cleo.evaluate(() => {
      const c = document.querySelector('#scores .chip.me');
      const name = c.querySelector('.name');
      const tag = c.querySelector('.tag');
      const cr = c.getBoundingClientRect();
      const tr = tag.getBoundingClientRect();
      return {
        tag: tag.textContent,
        clipped: name.scrollWidth > name.clientWidth,
        tagInside: tr.width > 0 && tr.left >= cr.left && tr.right <= cr.right + 0.5,
      };
    });
    assert.deepEqual(chip, { tag: '(you)', clipped: true, tagInside: true }, 'long name: "(you)" stays visible');
    // Joystick: a second finger lifting elsewhere does not end the first finger's drag.
    await touch(cleo, 'pointerdown', 1);
    await touch(cleo, 'pointermove', 1, 60);
    assert.equal((await sumo(cleo, 'stick')).x, 1, 'drag right = full stick');
    await touch(cleo, 'pointerdown', 2, -200);
    await touch(cleo, 'pointerup', 2, -200);
    assert.equal((await sumo(cleo, 'stick')).x, 1, 'still dragging after the second finger lifted');
    await touch(cleo, 'pointerup', 1, 60);
    assert.deepEqual(await sumo(cleo, 'stick'), { x: 0, y: 0 }, 'released by its own finger');
    console.log('✓ long name ellipsized with "(you)" visible; a second finger does not release the joystick');

    const dan = await open(browser, `name=Dan&code=${code.toLowerCase()}`, errors);
    for (const page of [cleo, dan]) {
      await page.waitForFunction(() => window.__sumo.names().join() === 'guest-Cleopatra_VI,guest-Dan', null, {
        timeout: 10_000,
      });
    }
    assert.deepEqual(
      await alice.evaluate(() => window.__sumo.names()),
      ['guest-Alice', 'guest-Bob'],
      'public room untouched',
    );
    const listing = await (await fetch(`${COLYSEUS_URL}/rooms/sumo`)).json();
    assert.ok(
      listing.rooms.some((r) => r.metadata.players === 2 && !r.metadata.private),
      'public room listed',
    );
    assert.ok(!listing.rooms.some((r) => r.metadata.code === code), 'private room not listed');
    await cleo.screenshot({ path: `${SHOT}-private.png` });
    // The room id alone does not get anyone in: joinById into a private room needs the code.
    const bare = await fetch(`${COLYSEUS_URL}/matchmake/joinById/${await sumo(cleo, 'roomId')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Snoop' }),
    });
    assert.ok(!bare.ok, 'joinById without the code is refused');
    console.log(`✓ private room ${code}: Cleo waits with the code, Dan joins by code; the listing hides it`);

    // 4. Rename from the harness panel.
    await dan.fill('#rally-dev-harness >> [data-role="name"]', 'Danny');
    await dan.click('#rally-dev-harness >> [data-role="name-form"] button');
    await dan.waitForURL(/name=Danny/, { waitUntil: 'commit', timeout: 30_000 });
    await dan.waitForFunction(() => window.__sumo && window.__sumo.joined, null, { timeout: 30_000 });
    // ?code= survives the reload, so Danny lands in Cleo's room again ("Dan" is held offline for the grace).
    await cleo.waitForFunction(() => window.__sumo.names().includes('guest-Danny'), null, { timeout: 15_000 });
    console.log('✓ harness panel "set name" → reload as Danny, back in the same private room');

    // 5. exitRequested → the game leaves its room (consented) → Bob sees Alice gone.
    await alice.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await alice.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    await bob.waitForFunction(() => window.__sumo.names().join() === 'guest-Bob', null, { timeout: 5_000 });
    console.log('✓ exitRequested → Alice left the room at once (no reconnection grace) → exit overlay');

    // Pages that are done: fewer software-rendered WebGL contexts for the rest.
    await Promise.all([alice, cleo, dan].map((p) => p.context().close()));

    // 6. Exit while the socket join is in flight: hold Eve's WebSocket to the game server until after the click.
    let release;
    const gate = new Promise((r) => (release = r));
    let connecting;
    const seen = new Promise((r) => (connecting = r));
    const eve = await open(browser, 'name=Eve', errors, {
      waitForJoin: false,
      beforeGoto: (page) =>
        page.routeWebSocket(/:2567\//, async (ws) => {
          connecting();
          await gate;
          ws.connectToServer();
        }),
    });
    await seen;
    await eve.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await eve.waitForTimeout(300);
    release();
    await eve.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    // Eve may show up for a moment while her socket lands; she must be gone right after (not held, not staying).
    await bob.waitForFunction(() => window.__sumo.names().join() === 'guest-Bob', null, { timeout: 5_000 });
    await bob.waitForTimeout(1000);
    assert.deepEqual(await bob.evaluate(() => window.__sumo.names()), ['guest-Bob'], 'no ghost seat for Eve');
    assert.equal(await sumo(eve, 'joined'), false);
    console.log('✓ exitRequested during the join → Eve left as soon as her socket landed (no ghost seat)');

    const unexpected = errors.filter((e) => !/WebGPU|GPU stall|favicon|Automatic fallback to software WebGL/i.test(e));
    assert.deepEqual(unexpected, [], 'no page errors');
    console.log('\nPASS sumo e2e');
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
    console.error('\nFAIL sumo e2e:', err);
    stopServers();
    process.exit(1);
  });
