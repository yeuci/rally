import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadCatalog } from './catalog.ts';
import { resolveConfig, type Env } from './config.ts';
import { buildSite, DEFAULT_OUT_DIR, WEB_ROOT, type BuildResult } from './build.ts';

export const DEV_PORT = 5190;

export interface Io {
  log: (line: string) => void;
  warn: (line: string) => void;
}

const consoleIo: Io = { log: (l) => console.log(l), warn: (l) => console.warn(l) };

/** A banner nobody scrolls past in CI logs. */
export function formatWarnings(warnings: string[]): string {
  const yellow = (s: string) => (process.stderr.isTTY ? `\x1b[33;1m${s}\x1b[0m` : s);
  const bar = '!'.repeat(78);
  return [
    yellow(bar),
    yellow(`!!  @rally/web: ${warnings.length} placeholder/config warning(s). NOT ready for production.`),
    ...warnings.map((w) => yellow(`!!  - ${w}`)),
    yellow('!!  Set the variables (see apps/web/.env.example); build with --strict to fail instead.'),
    yellow(bar),
  ].join('\n');
}

export class StrictModeError extends Error {
  override name = 'StrictModeError';
}

export interface RunOptions {
  argv?: string[];
  env?: Env;
  io?: Io;
  /** Test hooks. */
  fetch?: typeof fetch;
  gamesDir?: string;
  iconDir?: string | null;
}

/**
 * `tsx src/cli.ts [--dev] [--strict] [--out <dir>]`. Reads env (and apps/web/.env when present), loads the
 * catalog, writes the site. Returns the build result; throws on configuration or catalog errors.
 */
export async function run(opts: RunOptions = {}): Promise<BuildResult & { warnings: string[] }> {
  const io = opts.io ?? consoleIo;
  const { values } = parseArgs({
    args: opts.argv ?? [],
    options: {
      dev: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
    strict: true,
  });
  const env = opts.env ?? process.env;
  const port = Number(env.PORT) || DEV_PORT;
  const { config, warnings } = resolveConfig(env, values.dev ? { devOrigin: `http://localhost:${port}` } : {});

  const catalog = await loadCatalog(config, { fetch: opts.fetch, gamesDir: opts.gamesDir });
  warnings.push(...catalog.warnings);
  if (catalog.games.length === 0) warnings.push('The catalog is empty: the index lists no games.');

  const strict = values.strict || env.WEB_STRICT === '1' || env.WEB_STRICT === 'true';
  if (warnings.length) {
    io.warn(formatWarnings(warnings));
    if (strict) throw new StrictModeError(`--strict: refusing to build with ${warnings.length} warning(s)`);
  }

  const outDir = values.out ? path.resolve(values.out) : DEFAULT_OUT_DIR;
  const result = await buildSite({ config, games: catalog.games, outDir, iconDir: opts.iconDir });
  io.log(`@rally/web: origin ${config.origin}`);
  io.log(
    `@rally/web: catalog from ${catalog.source === 'supabase' ? 'Supabase (games, status = published)' : 'games/*/game.json'}: ${
      catalog.games.map((g) => g.id).join(', ') || '(none)'
    }`,
  );
  io.log(`@rally/web: wrote ${result.files.length} files to ${path.relative(WEB_ROOT, result.outDir) || '.'}/`);
  return { ...result, warnings };
}
