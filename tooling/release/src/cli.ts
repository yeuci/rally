#!/usr/bin/env node
/**
 * Owner-run releases (Windows, macOS or Linux; needs git, ssh and the Supabase CLI login that `db push` already
 * uses). Root scripts:
 *
 *   pnpm ship              everything, in order: update main, install, push migrations, redeploy the game server
 *                          (only when its code changed since the deployed commit), publish every game whose
 *                          version is not live yet; shows the plan and asks first
 *   pnpm ship:status       the plan only: what `pnpm ship` would do now (changes nothing)
 *   pnpm ship:db           push new migrations
 *   pnpm ship:server       redeploy the game server (--force restarts it even when nothing changed)
 *   pnpm ship:games [ids]  publish the games whose version is not live (all, or the ids given; --list also lists a
 *                          draft game for players)
 *
 * Flags: --yes (no question), --dry-run (plan only). Config comes from tooling/publish-game/.env (git-ignored):
 * SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and RALLY_COLYSEUS_URL as for publishing, plus RALLY_DEPLOY_SSH
 * (e.g. root@203.0.113.7) for the server. The public URL is RALLY_DEPLOY_URL, else the first https entry of
 * RALLY_COLYSEUS_URL.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import {
  blockingChanges,
  describePlan,
  planGames,
  serverNeedsDeploy,
  short,
  type GameAction,
  type LiveGame,
  type LocalGame,
} from './plan.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const WIN = process.platform === 'win32';
const ENV_FILE = path.join(ROOT, 'tooling/publish-game/.env');

class Stop extends Error {}

// --- processes ------------------------------------------------------------------------------------------------------

/** Run a command with the terminal attached (its prompts and output are the user's). `pnpm`/`npx` are .cmd on Windows. */
function run(cmd: string, args: string[], cwd = ROOT): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: WIN && (cmd === 'pnpm' || cmd === 'npx') });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Stop(`${cmd} ${args.join(' ')} failed (exit ${code})`)),
    );
  });
}

/** Run a command and return its stdout (trimmed); stderr stays on the terminal. */
function capture(cmd: string, args: string[], cwd = ROOT): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['inherit', 'pipe', 'inherit'], // stdin: ssh may ask for a password
      shell: WIN && (cmd === 'pnpm' || cmd === 'npx'),
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Stop(`${cmd} ${args.join(' ')} failed (exit ${code})`)),
    );
  });
}

const git = (...args: string[]) => capture('git', args);

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

const step = (title: string) => console.log(`\n▶ ${title}`);

// --- config ---------------------------------------------------------------------------------------------------------

function loadEnv(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}

function need(name: string, why: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Stop(`${name} is not set. Add it to tooling/publish-game/.env (${why}).`);
  return v;
}

function deployTarget(): { ssh: string; url: string } {
  const ssh = need('RALLY_DEPLOY_SSH', 'the ssh login of the game server box, e.g. RALLY_DEPLOY_SSH=root@203.0.113.7');
  const url =
    process.env.RALLY_DEPLOY_URL?.trim() ||
    (process.env.RALLY_COLYSEUS_URL ?? '')
      .split(',')
      .map((s) => s.trim())
      .find((s) => s.startsWith('https://'));
  if (!url)
    throw new Stop(
      'No https game server URL: set RALLY_DEPLOY_URL (or RALLY_COLYSEUS_URL) in tooling/publish-game/.env.',
    );
  if (!/^[A-Za-z0-9._@-]+$/.test(ssh)) throw new Stop(`RALLY_DEPLOY_SSH looks wrong: '${ssh}' (expected user@host)`);
  return { ssh, url: url.replace(/\/+$/, '') };
}

// --- facts ----------------------------------------------------------------------------------------------------------

/** Make sure we're on main with nothing uncommitted, fetch it; say what pulling would bring. */
async function checkMain(): Promise<{ behind: number; pullLine: string | null }> {
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') throw new Stop(`You're on '${branch}'. Releases go out from main: git checkout main`);
  const dirty = blockingChanges(await git('status', '--porcelain', '--untracked-files=no'));
  if (dirty.length > 0) {
    throw new Stop(
      `main has uncommitted changes; commit or discard them first (git checkout -- <file>):\n${dirty.join('\n')}`,
    );
  }
  await run('git', ['fetch', '--quiet', 'origin', 'main']);
  const ahead = Number(await git('rev-list', '--count', 'origin/main..HEAD'));
  if (ahead > 0) {
    throw new Stop(
      `Your main has ${ahead} commit(s) that are not on GitHub. The server deploys from GitHub, so push them ` +
        '(or reset to origin/main) before releasing.',
    );
  }
  const behind = Number(await git('rev-list', '--count', 'HEAD..origin/main'));
  if (behind === 0) return { behind, pullLine: null };
  const [from, to] = await Promise.all([
    git('rev-parse', '--short', 'HEAD'),
    git('rev-parse', '--short', 'origin/main'),
  ]);
  return { behind, pullLine: `pull ${behind} new commit(s) from GitHub (${from} → ${to}), then pnpm install` };
}

/** The game folders at `ref` (their game.json), read through git so a dry run sees what a pull would bring. */
async function localGames(ref: string): Promise<LocalGame[]> {
  const listing = await git('ls-tree', '-d', '--name-only', `${ref}:games`);
  const games: LocalGame[] = [];
  for (const dir of listing.split('\n').filter(Boolean)) {
    let json: string;
    try {
      json = await capture('git', ['show', `${ref}:games/${dir}/game.json`]);
    } catch {
      continue;
    }
    const m = JSON.parse(json) as { id: string; version: string; title: string };
    games.push({ id: m.id, version: m.version, title: m.title });
  }
  return games;
}

async function liveGames(ids: readonly string[]): Promise<Map<string, LiveGame>> {
  const sb = createClient(
    need('SUPABASE_URL', 'the Supabase project URL'),
    need('SUPABASE_SERVICE_ROLE_KEY', 'the service-role key, as for publishing'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const [games, versions] = await Promise.all([
    sb.from('games').select('id, status, current_version_id').in('id', ids),
    sb.from('game_versions').select('id, game_id, version').in('game_id', ids),
  ]);
  if (games.error) throw new Stop(`Supabase: cannot read games: ${games.error.message}`);
  if (versions.error) throw new Stop(`Supabase: cannot read game_versions: ${versions.error.message}`);
  const map = new Map<string, LiveGame>();
  for (const g of games.data as { id: string; status: string; current_version_id: string | null }[]) {
    const own = (versions.data as { id: string; game_id: string; version: string }[]).filter((v) => v.game_id === g.id);
    map.set(g.id, {
      status: g.status,
      current: own.find((v) => v.id === g.current_version_id)?.version ?? null,
      published: new Set(own.map((v) => v.version)),
    });
  }
  return map;
}

/** Repo-relative folders of the game server and every workspace package it depends on. */
async function serverDirs(): Promise<string[]> {
  const json = await capture('pnpm', ['ls', '--filter', '@rally/game-server...', '--depth', '-1', '--json']);
  return (JSON.parse(json) as { path: string }[]).map((p) => path.relative(ROOT, p.path).replace(/\\/g, '/'));
}

/** The commit the box last deployed (its `~/.rally-deployed` stamp), or null. */
async function deployedCommit(ssh: string): Promise<string | null> {
  const out = await capture('ssh', [ssh, `sudo -u rally -H sh -c 'cat "$HOME/.rally-deployed" 2>/dev/null || true'`]);
  const sha = out.split(/\s+/)[0] ?? '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

async function serverPlan(ssh: string, target: string) {
  const [deployed, dirs] = await Promise.all([deployedCommit(ssh), serverDirs()]);
  let changed: string[] | null = null;
  if (deployed) {
    try {
      changed = (await git('diff', '--name-only', deployed, target)).split('\n').filter(Boolean);
    } catch {
      changed = null;
    }
  }
  return serverNeedsDeploy(deployed, changed, dirs);
}

// --- steps ----------------------------------------------------------------------------------------------------------

async function pushDatabase(): Promise<void> {
  step('Database: pushing new migrations');
  await run('npx', ['supabase', 'db', 'push'], path.join(ROOT, 'packages/db'));
}

async function deployServer(ssh: string, url: string, force: boolean): Promise<void> {
  step(`Game server: deploying main to ${ssh}`);
  const remote = [
    'sudo',
    '-u',
    'rally',
    '-H',
    'rally-deploy',
    '--ref',
    'main',
    '--public-url',
    url,
    ...(force ? ['--force'] : []),
  ];
  await run('ssh', [ssh, remote.join(' ')]);
  const res = await fetch(`${url}/healthz`).catch(() => null);
  const body = res?.ok ? await res.text() : null;
  if (!body) throw new Stop(`${url}/healthz did not answer after the deploy; check the box (pm2 logs).`);
  console.log(`  ${url}/healthz → ${body}`);
}

/** Flip a draft that is already published to listed (what `publish-game --publish` does with a new version). */
async function listGame(id: string): Promise<void> {
  const sb = createClient(
    need('SUPABASE_URL', 'the Supabase project URL'),
    need('SUPABASE_SERVICE_ROLE_KEY', 'the service-role key'),
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const res = await sb.from('games').update({ status: 'published' }).eq('id', id);
  if (res.error) throw new Stop(`Supabase: cannot list ${id}: ${res.error.message}`);
}

async function publishGames(actions: readonly GameAction[], list: boolean): Promise<string[]> {
  const done: string[] = [];
  for (const g of actions) {
    if (g.kind === 'skip') {
      if (list && g.draft) {
        step(`Listing ${g.title} for players`);
        await listGame(g.id);
        done.push(`${g.title} listed`);
      }
      continue;
    }
    step(`Publishing ${g.title} ${g.version}`);
    const args = ['--filter', '@rally/publish-game', 'publish-game', g.id];
    if (g.makeVisible || list) args.push('--publish');
    await run('pnpm', args);
    done.push(`${g.title} ${g.version}`);
  }
  return done;
}

// --- commands -------------------------------------------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      yes: { type: 'boolean', short: 'y', default: false },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
    },
  });
  const [command, ...ids] = positionals;
  loadEnv();

  if (command === 'db') return pushDatabase();

  if (command === 'server') {
    const { ssh, url } = deployTarget();
    await run('git', ['fetch', '--quiet', 'origin', 'main']);
    const plan = await serverPlan(ssh, 'origin/main');
    console.log(`  server    ${plan.reason}`);
    if (!plan.deploy && !values.force)
      return console.log('  Nothing to deploy (pnpm ship:server --force restarts it anyway).');
    if (values['dry-run']) return;
    if (!values.yes && !(await confirm('Redeploy now? Live matches will end.'))) return;
    return deployServer(ssh, url, values.force);
  }

  if (command === 'games') {
    const local = await localGames('HEAD');
    const actions = planGames(local, await liveGames(local.map((g) => g.id)), ids);
    for (const line of describePlan({ pulled: null, db: false, server: null, games: actions })) console.log(line);
    const work = actions.some((a) => a.kind === 'publish' || (values.list && a.draft));
    if (values['dry-run'] || !work) return;
    if (!values.yes && !(await confirm('Publish these?'))) return;
    const done = await publishGames(actions, values.list);
    console.log(`\n✔ Published: ${done.join(', ')}. Reload Expo Go to see them.`);
    return;
  }

  if (command === 'ship' || command === 'status') {
    const planOnly = command === 'status' || values['dry-run'];
    const { pullLine } = await checkMain();
    const { ssh, url } = deployTarget();
    const local = await localGames('origin/main');
    const [server, live] = await Promise.all([serverPlan(ssh, 'origin/main'), liveGames(local.map((g) => g.id))]);
    const games = planGames(local, live);
    console.log(`\nRelease plan (main @ ${short(await git('rev-parse', 'origin/main'))}):`);
    for (const line of describePlan({ pulled: pullLine, db: true, server, games })) console.log(line);
    if (planOnly) return;
    if (!values.yes && !(await confirm('\nGo?'))) return;

    if (pullLine) {
      step('Code: pulling main');
      await run('git', ['pull', '--ff-only', 'origin', 'main']);
      await run('pnpm', ['install', '--frozen-lockfile']);
    }
    await pushDatabase();
    if (server.deploy) await deployServer(ssh, url, false);
    const done = await publishGames(games, false);
    console.log('\n✔ Released.');
    console.log(`  server: ${server.deploy ? 'redeployed' : 'unchanged'}`);
    console.log(`  games:  ${done.length > 0 ? done.join(', ') : 'nothing new'}`);
    console.log('  Reload Expo Go (pnpm app) to see it all.');
    return;
  }

  throw new Stop(
    'Usage: pnpm ship | ship:status | ship:db | ship:server | ship:games [ids] (see tooling/release/README.md)',
  );
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(
    `\n✖ ${err instanceof Stop ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
