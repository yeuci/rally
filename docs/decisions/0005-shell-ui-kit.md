# ADR 0005 — Shell UI kit: React Native Reusables on Uniwind

**Status:** Accepted · 2026-10

## Context

The Expo shell is conventional product UI (dashboard, catalog, profiles, friends, chat, parties). It must look clean and
be fast, and it is built by a solo developer whose UI habits come from React on the web with shadcn/ui. shadcn itself
cannot run in React Native: it is built on Radix primitives and Tailwind classes applied to DOM elements, and native
views have no DOM.

Options considered:

1. **React Native Reusables** — a port of shadcn/ui's model (components copied into the repo as owned source, styled with
   Tailwind classNames) with **Uniwind** as the Tailwind engine.
2. **Tamagui** — a full design system with an optimizing compiler that flattens components to raw native views.
3. **gluestack-ui v4/v5** — shadcn-inspired, also on Uniwind/NativeWind; alpha at the time of writing.
4. **Installed kits** (React Native Paper, HeroUI Native) with their own styling APIs.

## Decision

React Native Reusables components, styled with Tailwind 4 through Uniwind. Components live in
`apps/mobile/src/components/ui/` and are ours to edit. Theme tokens are CSS variables in `apps/mobile/global.css`
(shadcn's `new-york` / neutral palette, light and dark), compiled by Uniwind in Metro.

## Consequences

- **Performance:** Uniwind resolves classes at build time in Metro and ships no Babel plugin or PostCSS step; styles do
  not recompute per render. Tamagui's compiler is more aggressive on paper, but the shell's UI (lists, cards, sheets)
  is not where Rally's frame budget goes; the WebView games are.
- **Look:** the shadcn visual language and component vocabulary transfer directly; polishing a component means editing
  a file in the repo, not fighting a theme API.
- **Cost:** a few config files (`metro.config.js`, `global.css`, `uniwind-types.d.ts`, `components.json`) and
  knowledge the developer already has. Tamagui's configuration surface and its history of breaking on Expo SDK bumps
  are the recurring complaint from small teams and the main reason it was not chosen.
- **Primitives:** overlays and form controls use `@rn-primitives/*` (Radix-style, headless) and require a
  `PortalHost` in the root layout. Dialogs animate with Reanimated, which Expo already ships.
- **Risks:** Uniwind is young (1.x) and Expo-focused; Reusables tracks it closely. If Uniwind stalls, Reusables also
  supports NativeWind, so the components survive an engine swap. The Reusables CLI fetches from its own registry
  host; in locked-down environments copy component sources from the repo's `packages/registry/src/uniwind/components/ui/`.
- Not chosen: gluestack (alpha churn, same engine underneath), Paper/HeroUI (installed kits, different styling
  model, no shadcn carry-over).
