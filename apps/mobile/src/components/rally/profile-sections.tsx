import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { ChevronRightIcon, Gamepad2Icon, type LucideIcon } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { View, type TextStyle } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { useCosmetics } from '@/lib/coins';
import { memberSince, playsLabel, timeAgo } from '@/lib/format';
import { toggleHaptic } from '@/lib/haptics';
import { coverUriFor } from '@/lib/game-art';
import { avatarRowCapacity, FRIEND_CELL_WIDTH, ROW_GAP } from '@/lib/layout';
import { levelA11y, type LevelProgress } from '@/lib/levels-model';
import type { Profile } from '@/lib/profile';
import { formatScore, type PublicStats } from '@/lib/progress-format';
import type { FriendSummary, PlayedGame } from '@/lib/social';
import { showToast } from '@/lib/toast';
import { useBoxSize } from '@/lib/use-layout';
import { cn } from '@/lib/utils';
import { PlayerName, ProfileBanner } from './cosmetics';
import { EmptyState, RetryButton } from './empty-state';
import { GameCover } from './game-cover';
import { openPerson } from './person-row';
import { ProfileAvatar, ProfileAvatarSkeleton } from './profile-avatar';
import { HeaderAction, SectionHeader } from './section-header';
import { RowPressable } from './settings-rows';

const TABULAR: TextStyle = { fontVariant: ['tabular-nums'] };

/**
 * Profile identity block shared by /profile and /u/:username: ringed avatar, display name, @username, bio and
 * "Member since Oct 2026". Line boxes have fixed line heights so the skeleton (`profile` undefined) is the same height
 * as the loaded header, give or take the bio. `children` go under it (Edit profile, friendship buttons). A long press
 * on the avatar copies "@username" (toast + haptic).
 *
 * The player's equipped cosmetics (coins shop) show here for everyone who may see them: the banner as a gradient band
 * behind the top half of the avatar (it extends into the screen's top padding, so the layout does not move when it
 * arrives), the frame on the avatar, the name colour and badge on the display name. With `progress` (the account
 * level, when the viewer may see it) the avatar's ring shows the XP into the level with a level badge.
 */
export function ProfileHeader({
  profile: p,
  badge,
  progress,
  children,
}: {
  profile: Profile | null | undefined;
  badge?: string | null;
  /** The player's account level: a progress ring with a level badge on the avatar, and "Level 5" by the join date. */
  progress?: LevelProgress | null;
  children?: ReactNode;
}) {
  const look = useCosmetics(p?.id);
  const outer = 96 + (3 + 4) * 2;
  const since = p ? memberSince(p.created_at) : '';
  const meta = progress ? [`Level ${progress.level}`, since].filter(Boolean).join(' · ') : since;
  return (
    <View className="items-center gap-4">
      {look?.banner ? (
        <ProfileBanner banner={look.banner} className="absolute left-0 right-0" style={{ top: -16, height: outer / 2 + 24 }} />
      ) : null}
      {p ? (
        <TapPressable
          // Long press only: a tap does nothing (no haptic, no pressed state), so the avatar does not look like a button.
          onLongPress={() => void copyHandle(p.username)}
          delayLongPress={350}
          haptic={false}
          accessibilityRole="button"
          accessibilityLabel={`${p.display_name || p.username}, @${p.username}${progress ? `, ${levelA11y(progress)}` : ''}`}
          accessibilityHint="Long press to copy the username"
          accessibilityActions={COPY_ACTIONS}
          onAccessibilityAction={(e) => e.nativeEvent.actionName === 'longpress' && void copyHandle(p.username)}
        >
          <ProfileAvatar profile={p} size="xl" ring badge={badge} progress={progress} />
        </TapPressable>
      ) : (
        <ProfileAvatarSkeleton size="xl" ring />
      )}
      {p ? (
        <View className="items-center">
          <PlayerName
            look={look ?? {}}
            name={p.display_name || p.username}
            className="text-center text-[26px] font-extrabold leading-8 tracking-tight"
            numberOfLines={2}
            badgeSize={22}
            containerClassName="gap-1.5"
          />
          <Text className="text-muted-foreground text-[15px] font-medium leading-6">@{p.username}</Text>
          {/* Quieter than the handle: smaller, dimmed, a hair apart. Same 18 pt box as its skeleton line. */}
          <Text className="text-muted-foreground mt-0.5 text-xs leading-[18px] opacity-75">{meta}</Text>
        </View>
      ) : (
        <View className="items-center">
          <SkeletonText lineHeight={32} width={176} barClassName="rounded-lg" />
          <SkeletonText lineHeight={24} width={104} />
          <SkeletonText lineHeight={18} width={132} className="mt-0.5" />
        </View>
      )}
      {p?.bio ? <Text className="text-secondary-foreground max-w-sm text-center leading-6">{p.bio}</Text> : null}
      {children}
    </View>
  );
}

const COPY_ACTIONS = [{ name: 'longpress', label: 'Copy username' }] as const;

/** "@username" to the clipboard, confirmed by a toast (and a haptic, when on). */
async function copyHandle(username: string) {
  try {
    await Clipboard.setStringAsync(`@${username}`);
    toggleHaptic();
    showToast(`Copied @${username}`);
  } catch {
    showToast("Couldn't copy the username");
  }
}

/** Games played · Achievements · Friends (`public_profile_stats`); Friends is tappable when `onFriendsPress`. */
export function StatsStrip({
  stats,
  loading,
  onFriendsPress,
}: {
  stats: PublicStats | undefined;
  loading: boolean;
  onFriendsPress?: () => void;
}) {
  return (
    <View className="w-full max-w-md flex-row gap-3 self-center">
      <Stat label="Games played" value={stats?.gamesPlayed} loading={loading} />
      <Stat label="Achievements" value={stats?.achievements} loading={loading} />
      <Stat label="Friends" value={stats?.friends} loading={loading} onPress={onFriendsPress} />
    </View>
  );
}

function Stat({
  label,
  value,
  loading,
  onPress,
}: {
  label: string;
  /** null: hidden from this viewer (privacy / block), shown as a dash. */
  value: number | null | undefined;
  loading: boolean;
  onPress?: () => void;
}) {
  const shown = value === null ? '—' : formatScore(value ?? 0);
  const a11y = value === null ? `${label} hidden` : `${value ?? 0} ${label}`;
  const body = (
    <>
      {loading ? (
        <SkeletonText lineHeight={28} width={36} barClassName="rounded-lg" />
      ) : (
        <Text className="text-[22px] font-extrabold leading-7" style={TABULAR}>
          {shown}
        </Text>
      )}
      <Text variant="muted" className="text-[13px] leading-[18px]" numberOfLines={1}>
        {label}
      </Text>
    </>
  );
  const box = 'bg-card border-border flex-1 items-center gap-1 rounded-2xl border px-2 py-3';
  return onPress && !loading ? (
    <TapPressable onPress={onPress} accessibilityRole="button" accessibilityLabel={a11y} className={cn(box, 'active:opacity-70')}>
      {body}
    </TapPressable>
  ) : (
    <View className={box} accessible accessibilityLabel={loading ? undefined : a11y}>
      {body}
    </View>
  );
}

/** Row box shared by a played game and its skeleton (48 pt tile, two text lines). */
const GAME_ROW = 'flex-row items-center gap-3 px-4 py-2.5';

/**
 * "Games played" (`public_profile_games`): icon tile, title, plays and best score, last played. Tapping opens the
 * game page. Other players: shown only when the list is non-empty (privacy returns []). Own profile (`own`): "No games
 * yet" when empty.
 */
export function PlayedGamesSection({
  games,
  loading,
  error,
  own = false,
  limit = 5,
  onRetry,
}: {
  games: PlayedGame[] | undefined;
  loading: boolean;
  error: boolean;
  own?: boolean;
  /** Refetch after an error (the "Couldn't load games" row's Retry). */
  onRetry?: () => void;
  /** Rows shown before "See all" expands the list. */
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!loading && !own && (error || !games || games.length === 0)) return null;
  const list = games ?? [];
  const shown = expanded ? list : list.slice(0, limit);
  return (
    <View className="gap-3">
      <SectionHeader
        title="Games played"
        detail={list.length > 0 ? formatScore(list.length) : undefined}
        className="px-0"
        accessory={
          !loading && list.length > limit ? (
            <HeaderAction label={expanded ? 'Show less' : 'See all'} onPress={() => setExpanded((v) => !v)} />
          ) : undefined
        }
      />
      {loading ? (
        <PlayedGamesSkeleton />
      ) : error ? (
        <EmptyState
          compact
          icon={Gamepad2Icon}
          title="Couldn't load games"
          body="Check your connection and try again."
          action={onRetry ? <RetryButton compact onPress={onRetry} /> : undefined}
        />
      ) : shown.length === 0 ? (
        <EmptyState compact icon={Gamepad2Icon} title="No games yet" body="Games you play show up here." />
      ) : (
        <View className="bg-card border-border overflow-hidden rounded-2xl border">
          {shown.map((g, i) => (
            <View key={g.gameId}>
              {i > 0 && <Separator className="ml-[76px]" />}
              <PlayedGameRow game={g} />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function PlayedGameRow({ game: g }: { game: PlayedGame }) {
  const meta = [playsLabel(g.plays), g.bestScore !== null ? `Best ${formatScore(g.bestScore)}` : null].filter(Boolean).join(' · ');
  const when = timeAgo(g.lastPlayedAt);
  return (
    <TapPressable
      accessibilityRole="button"
      accessibilityLabel={[g.title, meta, when && `last played ${when}`].filter(Boolean).join(', ')}
      onPress={() => router.push({ pathname: '/game/[id]', params: { id: g.gameId } })}
      className={cn(GAME_ROW, 'active:bg-accent')}
    >
      <GameCover id={g.gameId} title={g.title} uri={coverUriFor(g.art, 'tile')} showTitle={false} className="border-border size-12 rounded-xl border" />
      <View className="shrink grow">
        <Text className="text-[15px] font-semibold leading-5" numberOfLines={1}>
          {g.title}
        </Text>
        <Text className="text-muted-foreground text-[13px] leading-[18px]" numberOfLines={1} style={TABULAR}>
          {meta}
        </Text>
      </View>
      {when ? <Text className="text-muted-foreground text-[12px]">{when}</Text> : null}
      <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" />
    </TapPressable>
  );
}

export function PlayedGamesSkeleton({ count = 3 }: { count?: number }) {
  return (
    <View className="bg-card border-border overflow-hidden rounded-2xl border">
      {Array.from({ length: count }, (_, i) => (
        <View key={i}>
          {i > 0 && <Separator className="ml-[76px]" />}
          <View className={GAME_ROW}>
            <Skeleton className="size-12 rounded-xl" />
            <View className="shrink grow">
              <SkeletonText lineHeight={20} width={i % 2 ? '50%' : '64%'} />
              <SkeletonText lineHeight={18} width="36%" />
            </View>
            <Skeleton className="h-3 w-12 rounded-full" />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Avatar (44) + gap + one 16 pt username line. */
const FRIEND_CELL_HEIGHT = 44 + 6 + 16;

/**
 * "Friends" (`public_friends`): one non-scrolling row of avatars, as many as fit the measured width (recomputed on
 * rotation), each opening that profile; "See all" when there are more than fit. Hidden when empty (privacy returns
 * []).
 */
export function FriendsRowSection({
  friends,
  total,
  loading,
  onSeeAll,
}: {
  friends: FriendSummary[] | undefined;
  /** The full count (stats), which can exceed the rows fetched. */
  total: number | undefined;
  loading: boolean;
  onSeeAll: () => void;
}) {
  const box = useBoxSize();
  if (!loading && (!friends || friends.length === 0)) return null;
  const capacity = box.size ? avatarRowCapacity(box.size.width) : 0;
  const list = friends ?? [];
  const shown = list.slice(0, capacity);
  const count = Math.max(total ?? 0, list.length);
  const more = !loading && count > shown.length;
  return (
    <View className="gap-3">
      <SectionHeader
        title="Friends"
        detail={count > 0 ? formatScore(count) : undefined}
        className="px-0"
        accessory={
          more ? (
            <HeaderAction label="See all" accessibilityLabel="See all friends" onPress={onSeeAll} />
          ) : undefined
        }
      />
      <View onLayout={box.onLayout} className="flex-row" style={{ gap: ROW_GAP, height: FRIEND_CELL_HEIGHT }}>
        {loading
          ? Array.from({ length: Math.max(capacity, 1) }, (_, i) => <FriendCellSkeleton key={i} />)
          : shown.map((f) => <FriendCell key={f.userId} friend={f} />)}
      </View>
    </View>
  );
}

function FriendCell({ friend: f }: { friend: FriendSummary }) {
  return (
    <TapPressable
      accessibilityRole="button"
      accessibilityLabel={f.displayName || f.username}
      onPress={() => openPerson(f.username)}
      className="items-center gap-1.5 active:opacity-70"
      style={{ width: FRIEND_CELL_WIDTH }}
    >
      <ProfileAvatar userId={f.userId} profile={{ username: f.username, display_name: f.displayName, avatar_url: f.avatarUrl }} size="md" />
      <PlayerName userId={f.userId} name={f.username} className="text-muted-foreground text-[12px] leading-4" badgeSize={11} containerClassName="gap-0.5" />
    </TapPressable>
  );
}

function FriendCellSkeleton() {
  return (
    <View className="items-center gap-1.5" style={{ width: FRIEND_CELL_WIDTH }}>
      <Skeleton className="size-11 rounded-full" />
      <SkeletonText lineHeight={16} width={44} />
    </View>
  );
}

/** A settings-style row (icon tile, label, value / badge, chevron) used on the own profile. */
export function LinkRow({
  icon,
  label,
  value,
  badge,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  value?: string;
  badge?: string | null;
  onPress: () => void;
}) {
  return (
    <RowPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[label, value, badge && `${badge} new`].filter(Boolean).join(', ')}
    >
      <View className="bg-muted size-9 items-center justify-center rounded-xl">
        <Icon as={icon} className="text-secondary-foreground size-[18px]" />
      </View>
      <Text className="flex-1 text-[15px] font-medium">{label}</Text>
      {badge ? (
        <View className="bg-primary h-6 min-w-6 items-center justify-center rounded-full px-1.5">
          <Text className="text-primary-foreground text-xs font-bold">{badge}</Text>
        </View>
      ) : null}
      {value ? (
        <Text className="text-muted-foreground text-[15px]" style={TABULAR}>
          {value}
        </Text>
      ) : null}
      <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" />
    </RowPressable>
  );
}
