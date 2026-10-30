# ADR 0002 — Game runtime: HTML5/WebGL bundles in a WebView behind a bridge

**Status:** Accepted · 2026-10

## Context

The MVP requires "dynamic game loading": new games and game updates must ship without an app-store release. The engine question (ADR 0003) is secondary to *how games run inside the app*, because that decides what can be delivered at runtime under Apple's and Google's policies.

Options considered:

1. **Games as web bundles (HTML/JS/WebGL) in a full-screen WebView**, talking to the shell over a message bridge.
2. **Games as JS bundles executed in the React Native runtime** (Hermes) with a native/GL renderer (e.g. R3F on `expo-gl`), hot-loaded from a CDN.
3. **Games compiled into the binary**; every new game is an app update.
4. **Native plug-in frameworks** (Unity/Godot embedded), each game a native module.

Verified platform facts (2026-10): App Store guideline 4.7 explicitly permits HTML5 mini apps/games not embedded in the binary, with obligations on the host (4.7.1–4.7.5). Google Play's executable-code policy exempts JavaScript running in a WebView. Hot-loading arbitrary code into Hermes is a policy gray area (2.5.2).

## Decision

Each game is a self-contained static bundle (`index.html` + hashed assets) built with Vite and loaded full-screen in `react-native-webview` (WKWebView / Android WebView). Game ↔ shell communication goes through a small, versioned, zod-validated message protocol (`@rally/protocol`) exposed to games as `@rally/sdk`. The game's multiplayer socket (Colyseus) is opened directly from the WebView, not relayed through the bridge.

Delivery: MVP loads bundles over HTTPS from Supabase Storage/CDN; before submission (M6) bundles are also shipped inside the binary and served from an on-device static HTTP server with sha256 verification. `file://` loading is never used.

Bundles are untrusted: they receive only what the bridge hands them (identity summary, a single-use seat reservation, per-game save data) and never a Supabase session or key.

## Consequences

- Games can be published by uploading a folder and flipping a pointer; the app binary is untouched. This is the property the whole product depends on.
- The host must satisfy 4.7: filtering/report/block, IAP for digital goods, no native API exposure without permission (haptics/orientation sit behind a kill switch), per-game consent sheet for sharing identity, a Universal Link index per game, per-game age rating. These are design constraints on the shell, not optional features.
- Performance ceiling is WebGL/WebGPU in a WebView rather than native GL. M0 validates this on a mid-range iPhone and a low-end Android before any social code is written; if it fails, this decision is revisited.
- iOS can kill the WebView content process under memory pressure with no warning; the host must detect it and offer reload. Bundles are budgeted at ~25 MB.
- The bridge is a security boundary: origin pinning, per-launch nonce, CSP + SRI, no `window.open`, no file access, rate-limited methods.
- Option 2 was rejected for the 2.5.2 gray area, lower performance ceiling, painful asset loading and the maintenance state of `expo-gl`. Option 3 defeats the MVP requirement. Option 4 multiplies binary size and native complexity per game.
