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
//      other player's state, so it went through the server). Bob then drives off the edge until Alice wins the
//      match: both match-over banners carry the server's `result` line for guests ("Guest: sign in to keep your
//      wins"), before the room resets.
//   3. Private room: ?private → "Waiting for players" with a 6-character code; ?code=<code> joins that room, not the
//      public one. A long name is ellipsized but "(you)" stays visible; a second finger lifting does not end the
//      joystick drag.
//   4. The harness panel's name field renames the player (reload with ?name=).
//   5. exitRequested from the panel → the game leaves the room → the other player sees one player fewer.
//   6. exitRequested while the room's socket is still connecting → the game leaves as soon as it lands (no ghost).
//   7. A closed tab opened with ?hold keeps its seat for the 60 s reconnection grace (shown offline to the others,
//      `connected` < `players` in the room listing); a new tab with ?resume=<roomId>:<token> reconnects into the same
//      seat (same session id).
//   8. A refresh without ?hold leaves with consent: the old seat is freed at once (no ghost player).
// Every page runs the client's dev-only ?lowfx=1 mode (≤ 15 fps, DPR 1, no MSAA/shadows/hit effects): up to four
// pages render WebGL in software (swiftshader) at once, and on a 2-vCPU CI runner full quality starves a reloading
// page until it cannot boot and join in time. Pages that are screenshotted or checked for layout (Alice, Bob, Cleo)
// have the full 1100×620 viewport until their last screenshot, then a small one like everyone else; pages are closed
// as soon as no step needs them.
// Env: SUMO_URL, COLYSEUS_URL (another port: the game server is started there and pages get ?colyseus=),
// E2E_SCREENSHOT=<png path prefix> (default <tmp>/sumo).
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../../../..');
const SUMO_URL = (process.env.SUMO_URL || 'http://localhost:5182/').replace(/\/?$/, '/');
const COLYSEUS_URL = (process.env.COLYSEUS_URL || 'http://localhost:2567').replace(/\/+$/, '');
const COLYSEUS_PORT = new URL(COLYSEUS_URL).port || '80';
/** Pages talk to the harness' default server unless COLYSEUS_URL names another one. */
const COLYSEUS_PARAM = COLYSEUS_URL === 'http://localhost:2567' ? '' : `&colyseus=${encodeURIComponent(COLYSEUS_URL)}`;
const SHOT = process.env.E2E_SCREENSHOT || path.join(os.tmpdir(), 'sumo');
/** Screenshots and the long-name / joystick checks (shrunk to SMALL once a page's screenshots are taken). */
const FULL = { width: 1100, height: 620 };
/** Everyone else: a quarter of the pixels to render (the harness panel, 300 px wide, still fits). */
const SMALL = { width: 480, height: 480 };
/** Page boot + matchmaking + socket join; generous because a software-rendering 2-vCPU runner is slow to boot. */
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

const t0 = Date.now();
let lap = t0;
/** Log a line with the time since the previous timed line (the CI runner's budget is what these steps take). */
function timed(line) {
  const now = Date.now();
  console.log(`${line}  [${((now - lap) / 1000).toFixed(1)} s]`);
  lap = now;
}
const passed = (msg) => timed(`✓ ${msg}`);

const sumo = (page, expr) => page.evaluate(`window.__sumo && window.__sumo.${expr}`);
const chipNames = (page) => page.$$eval('#scores .chip', (els) => els.map((e) => e.dataset.name).sort());

/** Wait for the game to hold a seat (window.__sumo.joined), with a message that says who and what. */
async function waitJoined(page, who) {
  try {
    await page.waitForFunction(() => window.__sumo && window.__sumo.joined, null, { timeout: JOIN_TIMEOUT_MS });
  } catch (err) {
    throw new Error(
      `${who}: not joined within ${JOIN_TIMEOUT_MS / 1000} s (window.__sumo.joined stayed false: page boot, ` +
        `matchmaking and the socket join did not all finish; a CPU-starved runner is the usual cause)`,
      { cause: err },
    );
  }
  assert.equal(await sumo(page, 'lowfx'), true, `${who}: ?lowfx=1 in effect`);
  await assertBootScreen(page, who);
}

/**
 * The host's loading screen (the harness draws the shell's) followed the game's labels through the join and went away
 * once the game reported progress 1, after ready() (the hold contract).
 */
async function assertBootScreen(page, who) {
  await page.waitForSelector('#rally-dev-harness >> [data-role="loading-overlay"]', {
    state: 'detached',
    timeout: 5_000,
  });
  await page.waitForSelector('#loading', { state: 'hidden', timeout: 5_000 });
  const log = await page.textContent('#rally-dev-harness >> [data-role="log"]');
  assert.match(log, /the loading screen stays up until progress 1/, `${who}: held after ready()`);
  assert.match(log, /loading: Joining the match/, `${who}: labelled join stage`);
  assert.match(log, /playable \d+ ms after ready\(\): loading screen hidden/, `${who}: revealed at progress 1`);
}

async function open(browser, query, errors, { waitForJoin = true, beforeGoto, viewport = SMALL } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${query}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${query}: ${m.text()}`);
  });
  if (beforeGoto) await beforeGoto(page);
  // Every page renders WebGL in software (swiftshader); `load` can take a while on a busy machine, and the
  // game's own __sumo probe is what we wait for anyway.
  await page.goto(`${SUMO_URL}?${query}&lowfx=1${COLYSEUS_PARAM}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (waitForJoin) await waitJoined(page, `?${query}`);
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
  await ensureServer('game server', `${COLYSEUS_URL}/healthz`, '@rally/game-server', { PORT: COLYSEUS_PORT });
  const { serverVersion } = await (await fetch(`${COLYSEUS_URL}/versions`)).json();
  assert.ok(serverVersion >= 2, `game server v${serverVersion} at ${COLYSEUS_URL} predates the result message`);
  await ensureServer('sumo dev server', SUMO_URL, '@rally/game-sumo');

  // Seats of an earlier run's tabs are held for the 60 s reconnection grace (RallyRoom.reconnectSeconds); quick play
  // would join that room.
  const deadline = Date.now() + 75_000;
  for (;;) {
    const { rooms } = await (await fetch(`${COLYSEUS_URL}/rooms/sumo`)).json();
    if (rooms.length === 0) break;
    if (Date.now() > deadline) throw new Error(`public sumo rooms still open: ${JSON.stringify(rooms)}`);
    if (rooms.length) console.log(`· waiting for ${rooms.length} leftover public room(s) to close…`);
    await new Promise((r) => setTimeout(r, 3000));
  }

  timed('· servers ready, no leftover rooms');
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  try {
    // 1. Two players, one room, each sees both in the HUD.
    const alice = await open(browser, 'name=Alice', errors, { viewport: FULL });
    await alice.waitForFunction(
      () =>
        window.__sumo.phase === 'waiting' &&
        /Waiting for players/.test(document.querySelector('#banner-title').textContent),
      null,
      { timeout: 10_000 },
    );
    // Bob holds his seat when his tab goes away (?hold), for the ?resume check in 7; everyone else leaves with consent.
    const bob = await open(browser, 'name=Bob&hold', errors, { viewport: FULL });
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => window.__sumo.names().join() === 'guest-Alice,guest-Bob', null, {
        timeout: 10_000,
      });
      // A guest's seat starts under a random `guest-xxxx` name until their `profile` message renames them, and the
      // HUD rebuilds its chips from the state on the next frame (a software-rendered frame can lag well behind the
      // patch): wait for the chips themselves, not just the state, to show both names.
      await page
        .waitForFunction(
          () =>
            [...document.querySelectorAll('#scores .chip')]
              .map((e) => e.dataset.name)
              .sort()
              .join() === 'guest-Alice,guest-Bob',
          null,
          { timeout: 5_000 },
        )
        .catch(() => {});
      assert.deepEqual(await chipNames(page), ['guest-Alice', 'guest-Bob']);
    }
    assert.equal(await alice.textContent('#scores .chip.me .name'), 'guest-Alice');
    assert.equal(await alice.textContent('#scores .chip.me .tag'), '(you)');
    assert.equal(await bob.textContent('#scores .chip.me .name'), 'guest-Bob');
    const panel = await alice.textContent('#rally-dev-harness >> [data-role="log"]');
    assert.ok(panel.includes(`matchmade sumo via ${COLYSEUS_URL} (quick, as "Alice")`), panel);
    passed('Alice and Bob matchmade through the harness into one room; both HUDs list both players');

    // 2. A round starts; keyboard input moves Alice's puck on the server.
    await alice.waitForFunction(() => window.__sumo.phase === 'countdown', null, { timeout: 10_000 });
    assert.match(await alice.textContent('#banner-title'), /^[123]$/);
    await Promise.all(
      [alice, bob].map((p) => p.waitForFunction(() => window.__sumo.phase === 'playing', null, { timeout: 10_000 })),
    );
    assert.equal(await sumo(alice, 'round'), 1);
    passed('countdown 3-2-1 → round 1 playing on both clients');
    const before = await bob.evaluate(() => window.__sumo.position('guest-Alice'));
    await alice.bringToFront();
    await alice.keyboard.down('ArrowLeft');
    await alice.waitForTimeout(450);
    await alice.keyboard.up('ArrowLeft');
    await bob.waitForFunction((x0) => window.__sumo.position('guest-Alice').x < x0 - 0.5, before.x, {
      timeout: 5_000,
    });
    const after = await bob.evaluate(() => window.__sumo.position('guest-Alice'));
    passed(
      `ArrowLeft on Alice's tab moved her puck on the server (x ${before.x.toFixed(2)} → ${after.x.toFixed(2)}, seen by Bob)`,
    );
    const rtt = await sumo(alice, 'rtt');
    assert.ok(typeof rtt === 'number', 'ping measured');
    assert.match(await alice.textContent('#ping'), /ping \d+ ms/);
    await alice.screenshot({ path: `${SHOT}-alice.png` });
    await bob.screenshot({ path: `${SHOT}-bob.png` });
    // Screenshotted: from here on Alice renders small (Bob after the result shot, Cleo after hers).
    await alice.setViewportSize(SMALL);
    timed(`  screenshots: ${SHOT}-alice.png, ${SHOT}-bob.png`);

    // 2b. Bob drives off the edge, away from Alice, until she has won the match (first to 3 rounds).
    await bob.bringToFront();
    const matchRoom = await sumo(alice, 'roomId');
    for (let round = 0; round < 8; round++) {
      await bob.waitForFunction(() => ['playing', 'matchOver'].includes(window.__sumo.phase), null, {
        timeout: 20_000,
      });
      if ((await sumo(bob, 'phase')) === 'matchOver') break;
      const [me, other] = await bob.evaluate(() => [
        window.__sumo.position('guest-Bob'),
        window.__sumo.position('guest-Alice'),
      ]);
      const key = me.x >= other.x ? 'ArrowRight' : 'ArrowLeft';
      await bob.keyboard.down(key);
      await bob.waitForFunction(
        () => window.__sumo.phase !== 'playing' || !window.__sumo.position('guest-Bob').alive,
        null,
        { timeout: 15_000 },
      );
      await bob.keyboard.up(key);
      await bob.waitForFunction(() => window.__sumo.phase !== 'playing', null, { timeout: 15_000 });
    }
    const guestResult = { matchId: `${matchRoom}:1`, recorded: false, reason: 'guest' };
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => window.__sumo.phase === 'matchOver', null, { timeout: 10_000 });
      await page.waitForFunction(() => window.__sumo.resultLine !== null, null, { timeout: 4_000 });
      assert.deepEqual(await sumo(page, 'resultLine'), { kind: 'guest', text: 'Guest: sign in to keep your wins' });
      assert.deepEqual(await sumo(page, 'result'), guestResult);
    }
    assert.equal(await alice.textContent('#banner-title'), 'You win!');
    assert.equal(await bob.textContent('#banner-title'), 'guest-Alice wins the match');
    await bob.screenshot({ path: `${SHOT}-result.png` });
    await bob.setViewportSize(SMALL);
    // ...and it is gone once the room resets for the next match.
    await alice.waitForFunction(() => window.__sumo.phase !== 'matchOver', null, { timeout: 10_000 });
    await alice.waitForFunction(() => window.__sumo.resultLine === null, null, { timeout: 2_000 });
    passed(`Alice won the match: both match-over banners say "Guest: sign in to keep your wins" (${SHOT}-result.png)`);

    // 3. Private room by code. Cleo has a long name (guest-Cleopatra_VI).
    const cleo = await open(browser, 'name=Cleopatra_VII&private', errors, { viewport: FULL });
    await cleo.waitForFunction(() => /^[A-Z2-9]{6}$/.test(window.__sumo.code), null, { timeout: 10_000 });
    const code = await sumo(cleo, 'code');
    await cleo.waitForFunction(
      (c) =>
        /Waiting for players/.test(document.querySelector('#banner-title').textContent) &&
        document.querySelector('[data-role="code"]')?.textContent === c,
      code,
      { timeout: 5_000 },
    );
    // The name is ellipsized, the "(you)" tag next to it is not clipped. Guests join as guest-<random tag> (matchmaking
    // carries no name) and are renamed by the `profile` message: measure once the long name is on the chip.
    await cleo.waitForSelector('#scores .chip.me .tag', { timeout: 5_000 });
    await cleo.waitForFunction(
      () => document.querySelector('#scores .chip.me .name')?.textContent === 'guest-Cleopatra_VI',
      null,
      { timeout: 5_000 },
    );
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
    passed('long name ellipsized with "(you)" visible; a second finger does not release the joystick');

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
    await cleo.setViewportSize(SMALL);
    // The room id alone does not get anyone in: joinById into a private room needs the code.
    const bare = await fetch(`${COLYSEUS_URL}/matchmake/joinById/${await sumo(cleo, 'roomId')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Snoop' }),
    });
    assert.ok(!bare.ok, 'joinById without the code is refused');
    passed(`private room ${code}: Cleo waits with the code, Dan joins by code; the listing hides it`);

    // 4. Rename from the harness panel.
    await dan.fill('#rally-dev-harness >> [data-role="name"]', 'Danny');
    await dan.click('#rally-dev-harness >> [data-role="name-form"] button');
    await dan.waitForURL(/name=Danny/, { waitUntil: 'commit', timeout: 30_000 });
    await waitJoined(dan, 'Danny, after the harness rename reload');
    // ?code= survives the reload, so Danny lands in Cleo's room again; "Dan" left with consent on the reload (no
    // ?hold), so no offline seat stays behind.
    await cleo.waitForFunction(() => window.__sumo.names().includes('guest-Danny'), null, { timeout: 15_000 });
    assert.ok(!(await cleo.evaluate(() => window.__sumo.names())).includes('guest-Dan'), 'no ghost seat for Dan');
    passed('harness panel "set name" → reload as Danny, back in the same private room (old seat freed)');
    // Pages that are done: fewer software-rendered WebGL contexts for the rest.
    await Promise.all([cleo, dan].map((p) => p.context().close()));

    // 5. exitRequested → the game leaves its room (consented) → Bob sees Alice gone.
    await alice.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await alice.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    await bob.waitForFunction(() => window.__sumo.names().join() === 'guest-Bob', null, { timeout: 5_000 });
    passed('exitRequested → Alice left the room at once (no reconnection grace) → exit overlay');
    await alice.context().close();

    // 6. Exit while the socket join is in flight: hold Eve's WebSocket to the game server until after the click.
    let release;
    const gate = new Promise((r) => (release = r));
    let connecting;
    const seen = new Promise((r) => (connecting = r));
    const eve = await open(browser, 'name=Eve', errors, {
      waitForJoin: false,
      beforeGoto: (page) =>
        page.routeWebSocket(new RegExp(`:${COLYSEUS_PORT}/`), async (ws) => {
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
    passed('exitRequested during the join → Eve left as soon as her socket landed (no ghost seat)');
    await eve.context().close();

    // 7. A closed tab reconnects within the grace: Bob's tab goes away without leaving (no consent), Fay sees him
    //    offline with his seat held; a new tab with ?resume=<roomId>:<token> takes the same seat back.
    const fay = await open(browser, 'name=Fay', errors);
    await fay.waitForFunction(() => window.__sumo.names().join() === 'guest-Bob,guest-Fay', null, { timeout: 10_000 });
    const bobSeat = { roomId: await sumo(bob, 'roomId'), sessionId: await sumo(bob, 'sessionId') };
    const token = await sumo(bob, 'reconnectionToken');
    assert.ok(token.startsWith(`${bobSeat.roomId}:`), `reconnection token ${token}`);
    const closedAt = Date.now();
    await bob.context().close();
    await fay.waitForFunction(() => window.__sumo.connectedOf('guest-Bob') === false, null, { timeout: 10_000 });
    const held = await (await fetch(`${COLYSEUS_URL}/rooms/sumo`)).json();
    const heldRow = held.rooms.find((r) => r.roomId === bobSeat.roomId);
    assert.equal(heldRow?.metadata.players, 2, 'seat held for the grace');
    assert.equal(heldRow?.metadata.connected, 1, 'one of them reconnecting');
    await fay.waitForTimeout(3000); // a few seconds away, well inside the 60 s
    const bob2 = await open(browser, `name=Bob&hold&resume=${encodeURIComponent(token)}`, errors);
    assert.deepEqual(
      { roomId: await sumo(bob2, 'roomId'), sessionId: await sumo(bob2, 'sessionId') },
      bobSeat,
      'same room, same seat',
    );
    const log = await bob2.textContent('#rally-dev-harness >> [data-role="log"]');
    assert.ok(log.includes(`reconnected to sumo via ${COLYSEUS_URL} (resume`), log);
    await fay.waitForFunction(() => window.__sumo.connectedOf('guest-Bob') === true, null, { timeout: 10_000 });
    assert.deepEqual(await fay.evaluate(() => window.__sumo.names()), ['guest-Bob', 'guest-Fay']);
    passed(
      `Bob closed his tab: seat held (offline), then ?resume reconnected him to the same seat after ${((Date.now() - closedAt) / 1000).toFixed(1)} s`,
    );

    // 8. A refresh without ?hold leaves with consent (the harness asks the game to exit on pagehide): no ghost seat.
    const faySession = await sumo(fay, 'sessionId');
    await fay.reload({ waitUntil: 'domcontentloaded' });
    await waitJoined(fay, 'Fay, after a refresh');
    assert.notEqual(await sumo(fay, 'sessionId'), faySession, 'a new seat');
    assert.equal(await sumo(fay, 'roomId'), bobSeat.roomId, 'quick play put her back in the same room');
    await fay.waitForFunction(() => window.__sumo.names().join() === 'guest-Bob,guest-Fay', null, { timeout: 10_000 });
    const afterReload = (await (await fetch(`${COLYSEUS_URL}/rooms/sumo`)).json()).rooms.find(
      (r) => r.roomId === bobSeat.roomId,
    );
    assert.deepEqual(
      {
        clients: afterReload?.clients,
        players: afterReload?.metadata.players,
        connected: afterReload?.metadata.connected,
      },
      { clients: 2, players: 2, connected: 2 },
    );
    passed('Fay refreshed her tab: the old seat was freed at once (2 players, none reconnecting)');

    // Leave with consent, so a rerun does not wait for these seats' grace.
    for (const page of [bob2, fay]) {
      await page.click('#rally-dev-harness >> button[data-action="exitRequested"]');
      await page.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    }

    const unexpected = errors.filter((e) => !/WebGPU|GPU stall|favicon|Automatic fallback to software WebGL/i.test(e));
    assert.deepEqual(unexpected, [], 'no page errors');
    console.log(`\nPASS sumo e2e in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
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
