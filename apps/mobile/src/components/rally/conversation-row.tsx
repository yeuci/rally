import { router } from 'expo-router';
import { PartyPopperIcon } from 'lucide-react-native';
import { View } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { timeAgo } from '@/lib/format';
import { conversationPreview, conversationTitle, type Conversation } from '@/lib/messages-model';
import { cn } from '@/lib/utils';
import { PlayerName } from './cosmetics';
import { ProfileAvatar } from './profile-avatar';
import { RowHighlight } from './row-highlight';

/** The same box as PersonRow (py-2.5 around the 44 pt avatar), so the list's skeleton fits. */
const ROW_CLASS = 'min-h-16 flex-row items-center gap-3 px-4 py-2.5';

/** Open a conversation's thread. */
export function openConversation(conversationId: string) {
  router.push({ pathname: '/messages/[id]', params: { id: conversationId } });
}

/**
 * A conversation in the Messages list: the other person's avatar and name (party chat: the party icon and "Party
 * chat"), the last line ("You: …", "Message deleted"), when, and an unread dot with a bold line while unread. Muted
 * conversations show their line in the muted colour even when unread. Tapping the row opens the thread.
 */
export function ConversationRow({ conversation: c, uid }: { conversation: Conversation; uid: string | null }) {
  const title = conversationTitle(c);
  const preview = conversationPreview(c, uid);
  const when = c.last ? timeAgo(c.last.at) : '';
  const unread = c.unread > 0 && !c.muted;
  return (
    <TapPressable
      accessibilityRole="button"
      accessibilityLabel={[title, unread ? `${c.unread} unread` : null, preview, when].filter(Boolean).join(', ')}
      accessibilityHint="Opens the conversation"
      onPress={() => openConversation(c.id)}
      className={ROW_CLASS}
    >
      {({ pressed }) => (
        <>
          <RowHighlight pressed={pressed} />
          {c.kind === 'party' || !c.other ? (
            <View className="bg-subtle border-subtle-line size-11 items-center justify-center rounded-full border">
              <Icon as={PartyPopperIcon} className="text-foreground size-5" />
            </View>
          ) : (
            <ProfileAvatar
              userId={c.other.userId}
              profile={{ username: c.other.username, display_name: c.other.displayName, avatar_url: c.other.avatarUrl }}
              size="md"
            />
          )}
          <View className="shrink grow">
            <View className="flex-row items-center gap-2">
              {c.other ? (
                <PlayerName
                  userId={c.other.userId}
                  name={title}
                  className="shrink text-[15px] font-semibold leading-5"
                />
              ) : (
                <Text className="shrink text-[15px] font-semibold leading-5" numberOfLines={1}>
                  {title}
                </Text>
              )}
              {when ? (
                <Text className="text-muted-foreground ml-auto text-[12px] leading-4" numberOfLines={1}>
                  {when}
                </Text>
              ) : null}
            </View>
            <Text
              className={cn(
                'text-[13px] leading-[18px]',
                unread ? 'text-foreground font-medium' : 'text-muted-foreground',
              )}
              numberOfLines={1}
            >
              {c.muted ? `${preview} · Muted` : preview}
            </Text>
          </View>
          {unread ? (
            <View
              className="bg-primary size-2.5 rounded-full"
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
          ) : null}
        </>
      )}
    </TapPressable>
  );
}
