import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WEAPON_IDS, WEAPONS, type GunRunPlayerView } from '@rally/game-gunrun-server';
import { formatClock, ladderStandings, rungText, weaponIcon } from '../src/hud.ts';
import { MatchResultView, parseResultMessage, resultLine } from '../src/result.ts';

const p = (over: Partial<GunRunPlayerView>): GunRunPlayerView => ({
  name: 'x',
  slot: 0,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  aim: 0,
  hp: 100,
  alive: true,
  prot: false,
  respawn: 0,
  tier: 0,
  tk: 0,
  kills: 0,
  deaths: 0,
  connected: true,
  guest: true,
  bot: false,
  ack: 0,
  ...over,
});

test('the scoreboard is the ladder: rung, kills on it, kills, fewer deaths, then the seat', () => {
  const players = new Map<string, GunRunPlayerView>([
    ['a', p({ slot: 0, tier: 2, tk: 0, kills: 6 })],
    ['b', p({ slot: 1, tier: 3, tk: 1, kills: 10 })],
    ['c', p({ slot: 2, tier: 2, tk: 2, kills: 8 })],
    ['d', p({ slot: 3, tier: 2, tk: 2, kills: 8, deaths: 3 })],
    ['e', p({ slot: 4, tier: 2, tk: 2, kills: 8, deaths: 3, bot: true })],
  ]);
  assert.deepEqual(
    ladderStandings({ players }).map(([id]) => id),
    ['b', 'c', 'd', 'e', 'a'],
  );
});

test('rungs, pips and the clock', () => {
  assert.deepEqual(rungText({ tier: 0, tk: 0 }), { rung: '1/9', pips: '○○○' });
  assert.deepEqual(rungText({ tier: 4, tk: 2 }), { rung: '5/9', pips: '●●○' });
  assert.deepEqual(rungText({ tier: 8, tk: 0 }), { rung: '9/9', pips: '' }, 'the knife: no pips');
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(65.9), '1:05');
  assert.equal(formatClock(-3), '0:00');
  assert.equal(weaponIcon(-1), '🛢️');
  assert.equal(weaponIcon(WEAPON_IDS.indexOf('knife')), WEAPONS.knife.icon);
  assert.equal(weaponIcon(99), null);
});

test('result messages: parsed defensively; the line names the boards and unlocks', () => {
  assert.equal(parseResultMessage(null), null);
  assert.equal(parseResultMessage({ matchId: 'm', recorded: false, reason: 'nope' }), null);
  assert.deepEqual(
    parseResultMessage({
      matchId: 'm',
      recorded: true,
      boards: { wins: { score: 4, rank: 2 }, kills: { score: 'x', rank: 1 } },
      unlocked: [{ key: 'first_win', title: 'Top Gun', icon: '🏆' }, { key: 1 }],
    }),
    {
      matchId: 'm',
      recorded: true,
      boards: { wins: { score: 4, rank: 2 } },
      unlocked: [{ key: 'first_win', title: 'Top Gun', icon: '🏆' }],
    },
  );
  assert.deepEqual(resultLine('pending'), { kind: 'pending', text: 'Saving your result…' });
  assert.equal(
    resultLine({ matchId: 'm', recorded: false, reason: 'guest' }).text,
    'Guest: sign in to keep your stats',
  );
  assert.equal(resultLine({ matchId: 'm', recorded: false, reason: 'unavailable' }).text, 'Result not saved');
  assert.equal(
    resultLine({
      matchId: 'm',
      recorded: true,
      boards: { kills: { score: 9, rank: 7 }, wins: { score: 4, rank: 2 } },
      unlocked: [{ key: 'first_win', title: 'Top Gun', icon: '🏆' }],
    }).text,
    'Wins #2 · Kills #7 · 🏆 Top Gun unlocked',
  );
  assert.equal(resultLine({ matchId: 'm', recorded: true, boards: {}, unlocked: [] }).text, 'Match saved');
});

test('the result belongs to the match-over banner it arrived for', () => {
  const v = new MatchResultView();
  v.observe('playing', 0);
  assert.equal(v.current(), null);
  v.receive({ matchId: 'r:1', recorded: false, reason: 'guest' }, 990);
  v.observe('over', 1000);
  assert.deepEqual(v.current(), { matchId: 'r:1', recorded: false, reason: 'guest' });
  v.observe('starting', 9000);
  assert.equal(v.current(), null, 'gone with the next match');
  v.observe('over', 20000);
  assert.equal(v.current(), 'pending', 'an old result is never shown for a new match');
});
