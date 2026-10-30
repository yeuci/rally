/* eslint-disable @typescript-eslint/no-require-imports */
// End-to-end check of the dev harness in a real browser (not part of `pnpm test`: it needs two servers).
//
//   pnpm --filter @rally/dev-harness test:e2e
//
// Starts the Colyseus game server (:2567) and the spike's Vite dev server (:5180) unless they are already
// running, drives Chromium with Playwright and asserts that the spike's hosted path works through the
// fake host: handshake, bridge RTT, host matchmaking → seat reservation → "in room", host events, save
// CONFLICT semantics, NOT_SUPPORTED methods, nonce check, ?nohost standalone path, the exit overlay, the panel's
// room list, and ?resume: a real reconnection into a seat held after a drop, the rejoin journal and its failure path.
// Servers it started are killed at the end. Env: SPIKE_URL, COLYSEUS_URL, E2E_SCREENSHOT=<png path>.
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { Client } = require('@colyseus/sdk');

const ROOT = path.resolve(__dirname, '../../..');
const SPIKE_URL = process.env.SPIKE_URL || 'http://localhost:5180/';
const COLYSEUS_URL = process.env.COLYSEUS_URL || 'http://localhost:2567';
const SCREENSHOT = process.env.E2E_SCREENSHOT || path.join(os.tmpdir(), 'rally-dev-harness-e2e.png');

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

/** Raw bridge call from inside the page, bypassing the SDK, to exercise host semantics directly. */
function bridgeCall(page, method, params, opts = {}) {
  return page.evaluate(
    ({ method, params, badNonce, timeoutMs }) =>
      new Promise((resolve) => {
        const host = window.__rally;
        const id = `e2e-${Math.random().toString(36).slice(2)}`;
        const original = host.recv;
        const timer = setTimeout(() => {
          host.recv = original;
          resolve({ timeout: true });
        }, timeoutMs);
        host.recv = (json) => {
          const env = JSON.parse(json);
          if (env.id !== id) return original(json);
          clearTimeout(timer);
          host.recv = original;
          resolve(env);
        };
        const nonce = badNonce ? 'x'.repeat(32) : host.nonce;
        window.ReactNativeWebView.postMessage(JSON.stringify({ v: 1, nonce, id, kind: 'req', method, params }));
      }),
    { method, params, badNonce: Boolean(opts.badNonce), timeoutMs: opts.timeoutMs || 5000 },
  );
}

async function main() {
  await ensureServer('game server', COLYSEUS_URL, '@rally/game-server');
  await ensureServer('spike dev server', SPIKE_URL, '@rally/game-spike');

  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    // 1. Hosted path through the fake host.
    await page.goto(SPIKE_URL);
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'in room', null, {
      timeout: 30_000,
    });
    console.log('✓ HUD status "in room" (ready → session.join → consumeSeatReservation)');
    // The spike probes the bridge every 2 s and its socket every 1 s; wait until both numbers are filled in,
    // then a little longer so the RTT shown is a steady-state probe rather than the one taken during boot.
    await page.waitForFunction(
      () => /bridge \d+(\.\d+)? ms\s+ws \d+ ms/.test(document.querySelector('#stats')?.textContent ?? ''),
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(4500);
    const stats = await page.textContent('#stats');
    const rtt = /bridge (\d+(?:\.\d+)?) ms/.exec(stats)[1];
    console.log(`✓ bridge RTT ${rtt} ms   (HUD: ${stats.split('\n')[2].trim()})`);
    assert.match(stats, /room [^—\s]+…\/\w+/, 'HUD shows the room id');

    const panelStatus = await page.textContent('#rally-dev-harness >> [data-role="status"]');
    assert.match(panelStatus, /^in room /);
    const panelLog = await page.textContent('#rally-dev-harness >> [data-role="log"]');
    assert.match(panelLog, /ready\(\) after \d+ ms/);
    assert.match(panelLog, /matchmade hello via http:\/\/localhost:2567/);
    console.log(`✓ panel: "${panelStatus}"`);
    // The panel's room list (GET /rooms/hello, polled while open) shows this page's room, marked as current.
    const joinedRoomId = panelStatus.replace(/^in room /, '');
    await page.waitForSelector('#rally-dev-harness >> [data-role="rooms"] .room.current', { timeout: 10_000 });
    const current = await page.getAttribute('#rally-dev-harness >> [data-role="rooms"] .room.current', 'data-room-id');
    assert.equal(current, joinedRoomId);
    console.log(`✓ panel room list shows room ${current} (you)`);

    // 2. Host events from the panel.
    await page.click('#rally-dev-harness >> button[data-action="pause"]');
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'paused');
    await page.click('#rally-dev-harness >> button[data-action="resume"]');
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'resumed');
    console.log('✓ pause / resume host events reach the game');

    // 3. Host semantics, straight over the bridge.
    const ctx = await bridgeCall(page, 'ready', { sdkVersion: '0.1.0' });
    assert.equal(ctx.error?.code, 'ALREADY_READY');
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('rally-harness:save:')) localStorage.removeItem(k);
    });
    const put1 = await bridgeCall(page, 'save.put', { slot: 'e2e', data: { level: 3 } });
    assert.deepEqual(put1.params, { version: 1 });
    const conflict = await bridgeCall(page, 'save.put', { slot: 'e2e', data: { level: 4 }, ifVersion: 0 });
    assert.equal(conflict.error?.code, 'CONFLICT');
    const put2 = await bridgeCall(page, 'save.put', { slot: 'e2e', data: { level: 4 }, ifVersion: 1 });
    assert.deepEqual(put2.params, { version: 2 });
    const got = await bridgeCall(page, 'save.get', { slot: 'e2e' });
    assert.deepEqual(got.params, { data: { level: 4 }, version: 2 });
    const stored = await page.evaluate(() => localStorage.getItem('rally-harness:save:spike:e2e'));
    assert.deepEqual(JSON.parse(stored), { data: { level: 4 }, version: 2 });
    assert.equal((await bridgeCall(page, 'save.get', { slot: 'bad slot!' })).error?.code, 'INVALID_PARAMS');
    console.log('✓ save.get / save.put persist in localStorage with versions, CONFLICT and slot validation');
    for (const m of [
      ['leaderboard.top', { boardId: 'x' }],
      ['leaderboard.submit', { boardId: 'x', score: 1 }],
      ['achievement.unlock', { key: 'k' }],
    ]) {
      const r = await bridgeCall(page, m[0], m[1]);
      assert.equal(r.error?.code, 'NOT_SUPPORTED', m[0]);
    }
    assert.equal((await bridgeCall(page, 'nope', {})).error?.code, 'UNKNOWN_METHOD');
    assert.equal((await bridgeCall(page, 'ping', {})).error?.code, 'INVALID_PARAMS');
    assert.equal((await bridgeCall(page, 'party.get', {})).params, null);
    assert.equal((await bridgeCall(page, 'ping', { t: 1 }, { badNonce: true, timeoutMs: 800 })).timeout, true);
    console.log(
      '✓ leaderboard/achievement NOT_SUPPORTED, unknown method, bad params, party.get null, wrong nonce dropped',
    );

    await page.screenshot({ path: SCREENSHOT });
    console.log(`  screenshot: ${SCREENSHOT}`);

    // 4. exitRequested → the spike leaves its room and calls exit("host") → exit overlay.
    await page.click('#rally-dev-harness >> button[data-action="exitRequested"]');
    await page.waitForSelector('#rally-dev-harness >> [data-role="exit-overlay"]', { timeout: 10_000 });
    const overlay = await page.textContent('#rally-dev-harness >> [data-role="exit-overlay"]');
    assert.match(overlay, /game exited \(host\)/);
    console.log(`✓ exitRequested → game called exit() → overlay "${overlay.replace('reload', '').trim()}"`);

    // 5. Standalone path: ?nohost leaves window.__rally undefined.
    const standalone = await context.newPage();
    await standalone.goto(`${SPIKE_URL}?nohost`);
    await standalone.waitForFunction(
      () => document.querySelector('#status')?.textContent === 'standalone (no host bridge)',
      null,
      { timeout: 30_000 },
    );
    assert.equal(await standalone.evaluate(() => typeof window.__rally), 'undefined');
    assert.match(await standalone.textContent('#rally-dev-harness >> button[data-action="toggle-host"]'), /host: off/);
    console.log('✓ ?nohost → standalone path ("standalone (no host bridge)"), panel shows host: off');

    // Software-rendered WebGL pages compete for the CPU: close the finished ones before opening more.
    await standalone.close();
    await page.close();

    // 6. ?resume=<roomId>:<token>: a player (a Node SDK client, as a guest) drops without consent; a fresh page
    //    reconnects into the held seat through POST /matchmake/reconnect (same room, same session).
    const sdk = new Client(COLYSEUS_URL);
    const dropped = await sdk.joinOrCreate('hello');
    const token = dropped.reconnectionToken;
    const { roomId, sessionId } = dropped;
    dropped.reconnection.enabled = false; // the page, not this client, takes the seat back
    await dropped.leave(false);
    const resumed = await context.newPage();
    await resumed.goto(`${SPIKE_URL}?resume=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' });
    await resumed.waitForFunction(() => document.querySelector('#status')?.textContent === 'in room', null, {
      timeout: 30_000,
    });
    const resumedLog = await resumed.textContent('#rally-dev-harness >> [data-role="log"]');
    assert.match(resumedLog, new RegExp(`reconnected to hello .*\\(resume, .*→ room ${roomId}, session ${sessionId}`));
    console.log(
      `✓ ?resume=<roomId>:<token> → POST /matchmake/reconnect → back in room ${roomId} as session ${sessionId}`,
    );

    //    The journal: a report for this room is stored (and offered as "reload with ?resume"), others are ignored.
    const reported = await bridgeCall(resumed, 'session.reportReconnection', {
      roomId,
      token: `${roomId}:not-a-real-token`,
      ttlSec: 30,
    });
    assert.equal(reported.params, null);
    await bridgeCall(resumed, 'session.reportReconnection', { roomId: 'other', token: 'other:x', ttlSec: 30 });
    const record = await resumed.evaluate(() =>
      Object.entries(localStorage).find(([k]) => k.startsWith('rally-harness:rejoin:spike:')),
    );
    assert.ok(record, 'rejoin record stored');
    assert.equal(JSON.parse(record[1]).roomId, roomId);
    assert.equal(JSON.parse(record[1]).token, 'not-a-real-token');
    await resumed.waitForSelector('#rally-dev-harness >> button[data-action="rejoin"]:not([hidden])');
    assert.match(
      await resumed.textContent('#rally-dev-harness >> [data-role="log"]'),
      /reconnection token for room other ignored: not the joined room/,
    );
    //    Bare ?resume (the rejoin button) uses the stored token; a dead one fails without falling back to quick play.
    await resumed.click('#rally-dev-harness >> button[data-action="rejoin"]');
    await resumed.waitForURL(/[?&]resume$/);
    await resumed.waitForFunction(() => /^error: /.test(document.querySelector('#status')?.textContent ?? ''), null, {
      timeout: 30_000,
    });
    const failedLog = await resumed.textContent('#rally-dev-harness >> [data-role="log"]');
    assert.match(failedLog, /session\.join MATCHMAKE_FAILED: that match has ended/);
    assert.doesNotMatch(failedLog, /matchmade hello/);
    assert.equal(
      await resumed.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('rally-harness:rejoin:'))),
      false,
      'failed resume clears the record',
    );
    console.log(
      '✓ rejoin journal: report stored for the joined room only; bare ?resume with a dead token → "that match has ended", record cleared',
    );

    const unexpected = errors.filter((e) => !/WebGPU|GPU stall|favicon/i.test(e));
    assert.deepEqual(unexpected, [], 'no page errors');
    console.log('\nPASS dev-harness e2e');
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
    console.error('\nFAIL dev-harness e2e:', err);
    stopServers();
    process.exit(1);
  });
