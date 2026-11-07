import { router, Stack } from 'expo-router';
import { CircleAlertIcon, MessageCircleIcon } from 'lucide-react-native';
import { useState } from 'react';
import { RefreshControl, ScrollView } from 'react-native';
import { ConversationRow } from '@/components/rally/conversation-row';
import { EmptyState, RetryButton } from '@/components/rally/empty-state';
import { PersonList, PersonListSkeleton } from '@/components/rally/person-row';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { useConversations } from '@/lib/messages';
import { describeSocialError } from '@/lib/social';
import { useColumnPadding, useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';

/**
 * Messages (`/messages`, from the drawer): your conversations (`my_conversations`), newest activity first with the
 * party chat pinned on top, each with the last line, when, and an unread dot. Rows open the thread
 * (`/messages/[id]`). Realtime keeps the list current (lib/messages.ts `handleMessageBroadcast`); pull to refresh
 * reads it again. Conversations start from a friend's profile or the Friends screen (Message), so the empty state
 * points there.
 */
export default function MessagesScreen() {
  const { insets } = useLayout();
  const column = useColumnPadding();
  const palette = usePalette();
  const { userId } = useSession();
  const conversations = useConversations();
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      await conversations.refetch(); // resolves, never throws
    } finally {
      setRefreshing(false);
    }
  }

  const friends = (
    <Button variant="secondary" onPress={() => router.push('/friends')}>
      <Text>Open Friends</Text>
    </Button>
  );

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="gap-6 pt-4"
      contentContainerStyle={[column, { paddingBottom: insets.bottom + 32 }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          tintColor={palette.foreground}
          colors={[palette.foreground]}
          progressBackgroundColor={palette.card}
        />
      }
    >
      <Stack.Screen options={{ title: 'Messages' }} />
      {conversations.isLoading ? (
        <PersonListSkeleton count={5} />
      ) : conversations.isError ? (
        <EmptyState
          icon={CircleAlertIcon}
          title="Couldn't load your messages"
          body={describeSocialError(conversations.error)}
          action={<RetryButton onPress={() => void conversations.refetch()} />}
        />
      ) : !conversations.data || conversations.data.length === 0 ? (
        <EmptyState
          icon={MessageCircleIcon}
          title="No messages yet"
          body="Messages from friends show up here. Tap Message on a friend's profile to start one."
          action={friends}
        />
      ) : (
        <PersonList
          items={conversations.data}
          keyOf={(c) => c.id}
          render={(c) => <ConversationRow conversation={c} uid={userId} />}
        />
      )}
    </ScrollView>
  );
}
