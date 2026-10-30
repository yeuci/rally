/** Case- and accent-insensitive match on title and genres (client-side search for M1). Pure; unit-tested. */
export function searchGames<T extends { title: string; genres: readonly string[] }>(games: readonly T[], query: string): T[] {
  const q = fold(query.trim());
  if (!q) return [];
  return games.filter((g) => fold(g.title).includes(q) || g.genres.some((genre) => fold(genre).includes(q)));
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Local filter for a list of players (your friends): case- and accent-insensitive on the username and display name;
 * a leading "@" is ignored. An empty query keeps everyone. Pure; unit-tested.
 */
export function filterPeople<T extends { username: string; displayName: string | null }>(people: readonly T[], query: string): T[] {
  const q = fold(query.trim().replace(/^@+/, ''));
  if (!q) return [...people];
  return people.filter((p) => fold(p.username).includes(q) || (!!p.displayName && fold(p.displayName).includes(q)));
}
