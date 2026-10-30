import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptedToast,
  createRequestQueueStore,
  createSeenRequests,
  dropRequest,
  enqueueRequest,
  parseSeenKeys,
  parseSocialEvent,
  pickCatchUp,
  reconcileQueue,
  REQUEST_QUEUE_MAX,
  requestKey,
  requestLine,
  sameRequestIn,
  SEEN_REQUESTS_MAX,
  seenRequestsKey,
  socialAction,
  type IncomingRequest,
  type KeyValueStore,
  type QueuedRequest,
  type SocialEvent,
} from '../src/lib/social-realtime-model';

const ME = 'me-uuid';
const SLOTH = 'sloth-uuid';
const AT = '2026-10-30T12:00:00.123456+00:00';

const ev = (type: SocialEvent['type'], from: string, to: string, at = AT): SocialEvent => ({ type, from, to, at });

// --- events --------------------------------------------------------------------------------------------------------

test('parseSocialEvent: the broadcast payload, bare or wrapped in { payload }', () => {
  const raw = { type: 'friend_request', from: SLOTH, to: ME, at: AT };
  assert.deepEqual(parseSocialEvent(raw), raw);
  assert.deepEqual(parseSocialEvent({ type: 'broadcast', event: 'social', payload: raw }), raw);
});

test('parseSocialEvent: malformed or unknown payloads are null', () => {
  assert.equal(parseSocialEvent(null), null);
  assert.equal(parseSocialEvent('friend_request'), null);
  assert.equal(parseSocialEvent([]), null);
  assert.equal(parseSocialEvent({ type: 'friend_poked', from: SLOTH, to: ME }), null);
  assert.equal(parseSocialEvent({ type: 'friend_request', from: SLOTH }), null);
  assert.equal(parseSocialEvent({ type: 'friend_request', from: '', to: ME }), null);
  assert.equal(parseSocialEvent({ type: 'friend_request', from: ME, to: ME }), null);
  // A missing time still parses (the key falls back to the epoch).
  assert.equal(parseSocialEvent({ type: 'friend_request', from: SLOTH, to: ME })?.at, new Date(0).toISOString());
});

test('socialAction: a request sent to me shows the sheet, keyed by requester + time', () => {
  assert.deepEqual(socialAction(ev('friend_request', SLOTH, ME), ME), {
    kind: 'show',
    request: { userId: SLOTH, key: requestKey(SLOTH, AT), createdAt: AT },
  });
});

test('socialAction: my outgoing request accepted → toast', () => {
  assert.deepEqual(socialAction(ev('friend_accepted', SLOTH, ME), ME), { kind: 'accepted', userId: SLOTH });
});

test('socialAction: a cancelled (or removed) incoming request dismisses its sheet', () => {
  assert.deepEqual(socialAction(ev('friend_request_cancelled', SLOTH, ME), ME), { kind: 'dismiss', userId: SLOTH });
  assert.deepEqual(socialAction(ev('friend_removed', SLOTH, ME), ME), { kind: 'dismiss', userId: SLOTH });
});

test('socialAction: my request declined only refreshes (no toast, nothing to dismiss)', () => {
  assert.deepEqual(socialAction(ev('friend_declined', SLOTH, ME), ME), { kind: 'refresh', userId: SLOTH });
});

test('socialAction: my own actions echoed from another device close the sheet for that player', () => {
  assert.deepEqual(socialAction(ev('friend_accepted', ME, SLOTH), ME), { kind: 'dismiss', userId: SLOTH });
  assert.deepEqual(socialAction(ev('friend_declined', ME, SLOTH), ME), { kind: 'dismiss', userId: SLOTH });
  assert.deepEqual(socialAction(ev('friend_removed', ME, SLOTH), ME), { kind: 'dismiss', userId: SLOTH });
  // Never a sheet for a request I sent.
  assert.deepEqual(socialAction(ev('friend_request', ME, SLOTH), ME), { kind: 'refresh', userId: SLOTH });
  assert.deepEqual(socialAction(ev('friend_request_cancelled', ME, SLOTH), ME), { kind: 'refresh', userId: SLOTH });
});

test('socialAction: events that do not name me, or with no user, are ignored', () => {
  assert.equal(socialAction(ev('friend_request', SLOTH, 'someone-else'), ME), null);
  assert.equal(socialAction(ev('friend_request', SLOTH, ME), null), null);
  assert.equal(socialAction(ev('friend_request', SLOTH, ME), ''), null);
  assert.equal(socialAction(null, ME), null);
});

test('requestKey: the same instant in Realtime and PostgREST spellings gives one key; garbage is kept verbatim', () => {
  assert.equal(requestKey(SLOTH, '2026-10-30T12:00:00.123+00:00'), requestKey(SLOTH, '2026-10-30T12:00:00.123Z'));
  assert.notEqual(requestKey(SLOTH, AT), requestKey('other', AT));
  assert.equal(requestKey(SLOTH, 'not a time'), `${SLOTH}:not a time`);
});

test('sameRequestIn: equal keys, or the same requester within 5 s', () => {
  const k = requestKey(SLOTH, '2026-10-30T12:00:00Z');
  assert.equal(sameRequestIn([k], k), true);
  assert.equal(sameRequestIn([requestKey(SLOTH, '2026-10-30T12:00:04Z')], k), true);
  assert.equal(sameRequestIn([requestKey(SLOTH, '2026-10-30T12:00:06Z')], k), false);
  assert.equal(sameRequestIn([requestKey('other', '2026-10-30T12:00:00Z')], k), false);
  assert.equal(sameRequestIn([], k), false);
});

test('copy', () => {
  assert.equal(acceptedToast('sloth'), 'sloth accepted your friend request');
  assert.equal(acceptedToast(null), 'Your friend request was accepted');
  assert.equal(requestLine('sloth'), 'sloth wants to be your friend');
});

// --- seen keys -----------------------------------------------------------------------------------------------------

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  let writes = 0;
  const storage: KeyValueStore = {
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => {
      writes += 1;
      map.set(k, v);
    },
  };
  return { storage, map, writes: () => writes };
}

test('parseSeenKeys: JSON array of strings, anything else is empty', () => {
  assert.deepEqual(parseSeenKeys(null), []);
  assert.deepEqual(parseSeenKeys('nope'), []);
  assert.deepEqual(parseSeenKeys('{"a":1}'), []);
  assert.deepEqual(parseSeenKeys('["a", 1, "", "b"]'), ['a', 'b']);
});

test('seen store: per user, persisted, deduplicated', async () => {
  const m = memory();
  const seen = createSeenRequests(m.storage, 'u1');
  await seen.markSeen(['a', 'b', 'a']);
  await seen.markSeen(['b']);
  assert.deepEqual([...(await seen.load())], ['a', 'b']);
  assert.deepEqual(JSON.parse(m.map.get(seenRequestsKey('u1'))!), ['a', 'b']);
  assert.equal(m.writes(), 1, 'nothing new → no write');
  // Another account reads its own key; a new store instance reads what was saved.
  assert.deepEqual([...(await createSeenRequests(m.storage, 'u2').load())], []);
  assert.deepEqual([...(await createSeenRequests(m.storage, 'u1').load())], ['a', 'b']);
});

test('seen store: capped, oldest dropped first', async () => {
  const m = memory();
  const seen = createSeenRequests(m.storage, 'u1');
  await seen.markSeen(Array.from({ length: SEEN_REQUESTS_MAX + 5 }, (_, i) => `k${i}`));
  const keys = [...(await seen.load())];
  assert.equal(keys.length, SEEN_REQUESTS_MAX);
  assert.equal(keys[0], 'k5');
});

test('seen store: prune keeps only pending requests (tolerant of timestamp spelling)', async () => {
  const m = memory();
  const seen = createSeenRequests(m.storage, 'u1');
  const k1 = requestKey(SLOTH, '2026-10-30T12:00:00Z');
  const k2 = requestKey('other', '2026-10-30T12:00:00Z');
  await seen.markSeen([k1, k2]);
  await seen.prune([requestKey(SLOTH, '2026-10-30T12:00:01Z')]);
  assert.deepEqual([...(await seen.load())], [k1]);
});

test('seen store: a failing storage never throws (reads as empty)', async () => {
  const broken: KeyValueStore = {
    getItem: async () => {
      throw new Error('disk');
    },
    setItem: async () => {
      throw new Error('disk');
    },
  };
  const seen = createSeenRequests(broken, 'u1');
  await seen.markSeen(['a']);
  assert.deepEqual([...(await seen.load())], ['a'], 'kept in memory for this run');
});

// --- catch-up ------------------------------------------------------------------------------------------------------

const req = (userId: string, createdAt: string): IncomingRequest => ({ userId, key: requestKey(userId, createdAt), createdAt });

test('pickCatchUp: the newest unseen request is shown, the other unseen ones are marked seen', () => {
  const a = req('a', '2026-10-30T10:00:00Z');
  const b = req('b', '2026-10-30T11:00:00Z');
  const c = req('c', '2026-10-30T12:00:00Z');
  const r = pickCatchUp([a, c, b], new Set([c.key]), []);
  assert.equal(r.show?.userId, 'b');
  assert.deepEqual(r.markSeen, [a.key]);
});

test('pickCatchUp: nothing unseen → nothing to show', () => {
  const a = req('a', '2026-10-30T10:00:00Z');
  assert.deepEqual(pickCatchUp([a], new Set([a.key]), []), { show: null, markSeen: [] });
  assert.deepEqual(pickCatchUp([], new Set(), []), { show: null, markSeen: [] });
});

test('pickCatchUp: a request already queued (same key, or same requester from the broadcast) is not repeated', () => {
  const a = req('a', '2026-10-30T10:00:00Z');
  assert.equal(pickCatchUp([a], new Set(), [{ userId: 'a', key: 'a:other' }]).show, null);
  assert.equal(pickCatchUp([a], new Set(), [{ userId: 'x', key: a.key }]).show, null);
});

test('pickCatchUp: a request seen via its broadcast time (within 5 s of created_at) counts as seen', () => {
  const a = req('a', '2026-10-30T10:00:00.400Z');
  assert.equal(pickCatchUp([a], new Set([requestKey('a', '2026-10-30T10:00:01Z')]), []).show, null);
});

// --- queue ---------------------------------------------------------------------------------------------------------

const q = (userId: string, createdAt = '2026-10-30T10:00:00Z', queuedAt = 0): QueuedRequest => ({ ...req(userId, createdAt), queuedAt });

test('enqueueRequest: in arrival order; the same key twice is one entry', () => {
  let queue = enqueueRequest([], q('a'));
  queue = enqueueRequest(queue, q('b'));
  const same = enqueueRequest(queue, q('a'));
  assert.equal(same, queue, 'unchanged (same array)');
  assert.deepEqual(queue.map((x) => x.userId), ['a', 'b']);
});

test('enqueueRequest: a re-sent request from the same player replaces theirs in place', () => {
  const queue = enqueueRequest([q('a'), q('b')], q('a', '2026-10-30T11:00:00Z'));
  assert.deepEqual(queue.map((x) => x.userId), ['a', 'b']);
  assert.equal(queue[0]!.createdAt, '2026-10-30T11:00:00Z');
});

test('enqueueRequest: capped; the head (on screen) stays, the oldest waiting one drops', () => {
  let queue: QueuedRequest[] = [];
  for (let i = 0; i < REQUEST_QUEUE_MAX + 2; i++) queue = enqueueRequest(queue, q(`u${i}`));
  assert.equal(queue.length, REQUEST_QUEUE_MAX);
  assert.equal(queue[0]!.userId, 'u0');
  assert.equal(queue[1]!.userId, 'u3');
  assert.equal(queue.at(-1)!.userId, `u${REQUEST_QUEUE_MAX + 1}`);
});

test('dropRequest: removes that player; unknown players leave the queue as is', () => {
  const queue = [q('a'), q('b')];
  assert.deepEqual(dropRequest(queue, 'a').map((x) => x.userId), ['b']);
  assert.equal(dropRequest(queue, 'zzz'), queue);
});

test('reconcileQueue: drops requests no longer pending, but keeps ones queued after the fetch started', () => {
  const stale = q('a', '2026-10-30T10:00:00Z', 100);
  const pending = q('b', '2026-10-30T10:00:00Z', 100);
  const fresh = q('c', '2026-10-30T10:00:00Z', 600);
  const out = reconcileQueue([stale, pending, fresh], new Set([pending.key]), 500);
  assert.deepEqual(out.map((x) => x.userId), ['b', 'c']);
  const same = [pending];
  assert.equal(reconcileQueue(same, new Set([pending.key]), 500), same);
});

test('queue store: notifies on change only, markShown once per key, clear resets both', () => {
  const store = createRequestQueueStore();
  let calls = 0;
  const off = store.subscribe(() => (calls += 1));
  store.enqueue(req('a', AT), 1);
  store.enqueue(req('a', AT), 2);
  assert.equal(calls, 1);
  assert.equal(store.get()[0]!.queuedAt, 1);
  store.drop('nobody');
  assert.equal(calls, 1);
  assert.equal(store.markShown('k'), true);
  assert.equal(store.markShown('k'), false);
  store.drop('a');
  assert.equal(calls, 2);
  assert.deepEqual(store.get(), []);
  store.enqueue(req('b', AT));
  store.clear();
  assert.deepEqual(store.get(), []);
  assert.equal(store.markShown('k'), true, 'a new account shows its requests again');
  off();
  store.enqueue(req('c', AT));
  assert.equal(calls, 4);
});
