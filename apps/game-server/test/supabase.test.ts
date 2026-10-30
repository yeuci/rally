import assert from 'node:assert/strict';
import type { ColyseusTestServer } from '@colyseus/testing';
import { ErrorCode } from 'colyseus';
import { SignJWT } from 'jose';
import type appConfig from '../src/app.config.js';
import { createAuthenticator, createSanctionLookup, suspensionMessage, type RallyAuth } from '../src/auth.js';
import { configWarnings, describeConfig, readServerConfig } from '../src/config.js';
import { RallyRoom } from '../src/rooms/RallyRoom.js';
import type { SumoRoom } from '../src/rooms/SumoRoom.js';
import { resetRateLimits } from '../src/routes.js';
import {
  ServiceRpcError,
  createServiceApi,
  createServiceRpc,
  isLegacyJwtKey,
  type SanctionStatus,
} from '../src/supabase.js';
import { fakeRpc } from './fakes.js';
import { testServer } from './server.js';

const PERMA = '0b7f6f2e-6a51-4c39-9a8e-2b8f1b3c9d10';
const U2 = '1c8a7d3f-7b62-4d4a-8b9f-3c9a2c4d0e21';
const BANNED = 'ba11ed00-0000-4000-8000-000000000001';
const MUTED = '30ed0000-0000-4000-8000-000000000002';

const LEGACY_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UifQ.c2lnbmF0dXJl';
const LEGACY_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIn0.c2lnbmF0dXJl';

interface Seen {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    const s: Seen = {
      url,
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    };
    seen.push(s);
    if (init.signal?.aborted) throw init.signal.reason;
    return respond(s);
  }) as unknown as typeof fetch;
  return { fn, seen };
}

describe('service-role Supabase client', () => {
  it('POSTs /rest/v1/rpc/<name>; a sb_secret_ key goes in apikey only, a legacy JWT key also as the bearer', async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const rpc = createServiceRpc({ url: 'https://abc.supabase.co/', serviceKey: 'sb_secret_xyz', fetch: f.fn });
    assert.deepEqual(await rpc('server_x', { p_a: 1 }), { ok: true });
    assert.equal(f.seen[0]!.url, 'https://abc.supabase.co/rest/v1/rpc/server_x');
    assert.equal(f.seen[0]!.method, 'POST');
    assert.deepEqual(f.seen[0]!.body, { p_a: 1 });
    assert.equal(f.seen[0]!.headers.apikey, 'sb_secret_xyz');
    assert.equal(f.seen[0]!.headers.Authorization, undefined);

    const legacy = createServiceRpc({ url: 'https://abc.supabase.co', serviceKey: LEGACY_SERVICE_KEY, fetch: f.fn });
    await legacy('server_x');
    assert.equal(f.seen[1]!.headers.apikey, LEGACY_SERVICE_KEY);
    assert.equal(f.seen[1]!.headers.Authorization, `Bearer ${LEGACY_SERVICE_KEY}`);
    assert.deepEqual(f.seen[1]!.body, {});
    assert.equal(isLegacyJwtKey('sb_secret_abc'), false);
    assert.equal(isLegacyJwtKey(LEGACY_SERVICE_KEY), true);
  });

  it('void functions answer null; errors carry the HTTP status and the PostgREST code; timeouts reject', async () => {
    const empty = fakeFetch(() => new Response(null, { status: 204 }));
    assert.equal(await createServiceRpc({ url: 'http://x', serviceKey: 'k', fetch: empty.fn })('f'), null);

    const failing = fakeFetch(
      () =>
        new Response(JSON.stringify({ code: '42501', message: 'permission denied for function f' }), { status: 401 }),
    );
    await assert.rejects(
      createServiceRpc({ url: 'http://x', serviceKey: 'k', fetch: failing.fn })('f'),
      (e: unknown) =>
        e instanceof ServiceRpcError &&
        e.status === 401 &&
        e.code === '42501' &&
        /rpc f: HTTP 401 permission denied/.test(e.message),
    );

    const hanging = (async (_url: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
      )) as unknown as typeof fetch;
    await assert.rejects(
      createServiceRpc({ url: 'http://x', serviceKey: 'k', fetch: hanging, timeoutMs: 30 })('slow'),
      (e: unknown) => e instanceof ServiceRpcError && e.status === 0 && /timed out after 30 ms/.test(e.message),
    );
  });

  it('typed calls: RPC names and argument names in one place (design §2, §5)', async () => {
    const fake = fakeRpc({
      server_sanction_status: (args: { p_user_id: string }) =>
        args.p_user_id === PERMA
          ? { banned_until: 'infinity', muted_until: null }
          : { banned_until: null, muted_until: '2026-11-02T14:00:00+00:00' },
      server_touch_game_rooms: 2,
    });
    const api = createServiceApi(fake.rpc);
    await api.removeGameRoom('R1');
    await api.touchGameRooms(['R1', 'R2']);
    assert.deepEqual<SanctionStatus>(await api.sanctionStatus(PERMA), { bannedUntil: Infinity, mutedUntil: null });
    assert.deepEqual<SanctionStatus>(await api.sanctionStatus(U2), {
      bannedUntil: null,
      mutedUntil: Date.parse('2026-11-02T14:00:00Z'),
    });
    assert.deepEqual(fake.calls, [
      { name: 'server_remove_game_room', args: { p_room_id: 'R1' } },
      { name: 'server_touch_game_rooms', args: { p_room_ids: ['R1', 'R2'] } },
      { name: 'server_sanction_status', args: { p_user_id: PERMA } },
      { name: 'server_sanction_status', args: { p_user_id: U2 } },
    ]);
    // server_record_match takes the MatchResult as is.
    const match = {
      matchId: 'R1:1',
      gameId: 'sumo',
      roomId: 'R1',
      private: true,
      winnerUserId: null,
      startedAt: '2026-10-30T10:00:00.000Z',
      endedAt: '2026-10-30T10:01:00.000Z',
      durationSec: 60,
      rounds: 3,
      leaderboardDeltas: {},
      players: [],
    };
    const recording = fakeRpc({
      server_record_match: ({ p_match }: { p_match: { matchId: string } }) =>
        p_match.matchId === 'R1:1' ? { duplicate: false, players: {} } : { duplicate: true },
    });
    assert.deepEqual(await createServiceApi(recording.rpc).recordMatch(match), { duplicate: false, players: {} });
    assert.deepEqual(recording.calls, [{ name: 'server_record_match', args: { p_match: match } }]);
    assert.deepEqual(await createServiceApi(recording.rpc).recordMatch({ ...match, matchId: 'R1:2' }), {
      duplicate: true,
    });
    // Not a uuid (a guest id, a test sub): no profile, so no sanctions, and no call.
    assert.deepEqual(await api.sanctionStatus('guest:abc'), { bannedUntil: null, mutedUntil: null });
    assert.equal(fake.calls.length, 4);
    // A null answer (no row) is "no sanctions"; garbage is an error (the lookup then fails open).
    assert.deepEqual(await createServiceApi(fakeRpc().rpc).sanctionStatus(U2), {
      bannedUntil: null,
      mutedUntil: null,
    });
    await assert.rejects(
      createServiceApi(fakeRpc({ server_sanction_status: { banned_until: 'soon' } }).rpc).sanctionStatus(U2),
      /unexpected banned_until/,
    );
  });
});

describe('config: SUPABASE_SERVICE_ROLE_KEY', () => {
  const base = { SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon' };

  it('production needs the key whenever SUPABASE_URL is set; it must be a secret key', () => {
    assert.throws(() => readServerConfig({ NODE_ENV: 'production', ...base }), /SUPABASE_SERVICE_ROLE_KEY is required/);
    assert.throws(() => readServerConfig(base), /SUPABASE_SERVICE_ROLE_KEY is required/, 'NODE_ENV unset = production');
    const prod = readServerConfig({ NODE_ENV: 'production', ...base, SUPABASE_SERVICE_ROLE_KEY: ' sb_secret_k ' });
    assert.equal(prod.supabaseServiceRoleKey, 'sb_secret_k');
    assert.equal(
      readServerConfig({ NODE_ENV: 'production', ...base, SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE_KEY })
        .supabaseServiceRoleKey,
      LEGACY_SERVICE_KEY,
    );
    // Guests-only production without Supabase needs no key.
    assert.equal(
      readServerConfig({ NODE_ENV: 'production', RALLY_ALLOW_GUESTS: '1' }).supabaseServiceRoleKey,
      undefined,
    );
    // Keys that cannot be the service role are refused in every mode.
    for (const wrong of ['anon', 'sb_publishable_abc', LEGACY_ANON_KEY, 'eyJnot.a.jwt']) {
      assert.throws(
        () => readServerConfig({ NODE_ENV: 'development', ...base, SUPABASE_SERVICE_ROLE_KEY: wrong }),
        /must be the secret \(service_role\) key/,
        wrong,
      );
    }
    assert.doesNotMatch(describeConfig(prod), /sb_secret_k/, 'the key is never logged');
    assert.match(describeConfig(prod), /service role: configured/);
  });

  it('optional in development and test, with a one-line warning when SUPABASE_URL is set', () => {
    const dev = readServerConfig({ NODE_ENV: 'development', ...base });
    assert.equal(dev.supabaseServiceRoleKey, undefined);
    const warnings = configWarnings(dev, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /SUPABASE_SERVICE_ROLE_KEY is not set: rooms are not mirrored/);
    assert.deepEqual(configWarnings(readServerConfig({ NODE_ENV: 'development' }), {}), []);
    // A key without a URL is ignored (and said so).
    const env = { NODE_ENV: 'development', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_k' };
    const noUrl = readServerConfig(env);
    assert.equal(noUrl.supabaseServiceRoleKey, undefined);
    assert.match(configWarnings(noUrl, env).join(), /without SUPABASE_URL: ignored/);
    assert.equal(readServerConfig({ NODE_ENV: 'test', ...base }).supabaseServiceRoleKey, undefined);
  });
});

describe('sanctions', () => {
  const secret = 'test-secret-with-at-least-32-characters!!';
  const DAY = 86_400_000;
  const token = (sub: string) =>
    new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));

  it('createSanctionLookup caches a user for 60 s, and fails open (logged, not cached) when the lookup fails', async () => {
    let now = 1_000_000;
    const logs: string[] = [];
    const fake = fakeRpc({ server_sanction_status: { banned_until: null, muted_until: null } });
    const lookup = createSanctionLookup(createServiceApi(fake.rpc), { now: () => now, log: (m) => logs.push(m) });
    assert.deepEqual(await lookup(PERMA), { bannedUntil: null, mutedUntil: null });
    now += 59_000;
    await lookup(PERMA);
    assert.equal(fake.of('server_sanction_status').length, 1, 'cached within 60 s');
    now += 2000;
    await lookup(PERMA);
    await lookup(U2);
    assert.equal(fake.of('server_sanction_status').length, 3, 'refetched after 60 s; per user');

    fake.failing = true;
    now += 61_000;
    assert.equal(await lookup(PERMA), null);
    assert.match(logs[0]!, /\[auth\] sanction check for 0b7f6f2e-\S+ failed, admitting/);
    fake.failing = false;
    assert.deepEqual(await lookup(PERMA), { bannedUntil: null, mutedUntil: null }, 'failures are not cached');
  });

  it('the authenticator refuses a ban (never downgrading to a guest), flags a mute, and fails open', async () => {
    const statuses: Record<string, SanctionStatus | 'error'> = {
      banned: { bannedUntil: Date.parse('2099-01-02T03:04:05Z'), mutedUntil: null },
      perma: { bannedUntil: Infinity, mutedUntil: null },
      expired: { bannedUntil: Date.now() - DAY, mutedUntil: Date.now() - DAY },
      muted: { bannedUntil: null, mutedUntil: Date.now() + DAY },
      broken: 'error',
    };
    const auth = createAuthenticator(
      {
        jwtSecret: secret,
        allowGuests: true,
        sanctions: createSanctionLookup(
          {
            sanctionStatus: async (id) => {
              const s = statuses[id];
              if (!s || s === 'error') throw new Error('down');
              return s;
            },
          },
          { log: () => {} },
        ),
      },
      {},
      () => {},
    );
    await assert.rejects(auth(await token('banned'), {}), /^AuthError: account suspended until 2099-01-02T03:04:05Z$/);
    await assert.rejects(auth(await token('perma'), {}), /account suspended until further notice/);
    assert.equal(suspensionMessage(Infinity), 'account suspended until further notice');
    const expired = await auth(await token('expired'), {});
    assert.equal(expired.userId, 'expired');
    assert.equal(expired.muted, undefined);
    assert.equal((await auth(await token('muted'), {})).muted, true);
    assert.equal((await auth(await token('broken'), {})).userId, 'broken', 'fail open');
  });

  describe('in RallyRoom.onAuth', () => {
    let colyseus: ColyseusTestServer<typeof appConfig>;

    before(async () => {
      colyseus = await testServer();
    });
    beforeEach(async () => {
      resetRateLimits();
      await colyseus.cleanup();
    });
    after(() => {
      RallyRoom.configureAuth(null);
      colyseus.sdk.auth.token = '';
    });

    it('a banned player is refused with AUTH_FAILED "account suspended until <date>"; a muted one gets in, muted', async () => {
      const fake = fakeRpc({
        server_sanction_status: ({ p_user_id }: { p_user_id: string }) =>
          p_user_id === BANNED
            ? { banned_until: '2099-05-06T07:08:09+00:00', muted_until: null }
            : { banned_until: null, muted_until: p_user_id === MUTED ? 'infinity' : null },
      });
      RallyRoom.configureAuth(
        createAuthenticator({
          jwtSecret: secret,
          allowGuests: true,
          sanctions: createSanctionLookup(createServiceApi(fake.rpc)),
        }),
      );
      colyseus.sdk.auth.token = await token(BANNED);
      await assert.rejects(colyseus.sdk.joinOrCreate('sumo', {}), (e: { code?: number; message?: string }) => {
        assert.equal(e.code, ErrorCode.AUTH_FAILED);
        assert.equal(e.message, 'account suspended until 2099-05-06T07:08:09Z');
        return true;
      });

      colyseus.sdk.auth.token = await token(MUTED);
      const room = await colyseus.sdk.joinOrCreate('sumo', {});
      room.onMessage('fx', () => {});
      const seat = colyseus.getRoomById<SumoRoom>(room.roomId).authOf(room.sessionId);
      assert.deepEqual<RallyAuth | undefined>(seat, {
        userId: MUTED,
        username: 'user-30ed',
        avatarUrl: null,
        guest: false,
        muted: true,
      });
      assert.deepEqual(
        fake.of('server_sanction_status').map((a) => a.p_user_id),
        [BANNED, MUTED],
        'checked after the token is verified, once per user',
      );
    });
  });
});
