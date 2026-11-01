import { DeviceMotion } from 'expo-sensors';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { SafeAreaFrameContext, SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenFrameContext } from '@/lib/viewport';
import { isTablet } from './orientation';
import { frameFor, turnForDevice, turnInsets, turnsInApp } from './orientation-model';

/**
 * The game's frame on screen: the game host and everything drawn over the game sit inside it.
 *
 * On an iPhone the app never asks iOS to rotate (orientation.ts: every forced rotation in Expo Go left something drawn
 * sideways or laid out for the other orientation). A landscape game is turned inside the app instead: the frame is the
 * game's own landscape box, turned a quarter to fill the portrait screen, toward the side the player holds the phone
 * (device motion; notch on the left until it says otherwise). Nothing outside the game ever changes size.
 *
 * Everything inside reads the frame: `useViewport()` its size and insets, `useSafeAreaInsets()` the turned insets
 * (the notch and home indicator on the frame's sides), and `useScreenTurn()` the turn, for code that moves things by
 * raw touch movement (which arrives in screen axes). Tablets and Android rotate natively, so their frame never turns.
 */

const IN_APP = turnsInApp(Platform.OS, isTablet());

/** The last turn the phone was held at, kept between games (notch on the left by default). */
let heldTurn: 90 | -90 = 90;

/** How the player holds the phone, while `active` (a turned game is on screen). */
function useHeldTurn(active: boolean): 90 | -90 {
  const [turn, setTurn] = useState(heldTurn);
  useEffect(() => {
    if (!active) return;
    let sub: { remove(): void } | null = null;
    try {
      DeviceMotion.setUpdateInterval(250);
      sub = DeviceMotion.addListener((m) => {
        const t = turnForDevice(m.orientation);
        if (t === null) return;
        heldTurn = t;
        setTurn(t);
      });
    } catch {
      // No motion sensor (a simulator): the default turn stays.
    }
    return () => sub?.remove();
  }, [active]);
  return turn;
}

export function GameFrame({
  orientation,
  children,
}: {
  /** The game's orientation (game.json). */
  orientation: 'portrait' | 'landscape' | 'any';
  children: ReactNode;
}) {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wantsTurn = frameFor(window, orientation, IN_APP, 90).turn !== 0;
  const held = useHeldTurn(wantsTurn);
  const frame = frameFor(window, orientation, IN_APP, held);
  const { width, height, left, top, turn } = frame;

  const frameInsets = useMemo(() => turnInsets(insets, turn), [insets, turn]);
  const context = useMemo(
    () => ({
      width,
      height,
      insets: frameInsets,
      turn,
      screen: { width: window.width, height: window.height, insets },
    }),
    [width, height, frameInsets, turn, window.width, window.height, insets],
  );
  const safeFrame = useMemo(() => ({ x: 0, y: 0, width, height }), [width, height]);
  // The same tree whether turned or not (only the style changes), so the game is never remounted.
  const box = useMemo(
    () =>
      turn === 0
        ? StyleSheet.absoluteFill
        : { position: 'absolute' as const, left, top, width, height, transform: [{ rotate: `${turn}deg` }] },
    [turn, left, top, width, height],
  );

  return (
    <View style={styles.screen}>
      {/* Light text on the host's dark chrome; hidden while turned (it would sit along the side). */}
      <StatusBar style="light" hidden={turn !== 0} />
      <View style={box}>
        <ScreenFrameContext.Provider value={context}>
          <SafeAreaFrameContext.Provider value={safeFrame}>
            <SafeAreaInsetsContext.Provider value={frameInsets}>{children}</SafeAreaInsetsContext.Provider>
          </SafeAreaFrameContext.Provider>
        </ScreenFrameContext.Provider>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: '#0A0A0A' } });
