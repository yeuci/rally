import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import {
  SafeAreaFrameContext,
  SafeAreaInsetsContext,
  useSafeAreaInsets,
  type EdgeInsets,
} from 'react-native-safe-area-context';
import { isTablet } from '@/game-host/orientation';
import { screenToFrame, type Turn } from '@/game-host/orientation-model';
import { usePrefs } from './prefs';

/**
 * The screen: the window's size and the safe-area insets of the nearest SafeAreaProvider; inside a game, the game's
 * frame (which an iPhone may show turned a quarter, game-host/game-frame.tsx). The play route has its own provider (a
 * native full-screen modal; the root's provider sits under it), so the game host reads the screen it is actually on.
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

/**
 * Inside a game's frame (game-host/game-frame.tsx): the frame's own size and insets, its quarter turn when an iPhone
 * shows a landscape game turned inside the portrait app, and the screen it sits on. Null everywhere else.
 */
export const ScreenFrameContext = createContext<(Viewport & { turn: Turn; screen: Viewport }) | null>(null);

export function useViewport(): Viewport {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const frame = useContext(ScreenFrameContext);
  if (frame) return frame;
  return { width: window.width, height: window.height, insets };
}

/**
 * How far the surrounding game frame is turned (0 outside a game, or when it is not turned). Touch movement arrives in
 * screen axes: code that drags things by `dx`/`dy` converts with `screenToFrame` (game-host/orientation-model.ts).
 */
export function useScreenTurn(): Turn {
  return useContext(ScreenFrameContext)?.turn ?? 0;
}

/**
 * The content of a native layer over a game (a React Native Modal, such as a bottom sheet): iOS presents it upright on
 * the screen, never turned with the game's frame, so inside it the screen's own size and insets apply again.
 */
export function UnturnedLayer({ children }: { children: ReactNode }) {
  const frame = useContext(ScreenFrameContext);
  // The contexts, not the hooks: those throw without a provider, and outside a game this only passes them through.
  const insets = useContext(SafeAreaInsetsContext);
  const safeFrame = useContext(SafeAreaFrameContext);
  const screen = frame?.screen;
  const rect = useMemo(
    () => (screen ? { x: 0, y: 0, width: screen.width, height: screen.height } : safeFrame),
    [screen, safeFrame],
  );
  return (
    <ScreenFrameContext.Provider value={null}>
      <SafeAreaFrameContext.Provider value={rect}>
        <SafeAreaInsetsContext.Provider value={screen ? screen.insets : insets}>
          {children}
        </SafeAreaInsetsContext.Provider>
      </SafeAreaFrameContext.Provider>
    </ScreenFrameContext.Provider>
  );
}

/**
 * A stable function turning a screen-axes movement (a responder's `dx`/`dy`, `vx`/`vy`, or a `pageX`/`pageY`
 * difference) into the surrounding frame's axes; the identity outside a turned game frame.
 */
export function useScreenToFrame(): (dx: number, dy: number) => { dx: number; dy: number } {
  const turn = useScreenTurn();
  const latest = useRef(turn);
  useEffect(() => {
    latest.current = turn;
  }, [turn]);
  return useCallback((dx: number, dy: number) => screenToFrame(dx, dy, latest.current), []);
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
