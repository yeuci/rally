import { WifiOffIcon } from 'lucide-react-native';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { NetStatus } from './settings';

/**
 * The host's standard connection banner over a running game (from the game's `net.status`): "Reconnecting…" while
 * the game reconnects, "Connection lost" with Leave once it has given up. Small and top-centre, in the menu button's
 * row but never over it (`top` and `inset` come from its rect). Nothing while connected.
 */
export function NetBanner({
  net,
  top,
  inset,
  onLeave,
}: {
  net: NetStatus | null;
  /** The menu button's top. */
  top: number;
  /** Space kept clear on both sides (the menu button and its margin). */
  inset: number;
  onLeave: () => void;
}) {
  if (!net || net.state === 'connected') return null;
  const lost = net.state === 'disconnected';
  return (
    <View style={[styles.row, { top, paddingHorizontal: inset }]} pointerEvents="box-none">
      <Animated.View
        key={net.state}
        entering={FadeIn.duration(200).reduceMotion(ReduceMotion.Never)}
        exiting={FadeOut.duration(200).reduceMotion(ReduceMotion.Never)}
        style={styles.pill}
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
      >
        {lost ? (
          <Icon as={WifiOffIcon} size={15} color="#FCA5A5" />
        ) : (
          <ActivityIndicator size="small" color="#FFFFFF" />
        )}
        <Text className="text-white" style={styles.text}>
          {lost ? 'Connection lost' : 'Reconnecting…'}
        </Text>
        {lost ? (
          <Pressable
            onPress={onLeave}
            accessibilityRole="button"
            accessibilityLabel="Leave the game"
            hitSlop={8}
            style={({ pressed }) => [styles.leave, pressed && styles.pressed]}
          >
            <Text style={styles.leaveText}>Leave</Text>
          </Pressable>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  pill: {
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 14,
    paddingRight: 6,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  text: { fontSize: 14, lineHeight: 18, fontWeight: '600', paddingRight: 8 },
  leave: { height: 26, paddingHorizontal: 12, borderRadius: 13, justifyContent: 'center', backgroundColor: '#FFFFFF' },
  leaveText: { fontSize: 13, lineHeight: 16, fontWeight: '700', color: '#0A0A0A' },
  pressed: { opacity: 0.7 },
});
