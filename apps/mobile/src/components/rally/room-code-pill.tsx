import { ShareIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, Share, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { tapHaptic } from '@/lib/haptics';
import { formatJoinCode, ROOM_CODE_PILL_MS, roomCodeShareMessage, spokenJoinCode } from '@/lib/join-code-input';

/**
 * "Room code K7M-2PQ · Share" over a running multiplayer game (play route), centred under the safe area: shown when
 * a join knows the private room's code (`onJoined` in game-host/handlers.ts), fades out after `ROOM_CODE_PILL_MS`.
 * Tapping it opens the native share sheet. Dark glass with white type: it sits on the game, not on the page. Key it on
 * the code so a different room shows it again.
 */
export function RoomCodePill({ code, gameTitle }: { code: string; gameTitle: string }) {
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), ROOM_CODE_PILL_MS);
    return () => clearTimeout(timer);
  }, []);

  const shown = formatJoinCode(code);
  const share = () => {
    tapHaptic();
    Share.share({ message: roomCodeShareMessage(gameTitle, code) }).catch(() => {});
  };

  // The container stays mounted so the pill's exiting fade can run.
  return (
    <View
      className="absolute left-0 right-0 items-center"
      style={{ top: Math.max(insets.top, 8) + 4, paddingLeft: insets.left + 56, paddingRight: insets.right + 56 }}
      pointerEvents="box-none"
    >
      {visible && (
        <Animated.View entering={FadeIn.duration(250)} exiting={FadeOut.duration(500)}>
          <Pressable
            onPress={share}
            accessibilityRole="button"
            accessibilityLabel={`Room code ${spokenJoinCode(code)}`}
            accessibilityHint="Shares the code"
            hitSlop={6}
            className="flex-row items-center gap-2 rounded-full border border-white/20 bg-black/65 py-2 pl-3.5 pr-3 active:opacity-70"
          >
            <Text className="text-[13px] font-medium text-white/75">Room code</Text>
            <Text className="font-mono text-[15px] font-bold tracking-wider text-white">{shown}</Text>
            <Text className="text-[13px] text-white/50">·</Text>
            <Icon as={ShareIcon} className="size-3.5 text-white" />
            <Text className="text-[13px] font-semibold text-white">Share</Text>
          </Pressable>
        </Animated.View>
      )}
    </View>
  );
}
