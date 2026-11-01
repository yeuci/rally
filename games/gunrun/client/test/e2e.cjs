/* eslint-disable @typescript-eslint/no-require-imports */
// End-to-end check of Gun Run through the dev harness: two players in two Chrome contexts, one room, a real game
// server with dev rules (not part of `pnpm test`: it needs two servers and a browser).
//
//   pnpm --filter @rally/game-gunrun test:e2e
//
// Starts the Colyseus game server on :2570 with RALLY_DEV_RULES=1 (the dev-only `dev` room message: bots, rules, place,
// hurt or promote a player) and Gun Run's Vite dev server (:5184) unless they are already running, drives Chromium with
// Playwright and asserts:
//   1. ?name=Alice and ?name=Bob → host matchmaking → one room; each scoreboard lists both (guests are guest-<name>).
//      Quick play fills Alice's room with bots; a dev command takes them out, so Bob's join starts a two-player match.
//   2. Three real kills: Bob is put in front of Alice (and hurt, so one pistol shot finishes him); she aims with the
//      mouse and holds the button. Each kill shows in both kill feeds; the third promotes her to the revolver (the
//      server's tier effect on Bob's page, her HUD's gun).
//   3. The knife: Alice is put on the last rung next to Bob and stabs with the knife button; the match is won, both
//      pages show the winner banner with the scoreboard and the server's guest `result` line.
//   4. Twin-stick touch on a phone-sized page: a left-half drag moves, a right-half finger fires, the knife button stabs.
//   5. Private room: ?private waits in the lobby with a code and a Start button; ?code= joins it; Start starts it.
//   6. exitRequested from the harness panel leaves the room at once (the other player sees one player fewer).
// Every page runs ?lowfx=1 (≤ 15 fps, DPR 1, no MSAA/shadows/effects) at a small viewport: two pages render WebGL in
// software (swiftshader) at once, and it must pass pinned to two cores (`taskset -c 0,1`).
// Env: GUNRUN_URL, COLYSEUS_URL (default http://localhost:2570), E2E_SCREENSHOT=<png path prefix>.
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../../../..');
const GAME_URL = (process.env.GUNRUN_URL || 'http://localhost:5184/').replace(/\/?$/, '/');
const COLYSEUS_URL = (process.env.COLYSEUS_URL || 'http://localhost:2570').replace(/\/+$/, '');
const COLYSEUS_PORT = new URL(COLYSEUS_URL).port || '80';
const SHOT = process.env.E2E_SCREENSHOT || path.join(os.tmpdir(), 'gunrun');
/** Small landscape pages: a quarter of a phone's pixels to render in software. */
const VIEW = { width: 640, height: 360 };
const JOIN_TIMEOUT_MS = 60_000;
/** The last rung of the ladder (the knife), as in the rules' LADDER. */
const FINAL_TIER = 8;

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
  if (await isUp(url)) {
    console.log(`· ${name} already running at ${url}`);
    return;
  }
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
  started.push({ name, child });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited early:\n${output}`);
    if (await isUp(url)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${name} did not come up at ${url} within 90 s:\n${output}`);
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

const t0 = Date.now();
let lap = t0;
function timed(line) {
  const now = Date.now();
  console.log(`${line}  [${((now - lap) / 1000).toFixed(1)} s]`);
  lap = now;
}
const passed = (msg) => timed(`✓ ${msg}`);

const probe = (page, expr) => page.evaluate(`window.__gunrun && window.__gunrun.${expr}`);
const dev = (page, cmd) => page.evaluate((c) => window.__gunrun.dev(c), cmd);
const player = (page, name) => page.evaluate((n) => window.__gunrun.player(n), name);

async function waitJoined(page, who) {
  try {
    await page.waitForFunction(() => window.__gunrun && window.__gunrun.joined, null, { timeout: JOIN_TIMEOUT_MS });
  } catch (err) {
    throw new Error(`${who}: not joined within ${JOIN_TIMEOUT_MS / 1000} s (page boot, matchmaking and join)`, {
      cause: err,
    });
  }
  assert.equal(await probe(page, 'lowfx'), true, `${who}: ?lowfx=1 in effect`);
}

async function open(browser, query, errors, { waitForJoin = true, viewport = VIEW, hasTouch = false } = {}) {
  const context = await browser.newContext({ viewport, hasTouch });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${query}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${query}: ${m.text()}`);
  });
  await page.goto(`${GAME_URL}?${query}&lowfx=1&colyseus=${encodeURIComponent(COLYSEUS_URL)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  if (waitForJoin) await waitJoined(page, `?${query}`);
  return page;
}

/** Synthetic touch pointer events on the canvas (they bubble to window, like real ones). */
function touch(page, type, pointerId, fx, fy = 0.6, target = 'stage') {
  return page.evaluate(
    ({ type, pointerId, fx, fy, target }) => {
      const c = document.getElementById(target);
      const r = document.getElementById('stage').getBoundingClientRect();
      c.dispatchEvent(
        new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: pointerId === 1,
          clientX: r.left + r.width * fx,
          clientY: r.top + r.height * fy,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { type, pointerId, fx, fy, target },
  );
}

/**
 * Alice shoots Bob with the mouse: Bob is put 4 units to her right (and hurt so one pistol shot is enough), she aims at
 * him and holds the button until his death shows on `watcher`'s page.
 */
async function mouseKill(alice, bob, watcher, n) {
  const killsBefore = await probe(watcher, 'killsSeen');
  // Bob is back from the last kill (a respawn would undo a teleport).
  await bob.waitForFunction(() => window.__gunrun.player('guest-Bob')?.alive === true, null, { timeout: 10_000 });
  await dev(alice, { cmd: 'place', x: -2, y: 0.4, aim: 0 });
  await dev(alice, { cmd: 'place', name: 'guest-Bob', x: 2, y: 0.4 });
  await bob.waitForFunction(
    () => {
      const b = window.__gunrun.player('guest-Bob');
      return b && b.alive && !b.prot && Math.abs(b.x - 2) < 0.05;
    },
    null,
    { timeout: 10_000 },
  );
  await dev(alice, { cmd: 'hurt', name: 'guest-Bob', damage: 90 });
  await alice.waitForFunction(() => window.__gunrun.player('guest-Bob').hp <= 10, null, { timeout: 5_000 });
  await alice.waitForFunction(() => Math.abs(window.__gunrun.player('guest-Alice').x + 2) < 0.05, null, {
    timeout: 5_000,
  });
  // Let Alice's camera settle on her new position, then aim the mouse at Bob and hold the button.
  await alice.waitForTimeout(500);
  await alice.bringToFront();
  const target = { x: 2, y: 0.4 };
  const at = await alice.evaluate(({ x, y }) => window.__gunrun.screenOf(x, y), target);
  await alice.mouse.move(at.x, at.y);
  await alice.mouse.down();
  const track = setInterval(() => {
    alice
      .evaluate(({ x, y }) => window.__gunrun.screenOf(x, y), target)
      .then((p) => alice.mouse.move(p.x, p.y))
      .catch(() => {});
  }, 250);
  try {
    await watcher.waitForFunction((k) => window.__gunrun.killsSeen > k, killsBefore, { timeout: 15_000 });
  } catch (err) {
    const state = await alice.evaluate(() => ({
      aim: window.__gunrun.aim,
      firing: window.__gunrun.firing,
      phase: window.__gunrun.phase,
      alice: window.__gunrun.player('guest-Alice'),
      bob: window.__gunrun.player('guest-Bob'),
    }));
    await alice.screenshot({ path: `${SHOT}-miss-${n}.png` });
    throw new Error(`kill ${n}: Alice's shots did not kill Bob: ${JSON.stringify(state)}`, { cause: err });
  } finally {
    clearInterval(track);
    await alice.mouse.up();
  }
}

async function main() {
  await ensureServer('game server (dev rules)', `${COLYSEUS_URL}/healthz`, '@rally/game-server', {
    PORT: COLYSEUS_PORT,
    RALLY_DEV_RULES: '1',
  });
  const { serverVersion, rooms } = await (await fetch(`${COLYSEUS_URL}/versions`)).json();
  assert.ok(serverVersion >= 4 && rooms.includes('gunrun'), `game server v${serverVersion} has no gunrun room`);
  await ensureServer('gunrun dev server', GAME_URL, '@rally/game-gunrun', { VITE_NO_HMR: '1' });

  // Seats of an earlier run's tabs are held for the 60 s reconnection grace; quick play would join that room.
  const deadline = Date.now() + 75_000;
  for (;;) {
    const listing = await (await fetch(`${COLYSEUS_URL}/rooms/gunrun`)).json();
    if (listing.rooms.length === 0) break;
    if (Date.now() > deadline) throw new Error(`public gunrun rooms still open: ${JSON.stringify(listing.rooms)}`);
    console.log(`· waiting for ${listing.rooms.length} leftover public room(s) to close…`);
    await new Promise((r) => setTimeout(r, 3000));
  }

  timed('· servers ready, no leftover rooms');
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  try {
    // 1. Alice joins quick play (bots fill her room); the bots go; Bob joins and the two of them get a match.
    const alice = await open(browser, 'name=Alice', errors);
    await alice.waitForFunction(() => window.__gunrun.names().length === 4, null, { timeout: 10_000 });
    const withBots = await alice.evaluate(() => window.__gunrun.names().map((n) => window.__gunrun.player(n).bot));
    assert.deepEqual(withBots.filter(Boolean).length, 3, 'quick play filled the room with three bots');
    await dev(alice, { cmd: 'bots', n: 0 });
    await dev(alice, { cmd: 'rules', rules: { respawnTime: 0.6, protectionTime: 0.2, overTime: 8, startingTime: 1 } });
    await alice.waitForFunction(() => window.__gunrun.names().join() === 'guest-Alice', null, { timeout: 10_000 });
    const bob = await open(browser, 'name=Bob', errors);
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => window.__gunrun.names().join() === 'guest-Alice,guest-Bob', null, {
        timeout: 10_000,
      });
      await page.waitForFunction(() => document.querySelectorAll('#board .row').length === 2, null, { timeout: 5_000 });
    }
    assert.equal(await probe(alice, 'roomId'), await probe(bob, 'roomId'), 'one room');
    const panel = await alice.textContent('#rally-dev-harness >> [data-role="log"]');
    assert.ok(panel.includes(`matchmade gunrun via ${COLYSEUS_URL} (quick, as "Alice")`), panel);
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => window.__gunrun.phase === 'playing', null, { timeout: 15_000 });
    }
    passed('Alice and Bob matchmade into one room (the bots made way); a two-player match started');

    // 2. Three real kills with the mouse: the third promotes Alice to the revolver.
    // The harness panel covers the right half of a small page: keep it out of the mouse's way while she aims.
    const hidePanel = await alice.addStyleTag({ content: '#rally-dev-harness { display: none !important; }' });
    const tiersBefore = await probe(bob, 'tiersSeen');
    for (let n = 1; n <= 3; n++) {
      await mouseKill(alice, bob, bob, n);
      await alice.waitForFunction((k) => window.__gunrun.player('guest-Alice').kills >= k, n, { timeout: 5_000 });
    }
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => window.__gunrun.player('guest-Alice').tier === 1, null, { timeout: 5_000 });
    }
    await bob.waitForFunction((n) => window.__gunrun.tiersSeen > n, tiersBefore, { timeout: 5_000 });
    assert.equal(await probe(alice, 'weapon'), 'revolver');
    await alice.waitForFunction(() => document.getElementById('gun-name').textContent === 'Revolver', null, {
      timeout: 5_000,
    });
    const feed = await probe(bob, 'feed');
    assert.equal(feed.filter((l) => l === 'guest-Alice>guest-Bob').length, 3, `Bob's kill feed: ${feed}`);
    assert.equal((await player(bob, 'guest-Bob')).deaths, 3);
    await alice.screenshot({ path: `${SHOT}-alice.png` });
    passed('three mouse kills: both feeds show them, the third promoted Alice to the revolver');

    // 3. The knife on the last rung wins: both pages show the winner, the scoreboard and the guest result line.
    const roomId = await probe(alice, 'roomId');
    const match = await probe(alice, 'match');
    await dev(alice, { cmd: 'setTier', tier: FINAL_TIER });
    // Bob on the third rung: the knife kill sends him down one.
    await dev(alice, { cmd: 'setTier', name: 'guest-Bob', tier: 2 });
    await bob.waitForFunction(() => window.__gunrun.player('guest-Bob')?.alive === true, null, { timeout: 10_000 });
    await dev(alice, { cmd: 'place', x: 0, y: 0.4, aim: 0 });
    await dev(alice, { cmd: 'place', name: 'guest-Bob', x: 1.1, y: 0.4 });
    await alice.waitForFunction(() => window.__gunrun.weapon === 'knife', null, { timeout: 5_000 });
    await bob.waitForFunction(
      () => {
        const b = window.__gunrun.player('guest-Bob');
        return b.alive && !b.prot && Math.abs(b.x - 1.1) < 0.05;
      },
      null,
      { timeout: 10_000 },
    );
    await alice.waitForFunction(() => document.getElementById('pips').textContent === 'knife kill wins', null, {
      timeout: 5_000,
    });
    // Face Bob (keyboard players aim with the stick: a tap right turns her toward him), then hold the knife button.
    await alice.evaluate(() => window.__gunrun.dev({ cmd: 'place', x: 0, y: 0.4, aim: 0 }));
    await alice.mouse.move(
      ...(await alice.evaluate(() => {
        const p = window.__gunrun.screenOf(1.1, 0.4);
        return [p.x, p.y];
      })),
    );
    const knife = await alice.$('#knife');
    const box = await knife.boundingBox();
    await alice.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await alice.mouse.down();
    try {
      for (const page of [alice, bob]) {
        await page.waitForFunction(() => window.__gunrun.phase === 'over', null, { timeout: 10_000 });
      }
    } finally {
      await alice.mouse.up();
      await hidePanel.evaluate((el) => el.remove());
    }
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => window.__gunrun.resultLine !== null, null, { timeout: 5_000 });
      assert.deepEqual(await probe(page, 'resultLine'), { kind: 'guest', text: 'Guest: sign in to keep your stats' });
      assert.deepEqual(await probe(page, 'result'), {
        matchId: `${roomId}:${match}`,
        recorded: false,
        reason: 'guest',
      });
      assert.equal(await probe(page, 'winner'), 'guest-Alice');
      assert.equal(await page.locator('#banner .standings tbody tr').count(), 2, 'the scoreboard');
    }
    assert.equal(await alice.textContent('#banner-title'), 'You win!');
    assert.equal(await bob.textContent('#banner-title'), 'guest-Alice wins!');
    // The kill effect plays at Bob's render time (a couple of patches behind the state that ended the match).
    await bob
      .waitForFunction(() => window.__gunrun.feed.includes('guest-Alice>guest-Bob demoted'), null, { timeout: 5_000 })
      .catch(() => {});
    const bobFeed = await probe(bob, 'feed');
    assert.ok(bobFeed.includes('guest-Alice>guest-Bob demoted'), `the knife kill demoted Bob (Bob's feed: ${bobFeed})`);
    await bob.screenshot({ path: `${SHOT}-result.png` });
    passed(
      `knife win: "You win!" / "guest-Alice wins!" with the scoreboard and the guest result line (${SHOT}-result.png)`,
    );

    // 4. exitRequested → Alice leaves at once; Bob sees one player.
    await alice.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await alice.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    await bob.waitForFunction(() => !window.__gunrun.names().includes('guest-Alice'), null, { timeout: 5_000 });
    passed('exitRequested → Alice left the room at once');
    await alice.context().close();
    await bob.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await bob.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    await bob.context().close();

    // 5. Private room by code, started from the lobby; twin-stick touch and the knife button on Cleo's page.
    const cleo = await open(browser, 'name=Cleo&private', errors, { hasTouch: true });
    await cleo.waitForFunction(() => /^[A-Z2-9]{6}$/.test(window.__gunrun.code), null, { timeout: 10_000 });
    const code = await probe(cleo, 'code');
    await cleo.waitForFunction(
      (c) =>
        window.__gunrun.banner === 'Private room' && document.querySelector('[data-role="code"]')?.textContent === c,
      code,
      { timeout: 5_000 },
    );
    assert.equal(await probe(cleo, 'phase'), 'waiting');
    assert.equal(await cleo.isVisible('#start'), true, 'Start button');
    assert.deepEqual(await probe(cleo, 'names()'), ['guest-Cleo'], 'no bots in a private room');
    await touch(cleo, 'pointerdown', 1, 0.2);
    await touch(cleo, 'pointermove', 1, 0.2 + 70 / VIEW.width);
    assert.equal((await probe(cleo, 'stick')).x, 1, 'drag right = full move');
    await touch(cleo, 'pointerdown', 2, 0.6);
    assert.equal(await probe(cleo, 'firing'), true, 'right thumb down = fire');
    await touch(cleo, 'pointerdown', 3, 0.95, 0.9, 'knife');
    assert.equal(await probe(cleo, 'melee'), true, 'the knife button stabs');
    await touch(cleo, 'pointerup', 3, 0.95, 0.9, 'knife');
    assert.equal((await probe(cleo, 'stick')).x, 1, 'still moving after the knife finger lifted');
    await touch(cleo, 'pointerup', 2, 0.6);
    await touch(cleo, 'pointerup', 1, 0.2 + 70 / VIEW.width);
    assert.deepEqual(await probe(cleo, 'stick'), { x: 0, y: 0 }, 'released by its own finger');
    assert.equal(await probe(cleo, 'firing'), false);
    const dan = await open(browser, `name=Dan&code=${code.toLowerCase()}`, errors);
    for (const page of [cleo, dan]) {
      await page.waitForFunction(() => window.__gunrun.names().join() === 'guest-Cleo,guest-Dan', null, {
        timeout: 10_000,
      });
    }
    const listing = await (await fetch(`${COLYSEUS_URL}/rooms/gunrun`)).json();
    assert.ok(!listing.rooms.some((r) => r.metadata.code === code), 'private room not listed');
    await cleo.screenshot({ path: `${SHOT}-private.png` });
    await cleo.click('#start');
    await dan.waitForFunction(() => ['starting', 'playing'].includes(window.__gunrun.phase), null, { timeout: 10_000 });
    passed(`private room ${code}: lobby with a code, Dan joined by code, Start started the match; touch + knife OK`);
    for (const page of [cleo, dan]) {
      await page.click('#rally-dev-harness >> button[data-action="exitRequested"]');
      await page.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    }

    const unexpected = errors.filter((e) => !/WebGPU|GPU stall|favicon|Automatic fallback to software WebGL/i.test(e));
    assert.deepEqual(unexpected, [], 'no page errors');
    console.log(`\nPASS gunrun e2e in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
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
    console.error('\nFAIL gunrun e2e:', err);
    stopServers();
    process.exit(1);
  });
