import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RESULT_BOARD, ServerMessage } from '../src/state.ts';

const manifest = JSON.parse(readFileSync(new URL('../../game.json', import.meta.url), 'utf8')) as {
  leaderboards: { id: string }[];
  server: { room: string; minVersion: number };
};

test('the result message reports the rank of a board game.json declares', () => {
  assert.equal(ServerMessage.result, 'result');
  assert.ok(manifest.leaderboards.some((b) => b.id === RESULT_BOARD));
});

test('game.json needs a server that sends `result` (SERVER_VERSION 2)', () => {
  assert.equal(manifest.server.room, 'sumo');
  assert.ok(manifest.server.minVersion >= 2);
});
