/** Recent searches: the list's rules and the stored JSON's parser (pure; unit-tested). The store is use-recent-searches.ts. */

export const RECENT_SEARCHES_MAX = 8;

/** Trimmed, inner whitespace collapsed; a bare "@" (the people-only prefix) is not a search. */
function clean(query: string): string {
  const q = query.trim().replace(/\s+/g, ' ');
  return q === '@' ? '' : q;
}

const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** `query` moved (or added) to the front, case-insensitive duplicates dropped, at most `max` kept. */
export function addRecentSearch(list: readonly string[], query: string, max = RECENT_SEARCHES_MAX): string[] {
  const q = clean(query);
  if (!q) return [...list];
  return [q, ...list.filter((item) => !same(item, q))].slice(0, max);
}

/** `query` removed (case-insensitive). */
export function removeRecentSearch(list: readonly string[], query: string): string[] {
  return list.filter((item) => !same(item, query));
}

/** The stored JSON array → a clean list (strings only, trimmed, no duplicates, at most `max`); [] when unreadable. */
export function parseRecentSearches(raw: string | null, max = RECENT_SEARCHES_MAX): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const q = clean(item);
      if (q && !out.some((o) => same(o, q))) out.push(q);
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  }
}
