import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, PixelRatio, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewHandle, type WebViewMessageEvent, type WebViewNavigation } from './webview';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useKeepAwake } from 'expo-keep-awake';
import * as Crypto from 'expo-crypto';
import type { LaunchContext } from '@rally/protocol';
import { HostBridge } from './bridge';
import { createSpikeHandlers } from './handlers';
import { buildDeliverScript, buildInjectedScript } from './injected';

/** How long the game may take from first byte to `ready()` before we show the failure overlay. */
const READY_TIMEOUT_MS = 20_000;

export interface GameHostResult {
  reason: string;
  readyMs: number | null;
  metrics: Record<string, number | string | boolean> | null;
  error: string | null;
}

export interface GameHostProps {
  gameId: string;
  gameVersion: string;
  bundleUrl: string;
  colyseusHttpUrl: string;
  colyseusWsUrl: string;
  roomName: string;
  orientation: 'portrait' | 'landscape' | 'any';
  onExit: (result: GameHostResult) => void;
}

type Phase = 'loading' | 'ready' | 'crashed' | 'failed';

function newNonce(): string {
  return Array.from(Crypto.getRandomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function GameHost(props: GameHostProps) {
  useKeepAwake();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const webviewRef = useRef<WebViewHandle>(null);

  const [phase, setPhase] = useState<Phase>('loading');
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('Loading…');
  const [reloadKey, setReloadKey] = useState(0);

  const startedAt = useRef(Date.now());
  const readyMs = useRef<number | null>(null);
  const lastMetrics = useRef<Record<string, number | string | boolean> | null>(null);
  const lastError = useRef<string | null>(null);
  const exited = useRef(false);
  const exitRequestedAt = useRef(0);

  const nonce = useMemo(() => newNonce(), [reloadKey]);

  const finish = useCallback(
    (reason: string) => {
      if (exited.current) return;
      exited.current = true;
      props.onExit({ reason, readyMs: readyMs.current, metrics: lastMetrics.current, error: lastError.current });
    },
    [props.onExit],
  );

  const launchContext = useMemo<LaunchContext>(
    () => ({
      game: { id: props.gameId, version: props.gameVersion },
      // M0: no accounts yet. M1 fills this from the Supabase session.
      user: { id: 'spike-tester', username: 'spike-tester', avatarUrl: null },
      intent: 'quick',
      device: {
        safeArea: { top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left },
        orientation: width > height ? 'landscape' : 'portrait',
        pixelRatio: PixelRatio.get(),
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
      },
    }),
    [props.gameId, props.gameVersion, insets.top, insets.right, insets.bottom, insets.left, width, height],
  );

  const bridge = useMemo(() => {
    const b = new HostBridge({
      nonce,
      bundleUrl: props.bundleUrl,
      deliver: (json) => webviewRef.current?.injectJavaScript(buildDeliverScript(json)),
      handlers: createSpikeHandlers({
        launchContext,
        colyseusHttpUrl: props.colyseusHttpUrl,
        colyseusWsUrl: props.colyseusWsUrl,
        roomName: props.roomName,
        onReady: () => {
          readyMs.current = Date.now() - startedAt.current;
          setPhase('ready');
        },
        onLoading: (p) => setProgress(p),
        onExit: (reason) => finish(reason),
      }),
      onGameEvent: (ev) => {
        if (ev.method === 'telemetry.report') lastMetrics.current = ev.params.values;
        else if (ev.method === 'game.error') lastError.current = ev.params.message;
      },
      onDrop: (reason) => console.warn('[bridge] dropped message:', reason),
    });
    return b;
    // launchContext is intentionally captured once per load; safe-area changes mid-game do not restart the bridge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, props.bundleUrl, props.colyseusHttpUrl, props.colyseusWsUrl, props.roomName, finish]);

  useEffect(() => () => bridge.close(), [bridge]);

  // Orientation lock per manifest.
  useEffect(() => {
    const lock =
      props.orientation === 'landscape'
        ? ScreenOrientation.OrientationLock.LANDSCAPE
        : props.orientation === 'portrait'
          ? ScreenOrientation.OrientationLock.PORTRAIT_UP
          : null;
    if (lock !== null) ScreenOrientation.lockAsync(lock).catch(() => {});
    return () => {
      ScreenOrientation.unlockAsync().catch(() => {});
    };
  }, [props.orientation]);

  // Background / foreground → pause / resume.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') bridge.sendEvent('resume', {});
      else if (state === 'background' || state === 'inactive') bridge.sendEvent('pause', {});
    });
    return () => sub.remove();
  }, [bridge]);

  // Android back: first press asks the game to exit; a second press within 2 s force-exits.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      requestExit();
      return true;
    });
    return () => sub.remove();
  });

  const requestExit = useCallback(() => {
    const now = Date.now();
    if (phase !== 'ready' || now - exitRequestedAt.current < 2000) {
      finish('forced');
      return;
    }
    exitRequestedAt.current = now;
    bridge.sendEvent('exitRequested', {});
    setStatus('Leaving…');
  }, [bridge, finish, phase]);

  // Load timeout.
  useEffect(() => {
    if (phase !== 'loading') return;
    const t = setTimeout(() => {
      lastError.current ??= `game did not call ready() within ${READY_TIMEOUT_MS / 1000}s`;
      setPhase('failed');
    }, READY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [phase, reloadKey]);

  const reload = useCallback(() => {
    startedAt.current = Date.now();
    readyMs.current = null;
    lastError.current = null;
    setProgress(0);
    setPhase('loading');
    setStatus('Loading…');
    setReloadKey((k) => k + 1);
  }, []);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => bridge.handleMessage(e.nativeEvent.data, e.nativeEvent.url),
    [bridge],
  );

  const onShouldStartLoadWithRequest = useCallback(
    (req: WebViewNavigation) => {
      if (bridge.isInsideBundle(req.url)) return true;
      console.warn('[bridge] blocked navigation to', req.url);
      return false;
    },
    [bridge],
  );

  const origin = useMemo(() => new URL(props.bundleUrl).origin, [props.bundleUrl]);

  return (
    <View style={styles.root}>
      {phase !== 'crashed' && (
        <WebView
          key={reloadKey}
          ref={webviewRef}
          style={styles.webview}
          source={{ uri: props.bundleUrl }}
          originWhitelist={[origin]}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          injectedJavaScriptBeforeContentLoaded={buildInjectedScript(nonce)}
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly
          onMessage={onMessage}
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
          onContentProcessDidTerminate={() => {
            lastError.current = 'WebView content process terminated (iOS memory pressure)';
            setPhase('crashed');
          }}
          onRenderProcessGone={(e) => {
            lastError.current = `WebView render process gone (didCrash=${String(e.nativeEvent.didCrash)})`;
            setPhase('crashed');
          }}
          onError={(e) => {
            lastError.current = `load error: ${e.nativeEvent.description}`;
            setPhase('failed');
          }}
          onHttpError={(e) => {
            lastError.current = `HTTP ${e.nativeEvent.statusCode} loading ${e.nativeEvent.url}`;
            setPhase('failed');
          }}
          onLoadProgress={(e) => {
            if (phase === 'loading') setProgress(Math.max(progress, e.nativeEvent.progress * 0.5));
          }}
        />
      )}

      {phase === 'loading' && (
        <View style={[styles.overlay, { paddingTop: insets.top }]} pointerEvents="box-none">
          <ActivityIndicator color="#41b6e6" size="large" />
          <Text style={styles.title}>{status}</Text>
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${Math.round(progress * 100)}%` }]} />
          </View>
          <Text style={styles.small} numberOfLines={1}>
            {props.bundleUrl}
          </Text>
        </View>
      )}

      {(phase === 'crashed' || phase === 'failed') && (
        <View style={styles.overlay}>
          <Text style={styles.title}>{phase === 'crashed' ? 'The game crashed' : 'The game failed to start'}</Text>
          <Text style={styles.small}>{lastError.current ?? 'unknown error'}</Text>
          <View style={styles.row}>
            <Pressable style={styles.button} onPress={reload}>
              <Text style={styles.buttonText}>Reload</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.buttonSecondary]} onPress={() => finish(phase)}>
              <Text style={styles.buttonText}>Back</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Close affordance for iOS (no hardware back). Games draw under it; the HUD is top-left. */}
      <Pressable
        accessibilityLabel="Close game"
        onPress={requestExit}
        style={[styles.close, { top: Math.max(insets.top, 8), right: Math.max(insets.right, 8) }]}
        hitSlop={12}
      >
        <Text style={styles.closeText}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b1019' },
  webview: { flex: 1, backgroundColor: '#0b1019' },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    backgroundColor: '#0b1019',
  },
  title: { color: '#f8fafc', fontSize: 18, fontWeight: '600' },
  small: { color: '#9fb3c8', fontSize: 12, textAlign: 'center' },
  bar: { width: 220, height: 4, borderRadius: 2, backgroundColor: '#1f2a3a', overflow: 'hidden' },
  barFill: { height: 4, backgroundColor: '#41b6e6' },
  row: { flexDirection: 'row', gap: 12, marginTop: 8 },
  button: { backgroundColor: '#334867', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 },
  buttonSecondary: { backgroundColor: '#263247' },
  buttonText: { color: '#f8fafc', fontWeight: '600' },
  close: {
    position: 'absolute',
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0b1019aa',
  },
  closeText: { color: '#f8fafc', fontSize: 16, lineHeight: 18 },
});
