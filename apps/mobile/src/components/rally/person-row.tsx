import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { PlayerName } from './cosmetics';
import { PresenceDot } from './presence-dot';
import { ProfileAvatar } from './profile-avatar';
import { RowHighlight } from './row-highlight';

/** Height of a person row: py-2.5 around the 44 pt avatar. Skeleton rows use the same box. */
const ROW_CLASS = 'min-h-16 flex-row items-center gap-3 px-4 py-2.5';

export interface PersonRowData {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/** A player's live status on a row ("Online", "In Sumo"); lib/social.ts `presenceRow`. */
export interface PersonPresence {
  label: string;
  tone: 'online' | 'in_game';
}

/** Open a player's public profile (your own row opens /profile). */
export function openPerson(username: string, self = false) {
  if (self) router.push('/profile');
  else router.push({ pathname: '/u/[username]', params: { username } });
}

/**
 * A player in a list (search results, friends, requests): avatar, display name, @username, optional detail line
 * and a trailing accessory (friendship button, Accept / Decline, Join). Tapping the row opens the profile. With
 * `presence` the second line shows the live status (a dot and "Online" / "In Sumo") in place of `detail`. The player's
 * equipped cosmetics show on the avatar (frame) and the name (colour, badge).
 */
export function PersonRow({
  person,
  detail,
  subtitle,
  presence,
  accessory,
  self = false,
}: {
  person: PersonRowData;
  /** Extra muted text after the @username ("Friends since Oct 2026", "2 h ago"). */
  detail?: string;
  /** Replaces the whole second line (the @username too) when the detail matters more: "Sumo · 2 h ago". */
  subtitle?: string;
  presence?: PersonPresence | null;
  accessory?: ReactNode;
  self?: boolean;
}) {
  const name = person.displayName || person.username;
  return (
    <TapPressable
      accessibilityRole="button"
      accessibilityLabel={
        presence
          ? `${name}, @${person.username}, ${presence.label}`
          : subtitle
            ? `${name}, @${person.username}, ${subtitle}`
            : `${name}, @${person.username}`
      }
      accessibilityHint="Opens the profile"
      onPress={() => openPerson(person.username, self)}
      className={ROW_CLASS}
    >
      {({ pressed }) => (
        <>
          <RowHighlight pressed={pressed} />
          <ProfileAvatar
            userId={person.userId}
            profile={{ username: person.username, display_name: person.displayName, avatar_url: person.avatarUrl }}
            size="md"
          />
          <View className="shrink grow">
            <View className="flex-row items-center gap-2">
              <PlayerName userId={person.userId} name={name} className="text-[15px] font-semibold leading-5" />
              {self && (
                <Badge variant="subtle">
                  <Text>You</Text>
                </Badge>
              )}
            </View>
            {presence ? (
              <View className="flex-row items-center">
                <Text className="text-muted-foreground shrink text-[13px] leading-[18px]" numberOfLines={1}>
                  {`@${person.username} · `}
                </Text>
                <PresenceDot className="mr-1.5" />
                <Text className="text-foreground shrink text-[13px] font-medium leading-[18px]" numberOfLines={1}>
                  {presence.label}
                </Text>
              </View>
            ) : (
              <Text className="text-muted-foreground text-[13px] leading-[18px]" numberOfLines={1}>
                {subtitle ?? (detail ? `@${person.username} · ${detail}` : `@${person.username}`)}
              </Text>
            )}
          </View>
          {accessory}
        </>
      )}
    </TapPressable>
  );
}

/** A card of person rows with inset separators. */
export function PersonList<T>({
  items,
  keyOf,
  render,
  className,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  render: (item: T) => ReactNode;
  className?: string;
}) {
  return (
    <View className={cn('bg-card border-border overflow-hidden rounded-2xl border', className)}>
      {items.map((item, i) => (
        <View key={keyOf(item)}>
          {i > 0 && <Separator className="ml-[72px]" />}
          {render(item)}
        </View>
      ))}
    </View>
  );
}

/** `count` skeleton rows in the same card, same row height as PersonRow. */
export function PersonListSkeleton({ count = 3, accessory = false }: { count?: number; accessory?: boolean }) {
  return (
    <View className="bg-card border-border overflow-hidden rounded-2xl border">
      {Array.from({ length: count }, (_, i) => (
        <View key={i}>
          {i > 0 && <Separator className="ml-[72px]" />}
          <View className={ROW_CLASS}>
            <Skeleton className="size-11 rounded-full" />
            <View className="shrink grow">
              <SkeletonText lineHeight={20} width={i % 2 ? '45%' : '60%'} />
              <SkeletonText lineHeight={18} width={i % 2 ? '30%' : '38%'} />
            </View>
            {accessory && <Skeleton className="h-8 w-[68px] rounded-full" />}
          </View>
        </View>
      ))}
    </View>
  );
}
