# Handoff (2026-10-30, updated after the hardening pass)

State of the working branch `claude/keen-bell-23e7mq` when usage ran out. Read this before `docs/architecture.md`'s Next steps.

## Committed and verified

- `1fc4c68` Social part 1 (DB): friendships, blocks, people search, public games, privacy. 156 PGlite tests.
- `1b840a8` Mobile: shimmer skeletons, search screen (games + people), public profiles, Friends screen, privacy. 111 tests.
- `92479e4` Review fixes (pair locking, silent drop for blocked requests, hook-level error alerts, stricter CSP, Android navigation guard).
- `6c44aaf` M3 phase 1: `RallyRoom`, Sumo game, harness names/private rooms. Snapshot of the agent's finished work: `pnpm turbo run typecheck lint test build` was 45/45 before its review started (see below).

All of `pnpm turbo run typecheck lint test build` passes on `92479e4`; CI on `main` is green (Actions unblocked when the repo went public).

## Done since the first handoff (all committed, 46/46 repo tasks green)

- `53ace70`, `273f87d` mobile hardening (matchmaking limits, token only over secure/private hosts, play accounting with a session journal, storage reset per launch, abandon never-ready sessions).
- `a7d14d4` publisher/SDK/CI hardening (pinned socket origins in the CSP, SRI on every script, wasm under CSP, achievement icon art, e2e job in CI).
- `e65b45c` DB hardening migration `20261030000400_hardening.sql` (session-bound scores and unlocks, record_play limits, save races/caps, retention jobs, avatar constraints, `abandon_play_session`).
- game-server/Sumo hardening (this commit): usernames from `profiles` via the player's token + anon key, guests explicit and always `guest-…`, private rooms require their code on `joinById`, throttles on code lookup and room creation, no reconnection grace after a flood kick, HelloRoom on RallyRoom, monitor behind basic auth, CORS allow-list, client stick release on pause, pointer-id joystick, exit during join; game-kit save double-apply/retry halt/audio re-arm.

## Next

1. **M3 phase 2 design and build** (never produced): shell quick play / server browser (`GET /rooms/<name>`) / private rooms (create with code; join by code → `GET /rooms/code/<CODE>` → `joinById` with `{ code }`) on the game page; Developer launcher room selection (hardcoded `hello` in `apps/mobile/src/app/dev/play.tsx`); presence heartbeat + `game_rooms` mirroring in the `onRoom*`/`onPlayer*` hooks; `reportMatchResult` → service-role RPC writing `game_stats`, `leaderboard_entries` (`wins`), `user_achievements`, idempotent on `matchId`, skipping guests; "Rejoin match?" within 60 s; `user_sanctions` in `onAuth`; hosting (Colyseus Cloud vs VPS vs Fly.io) with `wss://` and JWKS; Sumo art.
2. Session storage in SecureStore (chunked, with a migration) — documented in apps/mobile/README.md, not done.
3. Android release cleartext: decide whether preview builds keep loading LAN bundles over http (`expo-build-properties` is a static flag).

## Owner's to-do on the phone (after `git pull`)

```
cd packages\db && npx supabase db push        # applies 0200 (art), 0300 (social), 0400 (hardening)
# republish all three games: the CSP changed (pinned socket origins, wasm); bump "version" in each game.json first
pnpm --filter @rally/publish-game publish-game stack
pnpm --filter @rally/publish-game publish-game spike --no-activate
pnpm dev:mobile:go:clear
```

Game server on the PC: `apps/game-server/.env.local` needs `SUPABASE_URL=https://<ref>.supabase.co` and `SUPABASE_ANON_KEY=<anon key>` (same as the app's EXPO_PUBLIC_SUPABASE_ANON_KEY) so phone players get their real username; `pnpm dev:server` sets NODE_ENV=development itself (guests on, any CORS origin, monitor on localhost). Guests show as `guest-<name>`.

Try: search pill → type a name / `@username` → open a profile → Add; Profile → Friends; Edit profile → Privacy. A second account is needed for a real friendship (sign up on the PC build or a second device).

Sumo with one phone + Chrome (LAN): `pnpm dev:server` (:2567), `pnpm --filter @rally/game-sumo dev` (:5182), Chrome `http://localhost:5182/?name=Alice`, phone Safari `http://10.0.0.201:5182/?name=Phone` (guest, touch controls). Through the shell it needs `EXPO_PUBLIC_COLYSEUS_URL=http://10.0.0.201:2567`, a dev `game_versions` row for sumo pointing at `http://10.0.0.201:5182/index.html` (the dry run prints the rows) and `SUPABASE_URL` in `apps/game-server/.env.local`; `games/sumo/README.md` has the details.

## Rules that stayed in force

Keys never in chat or the repo (`.env` git-ignored; service-role key only in `tooling/publish-game/.env`). The assistant commits and pushes; the owner never runs `git add`. Push only to `claude/keen-bell-23e7mq`; merge to `main` through a pull request when CI is green.
