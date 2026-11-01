# @rally/release

One-command releases, run by the owner from the repo root (Windows, macOS or Linux).

| Command                  | What it does                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm ship`              | Everything, in order. It shows the plan and asks before doing anything.                                                                   |
| `pnpm ship:status`       | Shows what `pnpm ship` would do right now. Changes nothing.                                                                               |
| `pnpm ship:db`           | Pushes new database migrations (`supabase db push` in `packages/db`).                                                                     |
| `pnpm ship:server`       | Redeploys the game server, but only when its code changed since the deployed commit. `--force` restarts it anyway.                        |
| `pnpm ship:games [ids…]` | Publishes every game whose `game.json` version isn't on the CDN yet, or only the ids given. `--list` also lists a draft game for players. |
| `pnpm app`               | Starts the app for Expo Go over a tunnel.                                                                                                 |

The steps `pnpm ship` runs:

1. **Code.** It must be on `main` with nothing uncommitted, and nothing that isn't on GitHub yet. It pulls new commits, then runs `pnpm install`.
2. **Database.** `supabase db push`. Supabase lists the new migrations and asks before applying them.
3. **Game server.** It reads the commit the box last deployed (`~/.rally-deployed`, written by `infra/game-server/deploy.sh`). It redeploys only if the server, a game's rules package or the lockfile changed since that commit, because a restart ends every live match. After deploying it checks `/healthz`.
4. **Games.** It publishes each game whose version has no `game_versions` row yet. A brand-new game is also listed for players (`publish-game --publish`), since new games otherwise start as hidden drafts. The bridge test game (`spike`) is never shipped.

Flags: `--yes` skips the question, `--dry-run` prints the plan only.

## Setup (once)

Configuration lives in `tooling/publish-game/.env`, which is git-ignored and the same file publishing already uses:

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role key>
RALLY_COLYSEUS_URL=https://<game server host>
RALLY_DEPLOY_SSH=root@<box-ip>
```

`RALLY_DEPLOY_URL` overrides the deploy URL. Without it, the first https entry of `RALLY_COLYSEUS_URL` is used.

You also need `ssh` on your PATH; it's built into Windows 10 and later. If the box asks for a password, ssh prompts in the same terminal. `pnpm ship:db` uses the Supabase CLI login and project link that `db push` already relies on.

## Rollback

- **A game:** `pnpm --filter @rally/publish-game publish-game <id> --rollback <version>`
- **The server:** `infra/game-server/deploy.sh --ssh root@<box-ip> --ref <sha>`, or on the box `sudo -u rally -H rally-deploy --ref <sha>`. See `infra/game-server/README.md`.
