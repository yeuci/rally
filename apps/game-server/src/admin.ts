import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { ServerConfig } from './config.js';

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const digest = (s: string) => createHash('sha256').update(s).digest();

/** HTTP basic auth with any user name and this password (constant-time compare). */
export function basicAuth(password: string, realm = 'rally-admin'): Middleware {
  const expected = digest(password);
  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const match = /^Basic\s+(\S+)$/i.exec(header);
    const decoded = match ? Buffer.from(match[1]!, 'base64').toString('utf8') : '';
    const given = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : null;
    if (given !== null && timingSafeEqual(digest(given), expected)) return next();
    res.setHeader('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
    res.status(401).send('authentication required');
  };
}

/** Only requests from this machine (the socket address, never a forwarding header). */
export const localhostOnly: Middleware = (req, res, next) => {
  if (LOOPBACK.has(req.socket.remoteAddress ?? '')) return next();
  res.status(403).send('the monitor is localhost-only without RALLY_MONITOR_PASSWORD');
};

/**
 * Guard for `/monitor` and the playground (they can list, inspect and dispose rooms): basic auth when
 * `RALLY_MONITOR_PASSWORD` is set, in any environment; otherwise localhost only in development, and not mounted
 * at all elsewhere (null).
 */
export function adminGuard(config: Pick<ServerConfig, 'mode' | 'monitorPassword'>): Middleware | null {
  if (config.monitorPassword) return basicAuth(config.monitorPassword);
  return config.mode === 'development' ? localhostOnly : null;
}
