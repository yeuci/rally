import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { SPLASH } from '@/lib/brand';
import { LogoMark } from './logo';

/** Once per JS runtime (cold start): a remounted root (Android activity recreation) or a foreground skips it. */
let played = false;

/** True until the intro has played in this run; read it once when the root layout mounts. */
export function introPending(): boolean {
  return !played;
}

// Timeline (ms from the native splash being hidden). One full turn, eased in and out, so the mark comes back upright
// (never resting upside down); the zoom starts while the turn is still coming in, so it rushes closer as it settles,
// then fills the screen and fades into the app.
const LEAD = 32;
const SPIN = { degrees: 360, duration: 700 };
const ZOOM = { start: 520, duration: 450, scale: 14 };
const FADE = { duration: 260 }; // Reduce Motion: a plain cross-fade
const NEVER = ReduceMotion.Never; // Reduce Motion is handled explicitly below

/**
 * Cold-start intro. Mounts in the root layout on top of the first screen, drawing the native splash exactly (same
 * white mark at `SPLASH.imageWidth`, centred in the window on `SPLASH.backgroundColor`, whatever the theme). Once it
 * has laid out and a frame has passed, it hides the native splash (no visible change), turns the mark once around,
 * zooms it ~14× as the turn lands while it and the background fade, revealing the page, then unmounts. Blocks touches
 * only while it runs (≈ 1 s).
 */
export function IntroOverlay() {
  const reduceMotion = useReducedMotion();
  const [done, setDone] = useState(false);
  const started = useRef(false);
  const rotate = useSharedValue(0);
  const scale = useSharedValue(1);
  const markOpacity = useSharedValue(1);
  const backdropOpacity = useSharedValue(1);

  useEffect(() => {
    played = true;
    // Safety net: whatever happens to layout or the animation, never keep the splash or block the app.
    const t = setTimeout(() => {
      void SplashScreen.hideAsync().catch(() => {});
      setDone(true);
    }, 2500);
    return () => clearTimeout(t);
  }, []);

  const markStyle = useAnimatedStyle(() => ({
    opacity: markOpacity.value,
    transform: [{ rotate: `${rotate.value}deg` }, { scale: scale.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdropOpacity.value }));

  function run() {
    const finish = () => setDone(true);
    if (reduceMotion) {
      markOpacity.set(withTiming(0, { duration: FADE.duration, reduceMotion: NEVER }));
      backdropOpacity.set(
        withTiming(0, { duration: FADE.duration, reduceMotion: NEVER }, () => {
          scheduleOnRN(finish);
        }),
      );
      return;
    }
    rotate.set(
      withDelay(
        LEAD,
        withTiming(SPIN.degrees, { duration: SPIN.duration, easing: Easing.inOut(Easing.cubic), reduceMotion: NEVER }),
        NEVER,
      ),
    );
    scale.set(
      withDelay(LEAD + ZOOM.start, withTiming(ZOOM.scale, { duration: ZOOM.duration, easing: Easing.in(Easing.cubic), reduceMotion: NEVER }), NEVER),
    );
    markOpacity.set(
      withDelay(LEAD + ZOOM.start + 120, withTiming(0, { duration: ZOOM.duration - 120, easing: Easing.in(Easing.quad), reduceMotion: NEVER }), NEVER),
    );
    backdropOpacity.set(
      withDelay(
        LEAD + ZOOM.start,
        withTiming(0, { duration: ZOOM.duration, easing: Easing.inOut(Easing.quad), reduceMotion: NEVER }, () => {
          scheduleOnRN(finish);
        }),
        NEVER,
      ),
    );
  }

  function onLayout() {
    if (started.current) return;
    started.current = true;
    // Two frames: the overlay has been drawn before the native splash goes away.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void SplashScreen.hideAsync().catch(() => {});
        run();
      }),
    );
  }

  if (done) return null;

  return (
    <View
      style={styles.root}
      onLayout={onLayout}
      pointerEvents="auto"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View style={[styles.backdrop, backdropStyle]} />
      <Animated.View style={markStyle}>
        <LogoMark size={SPLASH.imageWidth} color={SPLASH.markColor} />
      </Animated.View>
    </View>
  );
}

const fill = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;

const styles = StyleSheet.create({
  root: {
    ...fill,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    elevation: 1000,
  },
  backdrop: { ...fill, backgroundColor: SPLASH.backgroundColor },
});
