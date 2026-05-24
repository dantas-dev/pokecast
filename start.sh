#!/usr/bin/env bash
# Start Pokecast: ensure deps, open the firewall (once) and open the browser.
set -e
cd "$(dirname "$0")"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20 >/dev/null 2>&1 || true

# firewall: subnet rule, only once (sentinel .firewall-done)
if [ ! -f .firewall-done ]; then
  DEV=$(ip -4 route show default 2>/dev/null | awk '{print $5; exit}')
  SUBNET=$(ip -4 route 2>/dev/null | awk -v d="$DEV" '$0 ~ d" proto kernel" {print $1; exit}')
  SUBNET=${SUBNET:-192.168.1.0/24}
  echo "Opening the firewall for the LAN ($SUBNET) — once (asks for sudo)..."
  if sudo ufw allow from "$SUBNET"; then touch .firewall-done; fi
fi

[ -d node_modules ] || npm install

PORT="${POKECAST_PORT:-8099}"
( sleep 1.5; command -v xdg-open >/dev/null && xdg-open "http://localhost:$PORT" >/dev/null 2>&1 || true ) &

echo "Opening http://localhost:$PORT  (Ctrl-C here to stop)"
exec node server.js
