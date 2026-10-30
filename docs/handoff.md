# Handoff (2026-10-30, end of session)

State of the working branch `claude/keen-bell-23e7mq` when usage ran out. Read this before `docs/architecture.md`'s Next steps.

## Committed and verified

- `1fc4c68` Social part 1 (DB): friendships, blocks, people search, public games, privacy. 156 PGlite tests.
- `1b840a8` Mobile: shimmer skeletons, search screen (games + people), public profiles, Friends screen, privacy. 111 tests.
- `92479e4` Review fixes (pair locking, silent drop for blocked requests, hook-level error alerts, stricter CSP, Android navigation guard).
- `6c44aaf` M3 phase 1: `RallyRoom`, Sumo game, harness names/private rooms. Snapshot of the agent's finished work: `pnpm turbo run typecheck lint test build` was 45/45 before its review started (see below).

All of `pnpm turbo run typecheck lint test build` passes on `92479e4`; CI on `main` is green (Actions unblocked when the repo went public).

## In flight when the session ended (re-run, do not assume results)

1. **Adversarial review of the Sumo diff** (RallyRoom auth, matchmaking wrapper in `apps/game-server/src/routes.ts`, netcode, client, build, docs). It may have left uncommitted fixes in `apps/game-server`, `games/sumo`, `packages/game-kit`, `tooling/dev-harness`. On resume: `git status`, read the diff, run the five-package turbo filter and `NODE_PATH=/usr/local/lib/node_modules_global pnpm --filter @rally/game-sumo test:e2e`, commit if green. If nothing is there, re-run a review of `6c44aaf` with the same six dimensions.
2. **Codebase audit + M3 phase 2 design** (read-only). Unverified candidates the first pass raised, worth checking in order: `record_play` callable without a session (inflates stats); `submit_solo_score` bound keeps growing after the session ended / 24 h on a never-ended session; asc boards accept 0; `unlock_achievement` has no session or rate limit; `save_put` concurrent first writes surface as unique_violation instead of CONFLICT; `play_sessions` has no retention job; `leaderboard_entries` readable by anonymous sessions; storage policy lets anon list draft/hidden bundles; `profiles.avatar_url` unconstrained (length/scheme); no rate limit on `session.join`; SRI covers only module scripts (dynamic chunks rely on the CDN; M6 local serving verifies them). Fix the confirmed ones in a new migration `20261030000400_hardening.sql` + mobile changes, with tests.
3. **M3 phase 2 design** was never produced (rate limit). Write it as a judged design (three angles, three judges, synthesis) covering: shell quick play / server browser (`GET /rooms/<name>`) / private rooms (create + code → `GET /rooms/code/<CODE>` → `joinById`) on the game page; Developer launcher room selection (hardcoded `hello` in `apps/mobile/src/app/dev/play.tsx`); `{ username }` in matchmaking options; presence heartbeat + `game_rooms` mirroring in the `onRoom*`/`onPlayer*` hooks; `reportMatchResult` → service-role RPC writing `game_stats`, `leaderboard_entries` (`wins`), `user_achievements`, idempotent on `matchId`, skipping guests; "Rejoin match?" within 60 s; `user_sanctions` in `onAuth`; hosting (Colyseus Cloud vs VPS vs Fly.io) with `wss://` and JWKS; Sumo art.

## Owner's to-do on the phone (after `git pull`)

```
cd packages\db && npx supabase db push        # applies 20261030000200 (art) and 20261030000300 (social)
pnpm --filter @rally/publish-game publish-game stack            # 0.1.2 with art (if not done)
pnpm --filter @rally/publish-game publish-game spike --no-activate
pnpm dev:mobile:go:clear
```

Try: search pill → type a name / `@username` → open a profile → Add; Profile → Friends; Edit profile → Privacy. A second account is needed for a real friendship (sign up on the PC build or a second device).

Sumo with one phone + Chrome (LAN): `pnpm dev:server` (:2567), `pnpm --filter @rally/game-sumo dev` (:5182), Chrome `http://localhost:5182/?name=Alice`, phone Safari `http://10.0.0.201:5182/?name=Phone` (guest, touch controls). Through the shell it needs `EXPO_PUBLIC_COLYSEUS_URL=http://10.0.0.201:2567`, a dev `game_versions` row for sumo pointing at `http://10.0.0.201:5182/index.html` (the dry run prints the rows) and `SUPABASE_URL` in `apps/game-server/.env.local`; `games/sumo/README.md` has the details.

## Rules that stayed in force

Keys never in chat or the repo (`.env` git-ignored; service-role key only in `tooling/publish-game/.env`). The assistant commits and pushes; the owner never runs `git add`. Push only to `claude/keen-bell-23e7mq`; merge to `main` through a pull request when CI is green.
