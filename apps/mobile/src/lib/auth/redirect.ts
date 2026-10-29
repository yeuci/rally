/**
 * Parses an auth redirect (`rally://auth/callback?sb_flow_id=…&code=…` or `…#error=…&error_description=…`).
 * Pure, unit-tested. GoTrue puts PKCE codes in the query and errors in either the query or the fragment;
 * `sb_flow_id` is the PKCE flow id auth-js appends to `redirectTo` (`appendPkceFlowIdToRedirects`).
 */
export interface AuthRedirect {
  code: string | null;
  /** Selects the code verifier of the flow that produced this redirect (`exchangeCodeForSession(code, { flowId })`). */
  flowId: string | null;
  error: string | null;
  errorCode: string | null;
  errorDescription: string | null;
}

export function parseAuthRedirect(url: string): AuthRedirect {
  const params = new Map<string, string>();
  const hashAt = url.indexOf('#');
  const queryAt = url.indexOf('?');
  const query = queryAt >= 0 ? url.slice(queryAt + 1, hashAt > queryAt ? hashAt : undefined) : '';
  const fragment = hashAt >= 0 ? url.slice(hashAt + 1) : '';
  for (const chunk of [query, fragment]) {
    for (const pair of chunk.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = decode(eq >= 0 ? pair.slice(0, eq) : pair);
      const v = decode(eq >= 0 ? pair.slice(eq + 1) : '');
      if (!params.has(k)) params.set(k, v);
    }
  }
  return {
    code: params.get('code') || null,
    flowId: params.get('sb_flow_id') || null,
    error: params.get('error') || null,
    errorCode: params.get('error_code') || null,
    errorDescription: params.get('error_description') || null,
  };
}

/** True when a deep link path is one of the auth redirect routes (`auth/callback`, `auth/reset-password`). */
export function isAuthRedirectPath(path: string): boolean {
  return /(^|\/)auth\/(callback|reset-password)(\?|#|$)/.test(path.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '/'));
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}
