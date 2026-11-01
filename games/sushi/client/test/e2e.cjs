/* eslint-disable @typescript-eslint/no-require-imports */
// End-to-end check of Sushi Shift through the dev harness: two chefs in two Chrome contexts, one room, a real game
// server with dev rules (not part of `pnpm test`: it needs two servers and a browser).
//
//   pnpm --filter @rally/game-sushi test:e2e
//
// Starts the Colyseus game server on :2571 with RALLY_DEV_RULES=1 (the dev-only `dev` room message: rules, skip to a
// day, spawn a customer, give an item, stars, a plate on the belt, close) and Sushi Shift's Vite dev server (:5185)
// unless they are already running, drives Chromium with Playwright and asserts:
//   1. ?name=Alice and ?name=Bob → host matchmaking → one room; each sees both chefs; the host menu got its settings
//      and How to play (menu.define) and the People list (menu.players).
//   2. A nigiri with the real controls (the keyboard's button on the highlighted station): the salmon crate → the
//      board (hold to chop) → the rice pot (cook, wait, scoop) → the mat (hold to roll) → the plates → the belt.
//      A customer on a stool takes it as it passes: both pages see the coin, the money and tip register.
//   3. A plate past its stale time shows as stale (the slot, the fly tag) on both pages.
//   4. Skipping to Wednesday opens the dining room (zones, the camera reframes); a table customer's bubble shows.
//   5. Closing the day: the night's summary, three cards, both chefs vote, the card wins, Thursday's morning; the
//      guest result line.
//   6. Touch on a phone-sized page: a drag anywhere moves the chef, the button presses (its own finger).
//   7. Private room: ?private waits in the lobby with a code; ?code= joins it; Start opens the restaurant.
//   8. exitRequested from the harness panel leaves the room at once.
// Every page runs ?lowfx=1 (≤ 15 fps, DPR 1, no MSAA/shadows/effects) at a small viewport: two pages render WebGL in
// software (swiftshader) at once, and it must pass pinned to two cores (`taskset -c 0,1`).
// Env: SUSHI_URL, COLYSEUS_URL (default http://localhost:2571), E2E_SCREENSHOT=<png path prefix>.
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../../../..');
const GAME_URL = (process.env.SUSHI_URL || 'http://localhost:5185/').replace(/\/?$/, '/');
const COLYSEUS_URL = (process.env.COLYSEUS_URL || 'http://localhost:2571').replace(/\/+$/, '');
const COLYSEUS_PORT = new URL(COLYSEUS_URL).port || '80';
const SHOT = process.env.E2E_SCREENSHOT || path.join(os.tmpdir(), 'sushi');
const VIEW = { width: 640, height: 300 };
const JOIN_TIMEOUT_MS = 90_000;

// Kinds, stations and seats as in the rules (games/sushi/server/src/recipes.ts, map.ts).
const K = { SalmonFish: 1, Rice: 11, Salmon: 13, SalmonNigiri: 21, SalmonRoll: 26, Ramen: 30 };
const ST = { salmonCrate: 0, rice: 9, board: 19, mat: 21, plates: 23 };
const STAND = {
  salmonCrate: { x: -5.75, y: -4.65 },
  rice: { x: 0.6, y: -4.65 },
  board: { x: -2.5, y: -2.15 },
  mat: { x: -0.5, y: -2.15 },
  plates: { x: 1.5, y: -2.15 },
  pass: { x: -1.0, y: -1.72 },
};
const FRONT_STOOL = 3; // the middle stool of the front straight (rank 0)
const DINING_TABLE_SEAT = 13; // the first dining-room chair

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

const probe = (page, expr) => page.evaluate(`window.__sushi && window.__sushi.${expr}`);
const dev = (page, cmd) => page.evaluate((c) => window.__sushi.dev(c), cmd);

async function waitJoined(page, who) {
  try {
    await page.waitForFunction(() => window.__sushi && window.__sushi.joined, null, { timeout: JOIN_TIMEOUT_MS });
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

/** Stand Alice somewhere, and wait until the server has her there and her page highlights `target`. */
async function standAt(page, name, at, target) {
  await dev(page, { cmd: 'place', x: at.x, y: at.y });
  await page.waitForFunction(
    ({ name, at }) => {
      const p = window.__sushi.player(name);
      return p && Math.abs(p.x - at.x) < 0.05 && Math.abs(p.y - at.y) < 0.05;
    },
    { name, at },
    { timeout: 10_000 },
  );
  if (target !== undefined) {
    await page
      .waitForFunction((t) => window.__sushi.target === t, target, { timeout: 10_000 })
      .catch(async (err) => {
        throw new Error(`highlight ${target} at ${JSON.stringify(at)}: got ${await probe(page, 'target')}`, {
          cause: err,
        });
      });
  }
}

/** A tap of the keyboard's button (Space). */
async function tap(page) {
  await page.keyboard.down('Space');
  await page.waitForTimeout(90);
  await page.keyboard.up('Space');
}

/** Hold the button until `done` holds in the page. */
async function holdUntil(page, done, what) {
  await page.keyboard.down('Space');
  try {
    await page.waitForFunction(done, null, { timeout: 15_000 });
  } catch (err) {
    throw new Error(`holding: ${what}`, { cause: err });
  } finally {
    await page.keyboard.up('Space');
  }
}

async function main() {
  await ensureServer('game server (dev rules)', `${COLYSEUS_URL}/healthz`, '@rally/game-server', {
    PORT: COLYSEUS_PORT,
    RALLY_DEV_RULES: '1',
  });
  const { serverVersion, rooms } = await (await fetch(`${COLYSEUS_URL}/versions`)).json();
  assert.ok(serverVersion >= 5 && rooms.includes('sushi'), `game server v${serverVersion} has no sushi room`);
  await ensureServer('sushi dev server', GAME_URL, '@rally/game-sushi', { VITE_NO_HMR: '1' });

  // Seats of an earlier run's tabs are held for the 60 s reconnection grace; quick play would join that room.
  const deadline = Date.now() + 75_000;
  for (;;) {
    const listing = await (await fetch(`${COLYSEUS_URL}/rooms/sushi`)).json();
    if (listing.rooms.length === 0) break;
    if (Date.now() > deadline) throw new Error(`public sushi rooms still open: ${JSON.stringify(listing.rooms)}`);
    console.log(`· waiting for ${listing.rooms.length} leftover public room(s) to close…`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  timed('· servers ready, no leftover rooms');

  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  try {
    // 1. Two chefs, one room.
    const alice = await open(browser, 'name=Alice', errors);
    await dev(alice, { cmd: 'rules', rules: { noArrivals: true, morningTime: 0.5 } });
    const bob = await open(browser, 'name=Bob', errors);
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => window.__sushi.names().join() === 'guest-Alice,guest-Bob', null, {
        timeout: 15_000,
      });
    }
    assert.equal(await probe(alice, 'roomId'), await probe(bob, 'roomId'), 'one room');
    const panel = await alice.textContent('#rally-dev-harness >> [data-role="log"]');
    assert.ok(panel.includes(`matchmade sushi via ${COLYSEUS_URL} (quick, as "Alice")`), panel);
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => ['morning', 'open'].includes(window.__sushi.phase), null, { timeout: 15_000 });
      await page.waitForFunction(() => window.__sushi.menu.define && window.__sushi.menu.players > 0, null, {
        timeout: 10_000,
      });
    }
    await alice.waitForFunction(() => window.__sushi.phase === 'open', null, { timeout: 15_000 });
    passed('Alice and Bob matchmade into one room; the host menu got the settings, How to play and the People list');

    // 2. A salmon nigiri with the real controls, crate to belt.
    const hidePanel = await alice.addStyleTag({ content: '#rally-dev-harness { display: none !important; }' });
    await alice.bringToFront();
    await standAt(alice, 'guest-Alice', STAND.salmonCrate, ST.salmonCrate);
    await tap(alice);
    await alice.waitForFunction((k) => window.__sushi.held === k, K.SalmonFish, { timeout: 5_000 });
    await standAt(alice, 'guest-Alice', STAND.board, ST.board);
    await tap(alice);
    await alice.waitForFunction((k) => window.__sushi.station(19)?.item?.kind === k, K.SalmonFish, { timeout: 5_000 });
    await holdUntil(alice, () => window.__sushi.station(19)?.item?.kind === 13, 'chop the salmon');
    await tap(alice);
    await alice.waitForFunction((k) => window.__sushi.held === k, K.Salmon, { timeout: 5_000 });
    await standAt(alice, 'guest-Alice', STAND.mat, ST.mat);
    await tap(alice);
    await alice.waitForFunction(() => window.__sushi.station(21)?.mat.includes(13), null, { timeout: 5_000 });
    // The rice pot: start it (a crew of two has no free cooker), let it cook, scoop.
    await standAt(alice, 'guest-Alice', STAND.rice, ST.rice);
    if ((await alice.evaluate(() => window.__sushi.station(9).state)) === 0) await tap(alice);
    await alice.waitForFunction(() => window.__sushi.station(9).state === 2, null, { timeout: 15_000 });
    await tap(alice);
    await alice.waitForFunction((k) => window.__sushi.held === k, K.Rice, { timeout: 5_000 });
    await standAt(alice, 'guest-Alice', STAND.mat, ST.mat);
    await tap(alice);
    await alice.waitForFunction(() => window.__sushi.station(21)?.mat.length === 2, null, { timeout: 5_000 });
    assert.equal(await probe(alice, 'action'), 'Roll', 'the button says what a hold will do');
    await holdUntil(alice, () => window.__sushi.station(21)?.item?.kind === 21, 'roll the nigiri');
    await tap(alice);
    await alice.waitForFunction((k) => window.__sushi.held === k, K.SalmonNigiri, { timeout: 5_000 });
    await standAt(alice, 'guest-Alice', STAND.plates, ST.plates);
    await tap(alice);
    await alice.waitForFunction(() => window.__sushi.heldPlated, null, { timeout: 5_000 });
    // A customer on the middle stool wants it.
    await dev(alice, { cmd: 'customer', seat: FRONT_STOOL, order: K.SalmonNigiri, patience: 300 });
    await alice.waitForFunction(() => window.__sushi.customers().some((c) => c.state === 'wait'), null, {
      timeout: 15_000,
    });
    await bob.waitForFunction((k) => window.__sushi.bubbles().includes(k), K.SalmonNigiri, { timeout: 10_000 });
    await standAt(alice, 'guest-Alice', STAND.pass);
    await alice.waitForFunction(() => window.__sushi.target >= 200, null, { timeout: 15_000 });
    await tap(alice);
    await alice.waitForFunction(() => window.__sushi.slots().some((s) => s.kind === 21), null, { timeout: 5_000 });
    const coinsBefore = (await probe(bob, 'seen')).coins;
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => window.__sushi.served === 1 && window.__sushi.money > 0, null, {
        timeout: 45_000,
      });
    }
    await bob.waitForFunction((n) => window.__sushi.seen.coins > n, coinsBefore, { timeout: 5_000 });
    const tips = await probe(alice, 'tips');
    const money = await probe(alice, 'money');
    assert.ok(tips > 0 && money === 120 + tips, `a white plate and its tip: money ${money}, tips ${tips}`);
    await alice.screenshot({ path: `${SHOT}-nigiri.png` });
    await hidePanel.evaluate((el) => el.remove());
    passed(`a salmon nigiri from the crate to the belt; the customer took it (¥120 + ¥${tips} tip, both pages)`);

    // 3. A stale plate.
    await dev(alice, { cmd: 'belt', slot: 5, kind: K.SalmonRoll, age: 999 });
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => window.__sushi.slots().some((s) => s.i === 5 && s.stale), null, {
        timeout: 10_000,
      });
    }
    await alice.waitForFunction(() => window.__sushi.seen.stale > 0 && window.__sushi.staleTags() > 0, null, {
      timeout: 15_000,
    });
    passed('a plate past its stale time is shown stale (the slot, the fly tag) on both pages');

    // 4. Wednesday: the dining room opens.
    await dev(alice, { cmd: 'day', day: 3 });
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => window.__sushi.day === 3 && (window.__sushi.zones & 1) === 1, null, {
        timeout: 10_000,
      });
    }
    await dev(alice, { cmd: 'customer', seat: DINING_TABLE_SEAT, order: K.Ramen, patience: 300 });
    await bob.waitForFunction((k) => window.__sushi.bubbles().includes(k), K.Ramen, { timeout: 20_000 });
    await bob.screenshot({ path: `${SHOT}-wednesday.png` });
    passed('skipping to Wednesday opened the dining room; a table customer orders ramen');

    // 5. The night: summary, three cards, both vote, Thursday.
    await dev(alice, { cmd: 'rules', rules: { voteTime: 30, closingMax: 1 } });
    await dev(alice, { cmd: 'close' });
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => window.__sushi.phase === 'night' && window.__sushi.nightVisible, null, {
        timeout: 20_000,
      });
      assert.equal(await page.locator('#cards .card').count(), 3, 'three cards');
    }
    const card = await alice.evaluate(() => window.__sushi.cards.split(',')[1]);
    await alice.click('#cards .card[data-i="1"]');
    await bob.click('#cards .card[data-i="1"]');
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => window.__sushi.seen.fx.includes('vote'), null, { timeout: 10_000 });
      await page.waitForFunction(() => window.__sushi.resultLine !== null, null, { timeout: 10_000 });
      assert.deepEqual(await probe(page, 'resultLine'), { kind: 'guest', text: 'Guest: sign in to keep your stats' });
    }
    await bob.screenshot({ path: `${SHOT}-night.png` });
    await alice.waitForFunction(() => window.__sushi.day === 4, null, { timeout: 15_000 });
    passed(`the night: summary, three cards, both voted "${card}", Thursday opened; the guest result line`);

    // 8. exitRequested → Alice leaves at once; Bob sees one chef.
    await alice.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await alice.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    await bob.waitForFunction(() => !window.__sushi.names().includes('guest-Alice'), null, { timeout: 5_000 });
    passed('exitRequested → Alice left the room at once');
    await alice.context().close();
    await bob.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await bob.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    await bob.context().close();

    // 6 + 7. Private room by code (touch on Cleo's page), started from the lobby.
    const cleo = await open(browser, 'name=Cleo&private', errors, { hasTouch: true });
    await cleo.waitForFunction(() => /^[A-Z2-9]{6}$/.test(window.__sushi.code), null, { timeout: 10_000 });
    const code = await probe(cleo, 'code');
    assert.equal(await probe(cleo, 'phase'), 'lobby');
    assert.equal(await cleo.isVisible('#start'), true, 'Start button');
    assert.equal(await cleo.textContent('[data-role="code"]'), code);
    const x0 = (await cleo.evaluate(() => window.__sushi.player('guest-Cleo'))).x;
    const pointer = (type, id, fx, fy, target = 'stage') =>
      cleo.evaluate(
        ({ type, id, fx, fy, target }) => {
          const el = document.getElementById(target);
          const r = el.getBoundingClientRect();
          el.dispatchEvent(
            new PointerEvent(type, {
              pointerId: id,
              pointerType: 'touch',
              isPrimary: id === 1,
              clientX: r.left + r.width * fx,
              clientY: r.top + r.height * fy,
              bubbles: true,
              cancelable: true,
            }),
          );
        },
        { type, id, fx, fy, target },
      );
    await pointer('pointerdown', 1, 0.3, 0.5);
    await pointer('pointermove', 1, 0.3 + 70 / VIEW.width, 0.5);
    const presses = await cleo.evaluate(() => window.__sushi.target);
    void presses;
    await pointer('pointerdown', 2, 0.5, 0.5, 'action');
    await cleo.waitForFunction(() => document.getElementById('action').classList.contains('down'), null, {
      timeout: 2_000,
    });
    await pointer('pointerup', 2, 0.5, 0.5, 'action');
    await cleo.waitForFunction((x) => window.__sushi.player('guest-Cleo').x > x + 0.5, x0, { timeout: 10_000 });
    await pointer('pointerup', 1, 0.3 + 70 / VIEW.width, 0.5);
    const dan = await open(browser, `name=Dan&code=${code.toLowerCase()}`, errors);
    for (const page of [cleo, dan]) {
      await page.waitForFunction(() => window.__sushi.names().join() === 'guest-Cleo,guest-Dan', null, {
        timeout: 10_000,
      });
    }
    const listing = await (await fetch(`${COLYSEUS_URL}/rooms/sushi`)).json();
    assert.ok(!listing.rooms.some((r) => r.metadata.code === code), 'private room not listed');
    await cleo.click('#start');
    await dan.waitForFunction(() => ['morning', 'open'].includes(window.__sushi.phase), null, { timeout: 10_000 });
    passed(`private room ${code}: the lobby with a code, Dan joined by code, Start opened it; touch stick + button OK`);
    for (const page of [cleo, dan]) {
      await page.click('#rally-dev-harness >> button[data-action="exitRequested"]');
      await page.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    }

    const unexpected = errors.filter(
      (e) => !/WebGPU|GPU stall|favicon|Automatic fallback to software WebGL|menu\.define/i.test(e),
    );
    assert.deepEqual(unexpected, [], 'no page errors');
    console.log(`\nPASS sushi e2e in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
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
    console.error('\nFAIL sushi e2e:', err);
    stopServers();
    process.exit(1);
  });
