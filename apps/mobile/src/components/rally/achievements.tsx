import { CircleAlertIcon, LockIcon, TrophyIcon } from 'lucide-react-native';
import { View } from 'react-native';
import { EmptyState, RetryButton } from '@/components/rally/empty-state';
import { Image } from '@/components/rally/image';
import { SectionHeader } from '@/components/rally/section-header';
import { Icon } from '@/components/ui/icon';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { gridColumns, gridTileWidth, ROW_GAP } from '@/lib/layout';
import { achievementCount, type AchievementIcon, type AchievementTile } from '@/lib/progress-format';
import { useBoxSize } from '@/lib/use-layout';
import { cn } from '@/lib/utils';

/** The achievement's icon (image, emoji or the default trophy) in a rounded tile; locked ones show a lock. */
export function AchievementBadge({
  icon,
  locked,
  size = 44,
}: {
  icon: AchievementIcon;
  locked: boolean;
  size?: number;
}) {
  const glyph = Math.round(size * 0.45);
  return (
    <View
      className={cn(
        'items-center justify-center overflow-hidden rounded-xl border',
        locked ? 'bg-subtle border-subtle-line' : 'bg-fill border-subtle-line',
      )}
      style={{ width: size, height: size }}
    >
      {locked ? (
        <Icon as={LockIcon} className="text-muted-foreground" size={glyph} />
      ) : icon.kind === 'image' ? (
        <Image source={{ uri: icon.uri }} className="absolute inset-0" contentFit="cover" transition={150} placeholderClassName="rounded-xl" />
      ) : icon.kind === 'glyph' ? (
        <Text style={{ fontSize: glyph, lineHeight: Math.round(glyph * 1.25) }}>{icon.text}</Text>
      ) : (
        <Icon as={TrophyIcon} className="text-foreground" size={glyph} />
      )}
    </View>
  );
}

/**
 * Game page achievements: "Achievements 3 / 5" and a grid of tiles (as many ≥130 pt columns as the column fits,
 * measured from its own box so portrait, landscape and rotation all lay out from the real width). Hidden ones read
 * "???" until unlocked. Renders nothing for a game without achievements.
 */
export function AchievementsSection({
  tiles,
  loading,
  error,
  onRetry,
}: {
  tiles: AchievementTile[] | undefined;
  loading: boolean;
  error: boolean;
  onRetry?: () => void;
}) {
  const box = useBoxSize();
  if (!loading && !error && (!tiles || tiles.length === 0)) return null;

  const width = box.size?.width ?? 0;
  const columns = gridColumns(width);
  const tileWidth = width > 0 ? gridTileWidth(width, columns) : 0;

  return (
    <View className="gap-3">
      <SectionHeader
        title="Achievements"
        detail={tiles && tiles.length > 0 ? achievementCount(tiles) : undefined}
        className="px-0"
      />
      <View onLayout={box.onLayout}>
        {loading ? (
          <AchievementGridSkeleton tileWidth={tileWidth} columns={columns} />
        ) : error ? (
          <EmptyState
            compact
            icon={CircleAlertIcon}
            title="Couldn't load achievements"
            body="Check your connection and try again."
            action={onRetry ? <RetryButton compact onPress={onRetry} /> : undefined}
          />
        ) : tileWidth > 0 ? (
          <View className="flex-row flex-wrap" style={{ gap: ROW_GAP }}>
            {tiles!.map((t) => (
              <Tile key={t.id} tile={t} width={tileWidth} />
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function Tile({ tile: t, width }: { tile: AchievementTile; width: number }) {
  return (
    <View
      accessible
      accessibilityLabel={`${t.secret ? 'Hidden achievement' : t.title}, ${t.unlocked ? 'unlocked' : 'locked'}`}
      className={cn('bg-card gap-2.5 rounded-2xl border p-3', t.unlocked ? 'border-subtle-line' : 'border-border')}
      style={{ width }}
    >
      <AchievementBadge icon={t.icon} locked={!t.unlocked} size={40} />
      <View className={cn('gap-0.5', !t.unlocked && 'opacity-60')}>
        <Text className="text-[14px] font-semibold leading-[18px]" numberOfLines={2}>
          {t.title}
        </Text>
        <Text className="text-muted-foreground text-[12px] leading-4" numberOfLines={2}>
          {t.secret ? 'Hidden until unlocked' : t.description || (t.unlocked ? 'Unlocked' : 'Locked')}
        </Text>
      </View>
    </View>
  );
}

/** One row of placeholder tiles with the real tile's box (badge, title line, two description lines). */
function AchievementGridSkeleton({ tileWidth, columns }: { tileWidth: number; columns: number }) {
  if (tileWidth <= 0) return <View style={{ height: TILE_SKELETON_HEIGHT }} />;
  return (
    <View className="flex-row flex-wrap" style={{ gap: ROW_GAP }}>
      {Array.from({ length: columns }, (_, i) => (
        <View key={i} className="bg-card border-border gap-2.5 rounded-2xl border p-3" style={{ width: tileWidth }}>
          <Skeleton className="size-10 rounded-xl" />
          <View className="gap-0.5">
            <SkeletonText lineHeight={18} width="70%" />
            <SkeletonText lineHeight={16} width="90%" />
            <SkeletonText lineHeight={16} width="50%" />
          </View>
        </View>
      ))}
    </View>
  );
}

/** p-3 + 40 badge + gap + 18 + 2 × 16 + gaps + borders. */
const TILE_SKELETON_HEIGHT = 24 + 40 + 10 + 18 + 32 + 4 + 2;

/** The section while the game page itself loads: heading and a row of placeholder tiles (measured like the real grid). */
export function AchievementsSectionSkeleton() {
  const box = useBoxSize();
  const width = box.size?.width ?? 0;
  const columns = gridColumns(width);
  return (
    <View className="gap-3">
      <SkeletonText lineHeight={22} width={124} />
      <View onLayout={box.onLayout}>
        <AchievementGridSkeleton tileWidth={width > 0 ? gridTileWidth(width, columns) : 0} columns={columns} />
      </View>
    </View>
  );
}
