import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HOW_RALLY_WORKS,
  WELCOME_COPY,
  WELCOME_STEPS,
  WELCOME_WINDOW_MS,
  WELCOMED_KEY_PREFIX,
  featuredForWelcome,
  isNewAccount,
  nextWelcomeStep,
  parseWelcomed,
  previousWelcomeStep,
  shouldShowWelcome,
  welcomeStepLabel,
  welcomeTopPadding,
  welcomedKey,
  welcomedRecord,
  type WelcomeInput,
} from '../src/lib/welcome-model';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 2, 12);
const iso = (ms: number) => new Date(ms).toISOString();

const input = (over: Partial<WelcomeInput> = {}): WelcomeInput => ({
  signedIn: true,
  createdAt: iso(NOW - 2 * MINUTE),
  welcomed: false,
  now: NOW,
  gameOpen: false,
  openedThisRun: false,
  ...over,
});

test('a new account is one created within the last ten minutes (or a little in the future: the device clock behind)', () => {
  assert.equal(WELCOME_WINDOW_MS, 10 * MINUTE);
  assert.equal(isNewAccount(iso(NOW), NOW), true);
  assert.equal(isNewAccount(iso(NOW - 9 * MINUTE), NOW), true);
  assert.equal(isNewAccount(iso(NOW - 10 * MINUTE), NOW), true, 'the window is inclusive');
  assert.equal(isNewAccount(iso(NOW - 10 * MINUTE - 1), NOW), false);
  assert.equal(isNewAccount(iso(NOW - 3 * 24 * 60 * MINUTE), NOW), false, 'an existing account');
  assert.equal(isNewAccount(iso(NOW + 3 * MINUTE), NOW), true, 'created "in the future": the clocks disagree a little');
  assert.equal(isNewAccount(iso(NOW + 11 * MINUTE), NOW), false);
  assert.equal(isNewAccount('2026-11-02 11:58:00+00', NOW), true, 'Postgres spelling parses too');
  assert.equal(isNewAccount(undefined, NOW), false);
  assert.equal(isNewAccount(null, NOW), false);
  assert.equal(isNewAccount('', NOW), false);
  assert.equal(isNewAccount('yesterday', NOW), false);
});

test('the welcome opens once for a signed-in new account whose flag has been read and is not set', () => {
  assert.equal(shouldShowWelcome(input()), true);
  assert.equal(shouldShowWelcome(input({ signedIn: false })), false, 'signed out or an anonymous mid-signup session');
  assert.equal(shouldShowWelcome(input({ createdAt: null })), false, 'the profile has not loaded');
  assert.equal(shouldShowWelcome(input({ createdAt: undefined })), false);
  assert.equal(shouldShowWelcome(input({ createdAt: iso(NOW - 11 * MINUTE) })), false, 'not a new account');
  assert.equal(shouldShowWelcome(input({ welcomed: null })), false, 'the flag has not been read yet');
  assert.equal(shouldShowWelcome(input({ welcomed: true })), false, 'welcomed before on this device');
  assert.equal(shouldShowWelcome(input({ gameOpen: true })), false, 'never over a game');
  assert.equal(shouldShowWelcome(input({ openedThisRun: true })), false, 'never twice in one run');
});

test('the stored flag: a record round-trips, and anything stored at all counts as welcomed', () => {
  assert.equal(WELCOMED_KEY_PREFIX, 'rally.welcomed.');
  assert.equal(welcomedKey('0b9d-uid'), 'rally.welcomed.0b9d-uid');
  const record = welcomedRecord('skipped', NOW);
  assert.deepEqual(parseWelcomed(JSON.stringify(record)), { at: NOW, how: 'skipped' });
  assert.deepEqual(parseWelcomed(JSON.stringify(welcomedRecord('play', NOW))), { at: NOW, how: 'play' });
  assert.equal(parseWelcomed(null), null);
  assert.equal(parseWelcomed(undefined), null);
  assert.equal(parseWelcomed(''), null);
  assert.deepEqual(parseWelcomed('1'), { at: null, how: null }, 'a bare marker still counts');
  assert.deepEqual(parseWelcomed('not json'), { at: null, how: null });
  assert.deepEqual(parseWelcomed('[1]'), { at: null, how: null });
  assert.deepEqual(
    parseWelcomed(JSON.stringify({ at: -5, how: 'later' })),
    { at: null, how: null },
    'bad fields dropped',
  );
});

test('three steps in order, with a way forward and back', () => {
  assert.deepEqual(WELCOME_STEPS, ['look', 'how', 'people']);
  assert.equal(nextWelcomeStep('look'), 'how');
  assert.equal(nextWelcomeStep('how'), 'people');
  assert.equal(nextWelcomeStep('people'), null);
  assert.equal(previousWelcomeStep('look'), null);
  assert.equal(previousWelcomeStep('how'), 'look');
  assert.equal(previousWelcomeStep('people'), 'how');
  assert.equal(welcomeStepLabel('look'), 'Step 1 of 3');
  assert.equal(welcomeStepLabel('people'), 'Step 3 of 3');
  assert.equal(WELCOME_COPY.look.title, 'Pick your look');
  assert.equal(WELCOME_COPY.how.title, 'How Rally works');
  assert.equal(WELCOME_COPY.people.title, 'Find your people');
  for (const step of WELCOME_STEPS) assert.ok(WELCOME_COPY[step].lede.length > 0, `${step} has a lede`);
});

test('"How Rally works" is three short lines: play, earn, spend', () => {
  assert.deepEqual(
    HOW_RALLY_WORKS.map((l) => l.key),
    ['play', 'earn', 'spend'],
  );
  assert.deepEqual(
    HOW_RALLY_WORKS.map((l) => l.title),
    ['Play games with friends', 'Earn coins and levels', 'Spend coins in the shop'],
  );
  for (const line of HOW_RALLY_WORKS) {
    assert.ok(line.body.length > 0 && line.body.length <= 80, `${line.key}: one line, not a paragraph`);
  }
});

test('"Play something" opens the hero\'s first featured game, when there is one', () => {
  assert.deepEqual(featuredForWelcome([{ id: 'sumo' }, { id: 'stack' }]), { id: 'sumo' });
  assert.equal(featuredForWelcome([]), null);
  assert.equal(featuredForWelcome(undefined), null);
  assert.equal(featuredForWelcome(null), null);
});

test('top padding: a fixed gap in an iOS sheet, the inset when the screen covers the window', () => {
  assert.equal(welcomeTopPadding(true, 59), 20);
  assert.equal(welcomeTopPadding(false, 59), 71);
  assert.equal(welcomeTopPadding(false, 0), 12);
  assert.equal(welcomeTopPadding(false, -4), 12, 'never less than the gap');
});
