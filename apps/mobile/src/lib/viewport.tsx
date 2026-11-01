import { useCallback, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';
import { isTablet } from '@/game-host/orientation';
import { usePrefs } from './prefs';

/**
 * The screen: the window's size and the safe-area insets of the nearest SafeAreaProvider. The play route has its own
 * provider (it is a native full-screen modal, turned on its own; the root's provider sits under it and never sees the
 * game's orientation), so the game host reads the insets of the screen it is actually on.
 *
 * Measuring the root view instead (the previous approach) went wrong on iPhone: when the shell turned, the root view
 * stayed one rotation behind the window while the window size was always right. Phones now keep the shell in portrait
 * (game-host/orientation.ts), and the window is the source of truth.
 */

export interface Viewport {
  width: number;
  height: number;
  insets: EdgeInsets;
}

export function useViewport(): Viewport {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return { width, height, insets };
}

/**
 * Dev builds with "Show FPS" on: the window, the root view and the insets side by side (and whether the device counts
 * as a tablet), so one screenshot shows whether anything went stale after a rotation.
 */
export function ScreenReadout() {
  const { showFps } = usePrefs();
  const { width, height, insets } = useViewport();
  const [root, setRoot] = useState<{ width: number; height: number } | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    setRoot((prev) => (prev && prev.width === w && prev.height === h ? prev : { width: w, height: h }));
  }, []);
  if (!__DEV__ || !showFps) return null;
  const rootText = root ? `${fmt(root.width)}×${fmt(root.height)}` : '?';
  return (
    <>
      <View style={StyleSheet.absoluteFill} onLayout={onLayout} pointerEvents="none" />
      <View pointerEvents="none" style={[styles.readout, { bottom: insets.bottom + 4, left: insets.left + 4 }]}>
        <Text style={styles.readoutText}>
          {`${isTablet() ? 'tablet' : 'phone'} · window ${fmt(width)}×${fmt(height)} · root ${rootText}\n`}
          {`insets t${fmt(insets.top)} l${fmt(insets.left)} r${fmt(insets.right)} b${fmt(insets.bottom)}`}
        </Text>
      </View>
    </>
  );
}

const fmt = (n: number) => String(Math.round(n));

const styles = StyleSheet.create({
  readout: {
    position: 'absolute',
    zIndex: 9999,
    elevation: 9999,
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  readoutText: { color: '#FFFFFF', fontSize: 10, lineHeight: 13, fontVariant: ['tabular-nums'] },
});
