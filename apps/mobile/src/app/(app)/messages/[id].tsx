import { Stack, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { ArrowUpIcon, BellOffIcon, CircleAlertIcon, EllipsisIcon, MessageCircleIcon } from 'lucide-react-native';
import { useCallback, useMemo, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, View } from 'react-native';
import { EmptyState, RetryButton } from '@/components/rally/empty-state';
import { openPerson } from '@/components/rally/person-row';
import { ReportSheet, type ReportTarget } from '@/components/rally/report-sheet';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { Textarea } from '@/components/ui/textarea';
import { useSession } from '@/lib/auth/session';
import { timeAgo } from '@/lib/format';
import { tapHaptic } from '@/lib/haptics';
import { useLayout } from '@/lib/use-layout';
import {
  useConversation,
  useDeleteMessage,
  useMarkRead,
  useSendMessage,
  useSenderProfiles,
  useSetConversationMuted,
  useThread,
  useThreadScreenMarker,
} from '@/lib/messages';
import {
  canSend,
  composeBody,
  conversationTitle,
  MESSAGE_MAX_LENGTH,
  messageActions,
  otherSenderIds,
  remainingLabel,
  showsSender,
  showsTimestamp,
  type Conversation,
  type Message,
} from '@/lib/messages-model';
import { describeSocialError } from '@/lib/social';
import { GUTTER } from '@/lib/layout';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';

/** Widest a bubble gets on a wide window (a chat line should not run across a tablet). */
const BUBBLE_MAX_WIDTH = 440;

/**
 * A conversation (`/messages/[id]`): the thread (`conversation_messages`, newest first in an inverted list, older
 * pages as you scroll up) and a composer (1000 characters, Send). The header shows the other person (tap → their
 * profile) or "Party chat", with Mute / Unmute in ⋯. Your messages sit on the right; in party chat the others' carry
 * their name. Long-press a message: Delete (your own) or Report (someone else's, the report sheet with the message).
 * The conversation is marked read when the screen is focused and on every message that arrives while it is
 * (lib/messages.ts `useThreadScreenMarker` + `handleMessageBroadcast`). Deleted messages keep their place as
 * "Message deleted".
 */
export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useSession();
  const { insets, width } = useLayout();
  const palette = usePalette();
  const headerHeight = useHeaderHeight();
  const focused = useIsFocused();
  const conversation = useConversation(id);
  const kind = conversation?.kind ?? 'dm';
  const thread = useThread(id);
  const send = useSendMessage(id ?? '', kind);
  const remove = useDeleteMessage(id ?? '');
  const setMuted = useSetConversationMuted(id ?? '');
  const markRead = useMarkRead(id);
  const [text, setText] = useState('');
  const [reporting, setReporting] = useState<ReportTarget | null>(null);

  useThreadScreenMarker(id, focused);
  // On focus (opened, or back from a profile): what was unread is read now.
  useFocusEffect(
    useCallback(() => {
      markRead();
    }, [markRead]),
  );

  const messages = useMemo(() => thread.data?.pages.flat() ?? [], [thread.data]);
  const senderIds = useMemo(() => (kind === 'party' ? otherSenderIds(messages, userId) : []), [kind, messages, userId]);
  const senders = useSenderProfiles(senderIds);
  const title = conversationTitle(conversation);
  const other = conversation?.other ?? null;

  function submit() {
    const body = composeBody(text);
    if (!canSend(body) || !id) return;
    tapHaptic();
    setText('');
    send.mutate(body, {
      // The text comes back on failure so it can be fixed and sent again (the toast says why).
      onError: () => setText((t) => (t ? t : body)),
    });
  }

  function nameOf(m: Message): string {
    if (!m.senderId) return 'Someone';
    if (other && m.senderId === other.userId) return `@${other.username}`;
    const p = senders.data?.get(m.senderId);
    return p ? `@${p.username}` : 'Someone';
  }

  function longPress(m: Message) {
    const actions = messageActions(m, userId);
    if (actions.length === 0) return;
    const items = actions.map((a) =>
      a === 'delete'
        ? { label: 'Delete', destructive: true, run: () => remove.mutate(m.id) }
        : {
            label: `Report ${nameOf(m)}`,
            destructive: true,
            run: () =>
              m.senderId &&
              setReporting({
                userId: m.senderId,
                name: nameOf(m),
                messageId: m.id,
                friendship: kind === 'dm' ? 'friends' : null,
              }),
          },
    );
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...items.map((it) => it.label), 'Cancel'],
          destructiveButtonIndex: items.flatMap((it, i) => (it.destructive ? [i] : [])),
          cancelButtonIndex: items.length,
        },
        (i) => items[i]?.run(),
      );
    } else {
      Alert.alert('Message', undefined, [
        { text: 'Cancel', style: 'cancel' },
        ...items.map((it) => ({ text: it.label, style: 'destructive' as const, onPress: it.run })),
      ]);
    }
  }

  function openMenu() {
    if (!conversation) return;
    const label = conversation.muted ? 'Unmute' : 'Mute';
    const run = () => setMuted.mutate(!conversation.muted);
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [label, 'Cancel'], cancelButtonIndex: 1 },
        (i) => i === 0 && run(),
      );
    } else {
      Alert.alert(title, undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: label, onPress: run },
      ]);
    }
  }

  const header = (
    <Stack.Screen
      options={{
        title,
        headerTitle: () => (
          <TapPressable
            onPress={() => other && openPerson(other.username)}
            disabled={!other}
            accessibilityRole={other ? 'button' : 'header'}
            accessibilityLabel={title}
            accessibilityHint={other ? 'Opens the profile' : undefined}
            className="flex-row items-center gap-1.5 active:opacity-70"
          >
            <Text className="text-[17px] font-semibold" numberOfLines={1}>
              {title}
            </Text>
            {conversation?.muted ? <Icon as={BellOffIcon} className="text-muted-foreground size-4" /> : null}
          </TapPressable>
        ),
        headerRight: conversation
          ? () => (
              <TapPressable
                onPress={openMenu}
                accessibilityRole="button"
                accessibilityLabel="More"
                hitSlop={10}
                className="active:opacity-70"
              >
                <Icon as={EllipsisIcon} className="text-foreground size-6" />
              </TapPressable>
            )
          : undefined,
      }}
    />
  );

  const bubbleMax = Math.min(BUBBLE_MAX_WIDTH, Math.round((width - insets.left - insets.right) * 0.8));
  const sideInsets = { paddingLeft: insets.left + GUTTER, paddingRight: insets.right + GUTTER };
  const sending = send.isPending;
  const remaining = remainingLabel(text);

  return (
    <KeyboardAvoidingView
      className="bg-background flex-1"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={headerHeight}
    >
      {header}
      {thread.isLoading ? (
        <ThreadSkeleton style={sideInsets} />
      ) : thread.isError ? (
        <View className="flex-1 justify-center" style={sideInsets}>
          <EmptyState
            icon={CircleAlertIcon}
            title="Couldn't load this conversation"
            body={describeSocialError(thread.error)}
            action={<RetryButton onPress={() => void thread.refetch()} />}
          />
        </View>
      ) : (
        <FlatList
          data={messages}
          inverted
          keyExtractor={(m) => m.id}
          className="flex-1"
          contentContainerStyle={[
            sideInsets,
            { paddingTop: 12, paddingBottom: 12, flexGrow: 1, justifyContent: 'flex-end' },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onEndReached={() => {
            if (thread.hasNextPage && !thread.isFetchingNextPage) void thread.fetchNextPage();
          }}
          onEndReachedThreshold={0.6}
          ListFooterComponent={
            thread.isFetchingNextPage ? (
              <View className="items-center py-3">
                <ActivityIndicator color={palette.foreground} />
              </View>
            ) : undefined
          }
          ListEmptyComponent={
            <View className="flex-1 items-center justify-center gap-2 py-10" style={{ transform: [{ scaleY: -1 }] }}>
              <Icon as={MessageCircleIcon} className="text-muted-foreground size-7" />
              <Text variant="muted" className="text-center">
                {kind === 'party'
                  ? 'Say hi to your party.'
                  : `Say hi to ${other ? other.displayName || `@${other.username}` : 'your friend'}.`}
              </Text>
            </View>
          }
          renderItem={({ item: m, index }) => (
            <Bubble
              message={m}
              own={m.senderId === userId}
              name={showsSender(messages, index, userId, kind) ? nameOf(m) : null}
              timestamp={showsTimestamp(messages, index) ? timeAgo(m.createdAt) : null}
              maxWidth={bubbleMax}
              onLongPress={() => longPress(m)}
            />
          )}
        />
      )}
      <Composer
        value={text}
        onChangeText={setText}
        onSend={submit}
        canSend={canSend(text, sending) && !!id}
        sending={sending}
        remaining={remaining}
        bottom={insets.bottom}
        style={sideInsets}
        conversation={conversation}
      />
      <ReportSheet target={reporting} onClose={() => setReporting(null)} />
    </KeyboardAvoidingView>
  );
}

/** One message: your own on the right in the primary colour, the others' on the left in a card. */
function Bubble({
  message: m,
  own,
  name,
  timestamp,
  maxWidth,
  onLongPress,
}: {
  message: Message;
  own: boolean;
  /** The sender's handle above the bubble (party chat, the first of a run); null to show none. */
  name: string | null;
  /** A time label above this message (after a gap); null to show none. */
  timestamp: string | null;
  maxWidth: number;
  onLongPress: () => void;
}) {
  const deleted = m.deleted;
  return (
    <View className={cn('mb-1.5', own ? 'items-end' : 'items-start')}>
      {timestamp ? (
        <Text className="text-muted-foreground w-full py-2 text-center text-[12px]" accessibilityRole="text">
          {timestamp}
        </Text>
      ) : null}
      {name ? (
        <Text className="text-muted-foreground mb-0.5 ml-3 text-[12px] font-medium" numberOfLines={1}>
          {name}
        </Text>
      ) : null}
      <TapPressable
        onLongPress={onLongPress}
        delayLongPress={350}
        haptic={false}
        accessibilityRole="text"
        accessibilityLabel={deleted ? 'Message deleted' : `${own ? 'You' : (name ?? 'They')}: ${m.body}`}
        accessibilityHint={deleted || m.pending ? undefined : 'Long press for options'}
        style={{ maxWidth }}
        className={cn(
          'rounded-2xl px-3.5 py-2',
          own ? 'bg-primary rounded-br-md' : 'bg-card border-border rounded-bl-md border',
          m.pending && 'opacity-60',
          deleted && 'bg-transparent border-border border',
        )}
      >
        <Text
          className={cn(
            'text-[15px] leading-[21px]',
            own && !deleted ? 'text-primary-foreground' : 'text-foreground',
            deleted && 'text-muted-foreground italic',
          )}
          selectable={!deleted}
        >
          {deleted ? 'Message deleted' : m.body}
        </Text>
      </TapPressable>
    </View>
  );
}

/**
 * The composer: a growing field (up to five lines, 1000 characters, the count shows over the last hundred) and the
 * round Send button, above the home indicator. Enter adds a line; Send sends.
 */
function Composer({
  value,
  onChangeText,
  onSend,
  canSend: enabled,
  sending,
  remaining,
  bottom,
  style,
  conversation,
}: {
  value: string;
  onChangeText: (t: string) => void;
  onSend: () => void;
  canSend: boolean;
  sending: boolean;
  remaining: string | null;
  bottom: number;
  style: { paddingLeft: number; paddingRight: number };
  conversation: Conversation | null;
}) {
  const palette = usePalette();
  const placeholder =
    conversation?.kind === 'party'
      ? 'Message your party'
      : conversation?.other
        ? `Message @${conversation.other.username}`
        : 'Message';
  return (
    <View className="border-border border-t pt-2" style={[style, { paddingBottom: Math.max(bottom, 8) }]}>
      <View className="flex-row items-end gap-2">
        <Textarea
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          maxLength={MESSAGE_MAX_LENGTH}
          numberOfLines={5}
          className="max-h-32 min-h-11 flex-1 rounded-[22px] px-4 py-2.5 leading-5"
          accessibilityLabel="Message"
          returnKeyType="default"
          blurOnSubmit={false}
        />
        <TapPressable
          onPress={onSend}
          disabled={!enabled}
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !enabled }}
          className={cn(
            'size-11 items-center justify-center rounded-full',
            enabled ? 'bg-primary active:opacity-70' : 'bg-secondary opacity-60',
          )}
        >
          {sending ? (
            <ActivityIndicator size="small" color={palette.primaryForeground} />
          ) : (
            <Icon
              as={ArrowUpIcon}
              className={cn('size-5', enabled ? 'text-primary-foreground' : 'text-muted-foreground')}
            />
          )}
        </TapPressable>
      </View>
      {remaining ? (
        <Text className="text-muted-foreground pt-1 text-right text-[12px]" style={{ fontVariant: ['tabular-nums'] }}>
          {remaining}
        </Text>
      ) : null}
    </View>
  );
}

/** A few bubbles' worth of placeholder while the first page loads (bottom-aligned, like the thread). */
function ThreadSkeleton({ style }: { style: { paddingLeft: number; paddingRight: number } }) {
  return (
    <View className="flex-1 justify-end gap-2 pb-3" style={style}>
      {[
        { own: false, w: '58%' },
        { own: true, w: '42%' },
        { own: false, w: '70%' },
        { own: false, w: '36%' },
        { own: true, w: '52%' },
      ].map((b, i) => (
        <View key={i} className={b.own ? 'items-end' : 'items-start'}>
          <Skeleton
            className={cn('h-10 rounded-2xl', b.own ? 'rounded-br-md' : 'rounded-bl-md')}
            style={{ width: b.w as `${number}%` }}
          />
        </View>
      ))}
    </View>
  );
}
