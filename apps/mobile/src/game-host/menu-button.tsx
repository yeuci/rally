import * as Haptics from 'expo-haptics';
import { ChevronLeftIcon, ChevronRightIcon, SettingsIcon } from 'lucide-react-native';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { PanResponder, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {
  DRAG_THRESHOLD,
  FLING_VELOCITY,
  TAB_HEIGHT,
  TAB_WIDTH,
  TUCK_PULL,
  buttonBounds,
  clamp,
  placeAt,
  restingPoint,
  rubberBand,
  setTucked,
  snapToEdge,
  tabPlacement,
  tuckSideFor,
  tuckTo,
  type Bounds,
  type ButtonOrientation,
  type Insets,
  type MenuButtonPrefs,
} from './menu-button-model';
import { MENU_BUTTON_SIZE } from './settings';
import { useScreenToFrame } from '@/lib/viewport';

/**
 * The game menu's button over a running game: a cog on a dark glass disc (premium, monochrome: 88 % opaque, a crisp
 * 1.5 pt white rim, a soft shadow). A tap opens the menu (scale-down and a light haptic); past `DRAG_THRESHOLD` the
 * touch becomes a drag and the disc follows the finger anywhere inside the safe area, then springs into place with a
 * little pull toward the nearest edge. Dragged or flung into a side edge it tucks into a slim half-pill tab (a
 * "bookmark") on that edge; tapping the tab slides the disc back out to its last spot, dragging the tab moves it
 * along the edge or pulls the disc out. The menu's "Tuck menu button to the side" switch does the same.
 *
 * Positions, the tab and the tucked state are remembered per game and orientation (menu-button-model.ts, through
 * GameHost). The game itself is only ever told about the default top-left place (`device.menuButton`).
 *
 * Touches go through React Native's responder system (it works over the WebView); the drag writes Reanimated shared
 * values, so the disc moves without re-rendering. Reduce Motion: no springs, slides or scaling, just fades.
 */

export interface MenuButtonProps {
  /** Screen size (pt) and safe area. */
  width: number;
  height: number;
  insets: Insets;
  orientation: ButtonOrientation;
  /** Remembered place; GameHost loads and saves it (per game). */
  prefs: MenuButtonPrefs;
  onPrefsChange: (prefs: MenuButtonPrefs) => void;
  onOpen: () => void;
  /** Faded out and untouchable (the menu is open). */
  hidden?: boolean;
  /** The player's haptics setting: the tap, tuck and untuck ticks follow it. */
  haptics: boolean;
}

const SIZE = MENU_BUTTON_SIZE;
const WHITE = '#FFFFFF';
const NEVER = ReduceMotion.Never;
const SPRING = { damping: 20, stiffness: 260, mass: 0.9, reduceMotion: NEVER } as const;
const FADE = { duration: 180, easing: Easing.out(Easing.quad), reduceMotion: NEVER } as const;
const TUCK = { duration: 260, easing: Easing.out(Easing.cubic), reduceMotion: NEVER } as const;
/** Pull (pt) on the tab, away from its edge, that brings the disc back out where the finger lets go. */
const TAB_PULL_OUT = 40;
/** Touch slop around the 40 pt disc (a 56 pt target) and the slim tab. */
const DISC_SLOP = 8;
const TAB_SLOP = { top: 10, bottom: 10, left: 16, right: 16 };

function tick(kind: 'tap' | 'tuck') {
  const done = kind === 'tap' ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light) : Haptics.selectionAsync();
  void done.catch(() => {});
}

export const MenuButton = memo(function MenuButton(props: MenuButtonProps) {
  const { width, height, insets, orientation, prefs, hidden = false } = props;
  const reduceMotion = useReducedMotion();
  const bounds = useMemo(() => buttonBounds(width, height, insets), [width, height, insets]);
  const rest = restingPoint(prefs, orientation, bounds);
  const tab = tabPlacement(prefs, orientation, bounds);
  const tucked = prefs.tucked;
  // The tab runs from the screen edge: across a side inset (landscape notch / home bar) to a visible TAB_WIDTH inside
  // the safe area, so it always reads as a bookmark on the edge, never as a floating pill.
  const edgeInset = tab.side === 'left' ? insets.left : insets.right;
  const tabWidth = TAB_WIDTH + edgeInset;
  const tabX = tab.side === 'left' ? 0 : width - tabWidth;
  /** The disc's top when parked behind the tab (centred on it). */
  const parkY = tab.top + TAB_HEIGHT / 2 - SIZE / 2;

  // Everything the worklets read lives in shared values; everything JS needs at drop time in a ref (current props).
  const x = useSharedValue(rest.x);
  const y = useSharedValue(rest.y);
  /** Drag anchor: where the disc was at touch-down (the finger's travel is the responder's dx / dy). */
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const pressed = useSharedValue(0);
  const lifted = useSharedValue(0);
  const armed = useSharedValue(0);
  const tuck = useSharedValue(tucked ? 1 : 0);
  const shown = useSharedValue(hidden ? 0 : 1);
  const motion = useSharedValue(reduceMotion ? 0 : 1);
  const side = useSharedValue(tab.side === 'left' ? -1 : 1);
  const tabTop = useSharedValue(tab.top);
  const tabLeft = useSharedValue(tabX);
  const tabSlide = useSharedValue(tabWidth);
  const tabStart = useSharedValue(0);
  const tabPull = useSharedValue(0);
  const area = useSharedValue<Bounds>(bounds);

  const latest = useRef({ props, bounds, parkY, tab, reduceMotion });
  useEffect(() => {
    latest.current = { props, bounds, parkY, tab, reduceMotion };
  });

  useEffect(() => {
    area.set(bounds);
  }, [area, bounds]);
  useEffect(() => {
    motion.set(reduceMotion ? 0 : 1);
  }, [motion, reduceMotion]);
  useEffect(() => {
    shown.set(withTiming(hidden ? 0 : 1, FADE));
  }, [shown, hidden]);

  // Place the disc (resting spot, or parked behind its tab) and the tab; animate the tuck. The first placement and
  // Reduce Motion jump (the tuck still fades); later ones spring.
  const placed = useRef(false);
  useEffect(() => {
    const first = !placed.current;
    placed.current = true;
    const jump = first || reduceMotion;
    const to = (v: typeof x, target: number) => v.set(jump ? target : withSpring(target, SPRING));
    side.set(tab.side === 'left' ? -1 : 1);
    tabTop.set(tab.top);
    tabLeft.set(tabX);
    tabSlide.set(tabWidth);
    if (!tucked) {
      to(x, rest.x);
      to(y, rest.y);
    } else if (!reduceMotion) {
      // Behind the tab, so untucking springs the disc out from there. (Reduce Motion: it waits at its spot, faded.)
      to(x, tab.side === 'left' ? bounds.minX : bounds.maxX);
      to(y, parkY);
    }
    tuck.set(first ? (tucked ? 1 : 0) : withTiming(tucked ? 1 : 0, reduceMotion ? FADE : TUCK));
  }, [
    x,
    y,
    side,
    tabTop,
    tabLeft,
    tabSlide,
    tuck,
    tucked,
    rest.x,
    rest.y,
    tab.side,
    tab.top,
    tabX,
    tabWidth,
    parkY,
    bounds,
    reduceMotion,
  ]);

  // --- JS side of the gestures (stable: they read the current props from `latest`) -------------------------------

  const open = useCallback(() => {
    const { props: p } = latest.current;
    if (p.haptics) tick('tap');
    p.onOpen();
  }, []);

  const armTick = useCallback(() => {
    if (latest.current.props.haptics) tick('tuck');
  }, []);

  /** The disc let go at `rawX`/`rawY` (unclamped, under the finger) with velocity `vx`/`vy`. */
  const drop = useCallback(
    (rawX: number, rawY: number, vx: number, vy: number) => {
      const { props: p, bounds: b } = latest.current;
      const tuckSide = tuckSideFor({ x: rawX, vx, vy }, b);
      if (tuckSide) {
        if (p.haptics) tick('tuck');
        p.onPrefsChange(tuckTo(p.prefs, p.orientation, tuckSide, b, clamp(rawY, b.minY, b.maxY)));
        return;
      }
      // Settle here even when the spot is unchanged (no new props, so the placement effect would not run).
      const target = snapToEdge({ x: rawX, y: rawY }, b);
      const reduce = latest.current.reduceMotion;
      x.set(reduce ? target.x : withSpring(target.x, SPRING));
      y.set(reduce ? target.y : withSpring(target.y, SPRING));
      p.onPrefsChange(placeAt(p.prefs, p.orientation, target, b));
    },
    [x, y],
  );

  const untuck = useCallback(() => {
    const { props: p } = latest.current;
    if (p.haptics) tick('tuck');
    p.onPrefsChange({ ...p.prefs, tucked: false });
  }, []);

  /** The tab let go after a drag: `dx` away from / along its edge, `dy` along it. */
  const dropTab = useCallback(
    (dx: number, dy: number, vx: number) => {
      const { props: p, bounds: b, parkY: py, tab: t } = latest.current;
      const out = t.side === 'left' ? 1 : -1;
      const discY = clamp(py + dy, b.minY, b.maxY);
      if (dx * out > TAB_PULL_OUT || vx * out > FLING_VELOCITY * 0.8) {
        // Pulled out: the disc appears under the finger and settles from there.
        const edgeX = t.side === 'left' ? b.minX : b.maxX;
        const from = { x: edgeX + out * Math.max(0, dx * out - TAB_WIDTH), y: discY };
        x.set(from.x);
        y.set(from.y);
        if (p.haptics) tick('tuck');
        p.onPrefsChange(placeAt(p.prefs, p.orientation, snapToEdge(from, b), b));
        return;
      }
      p.onPrefsChange(tuckTo(p.prefs, p.orientation, t.side, b, discY));
    },
    [x, y],
  );

  // --- Gestures (React Native's responder system) ------------------------------------------------------------------
  // Not gesture-handler: its root view, nested over the game's WebView, never received touches on iOS (Expo Go).
  // The core responder system works over any native view. Moves set shared values from JS (Reanimated draws them);
  // velocities arrive in px/ms and the model works in px/s. Movement arrives in screen axes: `toFrame` turns it into
  // the game frame's (an iPhone shows a landscape game turned a quarter, game-frame.tsx).
  const toFrame = useScreenToFrame();

  const press = useCallback(
    (on: boolean) => pressed.set(withTiming(on ? 1 : 0, { duration: on ? 90 : 160, reduceMotion: NEVER })),
    [pressed],
  );

  const discResponder = useMemo(() => {
    let dragging = false;
    let rawX = 0;
    let rawY = 0;
    const settle = () => {
      armed.set(0);
      lifted.set(motion.get() ? withSpring(0, SPRING) : 0);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => !dragging,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: () => {
        dragging = false;
        startX.set(x.get());
        startY.set(y.get());
        press(true);
      },
      onPanResponderMove: (_e, g) => {
        if (!dragging) {
          if (Math.hypot(g.dx, g.dy) < DRAG_THRESHOLD) return;
          dragging = true;
          press(false);
          armed.set(0);
          lifted.set(motion.get() ? withSpring(1, SPRING) : 1);
        }
        const b = area.get();
        const d = toFrame(g.dx, g.dy);
        rawX = startX.get() + d.dx;
        rawY = startY.get() + d.dy;
        x.set(rubberBand(rawX, b.minX, b.maxX));
        y.set(rubberBand(rawY, b.minY, b.maxY));
        const arm = rawX < b.minX - TUCK_PULL || rawX > b.maxX + TUCK_PULL ? 1 : 0;
        if (arm !== armed.get()) {
          armed.set(arm);
          if (arm) armTick();
        }
      },
      onPanResponderRelease: (_e, g) => {
        press(false);
        if (!dragging) {
          open();
          return;
        }
        dragging = false;
        settle();
        const v = toFrame(g.vx, g.vy);
        drop(rawX, rawY, v.dx * 1000, v.dy * 1000);
      },
      onPanResponderTerminate: () => {
        press(false);
        if (!dragging) return;
        dragging = false;
        settle();
        drop(rawX, rawY, 0, 0);
      },
    });
  }, [area, armed, lifted, motion, startX, startY, x, y, press, open, armTick, drop, toFrame]);

  const tabResponder = useMemo(() => {
    let dragging = false;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => !dragging,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: () => {
        dragging = false;
        tabStart.set(tabTop.get());
        press(true);
      },
      onPanResponderMove: (_e, g) => {
        if (!dragging) {
          if (Math.hypot(g.dx, g.dy) < DRAG_THRESHOLD) return;
          dragging = true;
          press(false);
        }
        const b = area.get();
        const d = toFrame(g.dx, g.dy);
        // Along the edge, inside the area; away from it with resistance (a pull past TAB_PULL_OUT brings it out).
        const top = tabStart.get() + d.dy;
        const discTop = top + TAB_HEIGHT / 2 - SIZE / 2;
        tabTop.set(top + (clamp(discTop, b.minY, b.maxY) - discTop));
        tabPull.set(rubberBand(Math.max(0, d.dx * -side.get()), 0, 0));
      },
      onPanResponderRelease: (_e, g) => {
        press(false);
        if (!dragging) {
          untuck();
          return;
        }
        dragging = false;
        tabPull.set(motion.get() ? withSpring(0, SPRING) : 0);
        dropTab(toFrame(g.dx, g.dy).dx, tabTop.get() - tabStart.get(), toFrame(g.vx, g.vy).dx * 1000);
      },
      onPanResponderTerminate: () => {
        press(false);
        dragging = false;
        tabPull.set(0);
      },
    });
  }, [area, motion, side, tabPull, tabStart, tabTop, press, untuck, dropTab, toFrame]);

  // --- Looks -------------------------------------------------------------------------------------------------------

  const discStyle = useAnimatedStyle(() => {
    const t = tuck.get();
    const m = motion.get();
    const scale = m
      ? (1 - 0.1 * pressed.get()) * (1 + 0.08 * lifted.get()) * (1 - 0.12 * armed.get()) * (1 - 0.45 * t)
      : 1;
    return {
      opacity: shown.get() * (1 - t) * (1 - 0.25 * armed.get()),
      transform: [{ translateX: x.get() + m * side.get() * t * SIZE * 0.5 }, { translateY: y.get() }, { scale }],
    };
  });
  const tabStyle = useAnimatedStyle(() => {
    const t = tuck.get();
    const m = motion.get();
    const s = side.get();
    // Slides in from its edge (Reduce Motion: fades in place); follows a pull away from the edge.
    const slide = m * (1 - t) * tabSlide.get() * s;
    return {
      opacity: shown.get() * t,
      transform: [
        { translateX: tabLeft.get() + slide - s * tabPull.get() },
        { translateY: tabTop.get() },
        { scale: m ? 1 - 0.06 * pressed.get() : 1 },
      ],
    };
  });

  const onDiscAction = (e: AccessibilityActionEvent) => {
    const { props: p, bounds: b } = latest.current;
    if (e.nativeEvent.actionName === 'activate') open();
    else if (e.nativeEvent.actionName === 'tuck') p.onPrefsChange(setTucked(p.prefs, p.orientation, true, b));
  };
  const onTabAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'activate') untuck();
    else if (e.nativeEvent.actionName === 'open') open();
  };

  const left = tab.side === 'left';
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View
        {...tabResponder.panHandlers}
        hitSlop={TAB_SLOP}
        style={[
          styles.tab,
          left ? styles.tabLeft : styles.tabRight,
          { width: tabWidth, paddingLeft: left ? edgeInset : 0, paddingRight: left ? 0 : edgeInset },
          tabStyle,
        ]}
        pointerEvents={tucked && !hidden ? 'auto' : 'none'}
        accessible={tucked && !hidden}
        accessibilityRole="button"
        accessibilityLabel="Show game menu"
        accessibilityHint="Brings back the menu button"
        accessibilityActions={[{ name: 'activate' }, { name: 'open', label: 'Open the game menu' }]}
        onAccessibilityAction={onTabAction}
        testID="game-menu-tab"
      >
        {left ? (
          <ChevronRightIcon size={16} color={CHEVRON} strokeWidth={2.5} />
        ) : (
          <ChevronLeftIcon size={16} color={CHEVRON} strokeWidth={2.5} />
        )}
      </Animated.View>
      <Animated.View
        {...discResponder.panHandlers}
        hitSlop={DISC_SLOP}
        style={[styles.disc, discStyle]}
        pointerEvents={tucked || hidden ? 'none' : 'auto'}
        accessible={!tucked && !hidden}
        accessibilityRole="button"
        accessibilityLabel="Game menu"
        accessibilityHint="Settings, how to play, and leave. Drag to move it."
        accessibilityActions={[{ name: 'activate' }, { name: 'tuck', label: 'Tuck to the side' }]}
        onAccessibilityAction={onDiscAction}
        testID="game-menu-button"
      >
        <SettingsIcon size={21} color={WHITE} strokeWidth={2.1} />
      </Animated.View>
    </View>
  );
});

const GLASS = 'rgba(22,22,26,0.88)';
const RIM = 'rgba(255,255,255,0.4)';
const CHEVRON = 'rgba(255,255,255,0.9)';

const styles = StyleSheet.create({
  disc: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: GLASS,
    borderWidth: 1.5,
    borderColor: RIM,
    // A soft drop shadow, and a thin inner highlight along the top: glass, not a flat sticker.
    boxShadow: '0px 4px 14px rgba(0,0,0,0.45), 0px 1px 3px rgba(0,0,0,0.35), inset 0px 1px 0px rgba(255,255,255,0.16)',
  },
  tab: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: TAB_WIDTH,
    height: TAB_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: GLASS,
    borderColor: RIM,
    borderTopWidth: 1.5,
    borderBottomWidth: 1.5,
    boxShadow: '0px 3px 12px rgba(0,0,0,0.45), inset 0px 1px 0px rgba(255,255,255,0.14)',
  },
  tabLeft: {
    borderRightWidth: 1.5,
    borderTopRightRadius: TAB_WIDTH,
    borderBottomRightRadius: TAB_WIDTH,
  },
  tabRight: {
    borderLeftWidth: 1.5,
    borderTopLeftRadius: TAB_WIDTH,
    borderBottomLeftRadius: TAB_WIDTH,
  },
});
