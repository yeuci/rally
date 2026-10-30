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

const COUNT_UNITS = [
  { size: 1_000_000_000, suffix: 'B' },
  { size: 1_000_000, suffix: 'M' },
  { size: 1_000, suffix: 'K' },
] as const;

/**
 * Compact count, Roblox style: 950 → "950", 12_400 → "12.4K", 3_100_000 → "3.1M", 1_000 → "1K". One decimal at most,
 * rounded down (a count never reads higher than it is, and 999_999 stays "999.9K" instead of "1000K"). Locale
 * independent (Hermes' compact notation varies by platform). Negative, fractional or non-finite input: floored to a
 * whole count ≥ 0.
 */
export function formatCount(n: number): string {
  const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  for (const { size, suffix } of COUNT_UNITS) {
    if (count < size) continue;
    // Tenths of the unit in integer math (12_400 / 100 = 124 → "12.4"), so no float rounding creeps in.
    const tenths = Math.floor(count / (size / 10));
    const whole = Math.floor(tenths / 10);
    const decimal = tenths % 10;
    return `${whole}${decimal ? `.${decimal}` : ''}${suffix}`;
  }
  return String(count);
}

/** "12.4K visits", "1 visit", "0 visits" (`games.visits`). */
export function visitsLabel(n: number): string {
  const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return `${formatCount(count)} ${count === 1 ? 'visit' : 'visits'}`;
}
