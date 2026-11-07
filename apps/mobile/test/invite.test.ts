import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INVITE_QUEUE_MAX,
  INVITE_TTL_MS,
  createInviteQueueStore,
  dropInvite,
  enqueueInvite,
  inviteAction,
  inviteDetail,
  inviteExpiresAt,
  inviteLine,
  inviteTitle,
  isInviteExpired,
  parseInviteAccepted,
  parseInviteEvent,
  pickInviteCatchUp,
  reconcileInvites,
  toIncomingInvites,
  type IncomingInvite,
  type MyInviteRow,
  type QueuedInvite,
} from '../src/lib/invite-model';

const ME = 'me-uuid';
const SLOTH = 'sloth-uuid';
const ANN = 'ann-uuid';
const T0 = Date.parse('2026-11-07T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function inv(id: string, over: Partial<IncomingInvite> = {}): IncomingInvite {
  return {
    inviteId: id,
    kind: 'party',
    fromId: SLOTH,
    partyId: 'p-1',
    gameId: null,
    roomId: null,
    createdAt: iso(T0),
    expiresAt: iso(T0 + INVITE_TTL_MS),
    partySize: null,
    gameTitle: null,
    ...over,
  };
}
const q = (i: IncomingInvite, queuedAt = T0): QueuedInvite => ({ ...i, queuedAt });

// --- events --------------------------------------------------------------------------------------------------------

test('parseInviteEvent: every type, bare or wrapped; junk is null', () => {
  const party = {
    type: 'party_invite',
    invite_id: 'i1',
    from: SLOTH,
    party_id: 'p-1',
    game_id: null,
    room_id: null,
    at: iso(T0),
  };
  assert.deepEqual(parseInviteEvent(party), party);
  assert.deepEqual(parseInviteEvent({ type: 'broadcast', event: 'invite', payload: party }), party);
  const room = {
    type: 'room_invite',
    invite_id: 'i2',
    from: SLOTH,
    party_id: null,
    game_id: 'sumo',
    room_id: 'r1',
    at: iso(T0),
  };
  assert.deepEqual(parseInviteEvent(room), room);
  assert.deepEqual(parseInviteEvent({ type: 'invite_declined', invite_id: 'i3', to: ANN, at: iso(T0) }), {
    type: 'invite_declined',
    invite_id: 'i3',
    to: ANN,
    at: iso(T0),
  });
  assert.deepEqual(parseInviteEvent({ type: 'invite_closed', invite_id: 'i4', at: iso(T0) }), {
    type: 'invite_closed',
    invite_id: 'i4',
    at: iso(T0),
  });
  for (const bad of [
    null,
    'x',
    [],
    { type: 'party_invite', invite_id: 'i' },
    { type: 'invite_declined', invite_id: 'i' },
    { type: 'nudge', invite_id: 'i' },
    { type: 'invite_closed' },
  ]) {
    assert.equal(parseInviteEvent(bad), null, JSON.stringify(bad));
  }
});

test('inviteAction: an invite to me shows, a closed one dismisses, a decline is noted; my own invites never show', () => {
  const shown = inviteAction(
    parseInviteEvent({
      type: 'room_invite',
      invite_id: 'i2',
      from: SLOTH,
      game_id: 'sumo',
      room_id: 'r1',
      at: iso(T0),
    }),
    ME,
  );
  assert.deepEqual(shown, {
    kind: 'show',
    invite: {
      inviteId: 'i2',
      kind: 'room',
      fromId: SLOTH,
      partyId: null,
      gameId: 'sumo',
      roomId: 'r1',
      createdAt: iso(T0),
      expiresAt: null,
      partySize: null,
      gameTitle: null,
    },
  });
  assert.equal(
    inviteAction(parseInviteEvent({ type: 'party_invite', invite_id: 'i', from: ME, party_id: 'p', at: iso(T0) }), ME),
    null,
  );
  assert.deepEqual(inviteAction(parseInviteEvent({ type: 'invite_closed', invite_id: 'i4' }), ME), {
    kind: 'dismiss',
    inviteId: 'i4',
  });
  assert.deepEqual(inviteAction(parseInviteEvent({ type: 'invite_declined', invite_id: 'i3', to: ANN }), ME), {
    kind: 'declined',
    inviteId: 'i3',
    to: ANN,
  });
  assert.equal(inviteAction(null, ME), null);
  assert.equal(inviteAction(parseInviteEvent({ type: 'invite_closed', invite_id: 'i4' }), null), null);
});

test('toIncomingInvites: my_invites rows with the sender card, newest first; unknown kinds dropped', () => {
  const row = (id: string, kind: string, at: number, over: Partial<MyInviteRow> = {}): MyInviteRow => ({
    id,
    kind,
    from_id: SLOTH,
    from_username: 'sloth',
    from_display_name: '',
    from_avatar_url: null,
    party_id: kind === 'party' ? 'p-1' : null,
    party_size: kind === 'party' ? '3' : null,
    game_id: kind === 'room' ? 'sumo' : null,
    game_title: kind === 'room' ? 'Sumo' : null,
    room_id: kind === 'room' ? 'r1' : null,
    created_at: iso(at),
    expires_at: iso(at + INVITE_TTL_MS),
    ...over,
  });
  const out = toIncomingInvites([row('old', 'party', T0), row('new', 'room', T0 + 1000), row('x', 'poke', T0)]);
  assert.deepEqual(
    out.map((i) => i.inviteId),
    ['new', 'old'],
  );
  assert.equal(out[1]!.partySize, 3);
  assert.equal(out[0]!.gameTitle, 'Sumo');
  assert.deepEqual(out[0]!.profile, { userId: SLOTH, username: 'sloth', displayName: null, avatarUrl: null });
  assert.deepEqual(toIncomingInvites(null), []);
});

test('expiry: expires_at when known, else ten minutes after creation', () => {
  assert.equal(inviteExpiresAt(inv('a')), T0 + INVITE_TTL_MS);
  assert.equal(inviteExpiresAt({ createdAt: iso(T0), expiresAt: null }), T0 + INVITE_TTL_MS);
  assert.equal(inviteExpiresAt({ createdAt: iso(T0), expiresAt: iso(T0 + 1000) }), T0 + 1000);
  assert.equal(isInviteExpired(inv('a'), T0 + INVITE_TTL_MS - 1), false);
  assert.equal(isInviteExpired(inv('a'), T0 + INVITE_TTL_MS), true);
});

test('copy: titles, lines, details', () => {
  assert.equal(inviteTitle('party'), 'Party invite');
  assert.equal(inviteTitle('room'), 'Game invite');
  assert.equal(inviteLine({ kind: 'party', gameTitle: null }, 'sloth'), 'sloth invited you to their party');
  assert.equal(inviteLine({ kind: 'room', gameTitle: 'Sumo' }, 'sloth'), 'sloth invited you to Sumo');
  assert.equal(inviteLine({ kind: 'room', gameTitle: null }, null), 'Someone invited you to a game');
  assert.equal(inviteDetail({ kind: 'party', partySize: 3, gameTitle: null }), '3 in the party');
  assert.equal(inviteDetail({ kind: 'party', partySize: null, gameTitle: null }), null);
  assert.equal(inviteDetail({ kind: 'room', partySize: null, gameTitle: 'Sumo' }), 'Join them in Sumo');
});

// --- queue ---------------------------------------------------------------------------------------------------------

test('enqueueInvite: same id unchanged (a richer row fills in, keeping its place), re-invites replace, cap keeps the head', () => {
  const a = q(inv('a'));
  let queue = enqueueInvite([], a);
  assert.equal(enqueueInvite(queue, q(inv('a'), T0 + 5)), queue, 'the same bare event again changes nothing');
  const richer = q(
    { ...inv('a'), profile: { userId: SLOTH, username: 'sloth', displayName: null, avatarUrl: null } },
    T0 + 9,
  );
  queue = enqueueInvite(queue, richer);
  assert.equal(queue[0]!.profile?.username, 'sloth');
  assert.equal(queue[0]!.queuedAt, T0, 'keeps when it was first queued');
  // Re-invited by the same sender (new id, same kind): replaced in place.
  queue = enqueueInvite([q(inv('a')), q(inv('b', { fromId: ANN }))], q(inv('a2')));
  assert.deepEqual(
    queue.map((x) => x.inviteId),
    ['a2', 'b'],
  );
  // A room invite from the same sender is a different thing.
  assert.equal(enqueueInvite(queue, q(inv('r', { kind: 'room' }))).length, 3);
  // The cap drops the oldest waiting one, never the head.
  let big: QueuedInvite[] = [];
  for (let i = 0; i < INVITE_QUEUE_MAX + 2; i++) big = enqueueInvite(big, q(inv(`i${i}`, { fromId: `u${i}` })));
  assert.equal(big.length, INVITE_QUEUE_MAX);
  assert.equal(big[0]!.inviteId, 'i0');
  assert.equal(big[1]!.inviteId, 'i3');
});

test('dropInvite / reconcileInvites: gone or expired invites leave; ones queued after the fetch began stay', () => {
  const queue = [q(inv('a'), T0), q(inv('b', { fromId: ANN }), T0), q(inv('late', { fromId: 'u3' }), T0 + 500)];
  assert.deepEqual(
    dropInvite(queue, 'b').map((x) => x.inviteId),
    ['a', 'late'],
  );
  assert.equal(dropInvite(queue, 'zzz'), queue);
  // The fetch began at T0 + 100 and only knows "a": "b" is gone, "late" may be newer than the fetch.
  assert.deepEqual(
    reconcileInvites(queue, new Set(['a']), T0 + 100, T0 + 200).map((x) => x.inviteId),
    ['a', 'late'],
  );
  // Unchanged → the same array (no re-render).
  assert.equal(reconcileInvites(queue, new Set(['a', 'b']), T0 + 100, T0 + 200), queue);
  // Expired ones go whatever the server said.
  assert.deepEqual(reconcileInvites(queue, new Set(['a', 'b', 'late']), T0, T0 + INVITE_TTL_MS), []);
});

test('pickInviteCatchUp: pending, unexpired, not seen in this run, not queued', () => {
  const pending = [
    inv('a'),
    inv('b', { fromId: ANN }),
    inv('c', { fromId: 'u3' }),
    inv('old', { fromId: 'u4', expiresAt: iso(T0 + 10) }),
  ];
  const out = pickInviteCatchUp(pending, new Set(['b']), [{ inviteId: 'c' }], T0 + 100);
  assert.deepEqual(
    out.map((x) => x.inviteId),
    ['a'],
  );
});

test('createInviteQueueStore: enqueue, dismiss remembers, shown once, expire, clear forgets', () => {
  const store = createInviteQueueStore();
  let notified = 0;
  const unsub = store.subscribe(() => (notified += 1));
  store.enqueue(inv('a'), T0);
  store.enqueue(inv('b', { fromId: ANN }), T0);
  assert.deepEqual(
    store.get().map((x) => x.inviteId),
    ['a', 'b'],
  );
  assert.equal(store.markShown('a'), true);
  assert.equal(store.markShown('a'), false, 'the haptic plays once, whichever host shows it');
  store.dismiss('b');
  assert.deepEqual(
    store.get().map((x) => x.inviteId),
    ['a'],
  );
  assert.equal(store.seen().has('b'), true, 'catch-up does not bring a dismissed invite back');
  store.expire(T0 + 5);
  assert.equal(store.get().length, 1);
  store.expire(T0 + INVITE_TTL_MS);
  assert.equal(store.get().length, 0);
  store.enqueue(inv('c', { fromId: 'u3' }), T0);
  store.reconcile(new Set(), T0 + 1, T0 + 2);
  assert.equal(store.get().length, 0, 'a queued invite the server no longer has leaves');
  store.clear();
  assert.equal(store.seen().size, 0);
  const before = notified;
  store.clear();
  assert.equal(notified, before, 'no change, no notification');
  unsub();
});

// --- the answer ----------------------------------------------------------------------------------------------------

test('parseInviteAccepted: party needs nothing more; a room says where to go', () => {
  assert.deepEqual(parseInviteAccepted({ kind: 'party', party: {} }), { kind: 'party' });
  assert.deepEqual(parseInviteAccepted({ kind: 'room', game_id: 'sumo', room_id: 'r1', code: 'K7M2PQ' }), {
    kind: 'room',
    gameId: 'sumo',
    roomId: 'r1',
    code: 'K7M2PQ',
  });
  assert.deepEqual(parseInviteAccepted({ kind: 'room', game_id: 'sumo', room_id: 'r1', code: null }), {
    kind: 'room',
    gameId: 'sumo',
    roomId: 'r1',
    code: null,
  });
  assert.equal(parseInviteAccepted({ kind: 'room', game_id: 'sumo', room_id: '../versions' }), null);
  assert.equal(parseInviteAccepted({ kind: 'room', room_id: 'r1' }), null);
  assert.equal(parseInviteAccepted({ kind: 'party_invite' }), null);
  assert.equal(parseInviteAccepted(null), null);
});
