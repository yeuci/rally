# apps/mobile

The Rally shell (Expo SDK 58, expo-router, New Architecture). M0 contains the spike launcher and the
`GameHost` screen: a full-screen `react-native-webview` plus the host side of the Rally SDK bridge.

Requires a **development build** (react-native-webview and the static server later are native modules;
Expo Go cannot load them).

```bash
cp .env.example .env            # set your LAN IP / CDN URL
pnpm --filter @rally/mobile ios       # or: npx eas-cli build --profile development --platform ios
pnpm --filter @rally/mobile android
pnpm --filter @rally/mobile start     # Metro for the dev client
```

Bridge host code lives in `src/game-host/`:

- `injected.ts` — the script installed before any game code runs (`window.__rally = { nonce, version, recv }`)
- `bridge.ts` — envelope validation, nonce + origin checks, request dispatch, event delivery
- `handlers.ts` — the M0 handler set (ready, ping, session.join via Colyseus matchmaking, exit, save in memory)
- `GameHost.tsx` — WebView configuration from architecture §2, lifecycle (pause/resume/back/crash) and overlays
