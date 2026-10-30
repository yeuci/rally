#!/usr/bin/env -S node --experimental-strip-types
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PublishError } from './errors.ts';
import { publishGame } from './publish.ts';

const USAGE = `Usage: publish-game <slug> [options]

Build games/<slug>/client, inject CSP + SRI, hash every file, upload to the Supabase Storage
bucket "games" under <slug>/<version>/, upsert the catalog row, insert game_versions and flip
games.current_version_id.

Options:
  --dry-run              Validate, build, process and hash; write publish-plan.json; no network
  --no-build             Use the existing games/<slug>/client/dist
  --no-activate          Upload and insert the version, but keep the live version
  --publish              Also set games.status = 'published' (new games start as draft)
  --rollback <version>   Only point games.current_version_id at an already published version
  --force                Overwrite an existing <slug>/<version>/ (normally refused: bump the version)
  --colyseus <url>       Colyseus URL for the CSP connect-src (repeatable; default RALLY_COLYSEUS_URL)
  --out <file>           Where --dry-run writes the plan (default games/<slug>/client/publish-plan.json)
  --games-dir <dir>      Folder holding the game folders (default <repo>/games)
  -h, --help             Show this help

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RALLY_COLYSEUS_URL (read from tooling/publish-game/.env if present).`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      'no-build': { type: 'boolean', default: false },
      'no-activate': { type: 'boolean', default: false },
      publish: { type: 'boolean', default: false },
      rollback: { type: 'string' },
      force: { type: 'boolean', default: false },
      colyseus: { type: 'string', multiple: true },
      out: { type: 'string' },
      'games-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const slug = positionals[0];
  if (!slug || positionals.length > 1) {
    console.error(USAGE);
    return 2;
  }
  if (values.publish && values['no-activate'])
    throw new PublishError('--publish needs the new version to be live; drop --no-activate');

  const envFile = path.resolve(import.meta.dirname, '../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const cwd = process.env.INIT_CWD ?? process.cwd();
  await publishGame({
    slug,
    dryRun: values['dry-run'],
    build: !values['no-build'],
    activate: !values['no-activate'],
    publish: values.publish,
    force: values.force,
    rollback: values.rollback,
    colyseus: values.colyseus,
    gamesDir: values['games-dir'] ? path.resolve(cwd, values['games-dir']) : undefined,
    planOut: values.out ? path.resolve(cwd, values.out) : undefined,
  });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (
      err instanceof PublishError ||
      (err instanceof TypeError && 'code' in err && String(err.code).startsWith('ERR_PARSE_ARGS'))
    ) {
      console.error(`publish-game: ${err.message}`);
    } else {
      console.error(err);
    }
    process.exit(1);
  },
);
