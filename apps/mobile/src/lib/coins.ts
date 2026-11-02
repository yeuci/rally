import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/auth/session';
import { pushCoinAward } from '@/lib/coin-toast';
import {
  createBatcher,
  HISTORY_PAGE,
  lookOf,
  nextHistoryCursor,
  parseCoinEvent,
  parseEquipped,
  parseRules,
  parseWallet,
  toCosmeticsMap,
  toLedgerEntries,
  toShopItems,
  type Cosmetics,
  type CosmeticKind,
  type EquippedItems,
  type LedgerEntry,
  type ShopItem,
  type WalletSummary,
} from '@/lib/coins-model';
import { xpByLedgerId } from '@/lib/levels-model';
import { prefs } from '@/lib/prefs';
import { supabase } from '@/lib/supabase';

/**
 * Coins and the shop (20261031000400_coins.sql; docs/coins.md). Coins are earned only server-side (matches, solo runs,
 * achievements, the daily bonus); the app reads the wallet (`my_wallet`), the history (`coin_ledger`, own rows), the
 * shop (`shop_items` + own `user_items` / `equipped_items`), buys and equips through the `buy_item` / `equip_item`
 * RPCs, and reads other players' equipped cosmetics through `public_cosmetics`, batched across every avatar and name
 * on screen. Awards arrive in real time on the `user:<uid>` channel (lib/social-realtime.ts → `handleCoinBroadcast`).
 */
export const coinKeys = {
  all: (uid: string | null) => ['coins', uid] as const,
  wallet: (uid: string | null) => ['coins', uid, 'wallet'] as const,
  history: (uid: string | null) => ['coins', uid, 'history'] as const,
  shop: (uid: string | null) => ['coins', uid, 'shop'] as const,
  /** Another player's (or your own) public look, as `viewer` sees it (blocks hide it). */
  cosmetics: (viewer: string | null, userId: string) => ['cosmetics', viewer, userId] as const,
  cosmeticsAll: () => ['cosmetics'] as const,
};

/** Wallet, history and shop of `uid` (after an award, a purchase, or coming back online). */
export function invalidateCoins(qc: QueryClient, uid: string | null) {
  void qc.invalidateQueries({ queryKey: coinKeys.all(uid) });
}

/**
 * A `coins` broadcast from the database: refresh the wallet and history, and show the "+25 coins" toast unless
 * Settings → Coin popups is off. The wallet's balance is updated at once from the event (it carries the new total).
 */
export function handleCoinBroadcast(qc: QueryClient, uid: string, payload: unknown): void {
  const award = parseCoinEvent(payload);
  if (!award) return;
  qc.setQueryData<WalletSummary>(coinKeys.wallet(uid), (w) => (w ? { ...w, balance: Math.max(w.balance, award.balance) } : w));
  invalidateCoins(qc, uid);
  // Level-up and streak coins are shown by their celebrations (lib/levels.ts, lib/streak.ts), not as a second toast.
  if (prefs.get().coinPopups && award.reason !== 'level' && award.reason !== 'streak') pushCoinAward(award);
}

/** `my_wallet()`: balance, lifetime earnings and today's progress toward the caps. */
export function useWallet() {
  const { userId, signedIn } = useSession();
  return useQuery({
    queryKey: coinKeys.wallet(userId),
    enabled: !!userId && signedIn,
    staleTime: 30_000,
    queryFn: async (): Promise<WalletSummary> => {
      const { data, error } = await supabase.rpc('my_wallet');
      if (error) throw error;
      return parseWallet(data);
    },
  });
}

/** `coin_rules` (public): the live amounts, for the shop's "How to earn". Rarely changes. */
export function useCoinRules() {
  return useQuery({
    queryKey: ['coin-rules'] as const,
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await supabase.from('coin_rules').select('key, value');
      if (error) throw error;
      return parseRules(data);
    },
  });
}

/** A coin history row with the XP that came with the same award (null when none). */
export type HistoryEntry = LedgerEntry & { xp: number | null };

/**
 * The caller's coin history, newest first, a page at a time (keyset on the ledger id), each row with the XP awarded
 * alongside it (`xp_ledger`, same reason and ref; 20261101000100_progress.sql). Without the XP (an older database, a
 * failed read) the history still loads.
 */
export function useCoinHistory() {
  const { userId } = useSession();
  return useInfiniteQuery({
    queryKey: coinKeys.history(userId),
    enabled: !!userId,
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last: HistoryEntry[]) => nextHistoryCursor(last),
    queryFn: async ({ pageParam }): Promise<HistoryEntry[]> => {
      let q = supabase
        .from('coin_ledger')
        .select('id, amount, reason, ref, note, game_id, balance_after, created_at')
        .eq('user_id', userId!)
        .order('id', { ascending: false })
        .limit(HISTORY_PAGE);
      if (pageParam !== undefined) q = q.lt('id', pageParam);
      const { data, error } = await q;
      if (error) throw error;
      const entries = toLedgerEntries(data);
      const refs = [...new Set(data.filter((r) => r.amount > 0).map((r) => r.ref))];
      let xp = new Map<number, number>();
      if (refs.length > 0) {
        const x = await supabase.from('xp_ledger').select('reason, ref, amount').eq('user_id', userId!).in('ref', refs);
        if (!x.error) xp = xpByLedgerId(data, x.data);
      }
      return entries.map((e) => ({ ...e, xp: xp.get(e.id) ?? null }));
    },
  });
}

export interface ShopData {
  items: ShopItem[];
  owned: Set<string>;
  equipped: EquippedItems;
}

/** Items on sale (and retired ones you own), what you own and what you have equipped. */
export function useShop() {
  const { userId } = useSession();
  return useQuery({
    queryKey: coinKeys.shop(userId),
    enabled: !!userId,
    queryFn: async (): Promise<ShopData> => {
      const [items, owned, equipped] = await Promise.all([
        supabase.from('shop_items').select('id, kind, name, description, price, data, available, sort, created_at').order('sort'),
        supabase.from('user_items').select('item_id').eq('user_id', userId!),
        supabase.from('equipped_items').select('kind, item_id').eq('user_id', userId!),
      ]);
      if (items.error) throw items.error;
      if (owned.error) throw owned.error;
      if (equipped.error) throw equipped.error;
      return {
        items: toShopItems(items.data),
        owned: new Set(owned.data.map((r) => r.item_id)),
        equipped: parseEquipped(equipped.data),
      };
    },
  });
}

/** `buy_item`: on success the wallet, shop and history refresh (the balance from the answer at once). */
export function useBuyItem() {
  const { userId } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (itemId: string) => {
      const { data, error } = await supabase.rpc('buy_item', { p_item_id: itemId });
      if (error) throw error;
      const r = (data ?? {}) as { status?: string; balance?: number };
      return { status: r.status === 'owned' ? ('owned' as const) : ('purchased' as const), balance: typeof r.balance === 'number' ? r.balance : null };
    },
    onSuccess: (r, itemId) => {
      qc.setQueryData<ShopData>(coinKeys.shop(userId), (s) => (s ? { ...s, owned: new Set([...s.owned, itemId]) } : s));
      if (r.balance !== null) {
        const balance = r.balance;
        qc.setQueryData<WalletSummary>(coinKeys.wallet(userId), (w) => (w ? { ...w, balance } : w));
      }
    },
    // Also after a refusal: "not enough coins" means the wallet on screen was stale.
    onSettled: () => invalidateCoins(qc, userId),
  });
}

/** `equip_item(kind, item | null)`: the shop and your own public look update at once. */
export function useEquipItem() {
  const { userId } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ kind, itemId }: { kind: CosmeticKind; itemId: string | null }) => {
      const { data, error } = await supabase.rpc('equip_item', { p_kind: kind, p_item_id: itemId ?? undefined });
      if (error) throw error;
      return parseEquipped(data);
    },
    onSuccess: (equipped) => {
      const shop = qc.setQueryData<ShopData>(coinKeys.shop(userId), (s) => (s ? { ...s, equipped } : s));
      if (userId && shop) qc.setQueryData<Cosmetics>(coinKeys.cosmetics(userId, userId), lookOf(shop.items, equipped));
      if (userId) void qc.invalidateQueries({ queryKey: coinKeys.cosmetics(userId, userId) });
    },
  });
}

// --- public cosmetics (batched) ------------------------------------------------------------------------------------

/** Every avatar and name on screen asks for its player; one `public_cosmetics` call per tick serves them all. */
const cosmeticsBatcher = createBatcher<string, Cosmetics>(
  async (ids) => {
    const { data, error } = await supabase.rpc('public_cosmetics', { p_user_ids: ids });
    if (error) throw error;
    return toCosmeticsMap(ids, data);
  },
  { maxBatch: 100 },
);

const COSMETICS_STALE_MS = 5 * 60_000;

/**
 * A player's equipped look (frame, name colour, banner, badge) as the signed-in viewer may see it; `undefined` while
 * loading or without a user id. Used by the shared components (ProfileAvatar, PlayerName, ProfileHeader), never per
 * screen.
 */
export function useCosmetics(userId: string | null | undefined): Cosmetics | undefined {
  const { userId: viewer } = useSession();
  const q = useQuery({
    queryKey: coinKeys.cosmetics(viewer, userId ?? ''),
    enabled: !!userId,
    staleTime: COSMETICS_STALE_MS,
    retry: 1,
    queryFn: async (): Promise<Cosmetics> => (await cosmeticsBatcher.load(userId!)) ?? {},
  });
  return q.data;
}
