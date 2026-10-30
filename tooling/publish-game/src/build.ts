import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PublishError } from './errors.ts';

/** Run `vite build` in the game's client folder with the Vite that folder resolves. */
export async function runViteBuild(clientDir: string, log: (line: string) => void = console.log): Promise<void> {
  const require = createRequire(path.join(clientDir, 'package.json'));
  let viteBin: string;
  try {
    const pkgPath = require.resolve('vite/package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.vite;
    if (!bin) throw new Error('vite has no bin');
    viteBin = path.join(path.dirname(pkgPath), bin);
  } catch (err) {
    throw new PublishError(
      `cannot find vite for ${clientDir} (${err instanceof Error ? err.message : String(err)}); run pnpm install`,
    );
  }
  log(`$ vite build   (in ${clientDir})`);
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [viteBin, 'build'], { cwd: clientDir, stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (code !== 0) throw new PublishError(`vite build failed in ${clientDir} (exit ${code})`);
}
