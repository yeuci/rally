/* eslint-disable @typescript-eslint/no-require-imports */
// End-to-end check of Northdale through the dev harness: two survivors in two Chrome contexts, one room, a real game
// server with dev rules (not part of `pnpm test`: it needs two servers and a browser).
//
//   pnpm --filter @rally/game-northdale test:e2e
//
// Starts the Colyseus game server on :2572 with RALLY_DEV_RULES=1 (the dev-only `dev` room message: time of day,
// skip to night N, spawn zombies, give items, hurt or down a survivor, set the truck) and Northdale's Vite dev server
// (:5186) unless they are already running, drives Chromium with Playwright and asserts:
//   1. ?name=Alice and ?name=Bob → host matchmaking → one room, both survivors on both pages; the host menu got
//      `menu.define` (settings + help) and `menu.players` with both names.
//   2. A chest: Alice stands at the safehouse chest and holds E; it opens and its loot lands in her pockets.
//   3. Melee: a zombie in front of Alice, frozen; she swings the knife (F) until it dies; the kill reaches Bob's page
//      and her kill count.
//   4. Night 3: one knife stab takes a day-1 zombie to 50 %, a night-3 zombie only to 65 % (HP × 1.44); the night-3
//      horde brings a chubby.
//   5. Revive: Alice is downed; Bob holds E next to her for 3 s; she is up at 40 HP.
//   6. The escape: the truck repaired (dev), night 4, Alice holds E at the truck: the holdout, the drive out, and the
//      run ends with "You escaped Northdale!" and the guest result line on both pages.
//   7. exitRequested from the harness panel leaves the room at once.
// Every page runs ?lowfx=1 (≤ 15 fps, DPR 1, no MSAA, light pools or effects) at a small viewport: two pages render
// WebGL in software (swiftshader) at once, and it must pass pinned to two cores (`taskset -c 0,1`).
// Env: NORTHDALE_URL, COLYSEUS_URL (default http://localhost:2572), E2E_SCREENSHOT=<png path prefix>.
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../../../..');
const GAME_URL = (process.env.NORTHDALE_URL || 'http://localhost:5186/').replace(/\/?$/, '/');
const COLYSEUS_URL = (process.env.COLYSEUS_URL || 'http://localhost:2572').replace(/\/+$/, '');
const COLYSEUS_PORT = new URL(COLYSEUS_URL).port || '80';
const SHOT = process.env.E2E_SCREENSHOT || path.join(os.tmpdir(), 'northdale');
const VIEW = { width: 640, height: 360 };
const JOIN_TIMEOUT_MS = 90_000;
/** Item codes and kinds, as in the rules (server/src/tuning.ts). */
const ITEM = { knife: 5 };
const KIND = { basic: 0, chubby: 2 };
/** A clear stretch of the main street, north of the safehouse (no wreck or pole within a few units). */
const STREET = { x: 0, y: -20 };

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

const probe = (page, expr) => page.evaluate(`window.__northdale && window.__northdale.${expr}`);
const dev = (page, cmd) => page.evaluate((c) => window.__northdale.dev(c), cmd);
const player = (page, name) => page.evaluate((n) => window.__northdale.player(n), name);

async function open(browser, query, errors) {
  const context = await browser.newContext({ viewport: VIEW });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${query}: ${e.message}`));
  // The harness logs `rally.net.status` reports to the console: "[rally-harness] net.status connected 12".
  page.netStatus = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${query}: ${m.text()}`);
    const at = m.text().indexOf('net.status ');
    if (m.type() === 'debug' && at >= 0)
      page.netStatus.push(
        m
          .text()
          .slice(at + 11)
          .trim(),
      );
  });
  await page.goto(`${GAME_URL}?${query}&lowfx=1&colyseus=${encodeURIComponent(COLYSEUS_URL)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  try {
    await page.waitForFunction(() => window.__northdale && window.__northdale.joined, null, {
      timeout: JOIN_TIMEOUT_MS,
    });
  } catch (err) {
    throw new Error(`?${query}: not joined within ${JOIN_TIMEOUT_MS / 1000} s`, { cause: err });
  }
  assert.equal(await probe(page, 'lowfx'), true, `${query}: ?lowfx=1 in effect`);
  // The harness panel covers part of a small page: keep it out of the way of the mouse (shown again to click it).
  await page.addStyleTag({ content: 'html.e2e-hide #rally-dev-harness { display: none !important; }' });
  await page.evaluate(() => document.documentElement.classList.add('e2e-hide'));
  return page;
}

/** Wait until `fn(arg)` is truthy on `page`; on timeout, throw with a snapshot of the state. */
async function until(page, fn, arg, what, timeout = 10_000) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch (err) {
    const state = await page.evaluate(() => ({
      phase: window.__northdale.phase,
      night: window.__northdale.night,
      names: window.__northdale.names(),
      zombies: window.__northdale.zombies(),
      context: window.__northdale.context,
    }));
    await page.screenshot({ path: `${SHOT}-fail.png` }).catch(() => {});
    throw new Error(`${what}: ${JSON.stringify(state)}`, { cause: err });
  }
}

/** Point the mouse at a ground point (the aim follows the cursor). */
async function aimAt(page, x, y) {
  const at = await page.evaluate(({ x, y }) => window.__northdale.screenOf(x, y), { x, y });
  await page.mouse.move(at.x, at.y);
}

/**
 * Keep the mouse on a ground point while the camera eases toward its mouse lead (the same screen point aims at a
 * different spot once the camera has moved). Returns a stop function.
 */
function track(page, x, y) {
  const timer = setInterval(() => void aimAt(page, x, y).catch(() => {}), 150);
  return () => clearInterval(timer);
}

async function main() {
  await ensureServer('game server (dev rules)', `${COLYSEUS_URL}/healthz`, '@rally/game-server', {
    PORT: COLYSEUS_PORT,
    RALLY_DEV_RULES: '1',
  });
  const { serverVersion, rooms } = await (await fetch(`${COLYSEUS_URL}/versions`)).json();
  assert.ok(serverVersion >= 5 && rooms.includes('northdale'), `game server v${serverVersion} has no northdale room`);
  await ensureServer('northdale dev server', GAME_URL, '@rally/game-northdale', { VITE_NO_HMR: '1' });

  // Seats of an earlier run's tabs are held for the 60 s reconnection grace; quick play would join that room.
  const deadline = Date.now() + 75_000;
  for (;;) {
    const listing = await (await fetch(`${COLYSEUS_URL}/rooms/northdale`)).json();
    if (listing.rooms.length === 0) break;
    if (Date.now() > deadline) throw new Error(`public northdale rooms still open: ${JSON.stringify(listing.rooms)}`);
    console.log(`· waiting for ${listing.rooms.length} leftover public room(s) to close…`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  timed('· servers ready, no leftover rooms');
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  try {
    // 1. Two survivors in one room; the host's menu got our settings, help and the people.
    const alice = await open(browser, 'name=Alice', errors);
    // No horde unless a test calls one, and long phases: the clock never runs out under the test.
    await dev(alice, { cmd: 'rules', rules: { spawnScale: 0, dayTime: 600, nightTime: 600, duskTime: 60 } });
    await dev(alice, { cmd: 'clear' });
    const bob = await open(browser, 'name=Bob', errors);
    for (const page of [alice, bob]) {
      await until(page, () => window.__northdale.names().join() === 'guest-Alice,guest-Bob', null, 'both in the room');
    }
    assert.equal(await probe(alice, 'roomId'), await probe(bob, 'roomId'), 'one room');
    assert.equal(await probe(alice, 'phase'), 'day');
    const defined = await probe(alice, 'menuDefined');
    assert.deepEqual(Object.keys(defined).sort(), ['cameraShake', 'labels', 'minimap'], 'menu.define values');
    await until(alice, () => window.__northdale.menuPlayers.length === 2, null, 'menu.players');
    const people = await probe(alice, 'menuPlayers');
    assert.deepEqual(people.map((p) => p.name).sort(), ['guest-Alice', 'guest-Bob']);
    assert.equal(people.find((p) => p.name === 'guest-Alice').you, true);
    const panel = await alice.textContent('#rally-dev-harness >> [data-role="log"]');
    assert.ok(panel.includes(`matchmade northdale via ${COLYSEUS_URL} (quick, as "Alice")`), panel);
    assert.ok(panel.includes('menu.players: guest-Alice'), 'the harness saw menu.players');
    // rally.net.status: "connected" on join, then every ~2 s with the round-trip time.
    for (let i = 0; i < 40 && !alice.netStatus.some((s) => /^connected \d+$/.test(s)); i++)
      await alice.waitForTimeout(100);
    assert.ok(
      alice.netStatus.some((s) => /^connected \d+$/.test(s)),
      `net.status with an rtt: ${alice.netStatus.join(' | ')}`,
    );
    passed('Alice and Bob matchmade into one room; menu.define, menu.players and net.status reached the host');

    // 2. A chest at the safehouse: hold E, it opens, the loot lands in Alice's pockets.
    const spot = await alice.evaluate(() => window.__northdale.chest());
    await dev(alice, { cmd: 'place', x: spot.x, y: spot.y - 1.15 });
    await until(
      alice,
      (s) =>
        Math.hypot(
          window.__northdale.player('guest-Alice').x - s.x,
          window.__northdale.player('guest-Alice').y - (s.y - 1.15),
        ) < 0.6,
      spot,
      'Alice at the chest',
    );
    await alice.waitForTimeout(400);
    const before = await player(alice, 'guest-Alice');
    const scrapBefore = await probe(alice, 'scrap');
    const openedBefore = await probe(alice, 'opened');
    await until(
      alice,
      () => window.__northdale.context === 'Open the chest',
      null,
      'the context button offers the chest',
    );
    await alice.bringToFront();
    await alice.keyboard.down('KeyE');
    try {
      await until(alice, (n) => window.__northdale.opened > n, openedBefore, 'chest opened', 8_000);
    } finally {
      await alice.keyboard.up('KeyE');
    }
    await alice.waitForTimeout(800);
    const after = await player(alice, 'guest-Alice');
    const scrapAfter = await probe(alice, 'scrap');
    const gained =
      scrapAfter > scrapBefore ||
      JSON.stringify(after.ammo) !== JSON.stringify(before.ammo) ||
      JSON.stringify(after.items) !== JSON.stringify(before.items) ||
      after.gun !== before.gun ||
      after.melee !== before.melee ||
      (await probe(alice, 'pickupsNear(2)')) > 0;
    assert.ok(gained, `the chest gave something: ${JSON.stringify({ before, after, scrapBefore, scrapAfter })}`);
    passed(`chest opened: ${JSON.stringify({ ammo: after.ammo, items: after.items, scrap: scrapAfter })}`);

    // 3. Melee: a zombie in front of Alice; she swings the knife until it dies; Bob's page sees the kill.
    await dev(alice, { cmd: 'place', x: STREET.x, y: STREET.y });
    await until(
      alice,
      (s) => Math.abs(window.__northdale.player('guest-Alice').y - s.y) < 0.5,
      STREET,
      'Alice on the street',
    );
    const me = await player(alice, 'guest-Alice');
    await dev(alice, { cmd: 'god', on: true });
    await dev(alice, { cmd: 'freeze', on: true });
    await dev(alice, { cmd: 'give', item: ITEM.knife });
    await dev(alice, { cmd: 'spawn', kind: KIND.basic, x: me.x + 1.2, y: me.y });
    await until(bob, () => window.__northdale.zombies().length === 1, null, 'the zombie on Bob’s page');
    const z = (await alice.evaluate(() => window.__northdale.zombies()))[0];
    const [zx, zy] = [z.x, z.y];
    const killsBefore = await probe(bob, 'killsSeen');
    const stopTrack = track(alice, zx, zy);
    await alice.waitForTimeout(1200);
    await alice.keyboard.down('KeyF');
    try {
      await until(bob, (k) => window.__northdale.killsSeen > k, killsBefore, 'the kill on Bob’s page', 10_000);
    } catch (err) {
      console.log(
        'alice',
        JSON.stringify(
          await alice.evaluate(() => ({
            aim: window.__northdale.aim,
            fx: window.__northdale.fxSeen,
            me: window.__northdale.player('guest-Alice'),
            melee: window.__northdale.melee,
            phase: window.__northdale.phase,
          })),
        ),
      );
      await alice.screenshot({ path: `${SHOT}-melee-fail.png` });
      throw err;
    } finally {
      await alice.keyboard.up('KeyF');
      stopTrack();
    }
    await until(alice, () => window.__northdale.player('guest-Alice').kills >= 1, null, 'Alice’s kill count');
    await alice.screenshot({ path: `${SHOT}-melee.png` });
    passed('melee: the knife killed the zombie; Bob saw the kill, Alice’s kills = 1');

    // 4. Night 3: zombies are stronger (one stab: 50 % left by day, 65 % at night 3) and a chubby joins the horde.
    const stab = async (label) => {
      const p = await player(alice, 'guest-Alice');
      await dev(alice, { cmd: 'clear' });
      await dev(alice, { cmd: 'spawn', kind: KIND.basic, x: p.x + 1.2, y: p.y });
      await until(alice, () => window.__northdale.zombies().length === 1, null, `${label}: spawned`);
      const z = (await alice.evaluate(() => window.__northdale.zombies()))[0];
      const stop = track(alice, z.x, z.y);
      await alice.waitForTimeout(1200);
      await alice.keyboard.press('KeyF');
      try {
        await until(alice, () => window.__northdale.zombies()[0]?.hp < 100, null, `${label}: stabbed`, 5_000);
      } finally {
        stop();
      }
      await alice.waitForTimeout(600);
      return (await alice.evaluate(() => window.__northdale.zombies()))[0].hp;
    };
    const dayHp = await stab('day');
    assert.ok(Math.abs(dayHp - 50) <= 1, `a day-1 zombie keeps 50 % after one stab (${dayHp})`);
    await dev(alice, { cmd: 'night', n: 3 });
    await until(alice, () => window.__northdale.phase === 'night' && window.__northdale.night === 3, null, 'night 3');
    const nightHp = await stab('night 3');
    assert.ok(Math.abs(nightHp - Math.round(100 - (30 / 86) * 100)) <= 1, `a night-3 zombie keeps 65 % (${nightHp})`);
    await dev(alice, { cmd: 'clear' });
    await dev(alice, { cmd: 'freeze', on: false });
    await dev(alice, { cmd: 'rules', rules: { spawnScale: 4 } });
    await dev(alice, { cmd: 'night', n: 3 });
    await until(
      alice,
      (k) => window.__northdale.zombies().some((z) => z.kind === k),
      KIND.chubby,
      'a chubby in the night-3 horde',
      30_000,
    );
    await alice.screenshot({ path: `${SHOT}-night3.png` });
    await dev(alice, { cmd: 'rules', rules: { spawnScale: 0 } });
    await dev(alice, { cmd: 'clear' });
    passed(`night 3: one stab leaves ${dayHp} % by day, ${nightHp} % at night 3; a chubby came with the horde`);

    // 5. Revive: Alice down, Bob holds E next to her for 3 s.
    const a = await player(alice, 'guest-Alice');
    await dev(alice, { cmd: 'god', on: false });
    await dev(alice, { cmd: 'down' });
    await dev(bob, { cmd: 'place', x: a.x + 0.9, y: a.y });
    await until(bob, () => window.__northdale.player('guest-Alice').life === 1, null, 'Alice down on Bob’s page');
    await until(
      bob,
      () => window.__northdale.context.startsWith('Revive'),
      null,
      'Bob’s context button offers the revive',
    );
    await bob.bringToFront();
    await bob.keyboard.down('KeyE');
    try {
      await until(bob, () => window.__northdale.player('guest-Alice').revive > 20, null, 'revive progress', 5_000);
      await until(alice, () => window.__northdale.player('guest-Alice').life === 0, null, 'Alice back up', 8_000);
    } finally {
      await bob.keyboard.up('KeyE');
    }
    assert.equal((await player(alice, 'guest-Alice')).hp, 40);
    passed('revive: Bob held E for 3 s, Alice is up at 40 HP');

    // 6. The escape: the truck repaired, night 4, Alice starts it: the holdout, the drive, the result.
    await dev(alice, { cmd: 'god', on: true });
    await dev(alice, { cmd: 'rules', rules: { holdoutTime: 3, escapeTime: 3, overTime: 30 } });
    await dev(alice, { cmd: 'truck', wheels: 2, fuel: 2, scrap: 60 });
    await dev(alice, { cmd: 'night', n: 4 });
    const truck = await alice.evaluate(() => window.__northdale.truckAt);
    await dev(alice, { cmd: 'place', x: truck.x + 2.6, y: truck.y });
    await until(alice, () => window.__northdale.context === 'Start the truck!', null, 'Alice can start the truck');
    await alice.bringToFront();
    await alice.keyboard.down('KeyE');
    try {
      await until(alice, () => window.__northdale.phase === 'holdout', null, 'the holdout', 6_000);
    } finally {
      await alice.keyboard.up('KeyE');
    }
    for (const page of [alice, bob]) {
      await until(page, () => window.__northdale.phase === 'over', null, 'the run is over', 20_000);
      await until(page, () => window.__northdale.resultLine !== null, null, 'the result line', 8_000);
      assert.deepEqual(await probe(page, 'resultLine'), { kind: 'guest', text: 'Guest: sign in to keep your stats' });
      assert.equal(await probe(page, 'centerTitle'), 'You escaped Northdale!');
      const result = await probe(page, 'result');
      assert.equal(result.recorded, false);
      assert.equal(result.reason, 'guest');
    }
    await bob.screenshot({ path: `${SHOT}-escape.png` });
    passed(`escape: holdout, the drive out, "You escaped Northdale!" and the guest result line (${SHOT}-escape.png)`);

    // 7. exitRequested → Alice leaves at once; Bob sees one survivor.
    for (const page of [alice, bob]) await page.evaluate(() => document.documentElement.classList.remove('e2e-hide'));
    await alice.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await alice.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    await until(bob, () => !window.__northdale.names().includes('guest-Alice'), null, 'Alice gone', 8_000);
    passed('exitRequested → Alice left the room at once');
    await alice.context().close();
    await bob.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await bob.context().close();

    const unexpected = errors.filter((e) => !/WebGPU|GPU stall|favicon|Automatic fallback to software WebGL/i.test(e));
    assert.deepEqual(unexpected, [], 'no page errors');
    console.log(`\nPASS northdale e2e in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
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
    console.error('\nFAIL northdale e2e:', err);
    stopServers();
    process.exit(1);
  });
