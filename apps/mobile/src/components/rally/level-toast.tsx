import { CheckIcon, CoinsIcon, FlameIcon } from 'lucide-react-native';
import { useEffect } from 'react';
import { AccessibilityInfo, Pressable, View, type TextStyle } from 'react-native';
import Animated, { FadeOutUp, ReduceMotion, ZoomIn } from 'react-native-reanimated';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { hideCelebration, useCelebration } from '@/lib/level-toast';
import { CELEBRATION_MS, celebrationText, type Celebration } from '@/lib/levels-model';

const TABULAR: TextStyle = { fontVariant: ['tabular-nums'] };

/** The shell and the play route each render one (inside their CoinToastHost): announce once. */
let announcedKey = 0;

/**
 * The level-up / challenge-complete / streak celebration (lib/level-toast.ts): a card under the coin pill, "Level 5 ·
 * You levelled up · +80 coins" with the new level on an inverted disc, "Challenge complete · Play 3 matches · +35 coins
 * · +50 XP" with a check, or "3-day streak · Streak kept up · +20 coins" with a flame. Monochrome but for the coins'
 * gold. Announced to screen readers; a tap or time dismisses it and the next one in the queue shows. Rendered by
 * `CoinToastHost`, so it also shows over a running game. Enter and exit follow Reduce Motion (`ReduceMotion.System`).
 */
export function CelebrationToast() {
  const c = useCelebration();

  useEffect(() => {
    if (!c) return;
    const t = celebrationText(c);
    if (announcedKey !== c.key) {
      announcedKey = c.key;
      AccessibilityInfo.announceForAccessibility([t.title, t.body, t.reward].filter(Boolean).join(', '));
    }
    const timer = setTimeout(() => hideCelebration(c.key), CELEBRATION_MS);
    return () => clearTimeout(timer);
  }, [c]);

  if (!c) return null;
  return (
    <Animated.View
      key={c.key}
      entering={ZoomIn.springify().damping(16).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutUp.duration(180).reduceMotion(ReduceMotion.System)}
      className="w-full max-w-sm"
    >
      <CelebrationCard celebration={c} onPress={() => hideCelebration(c.key)} />
    </Animated.View>
  );
}

/** The card itself (also used by the screenshot preview). */
export function CelebrationCard({ celebration: c, onPress }: { celebration: Celebration; onPress?: () => void }) {
  const t = celebrationText(c);
  // A challenge leads with its state ("Challenge complete · claim it") over its title; the others lead with the body.
  const caps = c.kind === 'challenge' ? `${t.title} · claim it` : t.body;
  const headline = c.kind === 'challenge' ? t.body : t.title;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="alert"
      accessibilityLabel={[t.title, t.body, t.reward].filter(Boolean).join(', ')}
      accessibilityHint="Dismisses the message"
      className="bg-card border-border flex-row items-center gap-3 rounded-2xl border p-3 pr-4 shadow-lg shadow-black/25 active:opacity-70"
    >
      <View className="bg-foreground border-border size-12 items-center justify-center rounded-full border-2">
        {c.kind === 'level' ? (
          <Text className="text-background text-[19px] font-black leading-6" style={TABULAR}>
            {c.level}
          </Text>
        ) : c.kind === 'streak' ? (
          <Icon as={FlameIcon} className="text-background size-6" />
        ) : (
          <Icon as={CheckIcon} className="text-background size-6" />
        )}
      </View>
      <View className="shrink grow">
        <Text
          className="text-muted-foreground text-[11px] font-bold uppercase leading-4 tracking-widest"
          numberOfLines={1}
        >
          {caps}
        </Text>
        <Text className="text-[17px] font-extrabold leading-[22px] tracking-tight" numberOfLines={1}>
          {headline}
        </Text>
      </View>
      {/* Level-up and streak coins are already paid; a challenge's reward waits for its Claim button. */}
      {(c.kind === 'level' || c.kind === 'streak') && c.coins > 0 ? (
        <View className="bg-gold-soft border-gold-line flex-row items-center gap-1 rounded-full border px-2.5 py-1">
          {/* The coin glyph as components/rally/coins.tsx draws it (imported there, so not imported from it). */}
          <Icon as={CoinsIcon} className="text-gold size-3.5" />
          <Text className="text-foreground text-[13px] font-bold leading-[18px]" style={TABULAR}>
            +{c.coins}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}
