# ADR 0003 — Game engine: PlayCanvas (engine-only, npm + Vite + TypeScript)

**Status:** Accepted · 2026-10

## Context

With games running as web bundles (ADR 0002), the engine choice is confined to the bundle and does not affect the shell. The original question was React Three Fiber vs PlayCanvas. Rally needs 3D and 2D games, mobile-first performance, a small runtime, and a cheap path to each new game for a solo developer.

Options considered:

1. **PlayCanvas engine** via npm, built with Vite + TypeScript (the documented `create-playcanvas` path).
2. **Three.js / React Three Fiber** in the WebView.
3. **Babylon.js.**
4. **Phaser** for 2D games alongside a 3D engine.

## Decision

PlayCanvas (engine 2.x, engine-only, no PlayCanvas Editor dependency) for all MVP games, including 2D ones. The `@rally/sdk` bridge and `@rally/game-kit` helpers are engine-agnostic, so Phaser (or anything else that builds to a static bundle) may be adopted later for 2D games without touching the shell.

## Consequences

- PlayCanvas is a complete mobile-first game engine (entity-component system, physics, animation, particles, asset pipeline, KTX2/Basis textures, glTF/Draco, WebGL2 + WebGPU) with a small runtime. R3F is a renderer around which a game framework would have to be built; Three.js carries more per-game glue.
- One engine for 2D and 3D keeps `game-kit` (boot, DPR cap, resize, safe area, touch controls, Colyseus adapter, audio unlock, pause/resume) to a single implementation for the MVP.
- If a declarative React-style API is wanted later, `@playcanvas/react` exists; it is not used now to keep bundles small and the dependency graph simple.
- Babylon.js was a credible alternative with a larger runtime and a less mobile-focused default pipeline; not chosen but not ruled out for a specific game.
- Deterministic simulation code for multiplayer games lives in `games/<slug>/shared` and is engine-independent, so prediction can be added per game later regardless of renderer.
