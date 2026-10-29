import { router } from 'expo-router';
import { Gamepad2Icon, MoonStarIcon, PlayIcon, SunIcon } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Uniwind, useUniwind } from 'uniwind';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { launchStore, useLaunchStore } from '@/launch-store';

export default function SpikeLauncher() {
  const { settings, lastRun } = useLaunchStore();
  const insets = useSafeAreaInsets();
  const { theme } = useUniwind();

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="gap-4 p-4"
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      keyboardShouldPersistTaps="handled"
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <Icon as={Gamepad2Icon} className="text-primary size-6" />
          <Text variant="h3">M0 spike</Text>
          <Badge variant="secondary">
            <Text>dev</Text>
          </Badge>
        </View>
        <Button
          size="icon"
          variant="ghost"
          className="rounded-full"
          accessibilityLabel="Toggle theme"
          onPress={() => Uniwind.setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          <Icon as={theme === 'dark' ? SunIcon : MoonStarIcon} />
        </Button>
      </View>

      <Text variant="muted">
        Loads the PlayCanvas spike full-screen in a WebView, completes the bridge handshake, matchmakes into the Colyseus hello
        room and reports FPS, frame time, bridge RTT and socket RTT.
      </Text>

      <Card>
        <CardHeader>
          <CardTitle>Endpoints</CardTitle>
          <CardDescription>Where the shell loads the bundle from and which game server it matchmakes against.</CardDescription>
        </CardHeader>
        <CardContent className="gap-4">
          <View className="gap-1.5">
            <Label nativeID="bundleUrl">Game bundle URL</Label>
            <Input
              aria-labelledby="bundleUrl"
              value={settings.bundleUrl}
              onChangeText={(bundleUrl) => launchStore.setSettings({ bundleUrl })}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://…/games/spike/0.1.0/index.html"
            />
          </View>
          <View className="gap-1.5">
            <Label nativeID="colyseusUrl">Colyseus HTTP URL</Label>
            <Input
              aria-labelledby="colyseusUrl"
              value={settings.colyseusUrl}
              onChangeText={(colyseusUrl) => launchStore.setSettings({ colyseusUrl: colyseusUrl.replace(/\/$/, '') })}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://<app>.colyseus.cloud"
            />
          </View>
          <Button size="lg" onPress={() => router.push('/game/spike')}>
            <Icon as={PlayIcon} />
            <Text>Launch spike</Text>
          </Button>
        </CardContent>
      </Card>

      {lastRun && (
        <Card>
          <CardHeader>
            <CardTitle>Last run</CardTitle>
            <CardDescription>
              {new Date(lastRun.endedAt).toLocaleTimeString()} · {lastRun.reason}
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-2">
            <Row k="ready()" v={lastRun.readyMs === null ? '—' : `${lastRun.readyMs} ms`} />
            {lastRun.error && <Row k="error" v={lastRun.error} />}
            {lastRun.metrics && (
              <>
                <Separator className="my-1" />
                {Object.entries(lastRun.metrics).map(([k, v]) => (
                  <Row key={k} k={k} v={String(v)} />
                ))}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Text variant="muted" className="text-xs leading-5">
        Memory is measured from Xcode Instruments / Android Studio Profiler on the WebView content process (architecture §10, M0
        verification).
      </Text>
    </ScrollView>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View className="flex-row justify-between gap-3">
      <Text variant="muted">{k}</Text>
      <Text className="shrink text-right font-mono text-sm" selectable>
        {v}
      </Text>
    </View>
  );
}
