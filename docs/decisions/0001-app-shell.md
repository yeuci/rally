# ADR 0001 — App shell: React Native + Expo

**Status:** Accepted · 2026-10

## Context

Rally is one mobile app for iOS and Android that hosts many small games behind a shared social layer (dashboard, profiles, friends, chat, parties, notifications). The shell is mostly conventional product UI; it is built and maintained by a solo developer who needs one codebase, fast iteration, and store-compliant native integrations (push, deep links, orientation, keep-awake, secure storage).

Options considered:

1. **React Native + Expo** (TypeScript, New Architecture, expo-router, EAS builds).
2. **Flutter.**
3. **Two native apps** (SwiftUI + Jetpack Compose).
4. **A single WebView app** (Capacitor-style) where the shell itself is a web page.

## Decision

React Native with Expo, TypeScript, New Architecture only (Expo SDK 55+). Navigation with expo-router. Native builds via EAS dev builds from day one because the game runtime (ADR 0002) needs config plugins and third-party native modules (`react-native-webview`, later a local static server) that Expo Go cannot load.

## Consequences

- One TypeScript codebase for the shell, the game SDK, the protocol package and the game server (see architecture §1 monorepo), so types flow end to end.
- Expo gives push (`expo-notifications`), deep links, orientation lock, keep-awake, file system and OTA updates for the *shell* without native code; the native escape hatch exists when needed.
- Hot-loading game code into the React Native runtime is explicitly **not** done (App Store 2.5.2); games run in a WebView (ADR 0002). The shell therefore stays a normal RN app from Apple's point of view.
- EAS dev builds mean a Mac or EAS cloud build for iOS; Expo Go is not supported for development.
- Flutter was rejected because the web-based game runtime and SDK are TypeScript, and sharing types/zod schemas across shell, SDK and server is worth more than Flutter's rendering advantages. Native twins double the surface for a solo developer. A pure WebView shell would weaken the "native social layer is first-class" argument that App Store 4.7 "primary purpose" rejections hinge on.
