import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MESSAGE_MAX_LENGTH, type MessageEvent } from '@rally/db';
import {
  appendOptimistic,
  applyBroadcastToList,
  applyMuted,
  applyRead,
  canSend,
  composeBody,
  conversationPreview,
  conversationTitle,
  markDeleted,
  mergeBroadcast,
  MESSAGE_TOAST_MAX,
  messageActions,
  messageErrorKind,
  messageFromEvent,
  messageToastText,
  nextThreadCursor,
  openDmErrorMessage,
  optimisticMessage,
  otherSenderIds,
  parseMessageEvent,
  parseSentMessage,
  remainingLabel,
  removeMessage,
  sendErrorMessage,
  settleOptimistic,
  shouldToast,
  showsSender,
  showsTimestamp,
  sortConversations,
  sumUnread,
  THREAD_PAGE,
  toConversations,
  toMessages,
  unreadAfter,
  unreadDelta,
  type Conversation,
  type Message,
} from '../src/lib/messages-model';

const ME = 'me-uuid';
const SLOTH = 'sloth-uuid';
const ANN = 'ann-uuid';
const DM = 'dm-conv';
const PARTY = 'party-conv';
const T0 = Date.parse('2026-11-07T12:00:00Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const msg = (id: string, senderId: string | null, body: string, at: number, extra: Partial<Message> = {}): Message => ({
  id,
  senderId,
  body,
  createdAt: iso(at),
  deleted: false,
  ...extra,
});

const ev = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  type: 'message',
  conversation_id: DM,
  message_id: 'm-new',
  sender_id: SLOTH,
  body: 'hey',
  at: iso(60_000),
  ...over,
});

const dmRow = (over: Partial<Conversation> = {}): Conversation => ({
  id: DM,
  kind: 'dm',
  partyId: null,
  other: { userId: SLOTH, username: 'sloth', displayName: 'Sloth', avatarUrl: null },
  last: { id: 'm1', senderId: SLOTH, body: 'yo', at: iso(0) },
  unread: 1,
  muted: false,
  ...over,
});

const partyRow = (over: Partial<Conversation> = {}): Conversation => ({
  id: PARTY,
  kind: 'party',
  partyId: 'party-1',
  other: null,
  last: { id: 'p1', senderId: ANN, body: 'ready?', at: iso(-3_600_000) },
  unread: 0,
  muted: false,
  ...over,
});

// --- rows → shapes -------------------------------------------------------------------------------------------------

test('toConversations: my_conversations rows → conversations, party rows without a person, counts clamped', () => {
  const rows = [
    {
      conversation_id: DM,
      kind: 'dm',
      party_id: null,
      other_user_id: SLOTH,
      other_username: 'sloth',
      other_display_name: '',
      other_avatar_url: null,
      last_message_id: 'm1',
      last_sender_id: SLOTH,
      last_body: 'yo',
      last_at: iso(0),
      unread: '2',
      muted: false,
    },
    {
      conversation_id: PARTY,
      kind: 'party',
      party_id: 'party-1',
      other_user_id: null,
      other_username: null,
      other_display_name: null,
      other_avatar_url: null,
      last_message_id: null,
      last_sender_id: null,
      last_body: null,
      last_at: null,
      unread: -3,
      muted: null,
    },
  ];
  const [party, dm] = toConversations(rows);
  assert.equal(party?.kind, 'party');
  assert.equal(party?.other, null);
  assert.equal(party?.last, null);
  assert.equal(party?.unread, 0);
  assert.equal(party?.muted, false);
  assert.equal(dm?.other?.displayName, null, 'empty display name reads as none');
  assert.equal(dm?.unread, 2);
  assert.equal(dm?.last?.body, 'yo');
  assert.deepEqual(toConversations(null), []);
});

test('toMessages: deleted rows keep their place with an empty body; the RPC order (newest first) is kept', () => {
  const out = toMessages([
    { id: 'b', sender_id: SLOTH, body: 'later', created_at: iso(10_000), deleted: false },
    { id: 'a', sender_id: null, body: 'should be hidden', created_at: iso(0), deleted: true },
  ]);
  assert.deepEqual(
    out.map((m) => m.id),
    ['b', 'a'],
  );
  assert.equal(out[1]?.deleted, true);
  assert.equal(out[1]?.body, '');
  assert.equal(out[1]?.senderId, null);
});

test('nextThreadCursor: the oldest time of a full page; nothing after a short page', () => {
  const full = Array.from({ length: THREAD_PAGE }, (_, i) => msg(`m${i}`, SLOTH, 'x', -i * 1000));
  assert.equal(nextThreadCursor(full), iso(-(THREAD_PAGE - 1) * 1000));
  assert.equal(nextThreadCursor(full.slice(0, 3)), undefined);
  assert.equal(nextThreadCursor([]), undefined);
});

// --- ordering ------------------------------------------------------------------------------------------------------

test('sortConversations: party chat pinned first (even with older activity), then newest activity, empty ones last', () => {
  const a = dmRow({ id: 'a', last: { id: 'x', senderId: SLOTH, body: 'a', at: iso(0) } });
  const b = dmRow({ id: 'b', last: { id: 'y', senderId: SLOTH, body: 'b', at: iso(5_000) } });
  const empty = dmRow({ id: 'c', last: null });
  const party = partyRow();
  assert.deepEqual(
    sortConversations([empty, a, b, party]).map((c) => c.id),
    [PARTY, 'b', 'a', 'c'],
  );
  // Stable for equal times: by id.
  const same1 = dmRow({ id: 'z1' });
  const same2 = dmRow({ id: 'z0' });
  assert.deepEqual(
    sortConversations([same1, same2]).map((c) => c.id),
    ['z0', 'z1'],
  );
});

test('conversationTitle / conversationPreview: the person (display name first) or "Party chat"; "You:" for your own line', () => {
  assert.equal(conversationTitle(dmRow()), 'Sloth');
  assert.equal(
    conversationTitle(dmRow({ other: { userId: SLOTH, username: 'sloth', displayName: null, avatarUrl: null } })),
    'sloth',
  );
  assert.equal(conversationTitle(partyRow()), 'Party chat');
  assert.equal(conversationTitle(null), 'Messages');
  assert.equal(conversationPreview(dmRow(), ME), 'yo');
  assert.equal(
    conversationPreview(dmRow({ last: { id: 'm', senderId: ME, body: 'hi\nthere', at: iso(0) } }), ME),
    'You: hi there',
  );
  assert.equal(
    conversationPreview(dmRow({ last: { id: 'm', senderId: SLOTH, body: '', at: iso(0) } }), ME),
    'Message deleted',
  );
  assert.equal(conversationPreview(partyRow({ last: null }), ME), 'No messages yet');
});

// --- broadcasts ----------------------------------------------------------------------------------------------------

test('parseMessageEvent: the payload, bare or wrapped; malformed or unknown types are null', () => {
  const raw = ev();
  assert.deepEqual(parseMessageEvent(raw), raw);
  assert.deepEqual(parseMessageEvent({ type: 'broadcast', event: 'dm', payload: raw }), raw);
  assert.equal(parseMessageEvent(null), null);
  assert.equal(parseMessageEvent('message'), null);
  assert.equal(parseMessageEvent([]), null);
  assert.equal(parseMessageEvent({ ...raw, type: 'launch' }), null);
  assert.equal(parseMessageEvent({ ...raw, conversation_id: '' }), null);
  assert.equal(parseMessageEvent({ ...raw, message_id: undefined }), null);
  // A gone sender (null) is fine; a missing body or time falls back.
  const sparse = parseMessageEvent({ type: 'message_deleted', conversation_id: DM, message_id: 'm', sender_id: null });
  assert.equal(sparse?.sender_id, null);
  assert.equal(sparse?.body, '');
  assert.equal(sparse?.at, new Date(0).toISOString());
});

test('messageFromEvent: a deletion is a deleted message with no body', () => {
  assert.deepEqual(messageFromEvent(ev({ type: 'message_deleted', body: 'leaked?' })), {
    id: 'm-new',
    senderId: SLOTH,
    body: '',
    createdAt: iso(60_000),
    deleted: true,
  });
});

test('mergeBroadcast: a new message joins the newest page; a repeated id adds nothing; an uncached thread stays uncached', () => {
  const pages = [[msg('m2', ME, 'two', 20_000), msg('m1', SLOTH, 'one', 10_000)]];
  const merged = mergeBroadcast(pages, ev({ message_id: 'm3', at: iso(30_000) }));
  assert.deepEqual(
    merged?.[0]?.map((m) => m.id),
    ['m3', 'm2', 'm1'],
  );
  assert.equal(mergeBroadcast(merged, ev({ message_id: 'm3', at: iso(30_000) })), merged, 'same id: the same pages');
  assert.equal(mergeBroadcast(undefined, ev()), undefined);
});

test('mergeBroadcast: a late echo of an older message takes its place by time, not the top', () => {
  const pages = [[msg('m2', ME, 'two', 20_000), msg('m1', SLOTH, 'one', 10_000)]];
  const merged = mergeBroadcast(pages, ev({ message_id: 'm1b', at: iso(15_000) }));
  assert.deepEqual(
    merged?.[0]?.map((m) => m.id),
    ['m2', 'm1b', 'm1'],
  );
});

test('mergeBroadcast: party chat echoes your own message; the pending copy is replaced by the stored row', () => {
  const pending = optimisticMessage('tmp', ME, 'gg', T0 + 40_000);
  const pages = [[pending, msg('m1', ANN, 'one', 10_000)]];
  const merged = mergeBroadcast(
    pages,
    ev({ conversation_id: PARTY, message_id: 'm-real', sender_id: ME, body: 'gg', at: iso(41_000) }),
  );
  assert.deepEqual(
    merged?.[0]?.map((m) => [m.id, m.pending ?? false]),
    [
      ['m-real', false],
      ['m1', false],
    ],
  );
});

test('mergeBroadcast: a deletion blanks the message on any page; nothing to blank → the same pages', () => {
  const pages = [[msg('m3', ME, 'three', 30_000)], [msg('m2', SLOTH, 'two', 20_000), msg('m1', SLOTH, 'one', 10_000)]];
  const merged = mergeBroadcast(pages, ev({ type: 'message_deleted', message_id: 'm1', body: '' }));
  assert.equal(merged?.[1]?.[1]?.deleted, true);
  assert.equal(merged?.[1]?.[1]?.body, '');
  assert.equal(merged?.[0], pages[0], 'untouched pages keep their identity');
  assert.equal(mergeBroadcast(pages, ev({ type: 'message_deleted', message_id: 'nope' })), pages);
});

// --- optimistic sends ----------------------------------------------------------------------------------------------

test('appendOptimistic → settleOptimistic: the copy takes the stored id, body and time; removeMessage drops a failed one', () => {
  const copy = optimisticMessage('tmp', ME, '  hi there  ', T0);
  assert.equal(copy.body, 'hi there');
  assert.equal(copy.pending, true);
  const pages = appendOptimistic(undefined, copy);
  assert.deepEqual(
    pages.map((p) => p.map((m) => m.id)),
    [['tmp']],
  );
  const settled = settleOptimistic(pages, 'tmp', {
    id: 'm9',
    conversation_id: DM,
    body: 'hi there',
    created_at: iso(500),
  });
  assert.deepEqual(settled?.[0]?.[0], {
    id: 'm9',
    senderId: ME,
    body: 'hi there',
    createdAt: iso(500),
    deleted: false,
    pending: false,
  });
  // The broadcast got there first (party chat): the copy is simply dropped.
  const raced = settleOptimistic([[msg('m9', ME, 'hi there', 500), copy]], 'tmp', {
    id: 'm9',
    conversation_id: DM,
    body: 'hi there',
    created_at: iso(500),
  });
  assert.deepEqual(
    raced?.[0]?.map((m) => m.id),
    ['m9'],
  );
  assert.deepEqual(removeMessage(pages, 'tmp'), [[]]);
  assert.equal(removeMessage(undefined, 'tmp'), undefined);
});

test('markDeleted: your own deletion shows at once', () => {
  const pages = [[msg('m1', ME, 'oops', 0)]];
  assert.deepEqual(markDeleted(pages, 'm1')?.[0]?.[0], { ...msg('m1', ME, '', 0), deleted: true });
});

test('parseSentMessage: send_message answers the stored row; anything else is null', () => {
  const row = { id: 'm1', conversation_id: DM, body: 'hi', created_at: iso(0) };
  assert.deepEqual(parseSentMessage(row), row);
  assert.equal(parseSentMessage({ id: 'm1' }), null);
  assert.equal(parseSentMessage(null), null);
});

// --- the list and the unread count ---------------------------------------------------------------------------------

test('applyBroadcastToList: the row takes the last line, moves up and counts unread for a message from someone else', () => {
  const other = dmRow({ id: 'other', last: { id: 'o', senderId: ANN, body: 'old', at: iso(90_000) }, unread: 0 });
  const list = [partyRow(), other, dmRow({ unread: 0 })];
  const { list: next, known } = applyBroadcastToList(list, ev({ at: iso(100_000) }), {
    uid: ME,
    kind: 'dm',
    onScreen: false,
  });
  assert.equal(known, true);
  assert.deepEqual(
    next?.map((c) => c.id),
    [PARTY, DM, 'other'],
    'party stays pinned, the dm moves above the other',
  );
  const row = next?.find((c) => c.id === DM);
  assert.equal(row?.unread, 1);
  assert.deepEqual(row?.last, { id: 'm-new', senderId: SLOTH, body: 'hey', at: iso(100_000) });
});

test('applyBroadcastToList: your own message and a thread on screen add no unread; a deletion blanks the last line', () => {
  const list = [dmRow({ unread: 0 })];
  assert.equal(
    applyBroadcastToList(list, ev({ sender_id: ME }), { uid: ME, kind: 'dm', onScreen: false }).list?.[0]?.unread,
    0,
  );
  assert.equal(applyBroadcastToList(list, ev(), { uid: ME, kind: 'dm', onScreen: true }).list?.[0]?.unread, 0);
  const deleted = applyBroadcastToList(list, ev({ type: 'message_deleted', message_id: 'm1', body: '' }), {
    uid: ME,
    kind: 'dm',
    onScreen: false,
  });
  assert.equal(deleted.list?.[0]?.last?.body, '');
  const otherDeleted = applyBroadcastToList(list, ev({ type: 'message_deleted', message_id: 'zzz', body: '' }), {
    uid: ME,
    kind: 'dm',
    onScreen: false,
  });
  assert.deepEqual(otherDeleted.list, list, 'an older message deleted: the row is unchanged');
});

test('applyBroadcastToList: an unknown conversation (or no list) is reported so the caller refetches', () => {
  const list = [dmRow()];
  const miss = applyBroadcastToList(list, ev({ conversation_id: 'new-conv' }), {
    uid: ME,
    kind: 'dm',
    onScreen: false,
  });
  assert.equal(miss.known, false);
  assert.deepEqual(miss.list, list);
  assert.deepEqual(applyBroadcastToList(undefined, ev(), { uid: ME, kind: 'dm', onScreen: false }), {
    list: undefined,
    known: false,
  });
});

test('applyRead / applyMuted / sumUnread: the unread arithmetic the badge shows', () => {
  const list = [partyRow({ unread: 4, muted: true }), dmRow({ unread: 3 }), dmRow({ id: 'b', unread: 2 })];
  assert.equal(sumUnread(list), 5, 'muted conversations do not count');
  const read = applyRead(list, DM);
  assert.equal(read?.[1]?.unread, 0);
  assert.equal(sumUnread(read ?? []), 2);
  assert.equal(applyRead(list, 'nope')?.[1]?.unread, 3);
  const unmuted = applyMuted(list, PARTY, false);
  assert.equal(unmuted?.[0]?.muted, false);
  assert.equal(sumUnread(unmuted ?? []), 9);
  assert.equal(applyRead(undefined, DM), undefined);
  assert.equal(applyMuted(undefined, DM, true), undefined);
});

test('unreadDelta / unreadAfter: +1 for a new message from someone else in an unmuted thread off screen; never below 0', () => {
  const base = { uid: ME, muted: false, onScreen: false };
  assert.equal(unreadDelta(ev(), base), 1);
  assert.equal(unreadDelta(ev({ sender_id: ME }), base), 0);
  assert.equal(unreadDelta(ev(), { ...base, muted: true }), 0);
  assert.equal(unreadDelta(ev(), { ...base, onScreen: true }), 0);
  assert.equal(unreadDelta(ev({ type: 'message_deleted' }), base), 0);
  assert.equal(unreadAfter(2, 1), 3);
  assert.equal(unreadAfter(undefined, 1), 1);
  assert.equal(unreadAfter(1, -5), 0);
});

// --- toasts --------------------------------------------------------------------------------------------------------

test('shouldToast: a new message from someone else, not muted, not on screen, not while a game is on screen', () => {
  const base = { uid: ME, muted: false, onScreen: false, gameOpen: false };
  assert.equal(shouldToast(ev(), base), true);
  assert.equal(shouldToast(ev({ sender_id: ME }), base), false, 'my own echo');
  assert.equal(shouldToast(ev({ sender_id: null }), base), false, 'a gone sender has nothing to announce');
  assert.equal(shouldToast(ev({ type: 'message_deleted', body: '' }), base), false);
  assert.equal(shouldToast(ev({ body: '   ' }), base), false);
  assert.equal(shouldToast(ev(), { ...base, muted: true }), false);
  assert.equal(shouldToast(ev(), { ...base, onScreen: true }), false);
  assert.equal(shouldToast(ev(), { ...base, gameOpen: true }), false, 'never over a game');
});

test('messageToastText: "sloth: <body>", whitespace collapsed, cut to 60 characters with an ellipsis', () => {
  assert.equal(messageToastText('sloth', 'hey', 'dm'), 'sloth: hey');
  assert.equal(messageToastText('sloth', '  up\nfor  a game? ', 'dm'), 'sloth: up for a game?');
  const long = messageToastText('sloth', 'a'.repeat(200), 'dm');
  assert.equal([...long].length, MESSAGE_TOAST_MAX);
  assert.ok(long.startsWith('sloth: aaaa'));
  assert.ok(long.endsWith('…'));
  // A body that just fits is not cut.
  const fits = messageToastText('sloth', 'b'.repeat(MESSAGE_TOAST_MAX - 'sloth: '.length), 'dm');
  assert.equal([...fits].length, MESSAGE_TOAST_MAX);
  assert.ok(!fits.endsWith('…'));
  // Astral characters count once (no half emoji at the cut).
  const emoji = messageToastText('sloth', '😀'.repeat(80), 'dm');
  assert.equal([...emoji].length, MESSAGE_TOAST_MAX);
  assert.equal(messageToastText('ann', 'ready?', 'party'), 'ann · Party chat: ready?');
  assert.equal(messageToastText(null, 'hi', 'dm'), 'New message: hi');
});

// --- errors --------------------------------------------------------------------------------------------------------

test('messageErrorKind: FILTERED and MUTED on top of the usual prefixes (prefix only)', () => {
  assert.equal(messageErrorKind({ message: 'FILTERED: that message cannot be sent' }), 'filtered');
  assert.equal(messageErrorKind({ message: 'MUTED: you cannot send messages right now' }), 'muted');
  assert.equal(messageErrorKind('FILTERED'), 'filtered');
  assert.equal(messageErrorKind({ message: 'the body was FILTERED' }), 'other');
  assert.equal(messageErrorKind({ message: 'RATE_LIMITED: send_message' }), 'rate-limited');
  assert.equal(messageErrorKind({ message: 'NOT_FOUND: no such friend' }), 'not-found');
  assert.equal(messageErrorKind(new Error('Network request failed')), 'network');
  assert.equal(messageErrorKind(null), 'other');
});

test('sendErrorMessage: the toasts the design fixes, and the rest', () => {
  assert.equal(sendErrorMessage({ message: 'FILTERED: that message cannot be sent' }), "That message can't be sent");
  assert.equal(
    sendErrorMessage({ message: 'MUTED: you cannot send messages right now' }),
    "You can't send messages right now",
  );
  assert.match(sendErrorMessage({ message: 'RATE_LIMITED: send_message' }), /too fast/);
  assert.match(sendErrorMessage({ message: 'NOT_FOUND: not a member' }), /only message friends/);
  assert.match(sendErrorMessage({ message: 'ANONYMOUS_FORBIDDEN' }), /Finish creating/);
  assert.match(sendErrorMessage(new Error('fetch failed')), /offline/);
  assert.match(sendErrorMessage({ message: 'INVALID: body' }), /Couldn't send/);
});

test('openDmErrorMessage: NOT_FOUND means "friends only" (it never reveals a block)', () => {
  assert.equal(openDmErrorMessage({ message: 'NOT_FOUND: no such friend' }), 'You can only message friends.');
  assert.match(openDmErrorMessage({ message: 'RATE_LIMITED' }), /try again in a minute/);
  assert.match(openDmErrorMessage(new Error('Network request failed')), /No connection/);
  assert.match(openDmErrorMessage({ message: 'INVALID' }), /Couldn't open/);
});

// --- composer and rendering ----------------------------------------------------------------------------------------

test('composeBody / canSend / remainingLabel: trimmed, 1..1000 characters, a count over the last hundred', () => {
  assert.equal(composeBody('  hi  '), 'hi');
  assert.equal(composeBody('a'.repeat(MESSAGE_MAX_LENGTH + 5)).length, MESSAGE_MAX_LENGTH);
  assert.equal(canSend(''), false);
  assert.equal(canSend('   \n'), false);
  assert.equal(canSend('hi'), true);
  assert.equal(canSend('hi', true), false, 'not while sending');
  assert.equal(canSend('a'.repeat(MESSAGE_MAX_LENGTH)), true);
  assert.equal(canSend('a'.repeat(MESSAGE_MAX_LENGTH + 1)), false);
  assert.equal(remainingLabel('hi'), null);
  assert.equal(remainingLabel('a'.repeat(899)), null);
  assert.equal(remainingLabel('a'.repeat(900)), `900 / ${MESSAGE_MAX_LENGTH}`);
  assert.equal(remainingLabel('a'.repeat(1000)), `1000 / ${MESSAGE_MAX_LENGTH}`);
});

test('showsTimestamp / showsSender: a label after a 5 min gap and for the oldest; party chat names the first of a run', () => {
  // Newest first.
  const list = [
    msg('d', ANN, 'd', 20 * 60_000),
    msg('c', ANN, 'c', 19 * 60_000),
    msg('b', ME, 'b', 10 * 60_000),
    msg('a', SLOTH, 'a', 0),
  ];
  assert.equal(showsTimestamp(list, 3), true, 'the oldest');
  assert.equal(showsTimestamp(list, 2), true, '10 min after a');
  assert.equal(showsTimestamp(list, 1), true, '9 min after b');
  assert.equal(showsTimestamp(list, 0), false, '1 min after c');
  assert.equal(showsTimestamp(list, 9), false);
  assert.equal(showsSender(list, 1, ME, 'party'), true, "ann's run starts at c");
  assert.equal(showsSender(list, 0, ME, 'party'), false, 'd continues the run');
  assert.equal(showsSender(list, 2, ME, 'party'), false, 'never your own');
  assert.equal(showsSender(list, 3, ME, 'party'), true);
  assert.equal(showsSender(list, 3, ME, 'dm'), false, 'a dm has one other person: no names');
  // A time label breaks a run: the name shows again under it.
  const gap = [msg('y', ANN, 'y', 30 * 60_000), msg('x', ANN, 'x', 0)];
  assert.equal(showsSender(gap, 0, ME, 'party'), true);
});

test('messageActions: Delete for your own, Report for others, nothing for deleted, unsent or orphaned messages', () => {
  assert.deepEqual(messageActions(msg('a', ME, 'a', 0), ME), ['delete']);
  assert.deepEqual(messageActions(msg('b', SLOTH, 'b', 0), ME), ['report']);
  assert.deepEqual(messageActions(msg('c', SLOTH, '', 0, { deleted: true }), ME), []);
  assert.deepEqual(messageActions(msg('d', ME, 'd', 0, { pending: true }), ME), []);
  assert.deepEqual(messageActions(msg('e', null, 'e', 0), ME), []);
});

test('otherSenderIds: the distinct other senders, sorted (for the party chat names lookup)', () => {
  const list = [
    msg('1', ANN, '', 0),
    msg('2', ME, '', 0),
    msg('3', SLOTH, '', 0),
    msg('4', ANN, '', 0),
    msg('5', null, '', 0),
  ];
  assert.deepEqual(otherSenderIds(list, ME), [ANN, SLOTH]);
  assert.deepEqual(otherSenderIds([], ME), []);
});
