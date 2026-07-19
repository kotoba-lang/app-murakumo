#!/usr/bin/env bash
# install.sh — install LiteLLM gateway as a launchd service on a murakumo mac mini.
#
# Run ONCE on the mac mini that should host the gateway (recommend the node with
# lowest serve_plain.py utilization; typically `dan`). After install, configure
# CF Tunnel route `llm.etzhayyim.com` → `http://localhost:4000` in the existing
# `murakumo-fleet` tunnel config (managed locally on this machine).
#
# Prereqs:
#   - macOS 14+ (sudo required for /opt/etzhayyim, /var/log writes)
#   - python3.11+ (or uv)
#   - serve_plain.py already running on port 8000 (same host for loopback)
#
# Master key:
#   We reuse the same per-machine Keychain pattern as other etzhayyim services.
#   Before running this script:
#     KEY="sk-litellm-$(openssl rand -hex 32)"
#     security add-generic-password -s "etzhayyim.litellm" -a "MASTER_KEY" -w "$KEY" -U
#   Then in each CF Worker that calls https://llm.etzhayyim.com:
#     wrangler secret put LITELLM_MASTER_KEY  # paste the same $KEY

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/etzhayyim/litellm}"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_SRC="$REPO_DIR/com.etzhayyim.litellm.plist"
CONFIG_SRC="$REPO_DIR/config.yaml"
SERVICE_LABEL="com.etzhayyim.litellm"
USER_PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"

need_sudo() { sudo -n true 2>/dev/null || { echo "sudo required for $1"; sudo -v; }; }

step() { printf "\033[34m==>\033[0m %s\n" "$*"; }

step "ensure install dir"
need_sudo "$INSTALL_DIR"
sudo install -d -o "$USER" -g staff "$INSTALL_DIR"

step "set up Python venv"
if ! [ -x "$INSTALL_DIR/.venv/bin/litellm" ]; then
  python3 -m venv "$INSTALL_DIR/.venv"
  "$INSTALL_DIR/.venv/bin/pip" install --upgrade pip
  "$INSTALL_DIR/.venv/bin/pip" install 'litellm[proxy]>=1.52'
else
  echo "  (already installed)"
fi

step "copy config.yaml"
install -m 0644 "$CONFIG_SRC" "$INSTALL_DIR/config.yaml"

step "fetch MASTER_KEY from Keychain"
MASTER_KEY="$(security find-generic-password -s etzhayyim.litellm -a MASTER_KEY -w 2>/dev/null || true)"
if [ -z "$MASTER_KEY" ]; then
  echo "  ERR: Keychain entry etzhayyim.litellm/MASTER_KEY missing." >&2
  echo "  Register it first:" >&2
  echo "    security add-generic-password -s etzhayyim.litellm -a MASTER_KEY -w \"sk-litellm-\$(openssl rand -hex 32)\" -U" >&2
  exit 1
fi

step "materialize plist with MASTER_KEY"
mkdir -p "$HOME/Library/LaunchAgents"
sed "s|REPLACE_AT_INSTALL|$MASTER_KEY|" "$PLIST_SRC" > "$USER_PLIST"
chmod 0600 "$USER_PLIST"   # plist contains the key — keep owner-only

step "ensure log dirs writable"
sudo install -d -m 0755 /var/log
sudo touch /var/log/etzhayyim-litellm.out.log /var/log/etzhayyim-litellm.err.log
sudo chown "$USER":staff /var/log/etzhayyim-litellm.*.log

step "load launch agent"
launchctl unload "$USER_PLIST" 2>/dev/null || true
launchctl load  "$USER_PLIST"

step "verify"
for i in $(seq 1 30); do
  if curl -fsS -H "Authorization: Bearer $MASTER_KEY" http://127.0.0.1:4000/health/liveliness >/dev/null 2>&1; then
    echo "\033[32m✓\033[0m LiteLLM healthy on http://127.0.0.1:4000"
    echo
    echo "Next:"
    echo "  1. Add CF Tunnel ingress route: llm.etzhayyim.com → http://localhost:4000"
    echo "     (edit the murakumo-fleet tunnel config on THIS mac)"
    echo "  2. Create DNS CNAME llm.etzhayyim.com → ae341542.cfargotunnel.com"
    echo "  3. Test end-to-end:"
    echo "     curl -X POST https://llm.etzhayyim.com/v1/chat/completions \\"
    echo "       -H 'Authorization: Bearer \$MASTER_KEY' \\"
    echo "       -H 'Content-Type: application/json' \\"
    echo "       -d '{\"model\":\"tier0-general\",\"messages\":[{\"role\":\"user\",\"content\":\"2+2\"}]}'"
    exit 0
  fi
  sleep 2
done
echo "\033[31m✗\033[0m LiteLLM did not respond in 60s. Check logs:"
echo "    tail -40 /var/log/etzhayyim-litellm.err.log"
exit 1
