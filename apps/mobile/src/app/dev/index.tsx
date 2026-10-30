import { router } from 'expo-router';
import { Gamepad2Icon, MoonStarIcon, PlayIcon, SunIcon } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUniwind } from 'uniwind';
import { ErrorText } from '@/components/rally/form-field';
import { Segmented } from '@/components/rally/segmented';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { RoomLookupError, roomByCode } from '@/game-host/matchmake';
import { DEV_ROOM_PRESETS, launchStore, useLaunchStore, type DevJoinMode } from '@/launch-store';
import { ROOM_ID_RE, joinTargetParams, targetForCode, type JoinTarget } from '@/lib/join-target';
import { prefs } from '@/lib/prefs';
import { useColumnPadding } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';

const JOIN_MODES: readonly { value: DevJoinMode; label: string }[] = [
  { value: 'quick', label: 'Quick' },
  { value: 'create', label: 'Create' },
  { value: 'code', label: 'Code' },
  { value: 'room', label: 'Room id' },
];
const ROOM_TYPE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function lookupMessage(err: unknown): string {
  if (err instanceof RoomLookupError) {
    if (err.code === 'NO_ROOM') return 'No open private room has that code.';
    if (err.code === 'RATE_LIMITED') return 'Too many code attempts. Wait a minute.';
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Developer launcher (the M0 spike path): direct bundle URL + Colyseus URL, room type (`hello` / `sumo`) and join
 * mode (quick / create / code / room id, mapped to the play route's `JoinTarget`), last-run metrics. Works without
 * a Supabase account (guest: no token); saves are in memory. Reachable from the welcome screen and the profile in
 * dev builds.
 */
export default function DeveloperLauncher() {
  const { settings, lastRun } = useLaunchStore();
  const insets = useSafeAreaInsets();
  const column = useColumnPadding(640);
  const { theme } = useUniwind();
  const palette = usePalette();
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  /** Settings → the same `JoinTarget` the play route takes (a code is looked up first, like the code sheet does). */
  async function launch() {
    try {
      const u = new URL(settings.bundleUrl);
      if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
    } catch {
      setError('The bundle URL must be an absolute http(s) URL.');
      return;
    }
    const roomName = settings.roomName.trim();
    if (!ROOM_TYPE_RE.test(roomName)) {
      setError('The room name is a room type of the game server (hello, sumo).');
      return;
    }
    let target: JoinTarget;
    const value = settings.joinValue.trim();
    if (settings.join === 'room') {
      if (!ROOM_ID_RE.test(value)) {
        setError('Enter a room id (letters, digits, _ and -).');
        return;
      }
      target = { join: 'room', room: value };
    } else if (settings.join === 'code') {
      setLooking(true);
      try {
        const found = await targetForCode(value, roomName, (code) => roomByCode(settings.colyseusUrl, code));
        if (!found.ok) {
          setError(found.reason === 'bad-code' ? 'Codes are 6 characters (no 0, O, 1, I or L).' : `That code is not for a "${roomName}" room.`);
          return;
        }
        target = found.target;
      } catch (err) {
        setError(lookupMessage(err));
        return;
      } finally {
        setLooking(false);
      }
    } else {
      target = { join: settings.join };
    }
    setError(null);
    router.push({ pathname: '/dev/play', params: joinTargetParams(target) });
  }

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="gap-4 pt-4"
      contentContainerStyle={[column, { paddingBottom: insets.bottom + 24 }]}
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
          // Through the preference (persisted, and Settings → Appearance shows it), not Uniwind.setTheme directly.
          onPress={() => prefs.update({ appearance: theme === 'dark' ? 'light' : 'dark' })}
        >
          <Icon as={theme === 'dark' ? SunIcon : MoonStarIcon} />
        </Button>
      </View>

      <Text variant="muted">
        Loads a game bundle full-screen in a WebView, completes the bridge handshake, matchmakes into the chosen Colyseus
        room (as a guest) and reports FPS, frame time, bridge RTT and socket RTT. No account needed: saves stay in memory.
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
          <View className="gap-1.5">
            <Label nativeID="roomName">Room</Label>
            <View className="flex-row items-center gap-2">
              <Input
                aria-labelledby="roomName"
                className="flex-1"
                value={settings.roomName}
                onChangeText={(roomName) => launchStore.setSettings({ roomName })}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="hello"
              />
              {DEV_ROOM_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  size="sm"
                  variant={settings.roomName === preset ? 'secondary' : 'ghost'}
                  onPress={() => launchStore.setSettings({ roomName: preset })}
                >
                  <Text>{preset}</Text>
                </Button>
              ))}
            </View>
          </View>
          <View className="gap-1.5">
            <Label nativeID="joinMode">Join</Label>
            <Segmented
              options={JOIN_MODES}
              value={settings.join}
              onChange={(join) => launchStore.setSettings({ join })}
              accessibilityLabel="How session.join matchmakes"
            />
            {(settings.join === 'code' || settings.join === 'room') && (
              <Input
                aria-labelledby="joinMode"
                value={settings.joinValue}
                onChangeText={(joinValue) => launchStore.setSettings({ joinValue })}
                autoCapitalize={settings.join === 'code' ? 'characters' : 'none'}
                autoCorrect={false}
                placeholder={settings.join === 'code' ? 'K7M-2PQ' : 'room id (from /rooms/<name> or the monitor)'}
              />
            )}
          </View>
          <ErrorText>{error}</ErrorText>
          <Button size="lg" onPress={() => void launch()} disabled={looking}>
            {looking ? <ActivityIndicator color={palette.primaryForeground} /> : <Icon as={PlayIcon} />}
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
            <Row k="entry" v={lastRun.entryMs === null ? '—' : `${lastRun.entryMs} ms`} />
            <Row k="page load" v={lastRun.pageMs === null ? '—' : `${lastRun.pageMs} ms`} />
            <Row k="ready()" v={lastRun.readyMs === null ? '—' : `${lastRun.readyMs} ms`} />
            <Row k="playtime" v={`${lastRun.playtimeS.toFixed(1)} s`} />
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
