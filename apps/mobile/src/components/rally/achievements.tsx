import { CircleAlertIcon, LockIcon, TrophyIcon } from 'lucide-react-native';
import { View } from 'react-native';
import { EmptyState } from '@/components/rally/empty-state';
import { Image } from '@/components/rally/image';
import { SectionHeader } from '@/components/rally/section-header';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
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
        <Image source={{ uri: icon.uri }} className="absolute inset-0" contentFit="cover" transition={150} />
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
}: {
  tiles: AchievementTile[] | undefined;
  loading: boolean;
  error: boolean;
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
          <View className="flex-row gap-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-32 flex-1 rounded-2xl" />
            ))}
          </View>
        ) : error ? (
          <EmptyState
            compact
            icon={CircleAlertIcon}
            title="Couldn't load achievements"
            body="Pull down to try again."
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
