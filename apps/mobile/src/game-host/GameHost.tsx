import type { LaunchContext, LaunchIntent } from '@rally/protocol';
import * as Crypto from 'expo-crypto';
import { useKeepAwake } from 'expo-keep-awake';
import * as ScreenOrientation from 'expo-screen-orientation';
import { XIcon } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, BackHandler, PixelRatio, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { GameHostController, type DeviceInfo, type GameHostResult } from './controller';
import type { MatchmakingTarget } from './handlers';
import { buildInjectedScript } from './injected';
import type { PlaySessionService } from './play-session';
import type { ProgressStore } from './progress';
import type { SaveStore } from './saves';
import { WebView, type WebViewHandle } from './webview';

export type { GameHostResult } from './controller';

export interface GameHostProps {
  /** Absolute URL of the game's entry document (`game_versions.entry_url`). */
  bundleUrl: string;
  game: LaunchContext['game'];
  /** Identity handed to the game in `ready()`; only after the 4.7.3 consent sheet was accepted. */
  user: LaunchContext['user'];
  intent: LaunchIntent;
  orientation: 'portrait' | 'landscape' | 'any';
  saves: SaveStore;
  /** Leaderboards + achievements behind the bridge. */
  progress: ProgressStore;
  /** False for multiplayer games (manifest `server`): `leaderboard.submit` answers NOT_SUPPORTED. */
  soloScores: boolean;
  /** Server play session (started at mount, closed once on exit); null records nothing (Developer launcher). */
  playSessions: PlaySessionService | null;
  matchmaking: MatchmakingTarget | null;
  onExit: (result: GameHostResult) => void;
  /** Called once the play was recorded server-side (session closed or `record_play`), e.g. to refresh leaderboards. */
  onPlayRecorded?: () => void;
}

function newNonce(): string {
  return Array.from(Crypto.getRandomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Full-screen game screen: WebView configured per architecture §2 plus the host side of the bridge.
 * Session state lives in a GameHostController created once per mount (key the component to relaunch); this
 * component only renders the controller's snapshot and forwards callbacks. Every session ends in exactly one
 * `onExit`, with `reason: 'unmount'` when the component unmounts first (the callee must not navigate then).
 * `bundleUrl`, `game`, `user`, `intent`, `saves`, `progress`, `soloScores`, `playSessions` and `matchmaking` are read
 * at mount.
 */
const ORIGIN_WHITELIST = ['*'];

export function GameHost(props: GameHostProps) {
  useKeepAwake();
  const { onExit, onPlayRecorded, orientation, bundleUrl } = props;
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const device = useMemo<DeviceInfo>(
    () => ({
      safeArea: { top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left },
      orientation: width > height ? 'landscape' : 'portrait',
      pixelRatio: PixelRatio.get(),
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
    }),
    [insets.top, insets.right, insets.bottom, insets.left, width, height],
  );

  const [controller] = useState(
    () =>
      new GameHostController({
        bundleUrl: props.bundleUrl,
        game: props.game,
        user: props.user,
        intent: props.intent,
        saves: props.saves,
        progress: props.progress,
        soloScores: props.soloScores,
        playSessions: props.playSessions,
        matchmaking: props.matchmaking,
        device,
        onExit: props.onExit,
        onPlayRecorded: props.onPlayRecorded,
        createNonce: newNonce,
      }),
  );
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const webviewRef = useRef<WebViewHandle>(null);

  useEffect(() => {
    controller.update({ device, onExit, onPlayRecorded });
  }, [controller, device, onExit, onPlayRecorded]);

  // The controller reaches the current WebView (re-keyed on reload) through this getter, never during render.
  useEffect(() => {
    controller.setWebView(() => webviewRef.current);
    return () => controller.setWebView(null);
  }, [controller]);

  // Unmounting without an exit (navigation away, sign-out) still ends the session: finish('unmount').
  useEffect(() => {
    controller.start();
    return () => controller.unmount();
  }, [controller]);

  // Orientation lock per manifest.
  useEffect(() => {
    const lock =
      orientation === 'landscape'
        ? ScreenOrientation.OrientationLock.LANDSCAPE
        : orientation === 'portrait'
          ? ScreenOrientation.OrientationLock.PORTRAIT_UP
          : null;
    if (lock !== null) ScreenOrientation.lockAsync(lock).catch(() => {});
    return () => {
      ScreenOrientation.unlockAsync().catch(() => {});
    };
  }, [orientation]);

  // Background / foreground → pause / resume.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') controller.setAppActive(true);
      else if (state === 'background' || state === 'inactive') controller.setAppActive(false);
    });
    return () => sub.remove();
  }, [controller]);

  // Android back: first press asks the game to exit; a second press within 2 s force-exits.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      controller.requestExit();
      return true;
    });
    return () => sub.remove();
  }, [controller]);

  const injected = useMemo(() => buildInjectedScript(view.nonce), [view.nonce]);

  return (
    <View style={styles.root}>
      {view.phase !== 'crashed' && (
        <WebView
          key={view.attempt}
          ref={webviewRef}
          style={styles.webview}
          source={{ uri: bundleUrl }}
          // Navigation gate: react-native-webview 14 hands any URL that fails `originWhitelist` to
          // Linking.openURL (Safari, tel:, the app's own rally:// routes), so the whitelist lets everything
          // through and onShouldStartLoadWithRequest is the only gate: bundle directory (http/https) or nothing.
          originWhitelist={ORIGIN_WHITELIST}
          onShouldStartLoadWithRequest={(req) => controller.allowNavigation(req.url)}
          injectedJavaScriptBeforeContentLoaded={injected}
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly
          onMessage={(e) => controller.handleMessage(e.nativeEvent.data, e.nativeEvent.url)}
          // Security (architecture §2)
          setSupportMultipleWindows={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          allowsLinkPreview={false}
          javaScriptCanOpenWindowsAutomatically={false}
          // Game-friendly WebView behaviour
          javaScriptEnabled
          domStorageEnabled
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          allowsBackForwardNavigationGestures={false}
          androidLayerType="hardware"
          contentMode="mobile"
          webviewDebuggingEnabled={__DEV__}
          // Crash handling
          onContentProcessDidTerminate={() =>
            controller.onProcessGone('WebView content process terminated (iOS memory pressure)')
          }
          onRenderProcessGone={(e) =>
            controller.onProcessGone(`WebView render process gone (didCrash=${String(e.nativeEvent.didCrash)})`)
          }
          onError={(e) => controller.onLoadError(`load error: ${e.nativeEvent.description}`)}
          onHttpError={(e) => controller.onLoadError(`HTTP ${e.nativeEvent.statusCode} loading ${e.nativeEvent.url}`)}
          onLoadStart={(e) => controller.onMainFrameLoadStart(e.nativeEvent.url)}
          onLoadProgress={(e) => controller.onLoadProgress(e.nativeEvent.progress)}
        />
      )}

      {view.phase === 'loading' && (
        <View
          className="bg-background absolute inset-0 items-center justify-center gap-3 p-6"
          style={{ paddingTop: insets.top }}
          pointerEvents="box-none"
        >
          <ActivityIndicator size="large" />
          <Text variant="large">{view.status}</Text>
          <View className="bg-muted h-1 w-56 overflow-hidden rounded-full">
            <View className="bg-primary h-1" style={{ width: `${Math.round(view.progress * 100)}%` }} />
          </View>
          {__DEV__ && (
            <Text variant="muted" numberOfLines={1}>
              {bundleUrl}
            </Text>
          )}
        </View>
      )}

      {(view.phase === 'crashed' || view.phase === 'failed') && (
        <View className="bg-background absolute inset-0 items-center justify-center gap-3 p-6">
          <Text variant="h4">{view.phase === 'crashed' ? 'The game crashed' : 'The game failed to start'}</Text>
          <Text variant="muted" className="text-center">
            {view.error ?? 'unknown error'}
          </Text>
          <View className="mt-2 flex-row gap-3">
            <Button onPress={() => controller.reload()}>
              <Text>Reload</Text>
            </Button>
            <Button variant="secondary" onPress={() => controller.finish(view.phase)}>
              <Text>Back</Text>
            </Button>
          </View>
        </View>
      )}

      {/* Close affordance for iOS (no hardware back). Games draw under it; the HUD is top-left. */}
      <Pressable
        accessibilityLabel="Close game"
        onPress={() => controller.requestExit()}
        className="bg-card border-border absolute h-8 w-8 items-center justify-center rounded-full border"
        style={{ top: Math.max(insets.top, 8), right: Math.max(insets.right, 8) }}
        hitSlop={12}
      >
        <Icon as={XIcon} className="size-4" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },
  webview: { flex: 1, backgroundColor: '#0A0A0A' },
});
