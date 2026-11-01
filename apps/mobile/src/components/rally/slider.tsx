import { useRef, useState } from 'react';
import { StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';

const THUMB = 22;

export interface SliderColors {
  track: string;
  fill: string;
  thumb: string;
}

/**
 * A horizontal slider on the plain responder system (no native module, so Expo Go has everything it needs): tap to
 * jump, drag to slide. Reports every step while dragging (`final` false) and once on release (`final` true), so a
 * caller can apply live and save on release. Screen readers adjust it a step at a time. Used by the game menu (white
 * on dark) and the app's Settings screen (theme colours).
 */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  colors,
}: {
  /** Accessibility label. */
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** The value as read out ("80%"). */
  format: (v: number) => string;
  onChange: (v: number, final: boolean) => void;
  colors: SliderColors;
}) {
  const [width, setWidth] = useState(0);
  /** The drag in progress: where it started (in the track and on the page) and the last value reported. */
  const drag = useRef({ x: 0, page: 0, last: value });

  const at = (x: number) => {
    const usable = Math.max(1, width - THUMB);
    const f = Math.min(1, Math.max(0, (x - THUMB / 2) / usable));
    const snapped = min + Math.round((f * (max - min)) / step) * step;
    return Math.min(max, Math.max(min, Number(snapped.toFixed(6))));
  };
  const report = (v: number, final: boolean) => {
    if (!final && v === drag.current.last) return;
    drag.current.last = v;
    onChange(v, final);
  };
  const xOf = (e: GestureResponderEvent) => drag.current.x + e.nativeEvent.pageX - drag.current.page;

  const f = max > min ? (Math.min(max, Math.max(min, value)) - min) / (max - min) : 0;
  const thumbX = f * Math.max(0, width - THUMB);
  const nudge = (dir: 1 | -1) => onChange(Math.min(max, Math.max(min, Number((value + dir * step).toFixed(6)))), true);

  return (
    <View
      style={styles.slider}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: format(value) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => nudge(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        drag.current = { x: e.nativeEvent.locationX, page: e.nativeEvent.pageX, last: value };
        report(at(e.nativeEvent.locationX), false);
      }}
      onResponderMove={(e) => report(at(xOf(e)), false)}
      onResponderRelease={(e) => report(at(xOf(e)), true)}
      onResponderTerminate={() => report(drag.current.last, true)}
    >
      <View style={[styles.track, { backgroundColor: colors.track }]} pointerEvents="none">
        <View style={[styles.fill, { width: thumbX + THUMB / 2, backgroundColor: colors.fill }]} />
      </View>
      <View
        style={[styles.thumb, { backgroundColor: colors.thumb, transform: [{ translateX: thumbX }] }]}
        pointerEvents="none"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  slider: { height: 32, justifyContent: 'center' },
  track: { position: 'absolute', left: THUMB / 2, right: THUMB / 2, height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, marginLeft: -THUMB / 2 },
  thumb: {
    position: 'absolute',
    left: 0,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
});
