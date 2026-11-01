import { View } from 'react-native';
import { timeAgo } from '@/lib/format';
import { useRecentlyPlayedWith } from '@/lib/friends';
import { recentPlayerDetail, type RecentPlayer } from '@/lib/social';
import { FriendButtons } from './friend-button';
import { PersonList, PersonListSkeleton, PersonRow } from './person-row';
import { SectionHeader } from './section-header';

/**
 * Friends screen, "Recently played with": people you shared counted multiplayer matches with in the last 14 days
 * (`recently_played_with`; the server leaves out guests, blocks, bans and players whose "Games played" is hidden from
 * you), most recent first: "Sumo · 2 h ago" under the name and the compact friendship button (Add / Requested / Accept /
 * Friends, optimistic through `useFriendshipAction`). A tap on a row opens the profile. Hidden when there is nobody
 * (or the list cannot be loaded: it is a suggestion, not the screen's content).
 */
export function RecentlyPlayedWith({ people, loading }: { people: RecentPlayer[] | undefined; loading: boolean }) {
  if (loading) {
    return (
      <View className="gap-3">
        <SectionHeader title="Recently played with" className="px-0" />
        <PersonListSkeleton count={2} accessory />
      </View>
    );
  }
  if (!people || people.length === 0) return null;
  return (
    <View className="gap-3">
      <SectionHeader title="Recently played with" detail="Last 14 days" className="px-0" />
      <PersonList
        items={people}
        keyOf={(p) => p.userId}
        render={(p) => (
          <PersonRow
            person={p}
            subtitle={recentPlayerDetail(p, (iso) => timeAgo(iso))}
            accessory={<FriendButtons userId={p.userId} name={`@${p.username}`} status={p.friendship} mode="compact" />}
          />
        )}
      />
    </View>
  );
}

/** The section wired to `recently_played_with`. */
export function RecentlyPlayedWithSection() {
  const recent = useRecentlyPlayedWith();
  return <RecentlyPlayedWith people={recent.isError ? undefined : recent.data} loading={recent.isLoading} />;
}
