import { useQuery } from '@tanstack/react-query';
import { checkServerHealth } from '@/lib/dev-env-model';

/**
 * The Developer page's live check of a game server (`/healthz` and `/versions`, lib/dev-env-model.ts): run when shown,
 * again on `refetch()` (the Refresh button) and when the app returns to the foreground. It runs offline too
 * (`networkMode: 'always'`): an unreachable server is exactly what it should report, not a paused query.
 */
export function useServerHealth(url: string) {
  return useQuery({
    queryKey: ['dev', 'server-health', url],
    queryFn: () => checkServerHealth(url, { fetch: (u, init) => fetch(u, init), now: Date.now }),
    networkMode: 'always',
    retry: false,
    staleTime: 0,
    gcTime: 60_000,
  });
}
