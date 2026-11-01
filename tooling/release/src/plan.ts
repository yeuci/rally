/**
 * The release decisions, pure so they are unit-tested: does the game server need a redeploy, which games need a
 * publish, and how to say it. `cli.ts` gathers the facts (git, the box, Supabase) and runs the steps.
 */

/**
 * Tracked files that tools rewrite on their own (uniwind regenerates its types every time Metro starts, with the
 * platform's line endings): a local change to one of them never blocks a release.
 */
export const GENERATED_FILES = new Set(['apps/mobile/uniwind-types.d.ts']);

/**
 * The paths in `git status --porcelain` output that block a release: every changed tracked file except the
 * generated ones. Tolerates a trimmed first line (" M a" read as "M a") and renames ("R  old -> new").
 */
export function blockingChanges(porcelain: string, generated: ReadonlySet<string> = GENERATED_FILES): string[] {
  return porcelain
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/^[A-Z?!]{1,2}\s+/, '')
        .split(' -> ')
        .pop()!
        .replace(/^"|"$/g, ''),
    )
    .filter((path) => !generated.has(path));
}

/** Games that never ship from `pnpm ship` (the bridge test game is published by hand, if ever). */
export const NEVER_SHIPPED = new Set(['spike']);

/**
 * Whether the deployed server is behind: any changed file inside the server's own folder or one of its workspace
 * dependencies (`serverDirs`, repo-relative, e.g. `apps/game-server`, `games/sushi/server`), or the lockfile. An
 * unknown deployed commit (first deploy, or one this checkout has never seen) always deploys.
 */
export function serverNeedsDeploy(
  deployedCommit: string | null,
  changedFiles: readonly string[] | null,
  serverDirs: readonly string[],
): { deploy: boolean; reason: string } {
  if (!deployedCommit) return { deploy: true, reason: 'no deployed commit recorded on the box' };
  if (!changedFiles)
    return { deploy: true, reason: `the deployed commit ${short(deployedCommit)} is not in this checkout` };
  const dirs = serverDirs.map((d) => d.replace(/\\/g, '/').replace(/\/+$/, '') + '/');
  const hits = changedFiles.filter((f) => f === 'pnpm-lock.yaml' || dirs.some((d) => f.startsWith(d)));
  if (hits.length === 0) return { deploy: false, reason: `no server changes since ${short(deployedCommit)}` };
  const shown = hits.slice(0, 3).join(', ') + (hits.length > 3 ? ` and ${hits.length - 3} more` : '');
  return { deploy: true, reason: `server code changed since ${short(deployedCommit)} (${shown})` };
}

export interface LocalGame {
  id: string;
  version: string;
  title: string;
}

export interface LiveGame {
  /** `games.status` (draft games are hidden from players). */
  status: string;
  /** The live version, or null when nothing is live. */
  current: string | null;
  /** Every version with a `game_versions` row. */
  published: ReadonlySet<string>;
}

export type GameAction =
  | { id: string; title: string; version: string; kind: 'publish'; makeVisible: boolean; draft: boolean; note?: string }
  | { id: string; title: string; version: string; kind: 'skip'; draft: boolean; note: string };

/**
 * One line per game. A version without a `game_versions` row is published; a brand-new game (no catalog row yet)
 * also goes live in the catalog (`--publish`), because a new game is otherwise a hidden draft. An existing draft
 * stays a draft (it may be hidden on purpose) and says so. `only` limits the run to those ids.
 */
export function planGames(
  local: readonly LocalGame[],
  live: ReadonlyMap<string, LiveGame>,
  only: readonly string[] = [],
): GameAction[] {
  const unknown = only.filter((id) => !local.some((g) => g.id === id));
  if (unknown.length > 0) throw new Error(`no game folder for: ${unknown.join(', ')}`);
  return local
    .filter((g) => (only.length > 0 ? only.includes(g.id) : !NEVER_SHIPPED.has(g.id)))
    .map((g): GameAction => {
      const row = live.get(g.id);
      const base = { id: g.id, title: g.title, version: g.version };
      if (!row)
        return { ...base, kind: 'publish', makeVisible: true, draft: false, note: 'new game, listed for players' };
      const isDraft = row.status === 'draft';
      const draft = isDraft ? `a hidden draft: \`pnpm ship:games ${g.id} --list\` lists it` : undefined;
      if (row.published.has(g.version)) {
        const where = row.current === g.version ? 'live' : `published (live: ${row.current ?? 'none'})`;
        const note = [`${g.version} already ${where}`, draft].filter(Boolean).join('; ');
        return { ...base, kind: 'skip', draft: isDraft, note };
      }
      const from = row.current ? `${row.current} → ${g.version}` : `first version ${g.version}`;
      const note = [from, draft].filter(Boolean).join('; ');
      return { ...base, kind: 'publish', makeVisible: false, draft: isDraft, note };
    });
}

/** The plan as the lines `pnpm ship` prints before it asks to go ahead. */
export function describePlan(p: {
  pulled: string | null;
  db: boolean;
  server: { deploy: boolean; reason: string } | null;
  games: readonly GameAction[] | null;
}): string[] {
  const lines: string[] = [];
  if (p.pulled) lines.push(`  code      ${p.pulled}`);
  if (p.db) lines.push('  database  push new migrations (Supabase asks before applying any)');
  if (p.server) lines.push(`  server    ${p.server.deploy ? 'redeploy' : 'skip'}: ${p.server.reason}`);
  if (p.games) {
    if (p.games.length === 0) lines.push('  games     none');
    for (const g of p.games) {
      const what = g.kind === 'publish' ? `publish ${g.version}` : 'skip';
      lines.push(`  game      ${g.title} (${g.id}): ${what}${g.note ? ` (${g.note})` : ''}`);
    }
  }
  return lines;
}

export const short = (sha: string) => sha.slice(0, 7);
