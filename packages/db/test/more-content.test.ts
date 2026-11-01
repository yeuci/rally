// 20261102000300_more_content.sql: the second batch of shop cosmetics and daily challenge templates (data only).
//
// Every shop item's data is checked against what the app's renderer draws: the keys lib/coins-model.ts
// parseCosmeticData reads per kind and the badge icons components/rally/cosmetics.tsx knows (BADGE_ICON_NAMES),
// mirrored here so this package stays independent of the app; apps/mobile/test/shop-catalog.test.ts runs the app's own
// parser over the same migration. Templates may only use kinds private.challenge_event counts, and name real games
// and boards (games/*/game.json).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrations, createTestDb } from './harness.ts';

const MIGRATION = '20261102000300';
const ONLY_THIS = { from: MIGRATION, before: '20261102000301' };
const GAMES_DIR = new URL('../../../games/', import.meta.url).pathname;

/** The batch as shipped: id, kind, price. */
const BATCH: [string, string, number][] = [
  ['name-coral', 'name_color', 150],
  ['name-lime', 'name_color', 150],
  ['name-silver', 'name_color', 300],
  ['name-orchid', 'name_color', 900],
  ['name-copper', 'name_color', 1500],
  ['name-moonlit', 'name_color', 5000],
  ['frame-graphite', 'avatar_frame', 150],
  ['frame-citrus', 'avatar_frame', 300],
  ['frame-beads', 'avatar_frame', 400],
  ['frame-iris', 'avatar_frame', 900],
  ['frame-twilight', 'avatar_frame', 1800],
  ['frame-prism', 'avatar_frame', 12000],
  ['frame-eclipse', 'avatar_frame', 25000],
  ['banner-slate', 'profile_banner', 150],
  ['banner-peach', 'profile_banner', 300],
  ['banner-pinstripe', 'profile_banner', 500],
  ['banner-confetti', 'profile_banner', 800],
  ['banner-blueprint', 'profile_banner', 1200],
  ['banner-obsidian', 'profile_banner', 8000],
  ['banner-nebula', 'profile_banner', 15000],
  ['badge-leaf', 'badge', 100],
  ['badge-spark', 'badge', 250],
  ['badge-moon', 'badge', 300],
  ['badge-shield', 'badge', 1000],
  ['badge-duel', 'badge', 2000],
  ['badge-diamond', 'badge', 6000],
];
const TEMPLATES = [
  'solo_2',
  'stack_10',
  'topple_1',
  'lumber_1',
  'sawline_1',
  'play_4',
  'solo_3',
  'sushi_1',
  'northdale_1',
  'solo_5',
  'variety_4',
  'friend_2',
];

// --- the renderer's rules (apps/mobile/src/lib/coins-model.ts), mirrored ----------------------------------------------

const HEX = /^#[0-9A-Fa-f]{6}$/;
/** BADGE_ICON_NAMES: any other icon would draw as a star. */
const BADGE_ICONS = new Set([
  'star',
  'flame',
  'crown',
  'zap',
  'gem',
  'heart',
  'rocket',
  'ghost',
  'skull',
  'trophy',
  'sparkles',
  'medal',
  'award',
  'leaf',
  'moon',
  'shield',
  'swords',
  'sun',
  'snowflake',
  'feather',
  'anchor',
  'mountain',
  'target',
  'infinity',
  'clover',
  'music',
  'compass',
  'puzzle',
  'gamepad-2',
]);
/** BANNER_PATTERNS. */
const PATTERNS = new Set(['stripes', 'dots', 'grid', 'stars']);
/** The data keys the renderer reads per kind (anything else would be silently ignored). */
const KEYS: Record<string, string[]> = {
  name_color: ['color', 'light', 'glow'],
  avatar_frame: ['colors', 'spin', 'dotted'],
  profile_banner: ['colors', 'pattern', 'shine'],
  badge: ['icon', 'color', 'light', 'fill'],
};
/** The extras that move or glow: kept for prestige items, so those stay clearly special. */
const SHOWY = ['glow', 'spin', 'shine'];
const PRESTIGE_PRICE = 5000;

/** Why `data` would not draw as intended for `kind` (none: it draws exactly as its data says). */
function drawProblems(kind: string, data: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const allowed = KEYS[kind];
  if (!allowed) return [`kind ${kind} is not drawn by the app`];
  for (const k of Object.keys(data)) if (!allowed.includes(k)) problems.push(`data.${k} is not read by the renderer`);
  const hex = (k: string) => {
    if (typeof data[k] !== 'string' || !HEX.test(data[k])) problems.push(`data.${k} is not #RRGGBB`);
  };
  const optionalHex = (k: string) => {
    if (k in data) hex(k);
  };
  const flag = (k: string) => {
    if (k in data && data[k] !== true) problems.push(`data.${k} must be true when set`);
  };
  const colors = (min: number, max: number) => {
    const c = data.colors;
    if (!Array.isArray(c) || c.length < min || c.length > max || !c.every((x) => typeof x === 'string' && HEX.test(x)))
      problems.push(`data.colors must be ${min} to ${max} #RRGGBB strings`);
  };
  switch (kind) {
    case 'name_color':
      hex('color');
      optionalHex('light');
      flag('glow');
      break;
    case 'badge':
      hex('color');
      optionalHex('light');
      optionalHex('fill');
      if (typeof data.icon !== 'string' || !BADGE_ICONS.has(data.icon))
        problems.push(`data.icon ${String(data.icon)} is not an icon the app draws (it would show a star)`);
      break;
    case 'avatar_frame':
      colors(1, 4);
      flag('spin');
      flag('dotted');
      break;
    case 'profile_banner':
      colors(2, 3);
      if ('pattern' in data && (typeof data.pattern !== 'string' || !PATTERNS.has(data.pattern)))
        problems.push(`data.pattern ${String(data.pattern)} is not a pattern the app draws`);
      flag('shine');
      break;
  }
  return problems;
}

interface Item {
  id: string;
  kind: string;
  name: string;
  description: string;
  price: number;
  data: Record<string, unknown>;
  sort: number;
  available: boolean;
  bytes: number;
}
const items = async (db: PGlite): Promise<Item[]> =>
  (
    await db.query<Item>(
      `select id, kind, name, description, price, data, sort, available, pg_column_size(data) as bytes
         from public.shop_items order by kind, sort, id`,
    )
  ).rows;

interface GameManifest {
  title: string;
  modes: string[];
  leaderboards: { id: string; sort: string; mode?: string }[];
}
const manifest = (gameId: string): GameManifest | null => {
  const file = `${GAMES_DIR}${gameId}/game.json`;
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as GameManifest) : null;
};

describe('20261102000300_more_content.sql', () => {
  let db: PGlite;
  before(async () => {
    db = await createTestDb();
  });
  after(() => db.close());

  test('the shop batch: 26 cosmetics across all four kinds, on a price ladder with a prestige tier', async () => {
    const all = await items(db);
    const byId = new Map(all.map((i) => [i.id, i]));
    const batch = BATCH.map(([id]) => byId.get(id));
    assert.ok(
      batch.every((i) => i),
      'every item of the batch is in the shop',
    );
    assert.deepEqual(
      batch.map((i) => [i!.id, i!.kind, i!.price]),
      BATCH,
    );
    assert.ok(batch.every((i) => i!.available));
    const cheap = batch.filter((i) => i!.price >= 100 && i!.price <= 500);
    const mid = batch.filter((i) => i!.price >= 800 && i!.price <= 2500);
    const prestige = batch.filter((i) => i!.price >= PRESTIGE_PRICE && i!.price <= 25000);
    assert.equal(cheap.length + mid.length + prestige.length, BATCH.length, 'every price is on a rung of the ladder');
    assert.ok(cheap.length >= 10, `many cheap items: ${cheap.length}`);
    assert.ok(mid.length >= 6, `mid items: ${mid.length}`);
    assert.ok(prestige.length >= 3 && prestige.length <= 8, `a few prestige items: ${prestige.length}`);
    for (const kind of Object.keys(KEYS)) {
      assert.ok(
        cheap.some((i) => i!.kind === kind) && mid.some((i) => i!.kind === kind),
        `${kind}: cheap and mid items`,
      );
      assert.ok(
        prestige.some((i) => i!.kind === kind),
        `${kind}: a prestige item`,
      );
    }
    assert.equal(Math.max(...all.map((i) => i.price)), 25000);
    // Shop constraints hold, and the copy is complete.
    for (const i of batch) {
      assert.match(i!.id, /^[a-z0-9][a-z0-9_-]{1,47}$/);
      assert.ok(i!.bytes <= 2048, `${i!.id}: data ${i!.bytes} bytes`);
      assert.ok(i!.description.length >= 1 && i!.description.length <= 200, `${i!.id}: description`);
    }
    // Names are unique across the whole catalog (the history and the sheet show the name alone).
    const names = all.map((i) => i.name.toLowerCase());
    assert.equal(new Set(names).size, names.length);
  });

  test('every item draws as the app expects (the whole catalog, v1 included)', async () => {
    for (const i of await items(db)) {
      assert.deepEqual(drawProblems(i.kind, i.data), [], `${i.id}: ${JSON.stringify(i.data)}`);
      if (SHOWY.some((k) => k in i.data))
        assert.ok(i.price >= PRESTIGE_PRICE, `${i.id}: motion and glow are for prestige items`);
    }
    // The mirror itself: what it refuses.
    assert.ok(drawProblems('name_color', { color: '#123456', glow: 'yes' }).length);
    assert.ok(drawProblems('name_color', { color: '#123456', sparkle: true }).length);
    assert.ok(drawProblems('badge', { icon: 'laurel', color: '#123456' }).length);
    assert.ok(drawProblems('badge', { icon: 'gem', color: '#123456', fill: 'cyan' }).length);
    assert.ok(drawProblems('avatar_frame', { colors: ['#111111', '#222222', '#333333', '#444444', '#555555'] }).length);
    assert.ok(drawProblems('profile_banner', { colors: ['#111111', '#222222'], pattern: 'plaid' }).length);
    assert.ok(drawProblems('profile_banner', { colors: ['#111111'] }).length);
    assert.ok(drawProblems('game_unlock', { game_id: 'sumo' }).length);
  });

  test('featured order: inside each kind, `sort` climbs with the price, no ties', async () => {
    const all = (await items(db)).filter((i) => i.available);
    for (const kind of Object.keys(KEYS)) {
      const ofKind = all.filter((i) => i.kind === kind).sort((a, b) => a.sort - b.sort);
      assert.equal(new Set(ofKind.map((i) => i.sort)).size, ofKind.length, `${kind}: distinct sorts`);
      for (let n = 1; n < ofKind.length; n++) {
        assert.ok(
          ofKind[n]!.price >= ofKind[n - 1]!.price,
          `${kind}: ${ofKind[n - 1]!.id} (${ofKind[n - 1]!.price}) before ${ofKind[n]!.id} (${ofKind[n]!.price})`,
        );
      }
    }
  });

  test('the template batch: 12 more, in kinds the counting code handles, real games and boards, the tier rewards', async () => {
    const rows = (
      await db.query<{
        key: string;
        kind: string;
        game_id: string | null;
        board_key: string | null;
        target: number;
        title: string;
        tier: number;
        coins: number;
        xp: number;
        active: boolean;
      }>(`select * from public.challenge_templates where key = any ($1::text[]) order by tier, key`, [TEMPLATES])
    ).rows;
    assert.deepEqual(rows.map((r) => r.key).sort(), [...TEMPLATES].sort());
    assert.deepEqual(
      [1, 2, 3].map((t) => rows.filter((r) => r.tier === t).length),
      [5, 4, 3],
    );
    // The kinds private.challenge_event moves (a `when '<kind>' then` branch of its counting CASE).
    const counter = (
      await db.query<{ src: string }>(
        `select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'private' and p.proname = 'challenge_event'`,
      )
    ).rows[0]!.src;
    const rewards: Record<number, [number, number]> = { 1: [20, 30], 2: [35, 50], 3: [50, 70] };
    for (const r of rows) {
      assert.ok(counter.includes(`when '${r.kind}' then`), `${r.key}: ${r.kind} is counted`);
      assert.ok(r.active, r.key);
      assert.deepEqual([r.coins, r.xp], rewards[r.tier], `${r.key}: tier ${r.tier} rewards`);
      if (r.kind !== 'score') assert.ok(r.target <= 5, `${r.key}: at most 5 of anything`);
      assert.equal(r.title.includes('{game}'), r.game_id !== null, `${r.key}: {game} names its game`);
      assert.doesNotMatch(r.title.replace(/\{game\}|\{target\}/g, ''), /[{}]/, `${r.key}: known placeholders only`);
      if (r.game_id) {
        const game = manifest(r.game_id);
        assert.ok(game, `${r.key}: games/${r.game_id} exists`);
        const filled = r.title.replace('{game}', game.title).replace('{target}', String(r.target));
        assert.ok(filled.length <= 80, `${r.key}: "${filled}"`);
        if (r.kind === 'score') {
          // A solo game with a best-score board sorted high to low (what the pick and the counter need).
          const board = game.leaderboards.find((b) => b.id === r.board_key);
          assert.ok(game.modes.includes('solo'), `${r.key}: a solo game`);
          assert.ok(
            board && board.sort === 'desc' && (board.mode ?? 'best') === 'best',
            `${r.key}: board ${r.board_key}`,
          );
        }
      }
    }
  });

  test('data only and replay-safe: the v1 rows stay as they were, a second run changes nothing', async () => {
    const fresh = await createTestDb({ before: MIGRATION });
    try {
      const snapshot = async () => ({
        items: (await fresh.query(`select * from public.shop_items order by id`)).rows,
        templates: (await fresh.query(`select * from public.challenge_templates order by key`)).rows,
        columns: (
          await fresh.query(
            `select table_name, column_name, data_type from information_schema.columns
              where table_schema in ('public', 'private') order by 1, 2`,
          )
        ).rows,
        functions: (
          await fresh.query(
            `select n.nspname, p.proname, md5(p.prosrc) as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('public', 'private') order by 1, 2, 3`,
          )
        ).rows,
      });
      const v1 = await snapshot();
      await applyMigrations(fresh, ONLY_THIS);
      const once = await snapshot();
      assert.deepEqual(once.columns, v1.columns, 'no schema change');
      assert.deepEqual(once.functions, v1.functions, 'no function change');
      assert.equal(once.items.length, v1.items.length + BATCH.length);
      assert.equal(once.templates.length, v1.templates.length + TEMPLATES.length);
      const ids = (rows: unknown[]) =>
        new Set(rows.map((r) => (r as { id?: string; key?: string }).id ?? (r as { key: string }).key));
      const v1Ids = ids(v1.items);
      assert.deepEqual(
        once.items.filter((r) => v1Ids.has((r as { id: string }).id)),
        v1.items,
      );
      const v1Keys = ids(v1.templates);
      assert.deepEqual(
        once.templates.filter((r) => v1Keys.has((r as { key: string }).key)),
        v1.templates,
      );
      // A price tuned in the SQL editor survives a replay.
      await fresh.query(`update public.shop_items set price = 4321 where id = 'frame-prism'`);
      await applyMigrations(fresh, ONLY_THIS);
      const twice = await snapshot();
      assert.equal(twice.items.length, once.items.length);
      assert.equal(twice.templates.length, once.templates.length);
      assert.equal(
        (twice.items.find((r) => (r as { id: string }).id === 'frame-prism') as { price: number }).price,
        4321,
      );
    } finally {
      await fresh.close();
    }
  });
});
