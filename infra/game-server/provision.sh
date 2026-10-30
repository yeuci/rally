#!/usr/bin/env bash
# One-time (and safe to re-run) setup of the Rally game-server box: Ubuntu 24.04 on a Hetzner CX22-class VPS
# (ADR 0006, infra/game-server/README.md). Run as root ON THE BOX, from a copy of this folder:
#
#   scp -r infra/game-server root@<box>:/root/rally-infra
#   ssh root@<box> bash /root/rally-infra/provision.sh --domain game.<your-domain> --email <you@your-domain>
#
# What it does (each step checks before it changes anything):
#   base packages, unattended-upgrades, ufw (22/80/443 only), Node 22 (NodeSource), pnpm + pm2 (npm -g), Caddy
#   (official apt repo), the non-root service user, /etc/rally (env template, never overwritten), the app folder,
#   the user's git deploy key, deploy.sh copied to /usr/local/bin/rally-deploy, the Caddyfile + domain drop-in,
#   the pm2 boot unit and pm2-logrotate.
# It never writes secrets: fill /etc/rally/game-server.env yourself, then run deploy.sh.
set -Eeuo pipefail

RALLY_USER="${RALLY_USER:-rally}"
RALLY_DIR="${RALLY_DIR:-/srv/rally}"
ENV_DIR=/etc/rally
ENV_FILE="$ENV_DIR/game-server.env"
NODE_MAJOR=22
PM2_SPEC='pm2@7'
PNPM_SPEC='pnpm@10'
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DOMAIN=''
EMAIL=''

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'provision.sh: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while (($#)); do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    -h | --help) usage 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die 'run as root (it installs packages, users and services)'
[[ $DOMAIN =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && $DOMAIN == *.* ]] ||
  die "--domain must be a plain host name such as game.<your-domain> (got '${DOMAIN}')"
[[ $EMAIL =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || die "--email must be an address for certificate notices (got '${EMAIL}')"
for f in Caddyfile game-server.env.template deploy.sh; do
  [[ -f $HERE/$f ]] || die "run from a copy of infra/game-server ($HERE has no $f)"
done
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ ${ID:-} == ubuntu ]] || printf 'provision.sh: warning: written for Ubuntu 24.04, this is %s\n' "${PRETTY_NAME:-unknown}" >&2
fi

export DEBIAN_FRONTEND=noninteractive
apt_updated=0
apt_update() { ((apt_updated)) || { apt-get update -q; apt_updated=1; }; }
need_pkgs() {
  local missing=() p
  for p in "$@"; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || missing+=("$p"); done
  ((${#missing[@]} == 0)) && return 0
  apt_update
  apt-get install -y -q "${missing[@]}"
}
# write_if_changed <path> <mode> <owner:group>  (content on stdin); returns 0 when the file changed
write_if_changed() {
  local path="$1" mode="$2" owner="$3" tmp
  tmp="$(mktemp)"
  cat >"$tmp"
  if [[ -f $path ]] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    chmod "$mode" "$path" && chown "$owner" "$path"
    return 1
  fi
  install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$path"
  rm -f "$tmp"
  return 0
}
as_user() { sudo -u "$RALLY_USER" -H -- "$@"; }

log 'Base packages'
need_pkgs ca-certificates curl gnupg git sudo ufw unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https

log 'Unattended security upgrades'
write_if_changed /etc/apt/apt.conf.d/20auto-upgrades 0644 root:root <<'EOF' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades >/dev/null

log 'Firewall: 22/tcp, 80/tcp, 443/tcp+udp in; 2567 stays on localhost'
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null  # SSH first, so enabling ufw cannot cut this session
ufw allow 80/tcp >/dev/null  # ACME HTTP challenge + redirect to https
ufw allow 443/tcp >/dev/null # https matchmaking + wss rooms
ufw allow 443/udp >/dev/null # HTTP/3 (Caddy); same port
ufw --force enable >/dev/null
ufw status verbose

log "Node.js ${NODE_MAJOR}"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  write_if_changed /etc/apt/sources.list.d/nodesource.list 0644 root:root <<EOF || true
deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main
EOF
  apt_updated=0
  apt_update
  apt-get install -y -q nodejs
fi
node --version

log 'pnpm and pm2'
command -v pnpm >/dev/null || npm install -g --no-fund --no-audit "$PNPM_SPEC"
command -v pm2 >/dev/null || npm install -g --no-fund --no-audit "$PM2_SPEC"
printf 'pnpm %s, pm2 %s\n' "$(pnpm --version)" "$(pm2 --version 2>/dev/null | tail -n1)"

log 'Caddy'
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
  chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt_updated=0
  apt_update
  apt-get install -y -q caddy
fi
caddy version

log "Service user '${RALLY_USER}' (no sudo, no password)"
if ! id "$RALLY_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$RALLY_USER" --shell /bin/bash "$RALLY_USER"
fi
passwd -l "$RALLY_USER" >/dev/null 2>&1 || true
RALLY_HOME="$(getent passwd "$RALLY_USER" | cut -d: -f6)"
install -d -m 0700 -o "$RALLY_USER" -g "$RALLY_USER" "$RALLY_HOME/.ssh"

log "App folder ${RALLY_DIR} and env file ${ENV_FILE}"
install -d -m 0750 -o "$RALLY_USER" -g "$RALLY_USER" "$RALLY_DIR"
install -d -m 0750 -o root -g "$RALLY_USER" "$ENV_DIR"
if [[ ! -e $ENV_FILE ]]; then
  install -m 0640 -o root -g "$RALLY_USER" "$HERE/game-server.env.template" "$ENV_FILE"
  echo "created $ENV_FILE from the template: fill it in with sudoedit before the first deploy"
else
  chown root:"$RALLY_USER" "$ENV_FILE" && chmod 0640 "$ENV_FILE"
  echo "$ENV_FILE exists: left as is"
fi

log 'deploy.sh -> /usr/local/bin/rally-deploy (refreshed on every provision run)'
write_if_changed /usr/local/bin/rally-deploy 0755 root:root <"$HERE/deploy.sh" || true

log 'Git deploy key (read-only; add the public key to the repository as a deploy key)'
if [[ ! -f $RALLY_HOME/.ssh/id_ed25519 ]]; then
  as_user ssh-keygen -q -t ed25519 -N '' -C "${RALLY_USER}@game-server deploy key" -f "$RALLY_HOME/.ssh/id_ed25519"
fi
cat "$RALLY_HOME/.ssh/id_ed25519.pub"

log "Caddy config for ${DOMAIN}"
caddy_changed=0
write_if_changed /etc/caddy/Caddyfile 0644 root:root <"$HERE/Caddyfile" && caddy_changed=1
install -d -m 0755 /etc/systemd/system/caddy.service.d
write_if_changed /etc/systemd/system/caddy.service.d/rally.conf 0644 root:root <<EOF && caddy_changed=1
# Written by infra/game-server/provision.sh: values for the {\$...} placeholders in /etc/caddy/Caddyfile.
[Service]
Environment=RALLY_GAME_DOMAIN=${DOMAIN}
Environment=RALLY_ACME_EMAIL=${EMAIL}
EOF
RALLY_GAME_DOMAIN="$DOMAIN" RALLY_ACME_EMAIL="$EMAIL" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl daemon-reload
systemctl enable caddy >/dev/null
if ((caddy_changed)) || ! systemctl is-active --quiet caddy; then
  # restart, not reload: a changed drop-in (the domain) only applies to a new process
  systemctl restart caddy
fi
systemctl --no-pager --lines=0 status caddy || true

log "pm2 boot unit (pm2-${RALLY_USER}.service resurrects what deploy.sh saved)"
pm2 startup systemd -u "$RALLY_USER" --hp "$RALLY_HOME" >/dev/null
systemctl enable "pm2-${RALLY_USER}" >/dev/null
install -d -m 0700 -o "$RALLY_USER" -g "$RALLY_USER" "$RALLY_HOME/.pm2"
systemctl start "pm2-${RALLY_USER}" || true # the user's pm2 daemon runs under systemd from now on

log 'pm2-logrotate (10 MB per file, 14 files, gzip)'
if [[ ! -d $RALLY_HOME/.pm2/modules/pm2-logrotate ]]; then
  as_user pm2 install pm2-logrotate >/dev/null
fi
as_user pm2 set pm2-logrotate:max_size 10M >/dev/null
as_user pm2 set pm2-logrotate:retain 14 >/dev/null
as_user pm2 set pm2-logrotate:compress true >/dev/null

cat <<EOF

Provisioned. Next (infra/game-server/README.md, "First deploy"):
  1. Add the public key printed above as a read-only deploy key of the repository.
  2. sudoedit ${ENV_FILE}   (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY)
  3. From your machine: infra/game-server/deploy.sh --ssh root@<box> --repo <git ssh url> --ref main \\
                          --public-url https://${DOMAIN}
     (or on the box: sudo -u ${RALLY_USER} -H rally-deploy --repo <git ssh url> --ref main)
EOF
