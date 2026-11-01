import type { LaunchContext, LaunchIntent } from '@rally/protocol';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, BackHandler, PixelRatio, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { GameHostController, type DeviceInfo, type GameHostResult, type HapticKind } from './controller';
import { fetchEntryDocument, type EntryDocument } from './entry';
import { usePrefs } from '@/lib/prefs';
import { GameMenu } from './game-menu';
import { MenuButton } from './menu-button';
import {
  DEFAULT_MENU_BUTTON_PREFS,
  buttonBounds,
  setTucked,
  type ButtonOrientation,
  type MenuButtonPrefs,
  type MenuButtonStore,
} from './menu-button-model';
import { NetBanner } from './net-banner';
import type { MatchmakingTarget } from './handlers';
import { buildInjectedScript } from './injected';
import { GameLoadingScreen, GameProblemScreen } from './loading-screen';
import { autoGraphics, menuButtonRect, type GameSettingsStore } from './settings';
import { gameSettingsStore, menuButtonStore } from '@/lib/game-settings';
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
  /** The private room's join code, when known: the game menu's People tab offers Copy / Share. */
  roomCode?: string | null;
  /** `manifest.capabilities`: `haptics` lets the game's `haptics()` requests through (while the player has them on). */
  capabilities?: readonly string[];
  /** The game menu's settings store; default AsyncStorage (platform settings once per device, game settings per game). */
  settingsStore?: GameSettingsStore | null;
  /** Where the menu button was moved or tucked, per game; default AsyncStorage. Null remembers nothing. */
  buttonStore?: MenuButtonStore | null;
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

/** A game's `haptics()` request (games granted the capability, while the player has haptics on). */
function playHaptic(kind: HapticKind): void {
  const done =
    kind === 'success' || kind === 'warning' || kind === 'error'
      ? Haptics.notificationAsync(
          kind === 'success'
            ? Haptics.NotificationFeedbackType.Success
            : kind === 'warning'
              ? Haptics.NotificationFeedbackType.Warning
              : Haptics.NotificationFeedbackType.Error,
        )
      : Haptics.impactAsync(
          kind === 'light'
            ? Haptics.ImpactFeedbackStyle.Light
            : kind === 'medium'
              ? Haptics.ImpactFeedbackStyle.Medium
              : Haptics.ImpactFeedbackStyle.Heavy,
        );
  void done.catch(() => {});
}

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
 * load failures get the same backdrop with Reload / Back. The menu button only shows over a running game.
 */
const ORIGIN_WHITELIST = ['*'];

/** The menu button's remembered place for this game: loaded once (null until then), saved on every change. */
function useMenuButtonPrefs(store: MenuButtonStore | null, gameId: string) {
  const [prefs, setPrefs] = useState<MenuButtonPrefs | null>(store ? null : DEFAULT_MENU_BUTTON_PREFS);
  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    void store.load(gameId).then((loaded) => {
      if (!cancelled) setPrefs(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [store, gameId]);
  const change = useCallback(
    (next: MenuButtonPrefs) => {
      setPrefs(next);
      void store?.save(gameId, next);
    },
    [store, gameId],
  );
  return [prefs, change] as const;
}

export function GameHost(props: GameHostProps) {
  useKeepAwake();
  const { onExit, onPlayRecorded, orientation, bundleUrl, entrySha256 } = props;
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  // The game menu's button over the game; the game keeps its HUD out of this rect (`device.menuButton`).
  const menuButton = useMemo(() => menuButtonRect({ top: insets.top, left: insets.left }), [insets.top, insets.left]);
  const device = useMemo<DeviceInfo>(
    () => ({
      safeArea: { top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left },
      orientation: width > height ? 'landscape' : 'portrait',
      pixelRatio: PixelRatio.get(),
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      menuButton,
    }),
    [insets.top, insets.right, insets.bottom, insets.left, width, height, menuButton],
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
        settingsStore: props.settingsStore === undefined ? gameSettingsStore : props.settingsStore,
        autoGraphics: autoGraphics({ os: Platform.OS, version: Platform.Version, pixelRatio: PixelRatio.get() }),
        playHaptic: props.capabilities?.includes('haptics') ? playHaptic : undefined,
        log: __DEV__ ? (m) => console.log(m) : undefined,
      }),
  );
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const webviewRef = useRef<WebViewHandle>(null);

  // The menu button can be dragged anywhere and tucked to a side (menu-button.tsx); the game is only told the default.
  const [buttonStore] = useState(() => (props.buttonStore === undefined ? menuButtonStore : props.buttonStore));
  const [buttonPrefs, setButtonPrefs] = useMenuButtonPrefs(buttonStore, props.game.id);
  const buttonOrientation: ButtonOrientation = width > height ? 'landscape' : 'portrait';
  const onButtonTucked = useCallback(
    (tucked: boolean) => {
      if (!buttonPrefs) return;
      setButtonPrefs(setTucked(buttonPrefs, buttonOrientation, tucked, buttonBounds(width, height, insets)));
    },
    [buttonPrefs, setButtonPrefs, buttonOrientation, width, height, insets],
  );

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

  // Android back: over the game it opens the game menu and closes it again (Leave is in the menu); while loading it
  // leaves; while leaving it closes a game that ignores the exit request (controller.handleBack).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      controller.handleBack();
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
          // Beside the game-menu button (top-left), never under it.
          style={{ top: menuButton.y + 8, left: menuButton.x + menuButton.width + 8 }}
        >
          <Text className="font-mono text-[12px] font-semibold leading-4 text-white" style={styles.fps}>
            {view.fps} fps
          </Text>
        </View>
      )}

      {view.phase === 'loading' && (
        <GameLoadingScreen
          // Prefixed: the WebView beside it is keyed by the bare attempt number (React needs sibling keys unique).
          key={`loading-${view.attempt}`}
          title={props.title ?? null}
          artUri={props.artUri}
          iconUri={props.iconUri}
          progress={view.progress}
          status={view.status}
          detail={view.detail}
          onLeave={() => controller.requestExit()}
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

      {/* Reconnecting / Connection lost, from the game's net.status (top-centre, clear of the default button spot;
          the button draws over it if the player moved it there). */}
      {view.phase === 'ready' && (
        <NetBanner
          net={view.net}
          top={menuButton.y}
          inset={menuButton.x + menuButton.width + 12}
          onLeave={controller.leave}
        />
      )}

      {/* The game menu's button over a running game: top-left by default (the game keeps its HUD out of that rect),
          movable and tuckable by the player. Hidden while the menu is open. The loading screen has its own "Leave",
          the problem screens their "Back". */}
      {view.phase === 'ready' && buttonPrefs !== null && (
        <MenuButton
          width={width}
          height={height}
          insets={insets}
          orientation={buttonOrientation}
          prefs={buttonPrefs}
          onPrefsChange={setButtonPrefs}
          onOpen={controller.openMenu}
          hidden={view.menuOpen}
          haptics={view.settings.platform.haptics}
        />
      )}

      {view.phase === 'ready' && view.menuOpen && (
        <GameMenu
          title={props.title ?? null}
          iconUri={props.iconUri}
          menu={view.menu}
          settings={view.settings}
          leaving={view.leaving}
          roomCode={props.roomCode ?? null}
          net={view.net}
          onResume={controller.closeMenu}
          onLeave={controller.leave}
          onChange={controller.changeSettings}
          buttonTucked={buttonPrefs?.tucked ?? false}
          onButtonTuckedChange={buttonPrefs ? onButtonTucked : undefined}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fps: { fontVariant: ['tabular-nums'] },
  root: { flex: 1, backgroundColor: '#0A0A0A' },
  webview: { flex: 1, backgroundColor: '#0A0A0A' },
});
