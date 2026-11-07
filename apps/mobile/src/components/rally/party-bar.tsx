import { router, usePathname } from 'expo-router';
import { ChevronRightIcon, CrownIcon } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown, ReduceMotion } from 'react-native-reanimated';
import { Icon } from '@/components/ui/icon';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { useParty } from '@/lib/party';
import {
  isLeader,
  orderedMembers,
  PARTY_BAR_AVATARS,
  PARTY_BAR_HEIGHT,
  PARTY_BAR_MARGIN,
  partyBarInset,
  partyBarLabel,
  partyBarVisible,
  type PartyMember,
} from '@/lib/party-model';
import { useViewport } from '@/lib/viewport';
import { ProfileAvatar } from './profile-avatar';

/** How far each stacked avatar overlaps the one before it. */
const STACK_OVERLAP = 10;
const AVATAR = 36;

/**
 * Bottom padding a scrolling screen adds while the party bar floats over its end (the dashboard, Friends, Browse,
 * Friend activity, the game page's sticky actions): the bar's height plus its margin, 0 without a party or where the
 * bar hides (lib/party-model.ts `partyBarVisible`).
 */
export function usePartyBarInset(): number {
  const party = useParty();
  const pathname = usePathname();
  return partyBarInset(partyBarVisible(party.data, pathname));
}

/**
 * The party bar (docs/social-phase.md §5): a floating pill above the home indicator while the signed-in user is in a
 * party: the members' avatars stacked (the leader first, with a crown), "Party · 3" and a chevron. A tap opens
 * `/party`. Mounted in `(app)/_layout.tsx` over the stack (so it stays through navigation); hidden on game screens
 * (the play route is a native modal above the shell anyway) and on the party screen itself. Width-limited on wide
 * windows, like the sheets.
 */
export function PartyBar() {
  const { userId } = useSession();
  const party = useParty();
  const pathname = usePathname();
  const { insets } = useViewport();
  const p = party.data;
  const visible = partyBarVisible(p, pathname);
  return (
    <View
      className="absolute bottom-0 left-0 right-0 items-center"
      style={{
        paddingBottom: Math.max(insets.bottom, PARTY_BAR_MARGIN),
        paddingLeft: insets.left + 16,
        paddingRight: insets.right + 16,
      }}
      pointerEvents="box-none"
    >
      {p && visible ? (
        <Animated.View
          entering={FadeInDown.duration(220).reduceMotion(ReduceMotion.System)}
          exiting={FadeOutDown.duration(180).reduceMotion(ReduceMotion.System)}
          style={styles.column}
        >
          <TapPressable
            accessibilityRole="button"
            accessibilityLabel={`${partyBarLabel(p.members.length)}${isLeader(p, userId) ? ', you lead it' : ''}`}
            accessibilityHint="Opens the party"
            onPress={() => router.push('/party')}
            className="bg-card border-border flex-row items-center gap-3 rounded-full border pl-2 pr-3 shadow-lg shadow-black/20 active:opacity-70"
            style={{ height: PARTY_BAR_HEIGHT }}
          >
            <AvatarStack members={orderedMembers(p)} leaderId={p.leader_id} />
            <Text className="shrink grow text-[15px] font-semibold leading-5" numberOfLines={1}>
              {partyBarLabel(p.members.length)}
            </Text>
            <Icon as={ChevronRightIcon} className="text-muted-foreground size-5" />
          </TapPressable>
        </Animated.View>
      ) : null}
    </View>
  );
}

/** The first few members' avatars, overlapping; the leader (first) wears a small crown. */
function AvatarStack({ members, leaderId }: { members: PartyMember[]; leaderId: string }) {
  const shown = members.slice(0, PARTY_BAR_AVATARS);
  const width = AVATAR + Math.max(0, shown.length - 1) * (AVATAR - STACK_OVERLAP);
  return (
    <View style={{ width, height: AVATAR }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {shown.map((m, i) => (
        <View
          key={m.user_id}
          className="bg-card absolute rounded-full p-[2px]"
          style={{ left: i * (AVATAR - STACK_OVERLAP), zIndex: shown.length - i }}
        >
          <ProfileAvatar
            userId={m.user_id}
            profile={{ username: m.username, display_name: m.display_name, avatar_url: m.avatar_url }}
            size="sm"
          />
          {m.user_id === leaderId ? (
            <View className="bg-card absolute -right-0.5 -top-0.5 rounded-full p-[2px]">
              <Icon as={CrownIcon} className="text-gold size-3" />
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({ column: { width: '100%', maxWidth: 448 } });
