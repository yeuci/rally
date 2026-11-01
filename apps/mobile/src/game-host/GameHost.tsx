import type { LaunchContext, LaunchIntent } from '@rally/protocol';
import * as Crypto from 'expo-crypto';
import { useKeepAwake } from 'expo-keep-awake';
import * as ScreenOrientation from 'expo-screen-orientation';
import { XIcon } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, BackHandler, PixelRatio, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { GameHostController, type DeviceInfo, type GameHostResult } from './controller';
import { fetchEntryDocument, type EntryDocument } from './entry';
import { usePrefs } from '@/lib/prefs';
import type { MatchmakingTarget } from './handlers';
import { buildInjectedScript } from './injected';
import { GameLoadingScreen, GameProblemScreen } from './loading-screen';
import type { PlaySessionService } from './play-session';
import type { ProgressStore } from './progress';
import type { SaveStore } from './saves';
import { WebView, type WebViewHandle } from './webview';

export type { GameHostResult } from './controller';

export interface GameHostProps {
  /** Absolute URL of the game's entry document (`game_versions.entry_url`). */
  bundleUrl: string;
  /** `game_versions.sha256`: the entry document is refused when it does not match. Null skips the check (Developer launcher). */
  entrySha256?: string | null;
  game: LaunchContext['game'];
  /** Display name for the loading screen; null/absent (Developer launcher) shows none. */
  title?: string | null;
  /** The loading screen's background: the cover, else the first screenshot (`coverUriFor(game, 'feature')`). */
  artUri?: string | null;
  /** The game's icon, above the title on the loading screen. */
  iconUri?: string | null;
  /** Bytes of the page's own files (loading-copy.ts `pageBytesOf(manifest)`): "Downloading game files · 1.2 of 3.4 MB". */
  pageBytes?: number | null;
  /** Identity handed to the game in `ready()`; only after the 4.7.3 consent sheet was accepted. */
  user: LaunchContext['user'];
  intent: LaunchIntent;
  /** `join=resume`: the reconnection token the launch context carries (it only informs the game; the host reconnects). */
  resume?: LaunchContext['resume'];
  orientation: 'portrait' | 'landscape' | 'any';
  saves: SaveStore;
  /** Leaderboards + achievements behind the bridge. */
  progress: ProgressStore;
  /** False for multiplayer games (manifest `server`): `leaderboard.submit` and `achievement.unlock` answer NOT_SUPPORTED. */
  soloScores: boolean;
  /**
   * Server play session (started at mount, closed once on exit); null records nothing (Developer launcher, and
   * multiplayer games, whose stats the game server writes).
   */
  playSessions: PlaySessionService | null;
  matchmaking: MatchmakingTarget | null;
  onExit: (result: GameHostResult) => void;
  /** Called once the play was recorded server-side (session closed or `record_play`), e.g. to refresh leaderboards. */
  onPlayRecorded?: () => void;
}

function newNonce(): string {
  return Array.from(Crypto.getRandomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
}

const sha256Hex = (text: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text);

/**
 * Full-screen game screen: WebView configured per architecture §2 plus the host side of the bridge.
 * Session state lives in a GameHostController created once per mount (key the component to relaunch); this
 * component only renders the controller's snapshot and forwards callbacks. Every session ends in exactly one
 * `onExit`, with `reason: 'unmount'` when the component unmounts first (the callee must not navigate then).
 * `bundleUrl`, `game`, `title`, `pageBytes`, `user`, `intent`, `resume`, `saves`, `progress`, `soloScores`,
 * `playSessions` and `matchmaking` (with its join target) are read at mount.
 *
 * While the game loads (`phase === 'loading'`, which includes the hold after `ready()` for games that send loading
 * labels) the loading screen covers the WebView (loading-screen.tsx); it fades out when the game is shown. Crashes and
 * load failures get the same backdrop with Reload / Back. The close button only shows over a running game.
 */
const ORIGIN_WHITELIST = ['*'];

export function GameHost(props: GameHostProps) {
  useKeepAwake();
  const { onExit, onPlayRecorded, orientation, bundleUrl, entrySha256 } = props;
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
        title: props.title ?? null,
        pageBytes: props.pageBytes ?? null,
        user: props.user,
        intent: props.intent,
        resume: props.resume,
        saves: props.saves,
        progress: props.progress,
        soloScores: props.soloScores,
        playSessions: props.playSessions,
        matchmaking: props.matchmaking,
        device,
        onExit: props.onExit,
        onPlayRecorded: props.onPlayRecorded,
        createNonce: newNonce,
        log: __DEV__ ? (m) => console.log(m) : undefined,
      }),
  );
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const webviewRef = useRef<WebViewHandle>(null);

  // The entry document is downloaded and verified here, then given to the WebView as html + baseUrl (see entry.ts:
  // Supabase serves HTML as text/plain). Re-fetched on every "Reload" (`view.attempt`).
  const [fetched, setFetched] = useState<{ attempt: number; doc: EntryDocument } | null>(null);
  const entry = fetched?.attempt === view.attempt ? fetched.doc : null;
  useEffect(() => {
    const attempt = view.attempt;
    let cancelled = false;
    const abort = new AbortController();
    fetchEntryDocument(bundleUrl, {
      expectedSha256: entrySha256 ?? null,
      digest: sha256Hex,
      signal: abort.signal,
      onProgress: (loaded, total) => {
        if (!cancelled) controller.onEntryProgress(loaded, total);
      },
    })
      .then((doc) => {
        if (cancelled) return;
        controller.onEntryLoaded();
        setFetched({ attempt, doc });
      })
      .catch((err: unknown) => {
        if (!cancelled) controller.onLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [controller, bundleUrl, entrySha256, view.attempt]);

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

  const { showFps } = usePrefs();
  const injected = useMemo(() => buildInjectedScript(view.nonce, { fps: showFps }), [view.nonce, showFps]);
  useEffect(() => {
    controller.setFpsOverlay(showFps);
  }, [controller, showFps]);

  return (
    <View style={styles.root}>
      {view.phase !== 'crashed' && entry !== null && (
        <WebView
          key={view.attempt}
          ref={webviewRef}
          style={styles.webview}
          source={{ html: entry.html, baseUrl: entry.baseUrl }}
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

      {view.phase === 'ready' && showFps && view.fps !== null && (
        <View
          pointerEvents="none"
          className="absolute rounded-md bg-black/60 px-1.5 py-0.5"
          style={{ top: insets.top + 6, left: insets.left + 6 }}
        >
          <Text className="font-mono text-[12px] font-semibold leading-4 text-white" style={styles.fps}>
            {view.fps} fps
          </Text>
        </View>
      )}

      {view.phase === 'loading' && (
        <GameLoadingScreen
          key={view.attempt}
          title={props.title ?? null}
          artUri={props.artUri}
          iconUri={props.iconUri}
          progress={view.progress}
          status={view.status}
          detail={view.detail}
          onLeave={controller.requestExit}
          devNote={__DEV__ ? bundleUrl : null}
        />
      )}

      {(view.phase === 'crashed' || view.phase === 'failed') && (
        <GameProblemScreen
          key={`problem-${view.attempt}`}
          title={props.title ?? null}
          artUri={props.artUri}
          iconUri={props.iconUri}
          phase={view.phase}
          error={view.error}
          showError={__DEV__}
          onReload={controller.reload}
          onBack={() => controller.finish(view.phase)}
        />
      )}

      {/* Close affordance for iOS (no hardware back) over a running game; games draw under it, their HUD is top-left.
          The loading screen has its own "Leave", the problem screens their "Back". */}
      {view.phase === 'ready' && (
        <Pressable
          accessibilityLabel="Close game"
          onPress={() => controller.requestExit()}
          className="bg-card border-border absolute h-8 w-8 items-center justify-center rounded-full border"
          style={{ top: Math.max(insets.top, 8), right: Math.max(insets.right, 8) }}
          hitSlop={12}
        >
          <Icon as={XIcon} className="size-4" />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fps: { fontVariant: ['tabular-nums'] },
  root: { flex: 1, backgroundColor: '#0A0A0A' },
  webview: { flex: 1, backgroundColor: '#0A0A0A' },
});
