import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describePlan, planGames, serverNeedsDeploy, type LiveGame } from '../src/plan.ts';

const SHA = 'a'.repeat(40);
const DIRS = ['apps/game-server', 'games/sushi/server', 'games/sumo/server'];

test('server: deploys when its code, a game rules package or the lockfile changed; not for app or client changes', () => {
  assert.equal(
    serverNeedsDeploy(SHA, ['apps/mobile/src/app/index.tsx', 'games/sushi/client/src/main.ts'], DIRS).deploy,
    false,
  );
  assert.match(serverNeedsDeploy(SHA, [], DIRS).reason, /no server changes since aaaaaaa/);
  for (const f of ['apps/game-server/src/version.ts', 'games/sushi/server/src/tuning.ts', 'pnpm-lock.yaml']) {
    const r = serverNeedsDeploy(SHA, [f], DIRS);
    assert.equal(r.deploy, true, f);
    assert.match(r.reason, new RegExp(f.replace(/[.]/g, '\\.')));
  }
  // A sibling folder whose name only starts the same is not the server.
  assert.equal(serverNeedsDeploy(SHA, ['apps/game-server-old/x.ts'], DIRS).deploy, false);
  // Windows separators and trailing slashes in the folder list are fine.
  assert.equal(serverNeedsDeploy(SHA, ['games/sumo/server/src/a.ts'], ['games\\sumo\\server\\']).deploy, true);
  const many = serverNeedsDeploy(
    SHA,
    ['apps/game-server/1', 'apps/game-server/2', 'apps/game-server/3', 'apps/game-server/4'],
    DIRS,
  );
  assert.match(many.reason, /and 1 more/);
});

test('server: an unknown deployed commit always deploys', () => {
  assert.deepEqual(serverNeedsDeploy(null, [], DIRS), {
    deploy: true,
    reason: 'no deployed commit recorded on the box',
  });
  assert.equal(serverNeedsDeploy(SHA, null, DIRS).deploy, true);
});

const live = (status: string, current: string | null, published: string[]): LiveGame => ({
  status,
  current,
  published: new Set(published),
});

const LOCAL = [
  { id: 'gunrun', version: '0.1.2', title: 'Gun Run' },
  { id: 'spike', version: '0.0.1', title: 'Spike' },
  { id: 'sushi', version: '0.1.0', title: 'Sushi Shift' },
  { id: 'stack', version: '0.1.3', title: 'Stack' },
  { id: 'sumo', version: '0.2.1', title: 'Sumo' },
];

test('games: publish new versions, list brand-new games, skip live ones and the spike', () => {
  const plan = planGames(
    LOCAL,
    new Map([
      ['gunrun', live('published', '0.1.1', ['0.1.0', '0.1.1'])],
      ['stack', live('published', '0.1.3', ['0.1.3'])],
      ['sumo', live('draft', '0.2.0', ['0.2.0'])],
    ]),
  );
  const by = Object.fromEntries(plan.map((p) => [p.id, p]));
  assert.equal(by.spike, undefined, 'the bridge test game never ships by default');
  assert.deepEqual({ kind: by.gunrun!.kind, note: by.gunrun!.note }, { kind: 'publish', note: '0.1.1 → 0.1.2' });
  assert.ok(by.gunrun!.kind === 'publish' && !by.gunrun!.makeVisible);
  assert.ok(by.sushi!.kind === 'publish' && by.sushi!.makeVisible, 'a game with no catalog row goes live for players');
  assert.equal(by.stack!.kind, 'skip');
  assert.match(by.stack!.note!, /0\.1\.3 already live/);
  assert.ok(by.sumo!.kind === 'publish' && !by.sumo!.makeVisible && by.sumo!.draft, 'an existing draft stays a draft');
  assert.match(by.sumo!.note!, /hidden draft: `pnpm ship:games sumo --list`/);
});

test('games: a version published but not live is skipped and says what is live; ids limit the run', () => {
  const plan = planGames(LOCAL, new Map([['stack', live('published', '0.1.2', ['0.1.2', '0.1.3'])]]), [
    'stack',
    'spike',
  ]);
  assert.deepEqual(
    plan.map((p) => [p.id, p.kind]),
    [
      ['spike', 'publish'],
      ['stack', 'skip'],
    ],
  );
  assert.match(plan[1]!.note!, /0\.1\.3 already published \(live: 0\.1\.2\)/);
  assert.throws(() => planGames(LOCAL, new Map(), ['nope']), /no game folder for: nope/);
});

test('describePlan: one line per step, games with what happens to them', () => {
  const games = planGames(LOCAL.slice(0, 1), new Map());
  const lines = describePlan({
    pulled: 'pull 2 new commit(s)',
    db: true,
    server: { deploy: false, reason: 'no server changes since aaaaaaa' },
    games,
  });
  assert.deepEqual(lines, [
    '  code      pull 2 new commit(s)',
    '  database  push new migrations (Supabase asks before applying any)',
    '  server    skip: no server changes since aaaaaaa',
    '  game      Gun Run (gunrun): publish 0.1.2 (new game, listed for players)',
  ]);
  assert.deepEqual(describePlan({ pulled: null, db: false, server: null, games: [] }), ['  games     none']);
});
