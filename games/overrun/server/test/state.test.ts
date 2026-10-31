import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ACHIEVEMENTS, MAX_PLAYERS, MIN_PLAYERS, RESULT_BOARDS, ServerMessage } from '../src/index.ts';

const manifest = JSON.parse(readFileSync(new URL('../../game.json', import.meta.url), 'utf8')) as {
  leaderboards: { id: string; sort: string }[];
  achievements: { key: string }[];
  players: { min: number; max: number };
  server: { room: string; minVersion: number };
};

test('the boards and achievements the room reports are the ones game.json declares', () => {
  assert.equal(ServerMessage.result, 'result');
  assert.deepEqual(
    manifest.leaderboards.map((b) => [b.id, b.sort]),
    RESULT_BOARDS.map((id) => [id, 'desc']),
  );
  assert.deepEqual(manifest.achievements.map((a) => a.key).sort(), Object.keys(ACHIEVEMENTS).sort());
});

test('game.json: room overrun, 1–4 players, a server with the overrun room (SERVER_VERSION 3)', () => {
  assert.equal(manifest.server.room, 'overrun');
  assert.ok(manifest.server.minVersion >= 3);
  assert.deepEqual([manifest.players.min, manifest.players.max], [MIN_PLAYERS, MAX_PLAYERS]);
});
