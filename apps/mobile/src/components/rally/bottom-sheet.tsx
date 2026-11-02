import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type ScrollViewProps,
} from 'react-native';
import Animated, {
  Extrapolation,
  ReduceMotion,
  SlideInDown,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Text } from '@/components/ui/text';
import { setSheetOpen } from '@/lib/open-sheets';
import { sheetDragCloses, sheetDragOffset, sheetDragStarts, sheetOverscrollCloses } from '@/lib/sheet-drag';
import { cn } from '@/lib/utils';
import { UnturnedLayer, useViewport } from '@/lib/viewport';

/**
 * A sheet that rises from the bottom edge over a dimmed backdrop (the join-code and rejoin sheets). React Native's
 * `Modal`, so it sits above every screen and the drawer; the keyboard pushes it up. A swipe down (lib/sheet-drag.ts),
 * a tap on the backdrop, the Android back button or VoiceOver's escape gesture calls `onClose`. Phones get a
 * full-width sheet, wide windows a centred 28 rem one.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  description,
  children,
  className,
  supportedOrientations,
  register = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * iOS: orientations the sheet may be shown in (React Native's default is portrait only). A sheet that can appear
   * over a landscape-locked game must allow landscape, or iOS rotates the screen (or refuses the presentation).
   */
  supportedOrientations?: ComponentProps<typeof Modal>['supportedOrientations'];
  /** Count in lib/open-sheets.ts while open (a sheet that waits for the others passes false). */
  register?: boolean;
}) {
  const id = useId();
  const registered = open && register;
  useEffect(() => {
    if (!registered) return;
    setSheetOpen(id, true);
    return () => setSheetOpen(id, false);
  }, [registered, id]);
  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
      supportedOrientations={supportedOrientations}
    >
      {/* Upright on the screen even over a game turned inside the app (game-host/game-frame.tsx): the screen's own
          insets apply in here. */}
      <UnturnedLayer>
        <SheetBody open={open} onClose={onClose} title={title} description={description} className={className}>
          {children}
        </SheetBody>
      </UnturnedLayer>
    </Modal>
  );
}

/**
 * Inside a sheet: `requestClose` slides it away and closes it, as a swipe down does; `markScrollTouch` tells the sheet
 * that the touch now starting is inside scrolling content, which keeps its own swipe out of the way (SheetScrollView).
 */
const SheetContext = createContext<{ requestClose: () => void; markScrollTouch: () => void } | null>(null);

/**
 * A ScrollView for a sheet's content. iOS gives a drag that starts inside a scroll view to the scroll view (it cancels
 * the touch before the sheet's own swipe can take it), so there the swipe down is a pull past the top instead: pull the
 * content down past its top and let go, and the sheet closes like a swipe (lib/sheet-drag.ts). It always bounces, so
 * this works when the content fits too. Its children sit in one wrapper (which takes `contentContainerClassName`) so
 * every touch in them is known to be a scrolling one.
 */
export function SheetScrollView({ onScrollEndDrag, contentContainerClassName, children, ...props }: ScrollViewProps) {
  const sheet = useContext(SheetContext);
  return (
    <ScrollView
      alwaysBounceVertical
      {...props}
      onScrollEndDrag={(e) => {
        onScrollEndDrag?.(e);
        const { contentOffset, velocity } = e.nativeEvent;
        if (sheet && sheetOverscrollCloses(contentOffset.y, velocity?.y ?? 0)) sheet.requestClose();
      }}
    >
      <View
        className={contentContainerClassName}
        onStartShouldSetResponderCapture={() => {
          sheet?.markScrollTouch();
          return false;
        }}
      >
        {children}
      </View>
    </ScrollView>
  );
}

/** How long a swiped sheet takes to leave, and the spring that brings a let-go sheet back. */
const CLOSE_MS = 180;
const SPRING = { damping: 22, stiffness: 260, mass: 0.7, reduceMotion: ReduceMotion.System };

/** The sheet itself, inside the Modal (so it reads the screen it is presented on). */
function SheetBody({
  open,
  onClose,
  title,
  description,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const { insets } = useViewport();
  /** How far below its resting place the sheet is dragged, and its height (for how far "away" is). */
  const drag = useSharedValue(0);
  const height = useSharedValue(0);
  /** Bumped when a swipe lets go far enough: the effect below slides the sheet away and closes it. */
  const [closeRequest, setCloseRequest] = useState(0);
  const requestClose = useCallback(() => setCloseRequest((n) => n + 1), []);
  // At rest whenever the sheet opens (React Native unmounts a closed Modal's content, but never rely on that).
  useEffect(() => {
    if (open) drag.set(0);
  }, [open, drag]);

  /** Whether the touch in progress started inside scrolling content (SheetScrollView marks it; reset per touch). */
  const touchInScroll = useSharedValue(false);
  const sheetContext = useMemo(
    () => ({ requestClose, markScrollTouch: () => touchInScroll.set(true) }),
    [requestClose, touchInScroll],
  );

  // Swipe down to close: the sheet follows the finger, the backdrop fades with it; let go far enough (or flick) and it
  // slides away and closes, else it springs back. A touch on the sheet's own surface (handle, title, text, artwork)
  // makes it the responder at once, as the game menu's draggable button does; a touch on a button stays the button's
  // until it clearly moves down, then the sheet takes it. Touches in scrolling content are left to the scroll view.
  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponderCapture: () => {
        touchInScroll.set(false);
        return false;
      },
      onStartShouldSetPanResponder: () => !touchInScroll.get(),
      onMoveShouldSetPanResponderCapture: (_e, g) => !touchInScroll.get() && sheetDragStarts(g.dx, g.dy),
      onMoveShouldSetPanResponder: (_e, g) => !touchInScroll.get() && sheetDragStarts(g.dx, g.dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_e, g) => drag.set(sheetDragOffset(g.dy)),
      onPanResponderRelease: (_e, g) => {
        if (sheetDragCloses(g.dy, g.vy)) setCloseRequest((n) => n + 1);
        else drag.set(withSpring(0, SPRING));
      },
      onPanResponderTerminate: () => drag.set(withSpring(0, SPRING)),
    }),
  );

  const slideAway = useEffectEvent(() => {
    drag.set(withTiming(Math.max(height.get(), 300) + 40, { duration: CLOSE_MS, reduceMotion: ReduceMotion.System }));
  });
  const close = useEffectEvent(() => onClose());
  // A sheet that may not close right now (a bug report still sending) comes back up.
  const comeBackIfOpen = useEffectEvent(() => {
    if (open) drag.set(withSpring(0, SPRING));
  });
  useEffect(() => {
    if (closeRequest === 0) return;
    slideAway();
    let back: ReturnType<typeof setTimeout> | undefined;
    const done = setTimeout(() => {
      close();
      back = setTimeout(comeBackIfOpen, 80);
    }, CLOSE_MS);
    return () => {
      clearTimeout(done);
      if (back) clearTimeout(back);
    };
  }, [closeRequest]);

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: drag.get() }] }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(drag.get(), [0, Math.max(height.get(), 1)], [1, 0], Extrapolation.CLAMP),
  }));

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} className="flex-1 justify-end">
      <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
        <Pressable
          className="bg-backdrop flex-1"
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
      </Animated.View>
      {/* The animated views carry plain styles only (the transform, the column); the sheet's look is on the plain View
          inside. Same split as the game menu's draggable button, whose drag works on iPhone. */}
      <Animated.View entering={SlideInDown.duration(260).reduceMotion(ReduceMotion.System)} style={styles.column}>
        <Animated.View
          {...pan.panHandlers}
          onLayout={(e) => height.set(e.nativeEvent.layout.height)}
          style={sheetStyle}
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
        >
          <View
            className={cn('bg-background border-border rounded-t-3xl border border-b-0 px-5 pt-2', className)}
            style={{
              paddingBottom: Math.max(insets.bottom, 16) + 8,
              paddingLeft: insets.left + 20,
              paddingRight: insets.right + 20,
            }}
          >
            {/* Grabber: the muted foreground at 40 % (a token with an opacity modifier would compile to no colour on native). */}
            <View className="bg-muted-foreground mb-4 h-1 w-10 self-center rounded-full opacity-40" />
            <View className="mb-4 gap-1">
              <Text className="text-xl font-bold leading-7 tracking-tight" role="heading">
                {title}
              </Text>
              {typeof description === 'string' ? (
                <Text className="text-muted-foreground text-sm leading-5">{description}</Text>
              ) : (
                description
              )}
            </View>
            <SheetContext.Provider value={sheetContext}>{children}</SheetContext.Provider>
          </View>
        </Animated.View>
      </Animated.View>
    </KeyboardAvoidingView>
  );
}

/** The sheet's column: full width on a phone, a centred 28 rem one on wide windows. */
const styles = StyleSheet.create({ column: { width: '100%', maxWidth: 448, alignSelf: 'center' } });
