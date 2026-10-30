/** "just now", "5 min ago", "3 h ago", "2 d ago", else a short date. */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "Oct 2026" (UTC month, so it does not shift with the device time zone); '' for a missing or bad date. */
export function monthYear(iso: string | null | undefined, locale?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleDateString(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** "Member since Oct 2026" from `profiles.created_at`; '' for a missing or bad date. `locale` is injectable for tests. */
export function memberSince(iso: string | null | undefined, locale?: string): string {
  const when = monthYear(iso, locale);
  return when ? `Member since ${when}` : '';
}

/** "3 plays", "1 play". */
export function playsLabel(n: number): string {
  const plays = Math.max(0, Math.floor(n));
  return `${plays} ${plays === 1 ? 'play' : 'plays'}`;
}
