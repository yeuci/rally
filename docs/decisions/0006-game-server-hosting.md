# ADR 0006 — Game-server hosting: one VPS now, Colyseus Cloud-ready

**Status:** Accepted · 2026-10 · **Amends** [ADR 0004](0004-backend-hosting.md) (where the Colyseus deployment
runs only; Supabase Cloud, Expo EAS and the Storage CDN are unchanged)

## Context

ADR 0004 put the single Colyseus deployment on Colyseus Cloud so that everything is managed. By M3 phase 2 the server
exists and the trade-offs are concrete (design `docs/m3-phase2.md` §6):

- **State is in memory, per process.** The matchmaker (no Redis driver or presence), the join-code lookup, the rate
  limits and the `game_rooms` mirror all live in the one node process (`ecosystem.config.cjs` `instances: 1`).
  More processes need shared drivers first, wherever the server runs.
- **The server is a monorepo package.** `@rally/game-sumo-server` is a `workspace:` dependency, so an upload that
  runs `npm install` outside the monorepo cannot resolve it.
- **Per-client limits need the real client address**, which only a proxy we trust can provide (`x-real-ip`).
- **Cost:** a Hetzner CX22-class VPS is ~€4–5/month; managed Colyseus Cloud tiers cost more for the same single
  process. The owner is fine patching one Ubuntu box.

## Decision

1. **Self-host now on one small VPS** (Hetzner CX22-class, Ubuntu 24.04), runbook and scripts in
   [`infra/game-server/`](../../infra/game-server/README.md):
   - **Caddy** terminates TLS (automatic certificates) for `https://` matchmaking and `wss://` room sockets on one
     public origin, `https://game.<your-domain>`, and proxies both to `127.0.0.1:2567`, overwriting `X-Real-IP`.
   - **pm2** runs `apps/game-server/ecosystem.config.cjs` unchanged (`instances: 1`, fork mode) as the non-root
     `rally` user, restored at boot by `pm2-rally.service`; `pm2-logrotate` rotates the logs.
   - **ufw** admits 22/80/443 only; 2567 is never public. `unattended-upgrades` patches the OS.
   - **Build in the checkout:** `deploy.sh` fetches a ref, runs `pnpm install --frozen-lockfile` and the build for
     `@rally/game-server...`, restarts pm2 and checks `GET /healthz`.
   - **Secrets** live only in `/etc/rally/game-server.env` on the box (`root:rally`, 0640), from a value-less template.
2. **Stay Colyseus Cloud-ready.** Nothing in `apps/game-server/src` knows about the VPS: the entry point is
   `@colyseus/tools`' `listen()`, the process file is the one Cloud reads, the client address comes from the same
   `x-real-ip` header Cloud's proxy sets, and `pnpm --filter @rally/game-server bundle` produces the self-contained
   upload (`apps/game-server/dist/cloud/`: esbuild inlines the workspace packages; npm dependencies stay external,
   pinned to the installed versions).
3. **The repository holds placeholders only.** `game.<your-domain>` in `apps/mobile/eas.json` and the docs is filled
   in by the owner once the domain exists (`<ip-with-dashes>.sslip.io` works until then); the box's domain is a
   `provision.sh` argument, never committed.

**URLs per environment**

| Variable                                | Development                                                                                       | Preview / production                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_COLYSEUS_URL` (app)        | LAN: `apps/mobile/.env` → `http://<pc-ip>:2567`; `eas.json` `development` holds a LAN placeholder | `eas.json` `preview` / `production` → `https://game.<your-domain>`                     |
| `RALLY_COLYSEUS_URL` (publish-game CSP) | not used (the LAN flow loads the Vite dev entry, which has no publisher CSP)                      | `https://game.<your-domain>`, plus any other endpoint a build of that version will use |

The app's value is the **https** base URL: matchmaking is plain HTTP(S) and the socket URL is derived from it
(`https` → `wss`), and the publisher pins both forms. `eas.json` `build.<profile>.env` applies to EAS builds only:
an `eas update` must be given the same value through its environment.

## What changes when moving to Colyseus Cloud

1. **Upload `apps/game-server/dist/cloud/`** (`pnpm --filter @rally/game-server bundle`), not the monorepo. Cloud
   installs its `package.json` with npm and starts `ecosystem.config.cjs` with pm2 as here. Check the current Cloud
   docs for the upload method (CLI from that folder, or a deploy repository/branch holding it).
2. **Env in the Cloud dashboard**, same names as `/etc/rally/game-server.env` (infra README, "Environment on the box").
   No env file is uploaded; `.env.cloud`, which `@colyseus/tools` would load, stays uncommitted (`.env.*` is
   gitignored).
3. **New endpoint** (`https://<app>.colyseus.cloud` or a custom domain on Cloud). If the public URL changes:
   `eas.json` preview/production plus a new build or update, and **every published game version** republished with
   `RALLY_COLYSEUS_URL` listing the new origin (the CSP is pinned per version). During the switch list both the old
   and the new origin. Keeping `game.<your-domain>` and repointing it avoids all of this.
4. **More than one process needs shared state first.** On Cloud, `@colyseus/tools` switches to
   `@colyseus/redis-driver` + `@colyseus/redis-presence` by itself on a multi-CPU machine or when `REDIS_URI` is set
   (and sets a per-process `publicAddress`). That shares matchmaking and reconnection, but not Rally's own state:
   - the join-code → room lookup and the rate limits must move to presence (Redis);
   - each process keeps mirroring and touching only its own rooms in `game_rooms`, which is correct as long as it
     never removes another process's rows;
   - every per-process `publicAddress` must be in `RALLY_COLYSEUS_URL` (CSP).
     Until then keep `instances: 1` on any host. The same work is what a second VPS process would need.
5. **Unchanged:** Supabase keys and JWKS, `/healthz`, the client address (Cloud's proxy sets `x-real-ip`), deploys
   restarting live rooms (ADR 0004).

## Consequences

- Cheapest option, builds straight from the monorepo, correct client addresses, and the same pm2 file everywhere.
- The owner runs the box: OS patches (automatic, plus occasional reboots), Caddy and pm2 upgrades, disk and uptime
  monitoring (an external check on `https://game.<your-domain>/healthz`). One box is a single point of failure;
  recovery is `provision.sh` + `deploy.sh` on a new box (no state to restore: rooms are ephemeral, results are in
  Supabase).
- The service-role key sits on the box in two places: the env file and pm2's dump (`~rally/.pm2/dump.pm2`, mode 600).
  Rotate it in Supabase and re-run `deploy.sh` if the box is ever suspect.
- Revisit Colyseus Cloud (or a second region) when one process is not enough, players far from the box see poor
  latency, or box maintenance starts costing real time.
