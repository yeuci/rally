import { CircleAlertIcon } from 'lucide-react-native';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';
import { config } from '@/config';
import { roomByCode } from '@/game-host/matchmake';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { checkJoinCode, codeCells, codeInputValue, formatJoinCode, spokenJoinCode } from '@/lib/join-code-input';
import { JOIN_CODE_LENGTH, type JoinTarget } from '@/lib/join-target';
import { useKeyboardAppearance, usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';
import { BottomSheet } from './bottom-sheet';

type RoomTarget = Extract<JoinTarget, { join: 'room' }>;

/**
 * "Join with code" (m3-phase2 §1): six cells limited to the code alphabet (upper-cased, shown `K7M-2PQ`; pasting a
 * message with a code in it works). The code is looked up (`GET /rooms/code/<CODE>`) before anything launches: a
 * code for another room type says "That code is for another game". A found room → `onJoin({ join: 'room', room,
 * code })`, which the caller hands to `useLaunchGame`. The lookup runs by itself once the sixth symbol is typed.
 */
export function JoinCodeSheet({
  open,
  onClose,
  gameTitle,
  roomName,
  onJoin,
}: {
  open: boolean;
  onClose: () => void;
  gameTitle: string;
  /** `manifest.server.room`: codes for other room types are refused. */
  roomName: string;
  /** A room was found: the caller closes the sheet and launches (`useLaunchGame`). */
  onJoin: (target: RoomTarget) => void;
}) {
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Join with code"
      description={`Enter the code from a private ${gameTitle} room.`}
    >
      {/* Mounted per opening: every opening starts empty. */}
      {open ? <CodeForm roomName={roomName} onJoin={onJoin} /> : null}
    </BottomSheet>
  );
}

function CodeForm({ roomName, onJoin }: { roomName: string; onJoin: (target: RoomTarget) => void }) {
  const palette = usePalette();
  const keyboardAppearance = useKeyboardAppearance();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const lookup = useRef<AbortController | null>(null);
  const [value, setValue] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(true);

  // Closing the sheet mid-lookup drops the request (and its answer).
  useEffect(() => () => lookup.current?.abort(), []);

  async function check(code: string) {
    if (checking) return;
    lookup.current?.abort();
    const abort = new AbortController();
    lookup.current = abort;
    setChecking(true);
    setError(null);
    const res = await checkJoinCode(code, roomName, (c) => roomByCode(config.colyseusUrl, c, { signal: abort.signal }));
    if (abort.signal.aborted) return;
    setChecking(false);
    if (res.ok) onJoin(res.target);
    else setError(res.message);
  }

  function onChangeText(text: string) {
    const next = codeInputValue(text);
    if (next === value) return;
    setValue(next);
    setError(null);
    if (next.length === JOIN_CODE_LENGTH) void check(next);
  }

  const complete = value.length === JOIN_CODE_LENGTH;
  const cells = codeCells(value);

  return (
    <View className="gap-4">
      <Pressable onPress={() => input.current?.focus()} accessible={false} className="items-center">
        <View
          className="flex-row items-center gap-2"
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
        >
          {cells.map((cell, i) => (
            <View key={i} className="flex-row items-center gap-2">
              {i === 3 && <Text className="text-muted-foreground text-2xl font-bold">-</Text>}
              <View
                className={cn(
                  'bg-card border-border h-14 w-11 items-center justify-center rounded-xl border',
                  cell.active && focused && 'border-ring bg-field-focus',
                  error && 'border-destructive',
                )}
              >
                <Text className="text-2xl font-bold">{cell.char}</Text>
              </View>
            </View>
          ))}
        </View>
        {/* The real field: invisible over the cells, so taps, the keyboard, paste and autofill all go to it. */}
        <TextInput
          ref={input}
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSubmitEditing={() => complete && void check(value)}
          autoFocus
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          textContentType="none"
          importantForAutofill="no"
          returnKeyType="join"
          caretHidden
          keyboardAppearance={keyboardAppearance}
          contextMenuHidden={false}
          editable={!checking}
          accessibilityLabel="Room code"
          accessibilityHint="Six letters and numbers"
          accessibilityValue={{ text: value ? spokenJoinCode(value) : 'empty' }}
          className="absolute bottom-0 left-0 right-0 top-0 text-transparent opacity-0"
        />
      </Pressable>

      {error ? (
        <View className="flex-row items-center justify-center gap-1.5 px-2" accessibilityLiveRegion="polite">
          <Icon as={CircleAlertIcon} className="text-destructive size-4" />
          <Text className="text-destructive shrink text-center text-sm">{error}</Text>
        </View>
      ) : (
        <Text className="text-muted-foreground text-center text-sm">
          {complete ? formatJoinCode(value) : 'Letters and numbers, like K7M-2PQ'}
        </Text>
      )}

      <Button size="lg" className="h-14 rounded-2xl" disabled={!complete || checking} onPress={() => void check(value)}>
        {checking ? <ActivityIndicator color={palette.primaryForeground} /> : null}
        <Text className="text-[17px] font-bold">{checking ? 'Checking…' : 'Join room'}</Text>
      </Button>
    </View>
  );
}
