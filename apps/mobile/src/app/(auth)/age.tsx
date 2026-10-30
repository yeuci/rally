import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, View, type TextInputInstance } from 'react-native';
import { AuthScreen } from '@/components/rally/auth-screen';
import { ErrorText } from '@/components/rally/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { meetsMinimumAge, parseDob } from '@/lib/auth/age';
import { ageGate, useAgeGate } from '@/lib/auth/age-gate-store';
import { parseSignupMethod } from '@/lib/auth/signup-method';
import { usePalette } from '@/lib/use-palette';

/**
 * Age gate (architecture §8): neutral date-of-birth screen before any account exists. A refusal is remembered
 * on this device and closes signup; the copy does not say why or how to get past it.
 */
export default function AgeGate() {
  const palette = usePalette();
  const method = parseSignupMethod(useLocalSearchParams<{ method?: string }>().method);
  const gate = useAgeGate();
  const [month, setMonth] = useState('');
  const [day, setDay] = useState('');
  const [year, setYear] = useState('');
  const [error, setError] = useState<string | null>(null);
  const dayRef = useRef<TextInputInstance>(null);
  const yearRef = useRef<TextInputInstance>(null);

  if (!gate.loaded) {
    return (
      <View className="bg-background flex-1 items-center justify-center">
        <ActivityIndicator color={palette.mutedForeground} />
      </View>
    );
  }

  if (gate.refused) {
    return (
      <AuthScreen
        title="Sorry"
        lede="We're unable to create a Rally account for you."
        footer={
          <Button variant="secondary" size="lg" onPress={() => router.replace('/welcome')}>
            <Text>Back</Text>
          </Button>
        }
      >
        <View />
      </AuthScreen>
    );
  }

  function submit() {
    const parsed = parseDob(month, day, year);
    if (!parsed.ok) {
      setError(parsed.reason === 'incomplete' ? 'Enter your full date of birth.' : "That date doesn't look right.");
      return;
    }
    if (!meetsMinimumAge(parsed.date)) {
      ageGate.refuse();
      return;
    }
    ageGate.pass(parsed.date);
    router.push({ pathname: '/sign-up', params: { method } });
  }

  const digits = (v: string) => v.replace(/\D/g, '');

  return (
    <AuthScreen
      title="What's your date of birth?"
      lede="We use it to set up your account. It isn't shown on your profile."
      footer={
        <Button size="lg" onPress={submit} disabled={!month || !day || year.length !== 4}>
          <Text>Continue</Text>
        </Button>
      }
    >
      <View className="flex-row gap-3">
        <View className="flex-1 gap-2">
          <Label nativeID="dob-month" className="text-secondary-foreground text-[13px] font-semibold">Month</Label>
          <Input
            aria-labelledby="dob-month"
            value={month}
            onChangeText={(v) => {
              const next = digits(v).slice(0, 2);
              setMonth(next);
              if (next.length === 2) dayRef.current?.focus();
            }}
            keyboardType="number-pad"
            placeholder="MM"
            maxLength={2}
            autoFocus
            className="h-14 text-center text-xl font-semibold"
          />
        </View>
        <View className="flex-1 gap-2">
          <Label nativeID="dob-day" className="text-secondary-foreground text-[13px] font-semibold">Day</Label>
          <Input
            ref={dayRef}
            aria-labelledby="dob-day"
            value={day}
            onChangeText={(v) => {
              const next = digits(v).slice(0, 2);
              setDay(next);
              if (next.length === 2) yearRef.current?.focus();
            }}
            keyboardType="number-pad"
            placeholder="DD"
            maxLength={2}
            className="h-14 text-center text-xl font-semibold"
          />
        </View>
        <View className="flex-[1.6] gap-2">
          <Label nativeID="dob-year" className="text-secondary-foreground text-[13px] font-semibold">Year</Label>
          <Input
            ref={yearRef}
            aria-labelledby="dob-year"
            value={year}
            onChangeText={(v) => setYear(digits(v).slice(0, 4))}
            keyboardType="number-pad"
            placeholder="YYYY"
            maxLength={4}
            className="h-14 text-center text-xl font-semibold"
            returnKeyType="done"
            onSubmitEditing={submit}
          />
        </View>
      </View>
      <ErrorText>{error}</ErrorText>
    </AuthScreen>
  );
}
