/** Version-prefixed paths never change once published (a new build is a new version), so cache them forever. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** The entry document stays short-lived so a `--force` re-upload of a version propagates within a minute. */
export const ENTRY_CACHE_CONTROL = 'public, max-age=60';

/** Cache-Control for a bundle-relative path; `entry` is the manifest's entry document. */
export function cacheControlFor(relPath: string, entry = 'index.html'): string {
  return relPath === entry ? ENTRY_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL;
}
