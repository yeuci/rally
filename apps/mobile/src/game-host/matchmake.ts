import { HostError } from './bridge';

/**
 * Whether the user's Supabase access token may be sent to `url` (the Colyseus matchmaker). Only over TLS
 * (https/wss), except, when `allowPrivateHttp` is set (dev builds: `__DEV__`), plain http to a private-network or
 * loopback host (`localhost`, 127/8, 10/8, 172.16/12, 192.168/16, `[::1]`) for the LAN game server. A URL with
 * credentials in it (`user@host`) or that does not parse is refused.
 */
export function mayAttachToken(url: string, allowPrivateHttp: boolean): boolean {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(url.trim());
  if (!m) return false;
  const scheme = m[1]!.toLowerCase();
  const authority = m[2]!;
  if (!authority || authority.includes('@')) return false;
  if (scheme === 'https' || scheme === 'wss') return true;
  if (scheme !== 'http' && scheme !== 'ws') return false;
  return allowPrivateHttp && isPrivateNetworkHost(authority.replace(/:\d*$/, ''));
}

/** Loopback or RFC 1918 host (dotted-quad IPv4, `localhost`, `[::1]`). Names other than localhost are not private. */
export function isPrivateNetworkHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '[::1]') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** A matchmaking request that has not answered by then fails (the game's own bridge request gave up at 10 s). */
export const MATCHMAKE_TIMEOUT_MS = 15_000;

/**
 * Host-side matchmaking against Colyseus's built-in HTTP routes (architecture §5).
 * `Authorization: Bearer <supabase jwt>` when a token is given (the caller checks `mayAttachToken` first).
 */
export async function matchmake(
  colyseusHttpUrl: string,
  method: 'joinOrCreate' | 'join' | 'create' | 'joinById',
  roomNameOrId: string,
  options: Record<string, unknown> = {},
  accessToken?: string,
  timeoutMs = MATCHMAKE_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const url = `${colyseusHttpUrl}/matchmake/${method}/${encodeURIComponent(roomNameOrId)}`;
  // React Native's fetch has no read timeout; `session.join` is single-flight, so a hung request must not hold it.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(options),
      signal: abort.signal,
    });
    text = await res.text();
  } catch (err) {
    const reason = abort.signal.aborted ? `no answer within ${Math.round(timeoutMs / 1000)}s` : err instanceof Error ? err.message : String(err);
    throw new HostError('MATCHMAKE_FAILED', `cannot reach ${url}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : text || res.statusText;
    const lower = msg.toLowerCase();
    if (lower.includes('locked')) throw new HostError('ROOM_LOCKED', msg);
    if (lower.includes('full') || lower.includes('maxclients')) throw new HostError('ROOM_FULL', msg);
    throw new HostError('MATCHMAKE_FAILED', `${res.status}: ${msg}`);
  }
  if (!body || typeof body !== 'object') {
    throw new HostError('MATCHMAKE_FAILED', 'empty matchmaking response');
  }
  return body as Record<string, unknown>;
}
