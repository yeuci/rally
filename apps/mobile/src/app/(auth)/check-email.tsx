import { router, useLocalSearchParams } from 'expo-router';
import { MailCheckIcon } from 'lucide-react-native';
import { View } from 'react-native';
import { AuthScreen } from '@/components/rally/auth-screen';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';

export default function CheckEmail() {
  const { email } = useLocalSearchParams<{ email?: string }>();
  return (
    <AuthScreen
      footer={
        <Button size="lg" variant="secondary" onPress={() => router.replace('/sign-in')}>
          <Text>Back to sign in</Text>
        </Button>
      }
    >
      <View className="items-center gap-4 pt-10">
        <View className="bg-muted size-16 items-center justify-center rounded-2xl">
          <Icon as={MailCheckIcon} className="size-8" />
        </View>
        <Text variant="h3" className="text-center">
          Check your inbox
        </Text>
        <Text variant="muted" className="text-center text-base leading-6">
          We sent a confirmation link to {email || 'your email'}. Open it on this phone to finish signing up.
        </Text>
      </View>
    </AuthScreen>
  );
}
