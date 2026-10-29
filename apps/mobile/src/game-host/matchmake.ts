import { HostError } from './bridge';

/**
 * Host-side matchmaking against Colyseus's built-in HTTP routes (architecture §5).
 * M0: no auth header. M3 adds `Authorization: Bearer <supabase jwt>`.
 */
export async function matchmake(
  colyseusHttpUrl: string,
  method: 'joinOrCreate' | 'join' | 'create' | 'joinById',
  roomNameOrId: string,
  options: Record<string, unknown> = {},
  accessToken?: string,
): Promise<Record<string, unknown>> {
  const url = `${colyseusHttpUrl}/matchmake/${method}/${encodeURIComponent(roomNameOrId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(options),
    });
  } catch (err) {
    throw new HostError('MATCHMAKE_FAILED', `cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
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
