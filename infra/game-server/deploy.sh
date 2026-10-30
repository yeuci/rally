#!/usr/bin/env bash
# Deploy (or redeploy) the Rally game server on the VPS (ADR 0006). Safe to re-run: same commit + same env file and
# a healthy process -> nothing is restarted. Rollback = deploy an older --ref.
#
#   From your machine (runs THIS copy of the script on the box as the service user, over ssh):
#     infra/game-server/deploy.sh --ssh root@<box> [--ref main] [--repo <git ssh url>] [--public-url https://game.<your-domain>]
#   On the box:
#     sudo -u rally -H rally-deploy [--ref main] [--repo <git ssh url>] [--public-url ...]
#
# Steps: lock, clone once / fetch <ref>, refuse a dirty checkout, check out the commit (detached),
# pnpm install --frozen-lockfile + build for @rally/game-server and its workspace deps, read /etc/rally/game-server.env,
# pm2 (re)start of ecosystem.config.cjs (instances: 1) with exactly that env, pm2 save, /healthz check.
# A restart drops every live room (one process): deploy in a quiet window (architecture §6).
#
# Options: --ref <branch|tag|sha> (default main)   --repo <url> (first deploy only)   --public-url <https url>
#          --force (restart even if nothing changed)   --ssh <user@host> (run remotely; needs root or passwordless sudo)
set -Eeuo pipefail

RALLY_USER="${RALLY_USER:-rally}"
RALLY_DIR="${RALLY_DIR:-/srv/rally}"
ENV_FILE="${RALLY_ENV_FILE:-/etc/rally/game-server.env}"
APP_NAME='rally-game-server' # must match apps/game-server/ecosystem.config.cjs
PORT=2567                    # must match the Caddyfile; PORT is not configurable through the env file
HEALTH_TIMEOUT_S=60

REF='main'
REPO=''
PUBLIC_URL=''
FORCE=0
SSH_TARGET=''

die() { printf 'deploy.sh: %s\n' "$*" >&2; exit 1; }
log() { printf '==> %s\n' "$*"; }

args=("$@")
while (($#)); do
  case "$1" in
    --ref) REF="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --public-url) PUBLIC_URL="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --ssh) SSH_TARGET="${2:-}"; shift 2 ;;
    -h | --help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

# Everything below ends up in a remote command line or a git argument: accept plain values only.
[[ $REF =~ ^[A-Za-z0-9._/-]+$ && $REF != -* ]] || die "bad --ref '$REF'"
[[ -z $REPO || ($REPO =~ ^[A-Za-z0-9@:/._~-]+$ && $REPO != -*) ]] || die "bad --repo '$REPO'"
[[ -z $PUBLIC_URL || $PUBLIC_URL =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]] || die "--public-url must be https://<host> (got '$PUBLIC_URL')"

# --- remote mode: stream this script to the box and run it there as the service user ----------------------------
if [[ -n $SSH_TARGET ]]; then
  [[ $SSH_TARGET =~ ^[A-Za-z0-9._@-]+$ && $SSH_TARGET != -* ]] || die "bad --ssh '$SSH_TARGET'"
  remote_args=()
  skip=0
  for a in "${args[@]}"; do
    if ((skip)); then skip=0; continue; fi
    if [[ $a == --ssh ]]; then skip=1; continue; fi
    remote_args+=("$(printf '%q' "$a")")
  done
  log "running on ${SSH_TARGET} as ${RALLY_USER}"
  # The remote shell reads the whole script first ("$(cat)") and passes it to bash -c, so nothing the script runs
  # (git over ssh, pnpm, pm2) can swallow the rest of it from stdin.
  exec ssh -o BatchMode=yes "$SSH_TARGET" \
    "sudo -n -u $(printf '%q' "$RALLY_USER") -H bash -c \"\$(cat)\" deploy.sh ${remote_args[*]+${remote_args[*]}}" \
    <"${BASH_SOURCE[0]}"
fi

# --- on the box ---------------------------------------------------------------------------------------------------
[[ $EUID -ne 0 ]] || die "do not run as root: sudo -u ${RALLY_USER} -H $0 ..."
[[ "$(id -un)" == "$RALLY_USER" ]] || die "run as ${RALLY_USER} (got $(id -un))"
command -v pnpm >/dev/null && command -v pm2 >/dev/null && command -v git >/dev/null ||
  die 'pnpm, pm2 or git missing: run provision.sh first'
[[ -r $ENV_FILE ]] || die "cannot read $ENV_FILE (provision.sh creates it from game-server.env.template)"
umask 027

exec 9>"$HOME/.rally-deploy.lock"
flock -n 9 || die 'another deploy is running'

# Parse the env file without executing it: KEY=value lines, optional matching quotes, '#' comments, empty = unset.
env_vars=()
declare -A env_seen=()
n=0
while IFS= read -r line || [[ -n $line ]]; do
  n=$((n + 1))
  line="${line%$'\r'}"
  [[ $line =~ ^[[:space:]]*(#.*)?$ ]] && continue
  [[ $line =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] ||
    die "$ENV_FILE:$n: expected KEY=value"
  key="${BASH_REMATCH[2]}"
  value="${BASH_REMATCH[3]}"
  if [[ $value =~ ^\"(.*)\"$ || $value =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
  [[ -n $value ]] || continue
  case "$key" in
    NODE_ENV | PORT) die "$ENV_FILE:$n: do not set $key (ecosystem.config.cjs / the Caddyfile own it)" ;;
    RALLY_DEV_RULES) [[ $value == 0 ]] || die "$ENV_FILE:$n: RALLY_DEV_RULES must never be on in production" ;;
    RALLY_ALLOW_GUESTS) [[ $value == 0 ]] || printf 'deploy.sh: warning: RALLY_ALLOW_GUESTS=%s admits unsigned players\n' "$value" >&2 ;;
  esac
  env_vars+=("$key=$value")
  env_seen[$key]=1
done <"$ENV_FILE"
for key in SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY; do
  [[ -n ${env_seen[$key]:-} ]] || die "$ENV_FILE: $key is empty (sudoedit $ENV_FILE)"
done

# Source.
export GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new'
if [[ ! -d $RALLY_DIR/.git ]]; then
  [[ -n $REPO ]] || die "$RALLY_DIR has no checkout yet: pass --repo <git ssh url> once"
  [[ -z "$(ls -A "$RALLY_DIR" 2>/dev/null)" ]] || die "$RALLY_DIR is not empty and not a git checkout"
  log "cloning into $RALLY_DIR"
  git clone --quiet "$REPO" "$RALLY_DIR"
fi
cd "$RALLY_DIR"
[[ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]] ||
  die "$RALLY_DIR has local changes to tracked files; the box only runs commits (git -C $RALLY_DIR status)"
previous="$(git rev-parse --verify --quiet HEAD || echo none)"
log "fetching $REF"
git fetch --quiet --prune --tags origin "$REF"
git -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD
commit="$(git rev-parse HEAD)"
log "commit ${commit:0:12} (was ${previous:0:12})"

# Nothing changed and the process is up: leave live rooms alone.
stamp_file="$HOME/.rally-deployed"
stamp="$commit $(sha256sum "$ENV_FILE" | cut -d' ' -f1)"
health() { curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/healthz"; }
if ((!FORCE)) && [[ -f $stamp_file && "$(cat "$stamp_file")" == "$stamp" ]] && health >/dev/null 2>&1; then
  log "already deployed and healthy: $(health) (use --force to restart anyway)"
  exit 0
fi

# Build (dev dependencies are needed for tsc; only the server and its workspace deps are installed).
export CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
log 'pnpm install'
pnpm install --frozen-lockfile --filter '@rally/game-server...'
log 'build'
pnpm --filter '@rally/game-server...' run build

# (Re)start with exactly the env file's variables, so a line removed from the file is really gone.
cd "$RALLY_DIR/apps/game-server"
base_env=("HOME=$HOME" "PATH=$PATH" "LANG=C.UTF-8" "USER=$RALLY_USER")
log "pm2 restart of ${APP_NAME}"
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true # absent on the first deploy
env -i "${base_env[@]}" "${env_vars[@]}" pm2 start ecosystem.config.cjs --only "$APP_NAME"
pm2 save >/dev/null
chmod 700 "$HOME/.pm2" && chmod 600 "$HOME/.pm2/dump.pm2" 2>/dev/null || true # the dump holds the env (secrets)

log "health check (up to ${HEALTH_TIMEOUT_S}s)"
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
until body="$(health 2>/dev/null)"; do
  if ((SECONDS >= deadline)); then
    pm2 logs "$APP_NAME" --lines 40 --nostream || true
    die "no healthy answer from 127.0.0.1:${PORT}/healthz; rollback: deploy --ref ${previous}"
  fi
  sleep 2
done
log "local: $body"
if [[ -n $PUBLIC_URL ]]; then
  body="$(curl -fsS --max-time 10 "${PUBLIC_URL%/}/healthz")" || die "${PUBLIC_URL%/}/healthz failed (Caddy, DNS or TLS)"
  log "public: $body"
fi
printf '%s\n' "$stamp" >"$stamp_file"
log "deployed ${commit:0:12}"
