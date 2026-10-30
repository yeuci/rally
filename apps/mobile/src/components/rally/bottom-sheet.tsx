import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from 'react-native';
import Animated, { ReduceMotion, SlideInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * A sheet that rises from the bottom edge over a dimmed backdrop (the join-code and rejoin sheets). React Native's
 * `Modal`, so it sits above every screen and the drawer; the keyboard pushes it up. A tap on the backdrop or the
 * Android back button calls `onClose`. Phones get a full-width sheet, wide windows a centred 28 rem one.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} className="flex-1 justify-end">
        <Pressable
          className="bg-backdrop absolute bottom-0 left-0 right-0 top-0"
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <Animated.View
          entering={SlideInDown.duration(260).reduceMotion(ReduceMotion.System)}
          className={cn(
            'bg-background border-border w-full max-w-md self-center rounded-t-3xl border border-b-0 px-5 pt-2',
            className,
          )}
          style={{
            paddingBottom: Math.max(insets.bottom, 16) + 8,
            paddingLeft: insets.left + 20,
            paddingRight: insets.right + 20,
          }}
          accessibilityViewIsModal
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
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
