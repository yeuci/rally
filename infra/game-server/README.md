# infra/game-server

How the Colyseus server (`apps/game-server`) runs in production: one small VPS, one pm2 process, Caddy for TLS.
The decision and the path to Colyseus Cloud are in [ADR 0006](../../docs/decisions/0006-game-server-hosting.md).

```text
app (https matchmaking, wss rooms) ──443──▶ Caddy (auto-TLS, X-Real-IP) ──▶ 127.0.0.1:2567 node (pm2, 1 process)
                                                                              └─▶ Supabase (JWKS, service RPCs)
```

| File                       | What                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provision.sh`             | Run once as root on a fresh Ubuntu 24.04 box (safe to re-run): packages, ufw, Node 22, pnpm, pm2, Caddy, user, pm2 boot unit, log rotation           |
| `deploy.sh`                | Every release: fetch a ref, build in the checkout, restart pm2 with the env file, `/healthz` check. Run from your machine with `--ssh` or on the box |
| `Caddyfile`                | Installed as `/etc/caddy/Caddyfile`; the domain and ACME e-mail come from a systemd drop-in written by `provision.sh`                                |
| `game-server.env.template` | Copied once to `/etc/rally/game-server.env` (no values). You fill it in on the box                                                                   |

Nothing in this folder names a real host or holds a secret: the domain is a `provision.sh` argument, the secrets
live only in `/etc/rally/game-server.env` on the box.

## First deploy (Hetzner CX22-class box)

Everything runs on the box over SSH, so it works the same from Windows, macOS or Linux (no bash needed locally).
The repository is public, so the box clones it over HTTPS and needs no deploy key.

1. Create the server: Ubuntu 24.04, shared x86 with 2 vCPU / 4 GB (CX22 or its successor), public IPv4 + IPv6, your
   SSH key, the location nearest your players (and the Supabase project's region).
2. Domain: an A (and AAAA) record `game.<your-domain>` → the server IP. No domain yet: use `<ip-with-dashes>.sslip.io`
   (e.g. `203-0-113-7.sslip.io`), which resolves to that IP with no setup.
3. Log in and fetch the scripts on the box:
   ```bash
   ssh root@<ip>
   apt-get update -q && apt-get install -y -q git
   git clone https://github.com/yeuci/rally.git /root/rally-src
   ```
4. Provision (as root, safe to re-run):
   ```bash
   bash /root/rally-src/infra/game-server/provision.sh --domain <host> --email <you@example.com>
   ```
   It prints a deploy key: only needed if the repository ever goes private (add it as a read-only deploy key then).
5. Fill in the secrets: `nano /etc/rally/game-server.env` → `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` (Supabase dashboard → Project Settings → API). Save with Ctrl+O, Enter, Ctrl+X.
6. Deploy:
   ```bash
   sudo -u rally -H rally-deploy --repo https://github.com/yeuci/rally.git --ref main --public-url https://<host>
   ```
7. Check: `curl https://<host>/healthz` → `{"ok":true,…}`, and `ufw status` → only 22, 80, 443.
8. `reboot`; a minute later `/healthz` answers again (Caddy and `pm2-rally` start at boot).
9. Put `https://<host>` in `apps/mobile/eas.json` (preview, production), in your `apps/mobile/.env`
   (`EXPO_PUBLIC_COLYSEUS_URL`) and in `RALLY_COLYSEUS_URL` for publishing; then follow the release order in
   `docs/m3-phase2.md` §7.

From a machine with bash you can also run `infra/game-server/deploy.sh --ssh root@<ip> …` locally (it streams the
script to the box); on Windows, use the on-box command above.

## Releases and rollback

```bash
infra/game-server/deploy.sh --ssh root@<ip>                     # deploy origin/main
infra/game-server/deploy.sh --ssh root@<ip> --ref v0.2.0        # a tag, branch or commit sha
infra/game-server/deploy.sh --ssh root@<ip> --ref <previous sha> # rollback (the failure message prints it)
```

- `--ssh` streams your local copy of `deploy.sh` to the box and runs it as `rally` (needs root or passwordless sudo
  on the ssh login). On the box: `sudo -u rally -H rally-deploy …` (a copy refreshed by `provision.sh`).
- Idempotent: same commit, same env file and a healthy process → it exits without restarting (`--force` restarts).
- A restart drops every live room: one process, in-memory rooms. Deploy only when server code changed, in a quiet
  window (architecture §6); a rejoin attempt then ends with "That match has ended".
- The box only runs commits: `deploy.sh` refuses a checkout with local edits to tracked files.
- After editing `/etc/rally/game-server.env`, run `deploy.sh` again (the env file is part of the "changed?" check).

## Environment on the box

`/etc/rally/game-server.env` (`root:rally`, `0640`). `deploy.sh` parses it (no shell evaluation) and starts pm2
with exactly those variables, so a deleted line is really gone. Meanings: `apps/game-server/README.md`, "Environment".

| Variable                    | On the box                                                                      |
| --------------------------- | ------------------------------------------------------------------------------- |
| `SUPABASE_URL`              | required (`deploy.sh` refuses to start without it)                              |
| `SUPABASE_ANON_KEY`         | required                                                                        |
| `SUPABASE_SERVICE_ROLE_KEY` | required, secret                                                                |
| `RALLY_MONITOR_PASSWORD`    | optional, secret; empty = monitor and playground not mounted                    |
| `SUPABASE_JWT_SECRET`       | legacy HS256 projects only                                                      |
| `RALLY_CORS_ORIGINS`        | leave empty (the app's native fetch needs no CORS)                              |
| `NODE_ENV`, `PORT`          | never in the file: `ecosystem.config.cjs` sets `production`, Caddy expects 2567 |
| `RALLY_DEV_RULES`           | never (`deploy.sh` refuses `1`)                                                 |
| `RALLY_ALLOW_GUESTS`        | leave unset (production refuses guests; `deploy.sh` warns on `1`)               |

`@colyseus/tools` also reads `/etc/environment` (overriding) and `apps/game-server/.env.production` (committed,
non-secret): keep Rally variables out of both.

## Network and TLS

- **ufw:** deny incoming except 22/tcp, 80/tcp, 443/tcp and 443/udp (HTTP/3). Port 2567 is never opened: the
  server is reached only through Caddy. A Hetzner Cloud Firewall with the same rules is a good second layer.
- **Caddy** gets and renews the certificate itself (port 80 must stay open for the HTTP challenge and the redirect),
  proxies WebSocket upgrades, sets `X-Real-IP` to the real peer (the server's per-client limits read it first) and
  drops a client-sent `X-Client-IP`. `stream_close_delay 5m` keeps room sockets open across `systemctl reload caddy`.
- **SSH:** key-only. If the server was created with a password, set `PasswordAuthentication no` in
  `/etc/ssh/sshd_config.d/` before anything else.
- **Patching:** `unattended-upgrades` installs security updates daily; reboot in a quiet window when
  `/var/run/reboot-required` exists (everything comes back by itself, step 9).

## Health and logs

- `GET /healthz` → `{ ok, serverVersion }`, local (`curl -s localhost:2567/healthz`) and public
  (`https://game.<your-domain>/healthz`). Point an external uptime monitor at the public one.
- pm2 restarts the process on crash and at 512 MB (`max_memory_restart`). `pm2 status`, `pm2 logs rally-game-server`
  (as `rally`: `sudo -u rally -H pm2 …`).
- **Log rotation:** app logs are in `/home/rally/.pm2/logs/`, rotated by `pm2-logrotate` (10 MB per file, 14 files,
  gzip; set by `provision.sh`). Caddy logs to journald (`journalctl -u caddy`), which rotates by size on its own;
  access logs are off. Results that could not be written show up as `[results] UNRECORDED <json>` lines: grep the
  pm2 logs for them before they rotate out.

## systemd and pm2

- `caddy.service` (apt package) + `/etc/systemd/system/caddy.service.d/rally.conf` (`RALLY_GAME_DOMAIN`,
  `RALLY_ACME_EMAIL`). Changing the domain: re-run `provision.sh --domain … --email …` (it restarts Caddy).
- `pm2-rally.service` (from `pm2 startup systemd -u rally`) runs `pm2 resurrect` at boot, which restores what
  `deploy.sh` last saved with `pm2 save`. The dump (`/home/rally/.pm2/dump.pm2`, mode 600) contains the env, i.e.
  the service key: it never leaves the box.
- After upgrading pm2 (`npm i -g pm2@7`), run `sudo -u rally -H pm2 update`.
- `instances: 1` in `apps/game-server/ecosystem.config.cjs` is load-bearing (in-memory matchmaker, join codes, limits
  and mirror). Do not scale with `pm2 scale`; see ADR 0006 for what more than one process needs.

## Colyseus Cloud build (not used by the VPS)

```bash
pnpm --filter @rally/game-server bundle   # builds the server + workspace deps, then apps/game-server/dist/cloud/
```

`dist/cloud/` holds `build/index.js` (with `@rally/game-sumo-server` inlined by esbuild), a `package.json` with
only npm dependencies pinned to the versions installed here, and `ecosystem.config.cjs`. That folder is the
self-contained upload; ADR 0006 lists the rest of the move.
