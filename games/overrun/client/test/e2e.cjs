/* eslint-disable @typescript-eslint/no-require-imports */
// End-to-end check of Overrun through the dev harness: two players in two Chrome contexts, one room, a real game
// server with dev rules (not part of `pnpm test`: it needs two servers and a browser).
//
//   pnpm --filter @rally/game-overrun test:e2e
//
// Starts the Colyseus game server on :2569 with RALLY_DEV_RULES=1 (the dev-only `dev` room message: freeze the horde,
// spawn a zombie, hurt or place a player) and Overrun's Vite dev server (:5183) unless they are already running, drives
// Chromium with Playwright and asserts:
//   1. ?name=Alice and ?name=Bob → host matchmaking → one room; each HUD lists both (guests are guest-<name>). Alice
//      is alone when she joins, so the run starts; Bob joins mid-wave and spawns at the next breather.
//   2. A wave starts (the horde frozen by a dev command). One zombie is put in front of Alice; she aims at it with the
//      mouse and holds the button: her pistol kills it on the server, and Bob sees the kill (the zombie leaves his
//      state, his page plays the kill effect, the team's kill count goes up).
//   3. Alice is knocked down (dev `hurt`); Bob stands next to her and revives her after 3 s, at 50 % HP.
//   4. Everyone goes down: the run ends, both pages show the run-over banner with the server's guest `result` line
//      ("Guest: sign in to keep your stats").
//   5. Twin-stick touch: a left-half drag moves, a right-half finger fires, a second finger lifting on the left does
//      not release the move stick.
//   6. Private room: ?private waits in the lobby with a code and a Start button; ?code= joins it; Start starts it.
//   7. exitRequested from the harness panel leaves the room at once (the other player sees one player fewer).
// Every page runs ?lowfx=1 (≤ 15 fps, DPR 1, no MSAA/shadows/decals) at a small viewport: two pages render WebGL in
// software (swiftshader) at once, and it must pass pinned to two cores (`taskset -c 0,1`).
// Env: OVERRUN_URL, COLYSEUS_URL (default http://localhost:2569), E2E_SCREENSHOT=<png path prefix>.
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../../../..');
const GAME_URL = (process.env.OVERRUN_URL || 'http://localhost:5183/').replace(/\/?$/, '/');
const COLYSEUS_URL = (process.env.COLYSEUS_URL || 'http://localhost:2569').replace(/\/+$/, '');
const COLYSEUS_PORT = new URL(COLYSEUS_URL).port || '80';
const SHOT = process.env.E2E_SCREENSHOT || path.join(os.tmpdir(), 'overrun');
/** Small landscape pages: a quarter of a phone's pixels to render in software. */
const VIEW = { width: 640, height: 360 };
const JOIN_TIMEOUT_MS = 60_000;

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

const probe = (page, expr) => page.evaluate(`window.__overrun && window.__overrun.${expr}`);
const dev = (page, cmd) => page.evaluate((c) => window.__overrun.dev(c), cmd);

async function waitJoined(page, who) {
  try {
    await page.waitForFunction(() => window.__overrun && window.__overrun.joined, null, { timeout: JOIN_TIMEOUT_MS });
  } catch (err) {
    throw new Error(`${who}: not joined within ${JOIN_TIMEOUT_MS / 1000} s (page boot, matchmaking and join)`, {
      cause: err,
    });
  }
  assert.equal(await probe(page, 'lowfx'), true, `${who}: ?lowfx=1 in effect`);
  await assertBootScreen(page, who);
}

/**
 * The host's loading screen (the harness draws the shell's) followed the game's labels (the models by the byte, the
 * join) and went away once the game reported progress 1, after ready() (the hold contract).
 */
async function assertBootScreen(page, who) {
  await page.waitForSelector('#rally-dev-harness >> [data-role="loading-overlay"]', {
    state: 'detached',
    timeout: 5_000,
  });
  await page.waitForSelector('#loading', { state: 'hidden', timeout: 5_000 });
  const log = await page.textContent('#rally-dev-harness >> [data-role="log"]');
  assert.match(log, /loading: Downloading characters/, `${who}: labelled model stage`);
  assert.match(log, /the loading screen stays up until progress 1/, `${who}: held after ready()`);
  assert.match(log, /loading: Joining the match/, `${who}: labelled join stage`);
  assert.match(log, /playable \d+ ms after ready\(\): loading screen hidden/, `${who}: revealed at progress 1`);
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
function touch(page, type, pointerId, fx, fy = 0.6) {
  return page.evaluate(
    ({ type, pointerId, fx, fy }) => {
      const c = document.getElementById('stage');
      const r = c.getBoundingClientRect();
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
    { type, pointerId, fx, fy },
  );
}

async function main() {
  await ensureServer('game server (dev rules)', `${COLYSEUS_URL}/healthz`, '@rally/game-server', {
    PORT: COLYSEUS_PORT,
    RALLY_DEV_RULES: '1',
  });
  const { serverVersion, rooms } = await (await fetch(`${COLYSEUS_URL}/versions`)).json();
  assert.ok(serverVersion >= 3 && rooms.includes('overrun'), `game server v${serverVersion} has no overrun room`);
  await ensureServer('overrun dev server', GAME_URL, '@rally/game-overrun', { VITE_NO_HMR: '1' });

  // Seats of an earlier run's tabs are held for the 60 s reconnection grace; quick play would join that room.
  const deadline = Date.now() + 75_000;
  for (;;) {
    const listing = await (await fetch(`${COLYSEUS_URL}/rooms/overrun`)).json();
    if (listing.rooms.length === 0) break;
    if (Date.now() > deadline) throw new Error(`public overrun rooms still open: ${JSON.stringify(listing.rooms)}`);
    console.log(`· waiting for ${listing.rooms.length} leftover public room(s) to close…`);
    await new Promise((r) => setTimeout(r, 3000));
  }

  timed('· servers ready, no leftover rooms');
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  try {
    // 1. Alice starts a run alone; Bob joins her room.
    const alice = await open(browser, 'name=Alice', errors);
    await alice.waitForFunction(() => ['breather', 'wave'].includes(window.__overrun.phase), null, { timeout: 10_000 });
    // Dev rules (the server honours them with RALLY_DEV_RULES=1): freeze the horde, short breathers, tiny waves.
    await dev(alice, { cmd: 'rules', rules: { breatherTime: 1.2, overTime: 6, waveSize: 2 } });
    await dev(alice, { cmd: 'freeze', on: true });
    const bob = await open(browser, 'name=Bob', errors);
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => window.__overrun.names().join() === 'guest-Alice,guest-Bob', null, {
        timeout: 10_000,
      });
      await page.waitForFunction(() => document.querySelectorAll('#team .mate').length === 2, null, { timeout: 5_000 });
    }
    assert.equal(await probe(alice, 'roomId'), await probe(bob, 'roomId'), 'one room');
    const panel = await alice.textContent('#rally-dev-harness >> [data-role="log"]');
    assert.ok(panel.includes(`matchmade overrun via ${COLYSEUS_URL} (quick, as "Alice")`), panel);
    // Bob spawns at the next breather (end the current wave if the run is in one).
    if (
      (await probe(bob, 'phase')) === 'wave' &&
      !(await bob.evaluate(() => window.__overrun.player('guest-Bob').active))
    ) {
      assert.match(await bob.textContent('#banner-sub'), /next breather/);
      await dev(alice, { cmd: 'endWave' });
    }
    await bob.waitForFunction(() => window.__overrun.player('guest-Bob')?.active === true, null, { timeout: 15_000 });
    passed('Alice and Bob matchmade into one room; Bob spawned between waves; both HUDs list both');

    // 2. A wave; one zombie in front of Alice; she shoots it with the mouse; Bob sees it die.
    await alice.waitForFunction(() => window.__overrun.phase === 'wave', null, { timeout: 15_000 });
    const wave = await probe(alice, 'wave');
    assert.ok(wave >= 1);
    await dev(alice, { cmd: 'place', x: 0, y: 2.5 });
    await dev(bob, { cmd: 'place', x: 6, y: 5 });
    await dev(alice, { cmd: 'spawn', kind: 0, x: 0, y: -1.5 });
    await bob.waitForFunction(() => window.__overrun.zombies().some((z) => Math.hypot(z.x, z.y + 1.5) < 0.5), null, {
      timeout: 10_000,
    });
    const target = await bob.evaluate(() => window.__overrun.zombies().find((z) => Math.hypot(z.x, z.y + 1.5) < 0.5));
    const killsBefore = await probe(bob, 'killsSeen');
    // Let Alice's camera settle on her new position, then aim the mouse at the zombie and hold the button.
    await alice.waitForFunction(() => Math.abs(window.__overrun.player('guest-Alice').y - 2.5) < 0.01, null, {
      timeout: 5_000,
    });
    await alice.waitForTimeout(600);
    await alice.bringToFront();
    // The harness panel covers the right half of a small page: keep it out of the mouse's way while she aims.
    const hidePanel = await alice.addStyleTag({ content: '#rally-dev-harness { display: none !important; }' });
    const at = await alice.evaluate(({ x, y }) => window.__overrun.screenOf(x, y), target);
    await alice.mouse.move(at.x, at.y);
    await alice.mouse.down();
    // Keep the cursor on the zombie while the camera leads toward the cursor (as a player tracks a target).
    const track = setInterval(() => {
      alice
        .evaluate(({ x, y }) => window.__overrun.screenOf(x, y), target)
        .then((p) => alice.mouse.move(p.x, p.y))
        .catch(() => {});
    }, 250);
    try {
      await bob.waitForFunction((id) => !window.__overrun.zombies().some((z) => z.id === id), target.id, {
        timeout: 15_000,
      });
    } catch (err) {
      const state = await alice.evaluate(() => ({
        aim: window.__overrun.aim,
        firing: window.__overrun.firing,
        phase: window.__overrun.phase,
        me: window.__overrun.player('guest-Alice'),
        zombies: window.__overrun.zombies(),
      }));
      await alice.screenshot({ path: `${SHOT}-miss.png` });
      clearInterval(track);
      throw new Error(
        `Alice's shots did not kill ${JSON.stringify(target)} (mouse at ${JSON.stringify(at)}): ${JSON.stringify(state)}`,
        {
          cause: err,
        },
      );
    }
    clearInterval(track);
    await alice.mouse.up();
    await hidePanel.evaluate((el) => el.remove());
    await bob.waitForFunction((n) => window.__overrun.killsSeen > n, killsBefore, { timeout: 5_000 });
    await bob.waitForFunction(() => window.__overrun.teamKills >= 1, null, { timeout: 5_000 });
    // Alice's page reads the same patch as Bob's; give it a moment (its frames are software-rendered), and if it never
    // shows the kill, report what Bob's page says about who has it.
    await alice
      .waitForFunction(() => window.__overrun.player('guest-Alice')?.kills === 1, null, { timeout: 5_000 })
      .catch(() => {});
    const seen = await bob.evaluate(() => ({
      alice: window.__overrun.player('guest-Alice'),
      bob: window.__overrun.player('guest-Bob'),
      teamKills: window.__overrun.teamKills,
    }));
    assert.equal(
      await alice.evaluate(() => window.__overrun.player('guest-Alice').kills),
      1,
      `Alice's kill (Bob's page: ${JSON.stringify(seen)})`,
    );
    const aim = await probe(alice, 'aim');
    assert.ok(aim.y < -0.9, `aimed up the screen (${JSON.stringify(aim)})`);
    await alice.screenshot({ path: `${SHOT}-alice.png` });
    await bob.screenshot({ path: `${SHOT}-bob.png` });
    passed(`Alice shot zombie ${target.id} with the mouse; Bob saw it die (state + kill effect)`);

    // 3. Alice goes down; Bob stands next to her for 3 s and revives her.
    await dev(bob, { cmd: 'hurt', name: 'guest-Alice', damage: 500 });
    await bob.waitForFunction(() => window.__overrun.player('guest-Alice').down === true, null, { timeout: 5_000 });
    await alice.waitForFunction(() => window.__overrun.banner === "You're down", null, { timeout: 5_000 });
    const downAt = await alice.evaluate(() => window.__overrun.player('guest-Alice'));
    await dev(bob, { cmd: 'place', x: downAt.x + 1, y: downAt.y });
    await bob.waitForFunction(() => window.__overrun.player('guest-Alice').revive > 30, null, { timeout: 8_000 });
    await alice.waitForFunction(() => window.__overrun.player('guest-Alice').down === false, null, { timeout: 10_000 });
    assert.equal(await alice.evaluate(() => window.__overrun.player('guest-Alice').hp), 50);
    assert.equal(await bob.evaluate(() => window.__overrun.player('guest-Bob').active), true);
    passed('Alice went down; Bob stood next to her and revived her at 50 % HP');

    // 3b. Med kits. Every pickup of a kind shares one mesh: picking up the last one on the ground must not destroy
    // it, or the next drop of that kind draws a destroyed mesh and every frame throws (the 3D view froze on phones
    // while the HUD kept going). Alice (50 HP) takes one, then a second one drops in front of both cameras.
    const mark = errors.length;
    await dev(alice, { cmd: 'god', on: true });
    const kitIds = () =>
      bob.evaluate(() =>
        window.__overrun
          .pickups()
          .filter((p) => p.kind === 0)
          .map((p) => p.id),
      );
    const dropKit = async (x, y) => {
      const before = await kitIds();
      await dev(alice, { cmd: 'drop', kind: 0, x, y });
      await bob.waitForFunction(
        (ids) => window.__overrun.pickups().some((p) => p.kind === 0 && !ids.includes(p.id)),
        before,
        {
          timeout: 5_000,
        },
      );
      return (await kitIds()).find((id) => !before.includes(id));
    };
    const first = await dropKit(0, -1.5);
    await bob.waitForTimeout(300);
    await dev(alice, { cmd: 'place', x: 0, y: -1.5 });
    await bob.waitForFunction((id) => !window.__overrun.pickups().some((p) => p.id === id), first, { timeout: 5_000 });
    assert.equal(await alice.evaluate(() => window.__overrun.player('guest-Alice').hp), 80, 'med kit: +30 HP');
    await bob.waitForTimeout(300);
    const second = await dropKit(0, 2.5);
    await bob.waitForTimeout(800);
    assert.deepEqual(errors.slice(mark), [], 'drawing the next med kit after one was picked up');
    await dev(alice, { cmd: 'place', x: 0, y: 2.5 });
    await bob.waitForFunction((id) => !window.__overrun.pickups().some((p) => p.id === id), second, { timeout: 5_000 });
    await dev(alice, { cmd: 'god', on: false });
    passed('med kits: Alice picked one up, the next one dropped and drew without errors');

    // 4. Everyone down: the run ends, both see the run-over banner with the guest result line.
    const roomId = await probe(alice, 'roomId');
    const run = await probe(alice, 'run');
    await dev(alice, { cmd: 'hurt', name: 'guest-Alice', damage: 500 });
    await dev(alice, { cmd: 'hurt', name: 'guest-Bob', damage: 500 });
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => window.__overrun.phase === 'over', null, { timeout: 10_000 });
      await page.waitForFunction(() => window.__overrun.resultLine !== null, null, { timeout: 5_000 });
      assert.deepEqual(await probe(page, 'resultLine'), { kind: 'guest', text: 'Guest: sign in to keep your stats' });
      assert.deepEqual(await probe(page, 'result'), { matchId: `${roomId}:${run}`, recorded: false, reason: 'guest' });
      assert.equal(await page.textContent('#banner-title'), 'Overrun!');
    }
    await bob.screenshot({ path: `${SHOT}-result.png` });
    passed(`run over: both pages show "Overrun!" with "Guest: sign in to keep your stats" (${SHOT}-result.png)`);

    // 5. exitRequested → Alice leaves at once; Bob sees one player.
    await alice.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await alice.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    await bob.waitForFunction(() => window.__overrun.names().join() === 'guest-Bob', null, { timeout: 5_000 });
    passed('exitRequested → Alice left the room at once');
    await alice.context().close();
    await bob.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await bob.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    await bob.context().close();

    // 6. Private room by code, started from the lobby; twin-stick touch on Cleo's page.
    const cleo = await open(browser, 'name=Cleo&private', errors, { hasTouch: true });
    await cleo.waitForFunction(() => /^[A-Z2-9]{6}$/.test(window.__overrun.code), null, { timeout: 10_000 });
    const code = await probe(cleo, 'code');
    await cleo.waitForFunction(
      (c) =>
        window.__overrun.banner === 'Private room' && document.querySelector('[data-role="code"]')?.textContent === c,
      code,
      { timeout: 5_000 },
    );
    assert.equal(await probe(cleo, 'phase'), 'waiting');
    assert.equal(await cleo.isVisible('#start'), true, 'Start button');
    // Twin stick: left half moves, right half fires, a second finger on the left does not release the stick.
    await touch(cleo, 'pointerdown', 1, 0.2);
    await touch(cleo, 'pointermove', 1, 0.2 + 70 / VIEW.width);
    assert.equal((await probe(cleo, 'stick')).x, 1, 'drag right = full move');
    await touch(cleo, 'pointerdown', 3, 0.1, 0.3);
    await touch(cleo, 'pointerup', 3, 0.1, 0.3);
    assert.equal((await probe(cleo, 'stick')).x, 1, 'still moving after the second finger lifted');
    await touch(cleo, 'pointerdown', 2, 0.8);
    assert.equal(await probe(cleo, 'firing'), true, 'right thumb down = fire');
    await touch(cleo, 'pointerup', 2, 0.8);
    await touch(cleo, 'pointerup', 1, 0.2 + 70 / VIEW.width);
    assert.deepEqual(await probe(cleo, 'stick'), { x: 0, y: 0 }, 'released by its own finger');
    assert.equal(await probe(cleo, 'firing'), false);
    const dan = await open(browser, `name=Dan&code=${code.toLowerCase()}`, errors);
    for (const page of [cleo, dan]) {
      await page.waitForFunction(() => window.__overrun.names().join() === 'guest-Cleo,guest-Dan', null, {
        timeout: 10_000,
      });
    }
    const listing = await (await fetch(`${COLYSEUS_URL}/rooms/overrun`)).json();
    assert.ok(!listing.rooms.some((r) => r.metadata.code === code), 'private room not listed');
    await cleo.screenshot({ path: `${SHOT}-private.png` });
    await cleo.click('#start');
    await dan.waitForFunction(() => window.__overrun.phase === 'breather', null, { timeout: 10_000 });
    passed(`private room ${code}: lobby with a code, Dan joined by code, Start started the run; twin stick OK`);
    for (const page of [cleo, dan]) {
      await page.click('#rally-dev-harness >> button[data-action="exitRequested"]');
      await page.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    }

    const unexpected = errors.filter((e) => !/WebGPU|GPU stall|favicon|Automatic fallback to software WebGL/i.test(e));
    assert.deepEqual(unexpected, [], 'no page errors');
    console.log(`\nPASS overrun e2e in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
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
    console.error('\nFAIL overrun e2e:', err);
    stopServers();
    process.exit(1);
  });
