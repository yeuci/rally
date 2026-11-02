# Rally

One app, many games. See [`idea.md`](idea.md) for the product and [`docs/architecture.md`](docs/architecture.md); new developers start at [`docs/onboarding.md`](docs/onboarding.md)
for the design; decisions are recorded in [`docs/decisions/`](docs/decisions/).

**Status: M0 spike** (architecture §10). This repo currently contains the minimal monorepo needed to prove
the core bet: a PlayCanvas scene running full-screen in a WebView inside an Expo app, talking to the shell
through the Rally SDK bridge, with a Colyseus WebSocket opened from inside the WebView.

## Layout

```
apps/mobile          Expo shell (expo-router). Host side of the bridge in src/game-host/
apps/game-server     Colyseus deployment; src/registry.ts lists every game's Room
packages/protocol    @rally/protocol — zod schemas + types: bridge envelope, methods, launch context, manifest
packages/sdk         @rally/sdk — bridge client that runs inside the game WebView (ESM + IIFE)
games/spike          The M0 spike game (game.json + Vite/TS/PlayCanvas client)
docs/                architecture.md, decisions/ (ADRs)
```

## Releasing (owner)

```bash
pnpm ship          # pull main, push migrations, redeploy the game server if its code changed, publish new game versions
pnpm ship:status   # what `pnpm ship` would do, without doing it
pnpm app           # start the app for Expo Go (tunnel)
pnpm app:fast      # the same at release speed (minified, no dev-mode checks): judge smoothness and startup with this
```

Single steps: `pnpm ship:db`, `pnpm ship:server`, `pnpm ship:games [ids]`. Setup and details:
[`tooling/release/README.md`](tooling/release/README.md).

## Prerequisites

- Node 22+, pnpm 10 (`corepack enable`)
- For the phone test: Xcode and/or Android Studio, or an Expo account for EAS builds

## Run the spike

```bash
pnpm install
pnpm typecheck && pnpm build && pnpm test
```

1. **Game server** — `pnpm dev:server` (Colyseus on `http://localhost:2567`, playground at `/`).
2. **Game bundle** — `pnpm dev:spike` serves `games/spike/client` on `http://<your-lan-ip>:5180`. Open it on the desktop
   to see the scene standalone; add `?colyseus=ws://localhost:2567` to join the hello room without the shell.
3. **Shell** — `pnpm dev:mobile:go` opens the app in Expo Go (`pnpm dev:mobile:go:clear` after pulling changes to routes or styles). `cp apps/mobile/.env.example apps/mobile/.env`, set both URLs to your LAN IP, then build a dev client
   (`pnpm --filter @rally/mobile ios` / `android`, or EAS) and `pnpm dev:mobile`. Tap **Launch spike**.

For the real M0 measurement, publish `games/spike/client/dist` to Supabase Storage (public bucket
`games/spike/0.1.0/`) and point the bundle URL at `index.html` there, and deploy `apps/game-server` to
Colyseus Cloud. M1 adds `tooling/publish-game` to automate the former.

## What M0 must show (architecture "Verification")

On a real iPhone and a low-end Android: ≥ 50 fps at DPR 2 with 300 cubes, WebView memory under ~300 MB
(Xcode Instruments / Android Studio profiler), warm load under 3 s, bridge round-trip working with the
nonce, and the WebSocket from the WebView reaching the Colyseus hello room (visible in the monitor).
If this fails, revisit ADR 0002 before writing any social code.
