import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoomLookupError, type RoomListing } from '../src/game-host/matchmake';
import {
  checkJoinCode,
  codeCells,
  codeInputValue,
  codeProblemMessage,
  extractJoinCode,
  formatJoinCode,
  spokenJoinCode,
  ROOM_CODE_PILL_MS,
  roomCodeShareMessage,
} from '../src/lib/join-code-input';
import {
  formatCountdown,
  isGameScreen,
  REJOIN_OFFER_MIN_S,
  rejoinCountdown,
  rejoinTitle,
  shouldOfferRejoin,
} from '../src/lib/rejoin';
import { openRoomsLabel, roomPhase, roomRow, roomRows } from '../src/lib/rooms';

// --- code input ------------------------------------------------------------------------------------------------

test('codeInputValue upper-cases and keeps only alphabet symbols, at most six', () => {
  assert.equal(codeInputValue('k7m'), 'K7M');
  assert.equal(codeInputValue('k7m-2pq'), 'K7M2PQ');
  assert.equal(codeInputValue(' K7M 2PQ '), 'K7M2PQ');
  // Look-alikes outside the alphabet (0 O 1 I L) and punctuation are dropped, not mapped.
  assert.equal(codeInputValue('O0I1L'), '');
  assert.equal(codeInputValue('AB0CD'), 'ABCD');
  assert.equal(codeInputValue('ABCDEFGH'), 'ABCDEF');
  assert.equal(codeInputValue(''), '');
});

test('codeInputValue finds the code inside pasted text', () => {
  assert.equal(codeInputValue('Join my Sumo room: k7m-2pq'), 'K7M2PQ');
  assert.equal(codeInputValue('code K7M 2PQ thanks'), 'K7M2PQ');
  assert.equal(extractJoinCode('nothing here'), null);
  // A token with symbols outside the alphabet is not a code.
  assert.equal(extractJoinCode('ABC-DE0 then K7M2PQ'), 'K7M2PQ');
});

test('formatJoinCode shows K7M-2PQ, partial codes as typed', () => {
  assert.equal(formatJoinCode('K7M2PQ'), 'K7M-2PQ');
  assert.equal(formatJoinCode('K7M2'), 'K7M-2');
  assert.equal(formatJoinCode('K7M'), 'K7M');
  assert.equal(formatJoinCode(''), '');
});

test('codeCells marks the caret cell', () => {
  assert.deepEqual(
    codeCells('K7').map((c) => [c.char, c.active]),
    [
      ['K', false],
      ['7', false],
      ['', true],
      ['', false],
      ['', false],
      ['', false],
    ],
  );
  assert.equal(
    codeCells('K7M2PQ').some((c) => c.active),
    false,
  );
  assert.equal(spokenJoinCode('K7M2PQ'), 'K 7 M, 2 P Q');
});

test('checkJoinCode: a valid code → join=room with the id and the normalised code', async () => {
  const seen: string[] = [];
  const res = await checkJoinCode('k7m-2pq', 'sumo', async (code) => {
    seen.push(code);
    return { roomId: 'abc_123', roomName: 'sumo' };
  });
  assert.deepEqual(seen, ['K7M2PQ']);
  assert.deepEqual(res, { ok: true, target: { join: 'room', room: 'abc_123', code: 'K7M2PQ' } });
});

test('checkJoinCode: bad code (no request), other game, lookup errors → sheet copy', async () => {
  let calls = 0;
  const bad = await checkJoinCode('K7M', 'sumo', async () => {
    calls += 1;
    return { roomId: 'x', roomName: 'sumo' };
  });
  assert.equal(calls, 0);
  assert.deepEqual(bad, { ok: false, problem: 'bad-code', message: codeProblemMessage('bad-code') });

  const other = await checkJoinCode('K7M2PQ', 'sumo', async () => ({ roomId: 'x', roomName: 'hello' }));
  assert.equal(other.ok, false);
  assert.equal(!other.ok && other.message, 'That code is for another game.');

  for (const code of ['NO_ROOM', 'RATE_LIMITED', 'UNREACHABLE', 'FAILED'] as const) {
    const res = await checkJoinCode('K7M2PQ', 'sumo', async () => {
      throw new RoomLookupError(code, 'x');
    });
    assert.deepEqual(res, { ok: false, problem: code, message: codeProblemMessage(code) });
  }
  // Anything else thrown (a malformed room id from the server, a bug) reads as FAILED.
  const odd = await checkJoinCode('K7M2PQ', 'sumo', async () => ({ roomId: '../etc', roomName: 'sumo' }));
  assert.equal(!odd.ok && odd.problem, 'FAILED');
});

// --- rooms -----------------------------------------------------------------------------------------------------

const listing = (over: Partial<RoomListing> & { md?: Record<string, unknown> } = {}): RoomListing => ({
  roomId: over.roomId ?? 'r1abcd',
  clients: over.clients ?? 2,
  maxClients: over.maxClients ?? 8,
  locked: over.locked ?? false,
  metadata:
    over.metadata !== undefined
      ? over.metadata
      : {
          gameId: 'sumo',
          name: 'Dojo',
          players: 3,
          maxPlayers: 8,
          private: false,
          serverVersion: 2,
          phase: 'waiting',
          ...over.md,
        },
});

test('roomRow: name, players/max from metadata, phase badge, joinable', () => {
  const row = roomRow(listing());
  assert.equal(row.name, 'Dojo');
  assert.equal(row.playersLabel, '3/8');
  assert.equal(row.phase, 'waiting');
  assert.equal(row.phaseLabel, 'Waiting');
  assert.equal(row.joinable, true);
  assert.equal(row.accessibilityLabel, 'Dojo, 3 of 8 players, waiting');
  // A server without `connected` metadata: everyone counts as connected.
  assert.deepEqual([row.connected, row.reconnecting, row.statusLabel], [3, 0, null]);

  const playing = roomRow(listing({ md: { phase: 'playing' } }));
  assert.equal(playing.phaseLabel, 'In match');
  assert.equal(roomPhase({ phase: 'countdown' }), 'in-match');
  assert.equal(roomPhase({ phase: 'matchOver' }), 'in-match');
  assert.equal(roomPhase({}), 'waiting');
  assert.equal(roomPhase(null), 'waiting');
});

test('roomRow: falls back to clients/maxClients and a generated name; full or locked is not joinable', () => {
  const bare = roomRow(listing({ roomId: 'xyz987', clients: 4, maxClients: 4, metadata: null }));
  assert.equal(bare.name, 'Room XYZ9');
  assert.equal(bare.playersLabel, '4/4');
  assert.equal(bare.joinable, false);
  assert.match(bare.accessibilityLabel, /, full$/);
  assert.equal(roomRow(listing({ locked: true })).joinable, false);
  assert.equal(roomRow(listing({ md: { name: '   ' } })).name, 'Room R1AB');
  assert.equal(roomRow(listing({ md: { players: -1 } })).players, 2);
});

test('roomRow: seats held for the reconnection grace read as reconnecting and still count toward full', () => {
  const row = roomRow(listing({ md: { players: 3, connected: 2 } }));
  assert.deepEqual([row.players, row.connected, row.reconnecting], [3, 2, 1]);
  assert.equal(row.playersLabel, '3/8');
  assert.equal(row.statusLabel, '2 playing · 1 reconnecting');
  assert.equal(row.accessibilityLabel, 'Dojo, 3 of 8 players (2 playing, 1 reconnecting), waiting');
  // All seats held (every tab closed): still listed, nobody playing.
  const ghost = roomRow(listing({ md: { players: 3, connected: 0 } }));
  assert.equal(ghost.statusLabel, '0 playing · 3 reconnecting');
  // Garbage or more connected than seats is clamped.
  assert.equal(roomRow(listing({ md: { connected: 'x' } })).connected, 3);
  assert.equal(roomRow(listing({ md: { connected: 9 } })).reconnecting, 0);
  const full = roomRow(listing({ md: { players: 8, connected: 5 } }));
  assert.equal(full.joinable, false, 'held seats are taken seats');
});

test('roomRows: joinable first, then most connected players first (ties keep the server order)', () => {
  const rows = roomRows(
    [
      listing({ roomId: 'ghosts', md: { players: 5, connected: 1 } }),
      listing({ roomId: 'fullHeld', md: { players: 8, connected: 6 } }),
      listing({ roomId: 'busy', md: { players: 4, connected: 4 } }),
      listing({ roomId: 'tieA', md: { players: 2, connected: 2 } }),
      listing({ roomId: 'tieB', md: { players: 2 } }),
      listing({ roomId: 'fullLive', md: { players: 8, connected: 8 } }),
    ],
    0,
  );
  assert.deepEqual(
    rows.map((r) => r.roomId),
    ['busy', 'tieA', 'tieB', 'ghosts', 'fullLive', 'fullHeld'],
  );
});

test('roomRows hides rooms below minVersion and private ones, joinable first', () => {
  const rows = roomRows(
    [
      listing({ roomId: 'full', md: { players: 8 } }),
      listing({ roomId: 'old', md: { serverVersion: 1 } }),
      listing({ roomId: 'nover', metadata: { name: 'x', players: 1, maxPlayers: 8 } }),
      listing({ roomId: 'priv', md: { private: true } }),
      listing({ roomId: 'open' }),
    ],
    2,
  );
  assert.deepEqual(
    rows.map((r) => r.roomId),
    ['open', 'full'],
  );
  assert.equal(openRoomsLabel(rows), '1 open room');
  // minVersion 0 keeps rooms that publish no version.
  assert.deepEqual(
    roomRows([listing({ roomId: 'nover', metadata: { players: 1, maxPlayers: 8 } })], 0).map((r) => r.roomId),
    ['nover'],
  );
  assert.equal(openRoomsLabel([]), '0 open rooms');
});

// --- rejoin ----------------------------------------------------------------------------------------------------

const NOW = 1_000_000;

test('shouldOfferRejoin: more than 5 s left, no game open, not dismissed', () => {
  const rec = { roomId: 'r1', expiresAt: NOW + 42_000 };
  assert.equal(shouldOfferRejoin(rec, { now: NOW, gameOpen: false }), true);
  assert.equal(shouldOfferRejoin(rec, { now: NOW, gameOpen: true }), false);
  assert.equal(shouldOfferRejoin(rec, { now: NOW, gameOpen: false, dismissedRoomId: 'r1' }), false);
  assert.equal(shouldOfferRejoin(rec, { now: NOW, gameOpen: false, dismissedRoomId: 'r2' }), true);
  assert.equal(shouldOfferRejoin(null, { now: NOW, gameOpen: false }), false);
  // Exactly 5 s is not enough; 6 s is.
  assert.equal(
    shouldOfferRejoin({ roomId: 'r1', expiresAt: NOW + REJOIN_OFFER_MIN_S * 1000 }, { now: NOW, gameOpen: false }),
    false,
  );
  assert.equal(shouldOfferRejoin({ roomId: 'r1', expiresAt: NOW + 6_000 }, { now: NOW, gameOpen: false }), true);
});

test('rejoinCountdown counts down whole seconds and expires', () => {
  const rec = { expiresAt: NOW + 42_500 };
  assert.deepEqual(rejoinCountdown(rec, NOW), {
    secondsLeft: 42,
    label: '0:42',
    expired: false,
    spoken: '42 seconds left',
  });
  assert.equal(rejoinCountdown(rec, NOW + 41_400).spoken, '1 second left');
  assert.deepEqual(rejoinCountdown(rec, NOW + 42_500), {
    secondsLeft: 0,
    label: '0:00',
    expired: true,
    spoken: '0 seconds left',
  });
  assert.equal(rejoinCountdown(rec, NOW + 90_000).label, '0:00');
  assert.equal(formatCountdown(65), '1:05');
  assert.equal(formatCountdown(Number.NaN), '0:00');
});

test('isGameScreen and rejoinTitle', () => {
  assert.equal(isGameScreen('/game/sumo/play'), true);
  assert.equal(isGameScreen('/dev/play'), true);
  assert.equal(isGameScreen('/game/sumo'), false);
  assert.equal(isGameScreen('/game/player/rooms'), false);
  assert.equal(isGameScreen('/'), false);
  assert.equal(rejoinTitle('Sumo'), 'Rejoin your Sumo match?');
  assert.equal(rejoinTitle(null), 'Rejoin your match?');
});

// --- room code pill (play screen) --------------------------------------------------------------------------------

test('room code pill: share text with the dashed code, gone after 8 s', () => {
  assert.equal(roomCodeShareMessage('Sumo', 'K7M2PQ'), 'Join my Sumo room on Rally with the code K7M-2PQ');
  assert.equal(roomCodeShareMessage('  ', 'K7M2PQ'), 'Join my room on Rally with the code K7M-2PQ');
  assert.equal(ROOM_CODE_PILL_MS, 8000);
});
