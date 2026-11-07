import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Party, PartyMember } from '@rally/db';
import { GameHostController } from '../src/game-host/controller';
import { createMemoryProgressStore } from '../src/game-host/progress';
import { createMemorySaveStore } from '../src/game-host/saves';
import {
  FOLLOW_COUNTDOWN_MS,
  FOLLOW_MAX_AGE_MS,
  INVITE_SENT_MS,
  PARTY_BAR_HEIGHT,
  PARTY_BAR_MARGIN,
  describePartyError,
  followBannerLine,
  followDecision,
  followIsFresh,
  followSecondsLeft,
  followTitle,
  inviteCandidates,
  isLeader,
  launchLine,
  launchParty,
  launchPartyChanged,
  launchPartyFromKey,
  launchPartyKey,
  leaveCopy,
  memberNote,
  memberOf,
  nextLeader,
  orderedMembers,
  parseParty,
  parsePartyEvent,
  partyBarInset,
  partyBarLabel,
  partyBarVisible,
  partyChannelAction,
  partyHasRoom,
  partyLaunchErrorCopy,
  partyTooBigCopy,
  partyUserAction,
  playWithPartyState,
} from '../src/lib/party-model';
import { BUNDLE, NONCE, device, req } from './helpers';

const ME = '11111111-1111-4111-8111-111111111111';
const SLOTH = '22222222-2222-4222-8222-222222222222';
const ANN = '33333333-3333-4333-8333-333333333333';
const PARTY_ID = '44444444-4444-4444-8444-444444444444';
const LAUNCH_ID = '55555555-5555-4555-8555-555555555555';
const AT = '2026-11-07T12:00:00.000Z';

const member = (
  user_id: string,
  username: string,
  joined_at: string,
  extra: Partial<PartyMember> = {},
): PartyMember => ({
  user_id,
  username,
  display_name: null,
  avatar_url: null,
  joined_at,
  status: null,
  game_id: null,
  ...extra,
});

function party(over: Partial<Party> = {}): Party {
  return {
    id: PARTY_ID,
    leader_id: SLOTH,
    conversation_id: 'c-1',
    created_at: AT,
    launch: null,
    members: [
      member(SLOTH, 'sloth', '2026-11-07T10:00:00Z', { status: 'in_game', game_id: 'sumo' }),
      member(ME, 'me', '2026-11-07T10:05:00Z', { status: 'online' }),
      member(ANN, 'ann', '2026-11-07T10:10:00Z'),
    ],
    ...over,
  };
}

// --- my_party --------------------------------------------------------------------------------------------------------

test('parseParty: the my_party shape; null for no party or junk; presence normalised', () => {
  assert.equal(parseParty(null), null);
  assert.equal(parseParty({ id: 'x' }), null);
  assert.equal(parseParty('party'), null);
  const raw = {
    id: PARTY_ID,
    leader_id: SLOTH,
    conversation_id: 'c-1',
    created_at: AT,
    launch: {
      id: LAUNCH_ID,
      game_id: 'sumo',
      game_title: 'Sumo',
      room_id: 'r1',
      code: null,
      leader_id: SLOTH,
      created_at: AT,
      expires_at: AT,
    },
    members: [
      {
        user_id: SLOTH,
        username: 'sloth',
        display_name: '',
        avatar_url: null,
        joined_at: AT,
        status: 'in_game',
        game_id: 'sumo',
      },
      // An unknown status reads as offline, and an online member carries no game.
      {
        user_id: ME,
        username: 'me',
        display_name: 'Me',
        avatar_url: 'a.png',
        joined_at: AT,
        status: 'away',
        game_id: 'sumo',
      },
      { user_id: ANN, username: 'ann', joined_at: AT, status: 'online', game_id: 'sumo' },
    ],
  };
  const p = parseParty(raw)!;
  assert.equal(p.launch?.code, null);
  assert.equal(p.launch?.game_title, 'Sumo');
  assert.deepEqual(
    p.members.map((m) => [m.user_id, m.display_name, m.status, m.game_id]),
    [
      [SLOTH, null, 'in_game', 'sumo'],
      [ME, 'Me', null, null],
      [ANN, null, 'online', null],
    ],
  );
  // No launch, no members key: still a party (members default to []).
  assert.deepEqual(
    parseParty({ id: PARTY_ID, leader_id: ME, conversation_id: 'c', created_at: AT, launch: null })?.members,
    [],
  );
});

test('leader, members, order: the leader first, then joined_at order', () => {
  const p = party({ leader_id: ME });
  assert.equal(isLeader(p, ME), true);
  assert.equal(isLeader(p, SLOTH), false);
  assert.equal(isLeader(null, ME), false);
  assert.equal(memberOf(p, ANN)?.username, 'ann');
  assert.equal(memberOf(p, 'nobody'), null);
  assert.deepEqual(
    orderedMembers(p).map((m) => m.username),
    ['me', 'sloth', 'ann'],
  );
});

test('nextLeader / leaveCopy: the earliest-joined other member takes over, as leave_party does', () => {
  const p = party();
  assert.equal(nextLeader(p, SLOTH)?.username, 'me');
  assert.match(leaveCopy(p, SLOTH).body, /^me becomes the leader/);
  assert.doesNotMatch(leaveCopy(p, ME).body, /leader/);
  assert.match(leaveCopy(party({ members: [member(SLOTH, 'sloth', AT)] }), SLOTH).body, /party ends/);
  assert.equal(nextLeader(party({ members: [member(SLOTH, 'sloth', AT)] }), SLOTH), null);
});

// --- events --------------------------------------------------------------------------------------------------------

test('parsePartyEvent: every shape, bare or wrapped in { payload }; junk is null', () => {
  const joined = { type: 'member_joined', party_id: PARTY_ID, user_id: ANN, by: ANN, at: AT };
  assert.deepEqual(parsePartyEvent(joined), joined);
  assert.deepEqual(parsePartyEvent({ type: 'broadcast', event: 'party', payload: joined }), joined);
  assert.deepEqual(parsePartyEvent({ type: 'member_left', party_id: PARTY_ID, user_id: ANN, at: AT }), {
    type: 'member_left',
    party_id: PARTY_ID,
    user_id: ANN,
    by: null,
    at: AT,
  });
  const launch = {
    type: 'launch',
    party_id: PARTY_ID,
    launch_id: LAUNCH_ID,
    game_id: 'sumo',
    room_id: 'r1',
    leader_id: SLOTH,
    at: AT,
  };
  assert.deepEqual(parsePartyEvent(launch), launch);
  assert.deepEqual(parsePartyEvent({ type: 'leader_changed', party_id: PARTY_ID, leader_id: ME, at: AT }), {
    type: 'leader_changed',
    party_id: PARTY_ID,
    leader_id: ME,
    at: AT,
  });
  assert.deepEqual(parsePartyEvent({ type: 'removed', party_id: PARTY_ID, at: AT }), {
    type: 'removed',
    party_id: PARTY_ID,
    at: AT,
  });
  const msg = { type: 'message', conversation_id: 'c-1', message_id: 'm-1', sender_id: SLOTH, body: 'gg', at: AT };
  assert.deepEqual(parsePartyEvent(msg), msg);
  assert.equal(parsePartyEvent({ ...msg, type: 'message_deleted', body: undefined })?.type, 'message_deleted');

  for (const bad of [
    null,
    [],
    'launch',
    { type: 'poke', party_id: PARTY_ID },
    { type: 'launch', party_id: PARTY_ID },
    { type: 'removed' },
    { type: 'message', conversation_id: 'c' },
  ]) {
    assert.equal(parsePartyEvent(bad), null, JSON.stringify(bad));
  }
  // A missing time still parses.
  assert.equal(parsePartyEvent({ type: 'removed', party_id: PARTY_ID })?.at, new Date(0).toISOString());
});

test('partyChannelAction: membership and lead refresh, my own leave ends it, launch follows, chat goes to messages', () => {
  const ev = (raw: Record<string, unknown>) =>
    partyChannelAction(parsePartyEvent({ party_id: PARTY_ID, at: AT, ...raw }), ME);
  assert.deepEqual(ev({ type: 'member_joined', user_id: ANN }), { kind: 'refresh' });
  assert.deepEqual(ev({ type: 'member_left', user_id: ANN }), { kind: 'refresh' });
  assert.deepEqual(ev({ type: 'member_left', user_id: ME }), { kind: 'left' });
  assert.deepEqual(ev({ type: 'leader_changed', leader_id: ME }), { kind: 'refresh' });
  assert.deepEqual(ev({ type: 'launch', launch_id: LAUNCH_ID, game_id: 'sumo', room_id: 'r1', leader_id: SLOTH }), {
    kind: 'launch',
    launch: { launchId: LAUNCH_ID, partyId: PARTY_ID, gameId: 'sumo', roomId: 'r1', leaderId: SLOTH, at: AT },
  });
  assert.equal(
    ev({ type: 'message', conversation_id: 'c-1', message_id: 'm', sender_id: SLOTH, body: 'hi' })?.kind,
    'message',
  );
  // The user topic's shapes never arrive here; nothing to do without a user.
  assert.equal(ev({ type: 'removed' }), null);
  assert.equal(
    partyChannelAction(parsePartyEvent({ type: 'member_joined', party_id: PARTY_ID, user_id: ANN }), null),
    null,
  );
});

test('partyUserAction: removed / party_ended end my membership; party channel shapes are ignored', () => {
  assert.deepEqual(partyUserAction(parsePartyEvent({ type: 'removed', party_id: PARTY_ID })), {
    kind: 'removed',
    partyId: PARTY_ID,
  });
  assert.deepEqual(partyUserAction(parsePartyEvent({ type: 'party_ended', party_id: PARTY_ID })), {
    kind: 'ended',
    partyId: PARTY_ID,
  });
  assert.equal(partyUserAction(parsePartyEvent({ type: 'member_joined', party_id: PARTY_ID, user_id: ANN })), null);
  assert.equal(partyUserAction(null), null);
});

// --- follow flow ---------------------------------------------------------------------------------------------------

test('followDecision: nothing for the leader, the sheet in the shell, the banner over another game', () => {
  const launch = { leaderId: SLOTH };
  assert.equal(followDecision(launch, SLOTH, false), 'none');
  assert.equal(followDecision(launch, SLOTH, true), 'none');
  assert.equal(followDecision(launch, ME, false), 'sheet');
  assert.equal(followDecision(launch, ME, true), 'banner');
  assert.equal(followDecision(launch, null, false), 'none');
});

test('follow countdown: 4 s, whole seconds rounded up, 0 when over; launches go stale after two minutes', () => {
  assert.equal(FOLLOW_COUNTDOWN_MS, 4000);
  assert.equal(followSecondsLeft(1000, 1000), 4);
  assert.equal(followSecondsLeft(1000, 1001), 4);
  assert.equal(followSecondsLeft(1000, 2000), 3);
  assert.equal(followSecondsLeft(1000, 4999), 1);
  assert.equal(followSecondsLeft(1000, 5000), 0);
  assert.equal(followSecondsLeft(1000, 99_000), 0);
  assert.equal(followIsFresh(0, FOLLOW_MAX_AGE_MS - 1), true);
  assert.equal(followIsFresh(0, FOLLOW_MAX_AGE_MS), false);
});

test('follow copy', () => {
  assert.equal(followTitle('sloth', 'Sumo'), 'Joining sloth in Sumo…');
  assert.equal(followTitle(null, null), 'Joining your party in a game…');
  assert.equal(followBannerLine('Sumo'), 'Your party started Sumo');
  assert.equal(followBannerLine(null), 'Your party started a game');
});

// --- game page -----------------------------------------------------------------------------------------------------

test('playWithPartyState: leader button (disabled when too big), member note, nothing otherwise', () => {
  const sumo = { title: 'Sumo', max_players: 8 };
  assert.deepEqual(playWithPartyState(party(), SLOTH, sumo), { kind: 'leader', partySize: 3, disabledReason: null });
  assert.deepEqual(playWithPartyState(party(), ME, sumo), {
    kind: 'member',
    note: 'Only sloth can start a party game',
  });
  assert.deepEqual(playWithPartyState(null, ME, sumo), { kind: 'none' });
  assert.deepEqual(playWithPartyState(party(), 'stranger', sumo), { kind: 'none' });
  // A solo game (or the game not loaded yet) shows nothing extra.
  assert.deepEqual(playWithPartyState(party(), SLOTH, { title: 'Stack', max_players: 1 }), { kind: 'none' });
  assert.deepEqual(playWithPartyState(party(), SLOTH, null), { kind: 'none' });
  // Too big: "Your party is 9; Sumo fits 8".
  const nine = party({ members: Array.from({ length: 9 }, (_, i) => member(i === 0 ? SLOTH : `u${i}`, `p${i}`, AT)) });
  assert.deepEqual(playWithPartyState(nine, SLOTH, sumo), {
    kind: 'leader',
    partySize: 9,
    disabledReason: 'Your party is 9; Sumo fits 8',
  });
  assert.equal(partyTooBigCopy(9, 'Sumo', 8), 'Your party is 9; Sumo fits 8');
  assert.equal(memberNote('sloth'), 'Only sloth can start a party game');
  // Exactly full fits.
  assert.equal(playWithPartyState(party(), SLOTH, { title: 'Duel', max_players: 3 }).kind, 'leader');
  assert.deepEqual(playWithPartyState(party(), SLOTH, { title: 'Duel', max_players: 2 }), {
    kind: 'leader',
    partySize: 3,
    disabledReason: 'Your party is 3; Duel fits 2',
  });
});

test('partyLaunchErrorCopy: every /party/launch failure has words', () => {
  for (const code of [
    'UNAUTHENTICATED',
    'NOT_FOUND',
    'CONFLICT',
    'GONE',
    'RATE_LIMITED',
    'UNAVAILABLE',
    'UNREACHABLE',
    'FAILED',
  ] as const) {
    assert.ok(partyLaunchErrorCopy(code).length > 10, code);
  }
  assert.match(partyLaunchErrorCopy('NOT_FOUND'), /leader/);
});

// --- party screen and bar ------------------------------------------------------------------------------------------

test('party bar: label, inset only while visible, hidden on games, the party screen and messages', () => {
  assert.equal(partyBarLabel(3), 'Party · 3');
  assert.equal(partyBarInset(true), PARTY_BAR_HEIGHT + PARTY_BAR_MARGIN);
  assert.equal(partyBarInset(false), 0);
  const p = party();
  assert.equal(partyBarVisible(p, '/'), true);
  assert.equal(partyBarVisible(p, '/friends'), true);
  assert.equal(partyBarVisible(p, '/game/sumo'), true);
  assert.equal(partyBarVisible(p, '/game/sumo/play'), false);
  assert.equal(partyBarVisible(p, '/party'), false);
  assert.equal(partyBarVisible(p, '/messages'), false);
  assert.equal(partyBarVisible(p, '/messages/c-1'), false);
  assert.equal(partyBarVisible(null, '/'), false);
  assert.equal(partyBarVisible(p, '/partying'), true);
});

test('launchLine: "Playing Sumo" with Join unless I am in that game', () => {
  const launch = {
    id: LAUNCH_ID,
    game_id: 'sumo',
    game_title: 'Sumo',
    room_id: 'r1',
    code: null,
    leader_id: SLOTH,
    created_at: AT,
    expires_at: AT,
  };
  assert.equal(launchLine(party(), ME), null);
  assert.deepEqual(launchLine(party({ launch }), ME), {
    label: 'Playing Sumo',
    join: { launchId: LAUNCH_ID, gameId: 'sumo', gameTitle: 'Sumo' },
  });
  // The leader is in Sumo already: no Join.
  assert.deepEqual(launchLine(party({ launch }), SLOTH), { label: 'Playing Sumo', join: null });
  // In another game: Join is offered.
  const elsewhere = party({ launch, members: [member(ME, 'me', AT, { status: 'in_game', game_id: 'overrun' })] });
  assert.ok(launchLine(elsewhere, ME)?.join);
});

test('inviteCandidates: friends not in the party, online first, then by name', () => {
  const friends = [
    { userId: 'z', username: 'zed', displayName: null },
    { userId: ANN, username: 'ann', displayName: null },
    { userId: 'b', username: 'bob', displayName: 'Bobby' },
    { userId: 'c', username: 'cat', displayName: null },
  ];
  const presence = new Map([
    ['z', {}],
    ['c', {}],
  ]);
  assert.deepEqual(
    inviteCandidates(friends, party(), presence).map((f) => f.username),
    ['cat', 'zed', 'bob'],
  );
  assert.deepEqual(
    inviteCandidates(friends, null, undefined).map((f) => f.username),
    ['ann', 'bob', 'cat', 'zed'],
  );
  assert.deepEqual(inviteCandidates(undefined, party(), presence), []);
  assert.equal(INVITE_SENT_MS, 10_000);
});

test('partyHasRoom: up to 8 members', () => {
  assert.equal(partyHasRoom(null), true);
  assert.equal(partyHasRoom(party()), true);
  assert.equal(
    partyHasRoom(party({ members: Array.from({ length: 8 }, (_, i) => member(`u${i}`, `p${i}`, AT)) })),
    false,
  );
});

test('describePartyError: the server texts become specific copy', () => {
  assert.match(describePartyError({ message: 'INVALID: party is full' }, 'invite'), /full \(8 players\)/);
  assert.match(describePartyError({ message: 'INVALID: only the party leader can do that' }), /Only the party leader/);
  assert.match(describePartyError({ message: 'INVALID: already in a party' }), /already in a party/);
  assert.match(describePartyError({ message: 'INVALID: sumo fits 8 players, the party has 9' }), /fewer players/);
  assert.match(describePartyError({ message: 'NOT_FOUND: no such friend' }, 'invite'), /can't be invited/);
  assert.match(describePartyError({ message: 'NOT_FOUND: that party is gone' }, 'respond'), /no longer there/);
  assert.match(describePartyError({ message: 'RATE_LIMITED: invite' }, 'invite'), /Slow down/);
  assert.match(describePartyError({ message: 'ANONYMOUS_FORBIDDEN: link first' }), /link Apple/);
  assert.match(describePartyError({ message: 'Network request failed' }), /No connection/);
});

// --- the game host -------------------------------------------------------------------------------------------------

test('launchParty / key / changed: what the game sees, a stable key, and when partyUpdated is due', () => {
  const lp = launchParty(party())!;
  assert.deepEqual(lp, { id: PARTY_ID, leaderId: SLOTH, memberIds: [SLOTH, ME, ANN] });
  assert.equal(launchParty(null), undefined);
  assert.deepEqual(launchPartyFromKey(launchPartyKey(party())), lp);
  assert.equal(launchPartyKey(null), '');
  assert.equal(launchPartyFromKey(''), null);
  assert.equal(launchPartyChanged(lp, { ...lp, memberIds: [...lp.memberIds] }), false);
  assert.equal(launchPartyChanged(lp, { ...lp, leaderId: ME }), true);
  assert.equal(launchPartyChanged(lp, { ...lp, memberIds: [SLOTH, ME] }), true);
  assert.equal(launchPartyChanged(lp, { ...lp, memberIds: [ME, SLOTH, ANN] }), true);
  assert.equal(launchPartyChanged(undefined, lp), true);
  assert.equal(launchPartyChanged(undefined, undefined), false);
});

function hostSetup(opts: { party?: ReturnType<typeof launchParty> | null; onInviteOpen?: () => void } = {}) {
  const injected: string[] = [];
  const controller = new GameHostController({
    bundleUrl: BUNDLE,
    game: { id: 'sumo', version: '1.0.0' },
    user: { id: ME, username: 'me', avatarUrl: null },
    intent: 'party',
    saves: createMemorySaveStore(),
    progress: createMemoryProgressStore({ id: ME, username: 'me' }),
    soloScores: false,
    playSessions: null,
    matchmaking: null,
    party: opts.party ?? null,
    onInviteOpen: opts.onInviteOpen,
    device,
    onExit: () => {},
    createNonce: () => NONCE,
    readyTimeoutMs: 60_000,
    warn: () => {},
  });
  controller.setWebView(() => ({ injectJavaScript: (js: string) => injected.push(js) }) as never);
  controller.start();
  const delivered = () =>
    injected.map(
      (js) =>
        JSON.parse(JSON.parse(js.slice(js.indexOf('recv(') + 5, js.lastIndexOf(');')))) as {
          kind: string;
          id: string;
          method?: string;
          params?: unknown;
          error?: { code: string };
        },
    );
  const call = async (method: string, params?: unknown) => {
    const raw = req(method, params);
    const id = (JSON.parse(raw) as { id: string }).id;
    controller.handleMessage(raw, BUNDLE);
    for (let i = 0; i < 50; i++) {
      const hit = delivered().find((e) => e.kind === 'res' && e.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error(`no response to ${method}`);
  };
  return { controller, delivered, call };
}

test('host: the launch context carries the party, party.get answers it, partyUpdated only on a change while live', async () => {
  const lp = launchParty(party())!;
  const { controller, delivered, call } = hostSetup({ party: lp });
  // Before ready(): a change is kept for the launch context, nothing is sent.
  controller.update({ party: { ...lp, leaderId: ME } });
  const ready = await call('ready', { sdkVersion: '1' });
  assert.deepEqual((ready.params as { party?: unknown }).party, { ...lp, leaderId: ME });
  assert.equal((ready.params as { intent: string }).intent, 'party');
  assert.deepEqual((await call('party.get')).params, { ...lp, leaderId: ME });

  const updates = () => delivered().filter((e) => e.kind === 'evt' && e.method === 'partyUpdated');
  controller.update({ party: { ...lp, leaderId: ME, memberIds: [...lp.memberIds] } });
  assert.equal(updates().length, 0, 'the same party again sends nothing');
  controller.update({ party: { ...lp, leaderId: ME, memberIds: [SLOTH, ME] } });
  assert.equal(updates().length, 1);
  assert.deepEqual(updates()[0]!.params, { ...lp, leaderId: ME, memberIds: [SLOTH, ME] });
  // The party ends: no event (the protocol has none for "no party"), party.get says null.
  controller.update({ party: null });
  assert.equal(updates().length, 1);
  assert.equal((await call('party.get')).params, null);
});

test('host: no party → no party in the context and party.get null; invite.open needs a host with the sheet', async () => {
  const bare = hostSetup();
  const ready = await bare.call('ready', { sdkVersion: '1' });
  assert.equal('party' in (ready.params as object), false);
  assert.equal((await bare.call('party.get')).params, null);
  assert.equal((await bare.call('invite.open')).error?.code, 'NOT_SUPPORTED');

  let opened = 0;
  const withSheet = hostSetup({ onInviteOpen: () => (opened += 1) });
  await withSheet.call('ready', { sdkVersion: '1' });
  assert.equal((await withSheet.call('invite.open')).params, null);
  assert.equal(opened, 1);
});
