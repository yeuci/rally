import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { SafeAreaView, useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';
import { usePrefs } from './prefs';
import { insetsFromProbe, type Frame } from './viewport-model';

/**
 * The screen as it is actually laid out: size and safe-area insets, measured, never reported.
 *
 * `useWindowDimensions` and `useSafeAreaInsets` come from events, and on iOS a rotation the app starts itself (a game
 * locking landscape, the shell turning back) can deliver them before the window has turned and then never again: the
 * shell kept a landscape window size or landscape insets on a portrait screen (the wide layout, buttons under the
 * status bar, a gallery page peeking in). Here a full-screen probe measures the root view, and a native SafeAreaView
 * inside it measures the insets UIKit applies right now (its padding is native and updates with the layout). Both
 * come from `onLayout`, so they always match what is drawn. Until the first measurement the reported values stand in.
 */

export interface Viewport {
  width: number;
  height: number;
  insets: EdgeInsets;
}

const ViewportContext = createContext<Viewport | null>(null);

const sameFrame = (a: Frame | null, b: Frame) =>
  !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

function frameOf(e: LayoutChangeEvent): Frame {
  const { x, y, width, height } = e.nativeEvent.layout;
  return { x, y, width, height };
}

export function ViewportProvider({ children }: { children: ReactNode }) {
  const reported = useWindowDimensions();
  const reportedInsets = useSafeAreaInsets();
  const [outer, setOuter] = useState<Frame | null>(null);
  const [inner, setInner] = useState<Frame | null>(null);
  const onOuter = useCallback((e: LayoutChangeEvent) => {
    const f = frameOf(e);
    setOuter((prev) => (sameFrame(prev, f) ? prev : f));
  }, []);
  const onInner = useCallback((e: LayoutChangeEvent) => {
    const f = frameOf(e);
    setInner((prev) => (sameFrame(prev, f) ? prev : f));
  }, []);

  const value = useMemo<Viewport>(() => {
    if (!outer || !inner || outer.width <= 0 || outer.height <= 0) {
      return { width: reported.width, height: reported.height, insets: reportedInsets };
    }
    return { width: outer.width, height: outer.height, insets: insetsFromProbe(outer, inner) };
  }, [outer, inner, reported.width, reported.height, reportedInsets]);

  // Dev builds with "Show FPS" on: the reported and the measured numbers side by side, so a screenshot after a
  // rotation shows which one went stale.
  const { showFps } = usePrefs();
  const readout =
    __DEV__ && showFps
      ? `window ${fmt(reported.width)}×${fmt(reported.height)} · root ${outer ? `${fmt(outer.width)}×${fmt(outer.height)}` : '?'}\n` +
        `insets reported ${insetText(reportedInsets)} · measured ${outer && inner ? insetText(value.insets) : '?'}`
      : null;

  return (
    <ViewportContext.Provider value={value}>
      {children}
      {readout ? (
        <View
          pointerEvents="none"
          style={[styles.readout, { bottom: value.insets.bottom + 4, left: value.insets.left + 4 }]}
        >
          <Text style={styles.readoutText}>{readout}</Text>
        </View>
      ) : null}
      <View
        style={StyleSheet.absoluteFill}
        onLayout={onOuter}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <SafeAreaView
          style={styles.fill}
          edges={['top', 'right', 'bottom', 'left']}
          mode="padding"
          pointerEvents="none"
        >
          <View style={styles.fill} onLayout={onInner} />
        </SafeAreaView>
      </View>
    </ViewportContext.Provider>
  );
}

/** The measured screen (size and insets); the reported values outside the provider or before the first layout. */
export function useViewport(): Viewport {
  const reported = useWindowDimensions();
  const reportedInsets = useSafeAreaInsets();
  const measured = useContext(ViewportContext);
  return measured ?? { width: reported.width, height: reported.height, insets: reportedInsets };
}

const fmt = (n: number) => String(Math.round(n));
const insetText = (i: EdgeInsets) => `t${fmt(i.top)} l${fmt(i.left)} r${fmt(i.right)} b${fmt(i.bottom)}`;

const styles = StyleSheet.create({
  fill: { flex: 1 },
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
