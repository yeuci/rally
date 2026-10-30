// RPCs: username_available, record_play, save_put (size limit, ownership), function privileges.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { asAnon, asUser, createTestDb, insertGame, signUp } from './harness.ts';

describe('rpcs', () => {
  let db: PGlite;
  let alice: string;
  let bob: string;

  before(async () => {
    db = await createTestDb();
    await db.exec(`insert into public.banned_words (word) values ('admin')`);
    await insertGame(db, 'spike');
    alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
    bob = await signUp(db, { username: 'bob', birth_date: '2000-01-01' });
  });
  after(() => db.close());

  const available = async (name: string): Promise<boolean> =>
    (await db.query<{ ok: boolean }>(`select public.username_available($1) as ok`, [name])).rows[0]!.ok;

  test('username_available: free, taken (any case), malformed, banned; callable signed out', async () => {
    for (const run of [(fn: () => Promise<void>) => asAnon(db, fn), (fn: () => Promise<void>) => asUser(db, bob, fn)]) {
      await run(async () => {
        assert.equal(await available('new_player'), true);
        assert.equal(await available('alice'), false);
        assert.equal(await available('ALICE'), false);
        assert.equal(await available('ab'), false);
        assert.equal(await available('bad name'), false);
        assert.equal(await available('x'.repeat(21)), false);
        assert.equal(await available('admin'), false);
        assert.equal(await available('Admin_2'), false);
      });
    }
  });

  test('record_play inserts then increments, clamping playtime', async () => {
    await asUser(db, alice, async () => {
      await db.query(`select public.record_play('spike', 120)`);
      await db.query(`select public.record_play('spike')`);
      await db.query(`select public.record_play('spike', 999999)`);
      await db.query(`select public.record_play('spike', -50)`);
      const r = await db.query<{ plays: number; playtime_s: number; last_played_at: Date | null }>(
        `select plays, playtime_s, last_played_at from public.game_stats where user_id = $1 and game_id = 'spike'`,
        [alice],
      );
      assert.equal(r.rows[0]!.plays, 4);
      assert.equal(r.rows[0]!.playtime_s, 120 + 0 + 86400 + 0);
      assert.ok(r.rows[0]!.last_played_at);
    });
  });

  test('record_play for an unknown game fails on the foreign key', async () => {
    await asUser(db, alice, async () => {
      await assert.rejects(db.query(`select public.record_play('nope', 1)`), /foreign key/);
    });
  });

  test('save_put writes to the caller only; other users cannot see it', async () => {
    await asUser(db, alice, async () => {
      await db.query(`select public.save_put('spike', 'slot_a', '{"level":7}'::jsonb)`);
    });
    await asUser(db, bob, async () => {
      // Same slot name for bob starts at version 1: slots are per user.
      const v = await db.query<{ v: number }>(`select public.save_put('spike', 'slot_a', '{"level":1}'::jsonb, 0) as v`);
      assert.equal(v.rows[0]!.v, 1);
      const rows = await db.query<{ data: { level: number } }>(`select data from public.game_saves where slot = 'slot_a'`);
      assert.deepEqual(rows.rows.map((r) => r.data.level), [1]);
    });
  });

  test('save_put rejects data of 64 KB or more, compressible or not', async () => {
    await asUser(db, alice, async () => {
      const random = JSON.stringify({ blob: randomBytes(40 * 1024).toString('base64') }); // ~54 KB of base64
      const ok = await db.query<{ v: number }>(`select public.save_put('spike', 'big', $1::jsonb) as v`, [random]);
      assert.equal(ok.rows[0]!.v, 1);

      const tooBig = JSON.stringify({ blob: randomBytes(60 * 1024).toString('base64') }); // ~80 KB
      await assert.rejects(db.query(`select public.save_put('spike', 'big', $1::jsonb)`, [tooBig]), /game_saves_size/);
      // Highly compressible payloads are measured uncompressed too.
      const repetitive = JSON.stringify({ blob: 'a'.repeat(200 * 1024) });
      await assert.rejects(db.query(`select public.save_put('spike', 'big2', $1::jsonb)`, [repetitive]), /game_saves_size/);
      // The rejected write did not bump the version.
      const v = await db.query<{ version: number }>(`select version from public.game_saves where slot = 'big'`);
      assert.equal(v.rows[0]!.version, 1);
    });
  });

  test('save_put validates the slot name', async () => {
    await asUser(db, alice, async () => {
      await assert.rejects(db.query(`select public.save_put('spike', 'bad slot!', '{}'::jsonb)`), /game_saves_slot/);
    });
  });

  test('write RPCs are not executable signed out; contains_banned_word is not exposed to anon', async () => {
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select public.save_put('spike', 'main', '{}'::jsonb)`), /permission denied/);
      await assert.rejects(db.query(`select public.record_play('spike', 1)`), /permission denied/);
      await assert.rejects(db.query(`select public.contains_banned_word('x')`), /permission denied/);
    });
  });

  test('without a JWT subject the RPCs refuse (defence in depth)', async () => {
    await asUser(db, '', async () => {
      await assert.rejects(db.query(`select public.save_put('spike', 'main', '{}'::jsonb)`), /UNAUTHENTICATED/);
      await assert.rejects(db.query(`select public.record_play('spike', 1)`), /UNAUTHENTICATED/);
    });
  });
});

test('contains_banned_word escapes regex metacharacters (follow-up migration)', async () => {
  const db = await createTestDb();
  await db.exec(`insert into public.banned_words (word) values ('a.b')`);
  const r = await db.query<{ hit: boolean }>(`select public.contains_banned_word('axb') as hit`);
  assert.equal(r.rows[0]?.hit, false, 'dot must not act as a wildcard');
  const r2 = await db.query<{ hit: boolean }>(`select public.contains_banned_word('say a.b now') as hit`);
  assert.equal(r2.rows[0]?.hit, true);
  await db.close();
});
