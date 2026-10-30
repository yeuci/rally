import { HostError } from './host-bridge.ts';

/** Port of apps/mobile/src/game-host/matchmake.ts: Colyseus's built-in `POST /matchmake/<method>/<room>`. */
export async function matchmake(
  colyseusHttpUrl: string,
  method: 'joinOrCreate' | 'join' | 'create' | 'joinById',
  roomNameOrId: string,
  options: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const url = `${colyseusHttpUrl}/matchmake/${method}/${encodeURIComponent(roomNameOrId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
  } catch (err) {
    throw new HostError(
      'MATCHMAKE_FAILED',
      `cannot reach ${url}: ${err instanceof Error ? err.message : String(err)} (is the game server running? pnpm dev:server)`,
    );
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : text || res.statusText;
    const lower = msg.toLowerCase();
    if (lower.includes('locked')) throw new HostError('ROOM_LOCKED', msg);
    if (lower.includes('full') || lower.includes('maxclients')) throw new HostError('ROOM_FULL', msg);
    throw new HostError('MATCHMAKE_FAILED', `${res.status}: ${msg}`);
  }
  if (!body || typeof body !== 'object') throw new HostError('MATCHMAKE_FAILED', 'empty matchmaking response');
  return body as Record<string, unknown>;
}

/** `GET /rooms/code/<code>` (apps/game-server routes.ts) → the private room's id. */
export async function roomIdForCode(colyseusHttpUrl: string, code: string): Promise<string> {
  const url = `${colyseusHttpUrl}/rooms/code/${encodeURIComponent(code.trim())}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new HostError('MATCHMAKE_FAILED', `cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) throw new HostError('MATCHMAKE_FAILED', `no room with code "${code}"`);
  const body = (await res.json().catch(() => null)) as { roomId?: unknown } | null;
  if (!res.ok || typeof body?.roomId !== 'string')
    throw new HostError('MATCHMAKE_FAILED', `${res.status}: bad code lookup`);
  return body.roomId;
}

/** `ws://host:2567` → `http://host:2567` (and wss → https); trailing slashes dropped. */
export function toHttpUrl(url: string): string {
  return url
    .trim()
    .replace(/^ws(s?):\/\//i, 'http$1://')
    .replace(/\/+$/, '');
}

/** Same rule as apps/mobile/src/config.ts `toWsUrl`. */
export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}
