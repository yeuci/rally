/**
 * Request → file mapping for the dev server, mirroring what hosts get from _headers / _redirects /
 * vercel.json: AASA as JSON, directory indexes, app-only paths → /open/, everything else → 404.html.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { APP_ONLY_PREFIXES } from './config.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentType(file: string): string {
  if (path.basename(file) === 'apple-app-site-association') return 'application/json';
  return TYPES[path.extname(file)] ?? 'application/octet-stream';
}

async function isFile(file: string): Promise<boolean> {
  return stat(file).then(
    (s) => s.isFile(),
    () => false,
  );
}

/** Resolve a request path to a file under root, or null. Never escapes root. */
export async function resolveRequest(root: string, pathname: string): Promise<{ file: string; status: number }> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = '/';
  }
  const rel = path.posix.normalize(decoded).replace(/^(\.\.(\/|$))+/, '');
  const target = path.join(root, rel);
  if (target.startsWith(root + path.sep) || target === root) {
    if (await isFile(target)) return { file: target, status: 200 };
    const index = path.join(target, 'index.html');
    if (await isFile(index)) return { file: index, status: 200 };
  }
  const first = rel.split('/').filter(Boolean)[0] ?? '';
  if ((APP_ONLY_PREFIXES as readonly string[]).includes(first))
    return { file: path.join(root, 'open/index.html'), status: 200 };
  return { file: path.join(root, '404.html'), status: 404 };
}

export function send(res: ServerResponse, status: number, file: string) {
  res.writeHead(status, { 'Content-Type': contentType(file), 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}
