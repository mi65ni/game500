#!/usr/bin/env bash
# Keeps one component running forever: ./supervise.sh server|tunnel
cd "$(dirname "$0")"; DIR=$(pwd); PORT=${PORT:-8500}
while true; do
  if [ "$1" = server ]; then
    echo "[$(date)] starting server" >> logs/server.log
    PORT=$PORT node "$DIR/server.js" >> logs/server.log 2>&1
  else
    echo "[$(date)] starting tunnel" >> logs/tunnel.log
    ( sleep 20; grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' logs/tunnel.log | tail -1 > PUBLIC_URL.txt ) &
    "$DIR/bin/cloudflared" tunnel --no-autoupdate --protocol http2 --url "http://localhost:$PORT" >> logs/tunnel.log 2>&1
  fi
  sleep 2
done
