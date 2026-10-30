/** Version-prefixed paths never change once published (a new build is a new version), so cache them forever. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** The entry document stays short-lived so a `--force` re-upload of a version propagates within a minute. */
export const ENTRY_CACHE_CONTROL = 'public, max-age=60';

/** Cache-Control for a bundle-relative path; `entry` is the manifest's entry document. */
export function cacheControlFor(relPath: string, entry = 'index.html'): string {
  return relPath === entry ? ENTRY_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL;
}

/**
 * `--force` guard. Every path except the entry document is cached for a year as immutable, by the CDN and by the
 * WebView, so a re-upload may only add or drop files: a path that already exists in the published version must keep
 * its bytes. Vite's content-hashed assets satisfy this by construction (new bytes, new name); a changed file under a
 * fixed name (`public/` copies, a hand-named chunk) would stay stale on devices that already cached it, and fail SRI
 * if the entry references it. Returns those paths (empty = safe to overwrite).
 */
export function staleUnderForce(
  previous: readonly { path: string; sha256: string }[],
  next: readonly { path: string; sha256: string }[],
  entry = 'index.html',
): string[] {
  const before = new Map(previous.map((f) => [f.path, f.sha256]));
  return next
    .filter((f) => f.path !== entry && before.has(f.path) && before.get(f.path) !== f.sha256)
    .map((f) => f.path)
    .sort();
}
