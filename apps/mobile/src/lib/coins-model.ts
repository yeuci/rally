/**
 * Pure rules behind coins and the shop (lib/coins.ts, lib/coin-toast.ts, the Shop and Coin history screens, the
 * cosmetics drawn on avatars and names): parsing what the database returns, ledger labels, the "+25 coins" toast's
 * merging, the shop's sections and item states, and the batching of public cosmetics reads. No React Native imports:
 * test/coins.test.ts runs them under plain Node. Economy rules live in the database (20261031000400_coins.sql,
 * docs/coins.md); nothing here decides an amount.
 */
import type { CoinReason, CosmeticKind, EquippedItems, WalletSummary } from '@rally/db';

export type { CoinReason, CosmeticKind, EquippedItems, WalletSummary } from '@rally/db';

const HEX = /^#[0-9A-Fa-f]{6}$/;
const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// --- amounts -------------------------------------------------------------------------------------------------------

/** "1,250" (grouped, whole coins). */
export function formatCoins(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Number.isFinite(n) ? n : 0);
}

/** "+25" for an award, "−250" (a real minus sign) for a purchase. */
export function signedCoins(n: number, locale?: string): string {
  return n < 0 ? `−${formatCoins(-n, locale)}` : `+${formatCoins(n, locale)}`;
}

/** "1 coin", "25 coins". */
export function coinsLabel(n: number, locale?: string): string {
  return `${formatCoins(n, locale)} ${Math.abs(n) === 1 ? 'coin' : 'coins'}`;
}

// --- wallet --------------------------------------------------------------------------------------------------------

export const EMPTY_WALLET: WalletSummary = {
  balance: 0,
  lifetime_earned: 0,
  daily_claimed: false,
  solo_today: 0,
  solo_cap: 0,
  match_today: 0,
  match_cap: 0,
};

/** `my_wallet()` → summary; anything missing or malformed reads as 0 / false. */
export function parseWallet(raw: unknown): WalletSummary {
  const o = obj(raw) ?? {};
  return {
    balance: Math.max(0, num(o.balance) ?? 0),
    lifetime_earned: Math.max(0, num(o.lifetime_earned) ?? 0),
    daily_claimed: o.daily_claimed === true,
    solo_today: num(o.solo_today) ?? 0,
    solo_cap: num(o.solo_cap) ?? 0,
    match_today: num(o.match_today) ?? 0,
    match_cap: num(o.match_cap) ?? 0,
  };
}

/** `coin_rules` rows → { key: value } (non-numbers dropped). */
export function parseRules(rows: readonly unknown[] | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const raw of rows ?? []) {
    const r = obj(raw);
    const key = str(r?.key);
    const value = num(r?.value);
    if (key && value !== null) out[key] = value;
  }
  return out;
}

/**
 * The shop's "How to earn" lines from the live rules (so tuning a rule in the database changes the copy too). A rule
 * that is missing or 0 is left out.
 */
export function earnLines(rules: Record<string, number>): { label: string; value: string }[] {
  const r = (k: string) => rules[k] ?? 0;
  const lines: { label: string; value: string }[] = [];
  if (r('match') > 0) lines.push({ label: 'Each multiplayer match', value: `+${formatCoins(r('match'))}` });
  if (r('win') > 0) lines.push({ label: 'Winning a match', value: `+${formatCoins(r('win'))}` });
  if (r('podium') > 0) {
    const min = r('podium_min_players');
    lines.push({ label: min > 1 ? `2nd or 3rd of ${min}+ players` : '2nd or 3rd place', value: `+${formatCoins(r('podium'))}` });
  }
  if (r('solo') > 0) {
    const cap = r('solo_daily_cap');
    lines.push({ label: cap > 0 ? `Each solo run (up to ${formatCoins(cap)} a day)` : 'Each solo run', value: `+${formatCoins(r('solo'))}` });
  }
  if (r('achievement') > 0) lines.push({ label: 'Each new achievement', value: `+${formatCoins(r('achievement'))}` });
  if (r('daily') > 0) lines.push({ label: 'First game of the day', value: `+${formatCoins(r('daily'))}` });
  return lines;
}

// --- reasons and the ledger ----------------------------------------------------------------------------------------

/** What each ledger reason is called in the app (toast, history). */
export const REASON_LABELS: Record<CoinReason, string> = {
  match: 'Match',
  win: 'Win',
  podium: 'Podium',
  achievement: 'Achievement',
  solo: 'Solo run',
  daily: 'Daily bonus',
  purchase: 'Purchase',
  adjustment: 'Bonus',
  level: 'Level up',
  challenge: 'Daily challenge',
};

const REASONS = Object.keys(REASON_LABELS) as CoinReason[];
export function isCoinReason(v: unknown): v is CoinReason {
  return typeof v === 'string' && (REASONS as string[]).includes(v);
}

export function reasonLabel(reason: string): string {
  return isCoinReason(reason) ? REASON_LABELS[reason] : 'Coins';
}

/** A coin_ledger row as the history screen uses it. */
export interface LedgerEntry {
  id: number;
  amount: number;
  reason: CoinReason;
  note: string | null;
  gameId: string | null;
  balanceAfter: number;
  createdAt: string;
}

/** coin_ledger rows (newest first) → entries; malformed rows are dropped. */
export function toLedgerEntries(rows: readonly unknown[] | null | undefined): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const raw of rows ?? []) {
    const r = obj(raw);
    const id = num(r?.id);
    const amount = num(r?.amount);
    if (!r || id === null || amount === null || amount === 0 || !isCoinReason(r.reason)) continue;
    out.push({
      id,
      amount,
      reason: r.reason,
      note: str(r.note),
      gameId: str(r.game_id),
      balanceAfter: num(r.balance_after) ?? 0,
      createdAt: str(r.created_at) ?? new Date(0).toISOString(),
    });
  }
  return out;
}

/** The history row's two lines: "Win" / "Sumo", "Purchase" / "Ember", "Daily bonus" / null. */
export function ledgerTitle(e: Pick<LedgerEntry, 'reason' | 'note'>): { title: string; detail: string | null } {
  return { title: REASON_LABELS[e.reason], detail: e.note };
}

/** Rows per history page; the next page starts below the last id seen (ids only grow). */
export const HISTORY_PAGE = 30;

export function nextHistoryCursor(page: readonly LedgerEntry[]): number | undefined {
  return page.length < HISTORY_PAGE ? undefined : page[page.length - 1]?.id;
}

// --- Realtime awards and the toast ---------------------------------------------------------------------------------

/** The database's `coins` broadcast on `user:<uid>` (one per award; purchases are never announced). */
export interface CoinAward {
  id: number;
  amount: number;
  reason: Exclude<CoinReason, 'purchase'>;
  balance: number;
  note: string | null;
  at: string;
}

/** A broadcast payload (or `{ payload }`) → award; null when malformed, not positive, or a purchase. */
export function parseCoinEvent(raw: unknown): CoinAward | null {
  const outer = obj(raw);
  const v = obj(outer?.payload) ?? outer;
  if (!v || v.type !== 'coins') return null;
  const id = num(v.id);
  const amount = num(v.amount);
  if (id === null || amount === null || amount <= 0 || !isCoinReason(v.reason) || v.reason === 'purchase') return null;
  return {
    id,
    amount,
    reason: v.reason,
    balance: Math.max(0, num(v.balance) ?? 0),
    note: str(v.note),
    at: str(v.at) ?? new Date(0).toISOString(),
  };
}

/** One toast on screen: awards that arrive close together add up ("+85 coins · Win · Daily bonus"). */
export interface CoinToast {
  /** Bumped whenever the toast changes, so the host restarts its timer. */
  key: number;
  amount: number;
  /** Distinct labels in arrival order. */
  reasons: string[];
  /** Ledger ids already counted (a repeated broadcast adds nothing). */
  ids: number[];
  /** When the last award joined it (epoch ms). */
  updatedAt: number;
}

/** How long a toast stays up after its last award, and the window in which a new award joins it. */
export const COIN_TOAST_MS = 3200;

/**
 * Adds `award` to the toast on screen if it is still up (within COIN_TOAST_MS of its last award), else starts a new
 * one. A ledger id already counted changes nothing (returns `current` itself).
 */
export function mergeCoinToast(current: CoinToast | null, award: CoinAward, now: number, seq: number): CoinToast {
  const live = current && now - current.updatedAt < COIN_TOAST_MS ? current : null;
  if (live?.ids.includes(award.id)) return live;
  const label = REASON_LABELS[award.reason];
  if (!live) return { key: seq, amount: award.amount, reasons: [label], ids: [award.id], updatedAt: now };
  return {
    key: seq,
    amount: live.amount + award.amount,
    reasons: live.reasons.includes(label) ? live.reasons : [...live.reasons, label],
    ids: [...live.ids.slice(-31), award.id],
    updatedAt: now,
  };
}

/** The toast's lines: "+85 coins" and "Win · Daily bonus". */
export function coinToastText(t: Pick<CoinToast, 'amount' | 'reasons'>): { amount: string; reasons: string } {
  return { amount: `+${coinsLabel(t.amount)}`, reasons: t.reasons.join(' · ') };
}

// --- cosmetics -----------------------------------------------------------------------------------------------------

export interface NameColor {
  color: string;
  /** The colour on the light theme (falls back to `color`). */
  light: string;
}
export interface FrameStyle {
  colors: string[];
}
export interface BannerStyle {
  colors: string[];
}
export interface BadgeStyle {
  icon: string;
  color: string;
  light: string;
}

/** A player's equipped look, as drawn by the shared components (avatar frame, name colour, banner, badge). */
export interface Cosmetics {
  nameColor?: NameColor;
  frame?: FrameStyle;
  banner?: BannerStyle;
  badge?: BadgeStyle;
}

export const COSMETIC_KINDS: readonly CosmeticKind[] = ['name_color', 'avatar_frame', 'profile_banner', 'badge'];
export function isCosmeticKind(v: unknown): v is CosmeticKind {
  return typeof v === 'string' && (COSMETIC_KINDS as readonly string[]).includes(v);
}

const colorList = (v: unknown, min: number, max: number): string[] | null =>
  Array.isArray(v) && v.length >= min && v.length <= max && v.every(isHex) ? (v as string[]) : null;

/** One item's `data` → the style for its kind; null when the data does not fit (the item is then not drawn). */
export function parseCosmeticData(kind: 'name_color', data: unknown): NameColor | null;
export function parseCosmeticData(kind: 'avatar_frame', data: unknown): FrameStyle | null;
export function parseCosmeticData(kind: 'profile_banner', data: unknown): BannerStyle | null;
export function parseCosmeticData(kind: 'badge', data: unknown): BadgeStyle | null;
export function parseCosmeticData(kind: string, data: unknown): NameColor | FrameStyle | BannerStyle | BadgeStyle | null;
export function parseCosmeticData(kind: string, data: unknown): NameColor | FrameStyle | BannerStyle | BadgeStyle | null {
  const d = obj(data);
  if (!d) return null;
  switch (kind) {
    case 'name_color':
      return isHex(d.color) ? { color: d.color, light: isHex(d.light) ? d.light : d.color } : null;
    case 'badge':
      return isHex(d.color) && typeof d.icon === 'string' && /^[a-z][a-z0-9-]{1,31}$/.test(d.icon)
        ? { icon: d.icon, color: d.color, light: isHex(d.light) ? d.light : d.color }
        : null;
    case 'avatar_frame': {
      const colors = colorList(d.colors, 1, 4);
      return colors ? { colors } : null;
    }
    case 'profile_banner': {
      const colors = colorList(d.colors, 2, 3);
      return colors ? { colors } : null;
    }
    default:
      return null;
  }
}

/** Adds one equipped item to a look (unknown kinds and bad data leave it unchanged). */
export function withCosmetic(look: Cosmetics, kind: string, data: unknown): Cosmetics {
  switch (kind) {
    case 'name_color': {
      const v = parseCosmeticData('name_color', data);
      return v ? { ...look, nameColor: v } : look;
    }
    case 'avatar_frame': {
      const v = parseCosmeticData('avatar_frame', data);
      return v ? { ...look, frame: v } : look;
    }
    case 'profile_banner': {
      const v = parseCosmeticData('profile_banner', data);
      return v ? { ...look, banner: v } : look;
    }
    case 'badge': {
      const v = parseCosmeticData('badge', data);
      return v ? { ...look, badge: v } : look;
    }
    default:
      return look;
  }
}

/**
 * `public_cosmetics` rows → each requested user's look. Every requested id gets an entry (empty when the user has
 * nothing equipped, is hidden by a block, or is unknown), so a batch caches "nothing" too.
 */
export function toCosmeticsMap(ids: readonly string[], rows: readonly unknown[] | null | undefined): Map<string, Cosmetics> {
  const map = new Map<string, Cosmetics>(ids.map((id) => [id, {}]));
  for (const raw of rows ?? []) {
    const r = obj(raw);
    const uid = str(r?.user_id);
    if (!r || !uid || !map.has(uid)) continue;
    map.set(uid, withCosmetic(map.get(uid)!, String(r.kind), r.data));
  }
  return map;
}

/** The colour to draw for the active theme. */
export function themedColor(c: { color: string; light: string } | undefined, theme: 'light' | 'dark'): string | undefined {
  if (!c) return undefined;
  return theme === 'light' ? c.light : c.color;
}

/** Evenly spaced stops for a frame or banner gradient (a single colour is a solid ring). */
export function gradientStops(colors: readonly string[]): { offset: number; color: string }[] {
  if (colors.length === 0) return [];
  if (colors.length === 1) return [{ offset: 0, color: colors[0]! }, { offset: 1, color: colors[0]! }];
  return colors.map((color, i) => ({ offset: i / (colors.length - 1), color }));
}

// --- shop ----------------------------------------------------------------------------------------------------------

/** A shop item as the app uses it (only the cosmetic kinds the app can draw; game unlocks are not shown in v1). */
export interface ShopItem {
  id: string;
  kind: CosmeticKind;
  name: string;
  description: string;
  price: number;
  data: unknown;
  available: boolean;
  sort: number;
}

/** shop_items rows → items the app can show: known cosmetic kinds with drawable data. */
export function toShopItems(rows: readonly unknown[] | null | undefined): ShopItem[] {
  const out: ShopItem[] = [];
  for (const raw of rows ?? []) {
    const r = obj(raw);
    const id = str(r?.id);
    const price = num(r?.price);
    if (!r || !id || price === null || !isCosmeticKind(r.kind) || !parseCosmeticData(r.kind, r.data)) continue;
    out.push({
      id,
      kind: r.kind,
      name: str(r.name) ?? id,
      description: typeof r.description === 'string' ? r.description : '',
      price,
      data: r.data,
      available: r.available !== false,
      sort: num(r.sort) ?? 0,
    });
  }
  return out;
}

export const KIND_TITLES: Record<CosmeticKind, string> = {
  name_color: 'Name colours',
  avatar_frame: 'Avatar frames',
  profile_banner: 'Profile banners',
  badge: 'Badges',
};

/** The singular, for the item sheet ("Avatar frame · 250 coins"). */
export const KIND_NAMES: Record<CosmeticKind, string> = {
  name_color: 'Name colour',
  avatar_frame: 'Avatar frame',
  profile_banner: 'Profile banner',
  badge: 'Badge',
};

/**
 * Where an item stands for the caller:
 * - `equipped`: owned and in its slot;
 * - `owned`: owned, not equipped;
 * - `buyable`: on sale and affordable;
 * - `short`: on sale, not enough coins.
 */
export type ItemState = 'equipped' | 'owned' | 'buyable' | 'short';

export function itemState(item: Pick<ShopItem, 'id' | 'kind' | 'price'>, owned: ReadonlySet<string>, equipped: EquippedItems, balance: number): ItemState {
  if (equipped[item.kind] === item.id) return 'equipped';
  if (owned.has(item.id)) return 'owned';
  return balance >= item.price ? 'buyable' : 'short';
}

/** Coins still missing for an item (0 when affordable). */
export function shortfall(price: number, balance: number): number {
  return Math.max(0, price - Math.max(0, balance));
}

export interface ShopSection {
  kind: CosmeticKind;
  title: string;
  items: { item: ShopItem; state: ItemState }[];
}

/**
 * The shop's sections in a fixed order (name colours, frames, banners, badges), each sorted by `sort`, price, id.
 * Retired items appear only when owned (the database already hides the others). Empty sections are dropped.
 */
export function shopSections(items: readonly ShopItem[], owned: ReadonlySet<string>, equipped: EquippedItems, balance: number): ShopSection[] {
  return COSMETIC_KINDS.map((kind) => ({
    kind,
    title: KIND_TITLES[kind],
    items: items
      .filter((i) => i.kind === kind && (i.available || owned.has(i.id)))
      .sort((a, b) => a.sort - b.sort || a.price - b.price || a.id.localeCompare(b.id))
      .map((item) => ({ item, state: itemState(item, owned, equipped, balance) })),
  })).filter((s) => s.items.length > 0);
}

/** Shop tiles per row for a content width: 2 on phones, 3 from 520 pt, 4 from 760 pt. */
export function shopColumns(contentWidth: number): number {
  return contentWidth >= 760 ? 4 : contentWidth >= 520 ? 3 : 2;
}

/** A tile's width for `columns` tiles separated by `gap` in `contentWidth`. */
export function shopTileWidth(contentWidth: number, columns: number, gap = 12): number {
  return Math.max(0, Math.floor((contentWidth - gap * (columns - 1)) / columns));
}

/** `equip_item` / `equipped_items` rows → { kind: item id }. */
export function parseEquipped(raw: unknown): EquippedItems {
  const out: EquippedItems = {};
  if (Array.isArray(raw)) {
    for (const r of raw) {
      const o = obj(r);
      if (o && isCosmeticKind(o.kind) && typeof o.item_id === 'string') out[o.kind] = o.item_id;
    }
    return out;
  }
  const o = obj(raw) ?? {};
  for (const k of COSMETIC_KINDS) if (typeof o[k] === 'string') out[k] = o[k] as string;
  return out;
}

/** The look a set of equipped items gives (for your own previews: the shop shows you with the item on). */
export function lookOf(items: readonly ShopItem[], equipped: EquippedItems): Cosmetics {
  let look: Cosmetics = {};
  for (const kind of COSMETIC_KINDS) {
    const item = items.find((i) => i.id === equipped[kind]);
    if (item) look = withCosmetic(look, kind, item.data);
  }
  return look;
}

/** What a purchase or equip failure means for the UI. */
export type ShopErrorKind = 'insufficient' | 'not_found' | 'rate_limited' | 'network' | 'other';

export function shopErrorKind(err: unknown): ShopErrorKind {
  const message = (err as { message?: unknown } | null)?.message;
  const m = typeof message === 'string' ? message : '';
  if (m.startsWith('INSUFFICIENT_FUNDS')) return 'insufficient';
  if (m.startsWith('NOT_FOUND')) return 'not_found';
  if (m.startsWith('RATE_LIMITED')) return 'rate_limited';
  if (/network|fetch|timed? ?out|offline/i.test(m)) return 'network';
  return 'other';
}

export function shopErrorText(kind: ShopErrorKind): string {
  switch (kind) {
    case 'insufficient':
      return "You don't have enough coins for this yet.";
    case 'not_found':
      return 'This item is no longer in the shop.';
    case 'rate_limited':
      return 'Too many changes at once. Try again in a moment.';
    case 'network':
      return "Couldn't reach Rally. Check your connection and try again.";
    default:
      return 'Something went wrong. Try again.';
  }
}

// --- batching ------------------------------------------------------------------------------------------------------

/**
 * Collects the keys asked for in one tick and fetches them together (a leaderboard's or friends list's rows each ask
 * for their own player's cosmetics; this makes that one request). `fetchMany` gets at most `maxBatch` distinct keys
 * per call and returns a map; a key missing from it resolves to `undefined`. A failed fetch rejects every waiter of
 * that batch. `schedule` is injected for tests (default: a 0 ms timer).
 */
export function createBatcher<K, V>(
  fetchMany: (keys: K[]) => Promise<Map<K, V>>,
  { maxBatch = 100, schedule = (fn: () => void) => void setTimeout(fn, 0) }: { maxBatch?: number; schedule?: (fn: () => void) => void } = {},
) {
  let pending = new Map<K, { resolve: (v: V | undefined) => void; reject: (e: unknown) => void }[]>();
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const batch = pending;
    pending = new Map();
    const keys = [...batch.keys()];
    for (let i = 0; i < keys.length; i += maxBatch) {
      const chunk = keys.slice(i, i + maxBatch);
      fetchMany(chunk).then(
        (map) => {
          for (const k of chunk) for (const w of batch.get(k) ?? []) w.resolve(map.get(k));
        },
        (err: unknown) => {
          for (const k of chunk) for (const w of batch.get(k) ?? []) w.reject(err);
        },
      );
    }
  };

  return {
    load(key: K): Promise<V | undefined> {
      return new Promise((resolve, reject) => {
        const waiters = pending.get(key);
        if (waiters) waiters.push({ resolve, reject });
        else pending.set(key, [{ resolve, reject }]);
        if (!scheduled) {
          scheduled = true;
          schedule(flush);
        }
      });
    },
  };
}
