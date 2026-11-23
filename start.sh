#!/usr/bin/env bash
# (Re)start the 500 game server + a public Cloudflare quick tunnel, each under an auto-restart loop.
# Prints the public URL (a quick-tunnel URL changes whenever the tunnel restarts).
#   NO_TUNNEL=1 ./start.sh   -> server only (http://localhost:8500)
cd "$(dirname "$0")"
DIR=$(pwd); export PORT=${PORT:-8500}
mkdir -p logs data bin
pkill -f "$DIR/supervise.sh" 2>/dev/null
pkill -f "node $DIR/server.js" 2>/dev/null
pkill -f "$DIR/bin/cloudflared" 2>/dev/null
sleep 1
[ -d node_modules ] || npm install --omit=dev --silent
setsid nohup "$DIR/supervise.sh" server >/dev/null 2>&1 < /dev/null &
for i in $(seq 1 20); do curl -fs "http://localhost:$PORT/healthz" >/dev/null && break; sleep 0.5; done
echo "Server running: http://localhost:$PORT"
[ -n "$NO_TUNNEL" ] && exit 0
if [ ! -x bin/cloudflared ]; then
  ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) A=arm64;; *) A=amd64;; esac
  OS=$(uname -s | tr A-Z a-z)
  if [ "$OS" = darwin ]; then curl -sSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$A.tgz | tar -xz -C bin
  else curl -sSL -o bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$A; fi
  chmod +x bin/cloudflared
fi
: > logs/tunnel.log
setsid nohup "$DIR/supervise.sh" tunnel >/dev/null 2>&1 < /dev/null &
URL=""
for i in $(seq 1 90); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' logs/tunnel.log | tail -1)
  if [ -n "$URL" ] && curl -fs -m 5 "$URL/healthz" >/dev/null; then echo "$URL" > PUBLIC_URL.txt; echo "500 is live at: $URL"; exit 0; fi
  sleep 2
done
echo "Public tunnel did not come up (this network may block Cloudflare tunnels, which need outbound port 7844)."
echo "See logs/tunnel.log. The game still runs locally at http://localhost:$PORT"
pkill -f "$DIR/supervise.sh tunnel"; pkill -f "$DIR/bin/cloudflared"
exit 1
