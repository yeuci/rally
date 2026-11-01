import { Image as ExpoImage } from 'expo-image';
import { RotateCwIcon, XIcon } from 'lucide-react-native';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { LogoMark } from '@/components/rally/logo';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { BRAND } from '@/lib/brand';
import { useReduceMotionSetting } from '@/lib/use-reduce-motion';
import { problemCopy } from './loading-copy';
import { useViewport } from '@/lib/viewport';

/**
 * The game's loading screen, Roblox-style: the game's own art (cover, else its first screenshot) blurred full-bleed
 * under a dark scrim, the Rally logo top-left, the game's icon and title in the middle over a clean progress bar, and
 * one plain line under it saying exactly what is happening ("Downloading characters", "Joining the match") with a
 * quiet byte count or percentage. A "Leave" button appears after {@link LEAVE_AFTER_MS}, so nobody is ever stuck.
 *
 * Always dark (it sits where the game will draw), in either orientation, inside the safe area. The bar's fill eases
 * forward and never back; while nothing has moved for a moment (waiting on the network) a soft sheen sweeps the
 * track. Reduce Motion: no sheen and no easing, only cross-fades. Mounted by GameHost while `phase === 'loading'`
 * (keyed per attempt), it fades out over {@link FADE_MS} when the game is shown.
 */

/** The "Leave" button shows after this long on the loading screen. */
export const LEAVE_AFTER_MS = 8000;
/** Fade-out when the game is shown (and fade-in of the content). */
export const FADE_MS = 250;
/** No progress for this long counts as waiting (the sheen fades in). */
const WAIT_MS = 700;

const WHITE = '#FFFFFF';
const NEVER = ReduceMotion.Never;

export interface GameArtProps {
  /** The game's display name; null (Developer launcher) shows no title. */
  title: string | null;
  /** Cover, else the first screenshot (lib/game-art.ts `coverUriFor(game, 'feature')`); null draws the brand gradient. */
  artUri?: string | null;
  /** The game's square icon, shown above the title when present. */
  iconUri?: string | null;
}

export interface GameLoadingScreenProps extends GameArtProps {
  /** 0…1. */
  progress: number;
  status: string;
  detail: string | null;
  onLeave: () => void;
  /** Developer-only note under everything (the bundle URL in dev builds); never shown to players. */
  devNote?: string | null;
}

export function GameLoadingScreen({
  title,
  artUri,
  iconUri,
  progress,
  status,
  detail,
  onLeave,
  devNote,
}: GameLoadingScreenProps) {
  const { width, height, insets } = useViewport();
  const reduceMotion = useReduceMotion();
  const [canLeave, setCanLeave] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setCanLeave(true), LEAVE_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

  const landscape = width > height;
  const compact = height < 480;
  const column = Math.min(landscape ? 420 : 340, width - insets.left - insets.right - 64);
  const iconSize = compact ? 56 : 72;
  const name = title?.trim() || null;

  return (
    <Animated.View
      style={styles.root}
      entering={FadeIn.duration(FADE_MS).reduceMotion(NEVER)}
      exiting={FadeOut.duration(FADE_MS).reduceMotion(NEVER)}
      accessibilityViewIsModal
    >
      <GameBackdrop artUri={artUri} />
      <TopBar insets={insets}>
        {canLeave ? (
          <Animated.View entering={FadeIn.duration(300).reduceMotion(NEVER)}>
            <Pressable
              onPress={onLeave}
              accessibilityRole="button"
              accessibilityLabel={name ? `Leave ${name}` : 'Leave the game'}
              hitSlop={10}
              style={({ pressed }) => [styles.leave, pressed && styles.pressed]}
            >
              <Icon as={XIcon} size={14} color={WHITE} />
              <Text className="text-white" style={styles.leaveText}>
                Leave
              </Text>
            </Pressable>
          </Animated.View>
        ) : null}
      </TopBar>

      <View
        style={[styles.center, { paddingTop: insets.top + 56, paddingBottom: insets.bottom + 40 }]}
        pointerEvents="box-none"
      >
        <View style={{ width: column, alignItems: 'center' }}>
          {iconUri ? (
            <ExpoImage
              source={{ uri: iconUri }}
              style={[styles.icon, { width: iconSize, height: iconSize, borderRadius: iconSize * 0.24 }]}
              contentFit="cover"
              transition={{ duration: 300, effect: 'cross-dissolve' }}
              accessibilityIgnoresInvertColors
            />
          ) : null}
          {name ? (
            <Text
              className="text-white"
              style={[styles.title, compact && styles.titleCompact]}
              numberOfLines={1}
              accessibilityRole="header"
            >
              {name}
            </Text>
          ) : null}
          <ProgressBar progress={progress} reduceMotion={reduceMotion} label={status} />
          <View style={styles.statusRow}>
            <Text className="text-white" style={styles.status} numberOfLines={2} accessibilityLiveRegion="polite">
              {status}
            </Text>
            {detail ? (
              <Text className="text-white" style={styles.detail} numberOfLines={1}>
                {detail}
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      {devNote ? (
        <Text
          className="text-white"
          style={[styles.devNote, { bottom: insets.bottom + 10, left: insets.left + 20, right: insets.right + 20 }]}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {devNote}
        </Text>
      ) : null}
    </Animated.View>
  );
}

export interface GameProblemScreenProps extends GameArtProps {
  phase: 'crashed' | 'failed';
  /** The raw error: players see a plain message from it (loading-copy.ts `problemCopy`); dev builds also see it. */
  error: string | null;
  onReload: () => void;
  onBack: () => void;
  /** Show the raw error under the message (dev builds). */
  showError?: boolean;
}

/** The crash / load-failure screen, on the same blurred art: what happened in plain words, Reload or Back. */
export function GameProblemScreen({
  title,
  artUri,
  iconUri,
  phase,
  error,
  onReload,
  onBack,
  showError,
}: GameProblemScreenProps) {
  const { width, height, insets } = useViewport();
  const copy = problemCopy(phase, error, title);
  const compact = height < 480;
  const column = Math.min(width > height ? 440 : 340, width - insets.left - insets.right - 48);

  return (
    <Animated.View style={styles.root} entering={FadeIn.duration(FADE_MS).reduceMotion(NEVER)} accessibilityViewIsModal>
      <GameBackdrop artUri={artUri} dim />
      <TopBar insets={insets} />
      <View
        style={[styles.center, { paddingTop: insets.top + 56, paddingBottom: insets.bottom + 24 }]}
        pointerEvents="box-none"
      >
        <View style={{ width: column, alignItems: 'center' }}>
          {iconUri && !compact ? (
            <ExpoImage
              source={{ uri: iconUri }}
              style={[styles.icon, styles.iconMuted, { width: 56, height: 56, borderRadius: 14 }]}
              contentFit="cover"
              accessibilityIgnoresInvertColors
            />
          ) : null}
          <Text className="text-white" style={styles.problemTitle} accessibilityRole="header">
            {copy.title}
          </Text>
          <Text className="text-white" style={styles.problemMessage}>
            {copy.message}
          </Text>
          {showError && error ? (
            <Text className="text-white" style={styles.problemError} numberOfLines={6} selectable>
              {error}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              onPress={onReload}
              accessibilityRole="button"
              style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
            >
              <Icon as={RotateCwIcon} size={16} color={BRAND.base} />
              <Text style={styles.primaryText}>Reload</Text>
            </Pressable>
            <Pressable
              onPress={onBack}
              accessibilityRole="button"
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            >
              <Text className="text-white" style={styles.secondaryText}>
                Back
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

/** The live Reduce Motion setting, falling back to Reanimated's startup reading until it is known. */
function useReduceMotion(): boolean {
  const atStartup = useReducedMotion();
  return useReduceMotionSetting() ?? atStartup;
}

/** Rally logo (mark + wordmark, always white here) top-left, and an optional action top-right, inside the safe area. */
function TopBar({ insets, children }: { insets: { top: number; left: number; right: number }; children?: ReactNode }) {
  return (
    <View
      style={[styles.topBar, { top: Math.max(insets.top, 12) + 6, left: insets.left + 20, right: insets.right + 20 }]}
      pointerEvents="box-none"
    >
      <View style={styles.brand} accessible accessibilityRole="image" accessibilityLabel="Rally">
        <LogoMark size={26} color={WHITE} />
        <Text className="text-white" style={styles.brandText} importantForAccessibility="no">
          Rally
        </Text>
      </View>
      {children}
    </View>
  );
}

/**
 * Full-bleed background: the brand gradient, the game's art blurred over it (fading in once loaded), and a dark scrim
 * for white type. The shade layers are native gradient views (expo-linear-gradient), which follow every resize: the
 * game locks its orientation right after this mounts, and SVG layers kept their first (portrait) width for a while.
 */
export const GameBackdrop = memo(function GameBackdrop({
  artUri,
  dim = false,
}: {
  artUri?: string | null;
  dim?: boolean;
}) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <BrandGradient />
      {artUri ? (
        <ExpoImage
          source={{ uri: artUri }}
          style={styles.art}
          contentFit="cover"
          blurRadius={28}
          transition={{ duration: 450, effect: 'cross-dissolve' }}
          accessibilityIgnoresInvertColors
        />
      ) : null}
      <Scrim strong={dim} photo={!!artUri} />
    </View>
  );
});

/** Near-black to charcoal with a soft light behind the title: the brand's monochrome, for games without art yet. */
function BrandGradient() {
  return (
    <>
      <LinearGradient
        style={StyleSheet.absoluteFill}
        colors={['#262626', '#121212', BRAND.base]}
        locations={[0, 0.55, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      />
      {/* The soft light: a faint band across the middle, where the title sits. */}
      <LinearGradient
        style={StyleSheet.absoluteFill}
        colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.07)', 'rgba(255,255,255,0)']}
        locations={[0.15, 0.44, 0.8]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
      />
    </>
  );
}

/** Black shade: deeper under the logo and at the bottom, lighter in the middle where the title and bar sit. */
function Scrim({ strong, photo }: { strong: boolean; photo: boolean }) {
  // Bright art (a lit arena in the middle of a dark cover) still needs white type to read: a flat dim, then the edges.
  const base = strong ? 0.52 : photo ? 0.4 : 0;
  return (
    <>
      {base > 0 ? <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(0,0,0,${base})` }]} /> : null}
      <LinearGradient
        style={StyleSheet.absoluteFill}
        colors={['rgba(0,0,0,0.45)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.55)']}
        locations={[0, 0.3, 0.62, 1]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
      />
    </>
  );
}

/**
 * Rounded track, eased fill that only ever moves forward, and a soft sheen that sweeps the track once nothing has
 * moved for {@link WAIT_MS} (waiting on the network). Reduce Motion: the fill jumps and there is no sheen.
 */
function ProgressBar({ progress, reduceMotion, label }: { progress: number; reduceMotion: boolean; label: string }) {
  // The furthest the fill has been sent; the controller's progress already never drops within a load.
  const shown = useRef(0);
  const fill = useSharedValue(0);
  const trackWidth = useSharedValue(0);
  const sweep = useSharedValue(0);
  const sheen = useSharedValue(0);
  const target = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));

  useEffect(() => {
    const next = Math.max(shown.current, target);
    if (next === shown.current && fill.get() >= next) return;
    shown.current = next;
    fill.set(
      reduceMotion ? next : withTiming(next, { duration: 600, easing: Easing.out(Easing.cubic), reduceMotion: NEVER }),
    );
  }, [target, reduceMotion, fill]);

  // Any movement hides the sheen; it comes back once the bar has been still for a moment.
  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(sheen);
      sheen.set(0);
      return;
    }
    sheen.set(
      withSequence(
        withTiming(0, { duration: 150, reduceMotion: NEVER }),
        withDelay(WAIT_MS, withTiming(1, { duration: 450, reduceMotion: NEVER }), NEVER),
      ),
    );
  }, [target, reduceMotion, sheen]);

  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(sweep);
      return;
    }
    sweep.set(0);
    sweep.set(
      withRepeat(
        withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.quad), reduceMotion: NEVER }),
        -1,
        false,
        undefined,
        NEVER,
      ),
    );
    return () => cancelAnimation(sweep);
  }, [reduceMotion, sweep]);

  const fillStyle = useAnimatedStyle(() => ({ width: `${fill.value * 100}%` }));
  const sheenStyle = useAnimatedStyle(() => {
    const band = Math.max(56, trackWidth.value * 0.32);
    return {
      opacity: sheen.value,
      width: band,
      transform: [{ translateX: interpolate(sweep.value, [0, 1], [-band, trackWidth.value]) }],
    };
  });

  const percent = Math.round(target * 100);
  return (
    <View
      style={styles.track}
      onLayout={(e: LayoutChangeEvent) => trackWidth.set(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: percent }}
    >
      {!reduceMotion ? (
        <Animated.View style={[styles.sheen, sheenStyle]} pointerEvents="none">
          <SheenBand />
        </Animated.View>
      ) : null}
      <Animated.View style={[styles.fill, fillStyle]} />
    </View>
  );
}

const SheenBand = memo(function SheenBand() {
  return (
    <LinearGradient
      style={StyleSheet.absoluteFill}
      colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.42)', 'rgba(255,255,255,0)']}
      start={{ x: 0, y: 0.5 }}
      end={{ x: 1, y: 0.5 }}
    />
  );
});

const FILL = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;
const BAR_HEIGHT = 6;
const TEXT_SHADOW = {
  textShadowColor: 'rgba(0,0,0,0.35)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 6,
};

const styles = StyleSheet.create({
  root: { ...FILL, backgroundColor: BRAND.base, overflow: 'hidden' },
  // A touch larger than the screen: a blurred bitmap's edges go soft and dark.
  art: { position: 'absolute', top: -24, right: -24, bottom: -24, left: -24 },
  topBar: {
    position: 'absolute',
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  brandText: { fontSize: 20, lineHeight: 26, fontWeight: '800', letterSpacing: -0.5, ...TEXT_SHADOW },
  leave: {
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 17,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.38)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  leaveText: { fontSize: 14, lineHeight: 18, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  center: { ...FILL, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  icon: {
    marginBottom: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.22)',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  iconMuted: { marginBottom: 14, opacity: 0.9 },
  title: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
    letterSpacing: -0.6,
    textAlign: 'center',
    marginBottom: 22,
    ...TEXT_SHADOW,
  },
  titleCompact: { fontSize: 23, lineHeight: 28, marginBottom: 16 },
  track: {
    width: '100%',
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
    backgroundColor: 'rgba(255,255,255,0.16)',
    overflow: 'hidden',
  },
  fill: { position: 'absolute', top: 0, bottom: 0, left: 0, borderRadius: BAR_HEIGHT / 2, backgroundColor: '#FAFAFA' },
  sheen: { position: 'absolute', top: 0, bottom: 0, left: 0 },
  statusRow: { width: '100%', marginTop: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  status: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: '500', opacity: 0.9, ...TEXT_SHADOW },
  detail: {
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '500',
    opacity: 0.55,
    fontVariant: ['tabular-nums'],
    ...TEXT_SHADOW,
  },
  devNote: { position: 'absolute', fontSize: 11, lineHeight: 14, opacity: 0.35, textAlign: 'center' },
  problemTitle: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '800',
    letterSpacing: -0.4,
    textAlign: 'center',
    ...TEXT_SHADOW,
  },
  problemMessage: { marginTop: 8, fontSize: 15, lineHeight: 21, opacity: 0.82, textAlign: 'center', ...TEXT_SHADOW },
  problemError: {
    marginTop: 12,
    alignSelf: 'stretch',
    padding: 10,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.45)',
    fontFamily: 'Menlo',
    fontSize: 11,
    lineHeight: 15,
    opacity: 0.75,
  },
  actions: { marginTop: 22, flexDirection: 'row', gap: 10 },
  primary: {
    height: 44,
    paddingHorizontal: 22,
    borderRadius: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: WHITE,
  },
  primaryText: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: BRAND.base },
  secondary: {
    height: 44,
    paddingHorizontal: 22,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  secondaryText: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
});
