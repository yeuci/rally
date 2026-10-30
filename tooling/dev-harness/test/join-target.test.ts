import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  joinTargetHref,
  launchIntentFor,
  parseJoinTarget,
  type JoinTarget,
  type RejoinRecord,
} from '../src/handlers.ts';
import { splitReconnectionToken } from '../src/matchmake.ts';
import { roomRows } from '../src/panel.ts';

const q = (search: string) => new URLSearchParams(search);
const stored: RejoinRecord = {
  gameId: 'sumo',
  roomId: 'R1',
  token: 'tok',
  code: 'K7M2PQ',
  intent: 'private',
  ttlSec: 60,
  expiresAt: Date.now() + 60_000,
};

test('parseJoinTarget: quick by default, ?private / intent private, ?code, ?room, ?room&code', () => {
  assert.deepEqual(parseJoinTarget(q('')), { kind: 'quick' });
  assert.deepEqual(parseJoinTarget(q('?name=alice&intent=solo')), { kind: 'quick' });
  assert.deepEqual(parseJoinTarget(q('?private')), { kind: 'private' });
  assert.deepEqual(parseJoinTarget(q(''), { intent: 'private' }), { kind: 'private' });
  assert.deepEqual(parseJoinTarget(q('?code=K7M2PQ')), { kind: 'code', code: 'K7M2PQ' });
  assert.deepEqual(parseJoinTarget(q('?room=abc')), { kind: 'room', roomId: 'abc' });
  // With both, the id is used directly with the code (no lookup), which is what the panel's room list sends.
  assert.deepEqual(parseJoinTarget(q('?room=abc&code=K7M2PQ')), { kind: 'room', roomId: 'abc', code: 'K7M2PQ' });
  // Blank values do not count.
  assert.deepEqual(parseJoinTarget(q('?room=&code=%20')), { kind: 'quick' });
});

test('parseJoinTarget: ?resume=<roomId>:<token> splits on the first colon and wins over the other targets', () => {
  assert.deepEqual(parseJoinTarget(q('?resume=R9:abc:def&private')), {
    kind: 'resume',
    roomId: 'R9',
    token: 'abc:def',
  });
  assert.deepEqual(parseJoinTarget(q('?resume=R9:tok&code=ZZZ999')), {
    kind: 'resume',
    roomId: 'R9',
    token: 'tok',
    code: 'ZZZ999',
  });
  // A bare token needs the room id from ?room=.
  assert.deepEqual(parseJoinTarget(q('?resume=tok&room=R9')), { kind: 'resume', roomId: 'R9', token: 'tok' });
  assert.equal(parseJoinTarget(q('?resume=tok')).kind, 'invalid');
  assert.equal(parseJoinTarget(q('?resume=R9:')).kind, 'invalid');
  // The stored record's code is reused only for the same room.
  assert.deepEqual(parseJoinTarget(q('?resume=R1:new'), { stored }), {
    kind: 'resume',
    roomId: 'R1',
    token: 'new',
    code: 'K7M2PQ',
  });
  assert.deepEqual(parseJoinTarget(q('?resume=R2:new'), { stored }), { kind: 'resume', roomId: 'R2', token: 'new' });
});

test('parseJoinTarget: bare ?resume uses the stored record, else is invalid (no silent quick play)', () => {
  assert.deepEqual(parseJoinTarget(q('?resume'), { stored }), {
    kind: 'resume',
    roomId: 'R1',
    token: 'tok',
    code: 'K7M2PQ',
  });
  const missing = parseJoinTarget(q('?resume'), { stored: null });
  assert.equal(missing.kind, 'invalid');
  assert.match((missing as { reason: string }).reason, /no reconnection token is stored/);
});

test('splitReconnectionToken: <roomId>:<token> on the first colon; a bare token has no room', () => {
  assert.deepEqual(splitReconnectionToken('abcd1234:tok'), { roomId: 'abcd1234', token: 'tok' });
  assert.deepEqual(splitReconnectionToken('abcd1234:t:o:k'), { roomId: 'abcd1234', token: 't:o:k' });
  assert.deepEqual(splitReconnectionToken('tok'), { roomId: null, token: 'tok' });
  assert.deepEqual(splitReconnectionToken(':tok'), { roomId: '', token: 'tok' });
});

test('launchIntentFor: joinById for room/code, private, the original intent for a resume', () => {
  assert.equal(launchIntentFor({ kind: 'quick' }, 'quick'), 'quick');
  assert.equal(launchIntentFor({ kind: 'quick' }, 'solo'), 'solo');
  assert.equal(launchIntentFor({ kind: 'private' }, 'quick'), 'private');
  assert.equal(launchIntentFor({ kind: 'code', code: 'X' }, 'quick'), 'joinById');
  assert.equal(launchIntentFor({ kind: 'room', roomId: 'R' }, 'quick'), 'joinById');
  assert.equal(launchIntentFor({ kind: 'resume', roomId: 'R1', token: 't' }, 'quick', stored), 'private');
  assert.equal(launchIntentFor({ kind: 'resume', roomId: 'R2', token: 't' }, 'quick', stored), 'quick');
  assert.equal(launchIntentFor({ kind: 'resume', roomId: 'R2', token: 't', code: 'C' }, 'quick'), 'joinById');
  assert.equal(launchIntentFor({ kind: 'invalid', reason: 'x' }, 'quick'), 'quick');
});

test('joinTargetHref replaces only the join parameters and round-trips through parseJoinTarget', () => {
  const base = 'http://localhost:5180/?name=alice&private&code=OLD123&colyseus=ws%3A%2F%2Fpc%3A2567';
  const targets: Exclude<JoinTarget, { kind: 'invalid' }>[] = [
    { kind: 'quick' },
    { kind: 'private' },
    { kind: 'code', code: 'K7M2PQ' },
    { kind: 'room', roomId: 'abc' },
    { kind: 'room', roomId: 'abc', code: 'K7M2PQ' },
    { kind: 'resume', roomId: 'R9', token: 'tok' },
  ];
  for (const t of targets) {
    const url = new URL(joinTargetHref(base, t));
    assert.equal(url.searchParams.get('name'), 'alice');
    assert.equal(url.searchParams.get('colyseus'), 'ws://pc:2567');
    assert.deepEqual(parseJoinTarget(url.searchParams), t);
  }
  assert.equal(joinTargetHref('http://h/?room=x', { kind: 'private' }), 'http://h/?private');
  assert.equal(joinTargetHref('http://h/?intent=private&room=x', { kind: 'room', roomId: 'y' }), 'http://h/?room=y');
  // `stored` → bare ?resume (the journal holds the freshest token).
  assert.equal(joinTargetHref('http://h/?name=a&room=x', { kind: 'stored' }), 'http://h/?name=a&resume');
  assert.deepEqual(parseJoinTarget(new URL('http://h/?name=a&resume').searchParams, { stored }).kind, 'resume');
});

test('roomRows: metadata name/players/phase, fallbacks, joinable and current', () => {
  const rows = roomRows(
    [
      {
        roomId: 'A',
        clients: 2,
        maxClients: 6,
        locked: false,
        metadata: { name: 'Sumo AB12', players: 3, maxPlayers: 6, private: false, serverVersion: 2, phase: 'playing' },
      },
      { roomId: 'B', clients: 6, maxClients: 6, locked: false, metadata: { name: '  ', phase: 'waiting' } },
      { roomId: 'C', clients: 1, maxClients: 8, locked: true, metadata: null },
      {
        roomId: 'D',
        clients: 1,
        maxClients: 4,
        locked: false,
        metadata: { name: 'Mine', private: true, code: 'K7M2PQ', players: 1, maxPlayers: 4 },
      },
    ],
    'C',
  );
  assert.deepEqual(rows[0], {
    roomId: 'A',
    name: 'Sumo AB12',
    players: 3,
    maxPlayers: 6,
    phase: 'In match',
    private: false,
    serverVersion: 2,
    joinable: true,
    current: false,
  });
  assert.deepEqual(
    rows.slice(1).map((r) => [r.name, r.players, r.maxPlayers, r.phase, r.joinable, r.current, r.code]),
    [
      ['B', 6, 6, 'Waiting', false, false, undefined],
      ['C', 1, 8, null, false, true, undefined],
      ['Mine', 1, 4, null, true, false, 'K7M2PQ'],
    ],
  );
});
