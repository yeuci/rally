import { Image as ExpoImage, type ImageProps as ExpoImageProps } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const DEFAULT_TRANSITION = 220;

type ImageProps = Omit<ExpoImageProps, 'style'> & {
  className?: string;
  /** Box of the image (size / position); the bitmap fills it. */
  style?: StyleProp<ViewStyle>;
  /** Classes for the loading placeholder (default: square corners, the parent clips). */
  placeholderClassName?: string;
};

/**
 * expo-image (disk + memory cache) in a box that shows a shimmering skeleton until the bitmap has loaded, then fades
 * the image in over it (`transition`, ms). The skeleton stays under the image until the fade has finished, so
 * nothing flashes the parent's background in between. A failed load keeps a plain placeholder (no endless shimmer).
 * `className` / `style` size and place the box (`absolute inset-0` to fill a parent).
 */
export function Image({
  className,
  style,
  placeholderClassName,
  transition = DEFAULT_TRANSITION,
  onLoad,
  onError,
  source,
  ...props
}: ImageProps) {
  const uri = sourceKey(source);
  // The uri the state belongs to: a new source starts loading again without an effect resetting the flags.
  const [settled, setSettled] = useState<{ uri: string; state: 'shown' | 'failed' } | null>(null);
  const state = settled && settled.uri === uri ? settled.state : 'loading';
  const fade = typeof transition === 'number' ? transition : (transition?.duration ?? DEFAULT_TRANSITION);

  return (
    <View className={cn('overflow-hidden', className)} style={style}>
      {state === 'loading' ? (
        <Skeleton className={cn('absolute inset-0 rounded-none', placeholderClassName)} />
      ) : state === 'failed' ? (
        <View className={cn('bg-skeleton absolute inset-0', placeholderClassName)} />
      ) : null}
      <ExpoImage
        {...props}
        source={source}
        style={StyleSheet.absoluteFill}
        transition={transition}
        onLoad={(e) => {
          // Drop the skeleton once the cross-fade is over (setState after unmount is a no-op).
          setTimeout(() => setSettled({ uri, state: 'shown' }), fade);
          onLoad?.(e);
        }}
        onError={(e) => {
          setSettled({ uri, state: 'failed' });
          onError?.(e);
        }}
      />
    </View>
  );
}

function sourceKey(source: ExpoImageProps['source']): string {
  if (!source) return '';
  if (typeof source === 'string') return source;
  if (typeof source === 'number') return String(source);
  if (Array.isArray(source)) return source.map((s) => (typeof s === 'object' && s ? (s.uri ?? '') : String(s))).join('|');
  return (source as { uri?: string }).uri ?? '';
}
