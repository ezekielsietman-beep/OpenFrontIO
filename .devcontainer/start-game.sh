#!/usr/bin/env bash
# Starts the OpenFront dev server in the background, unless it is already up.
# Safe to run any number of times. Log: /tmp/openfront-dev.log
if curl -sf -o /dev/null http://localhost:9000; then
  echo "OpenFront is already running on port 9000."
  exit 0
fi
cd "$(dirname "$0")/.." || exit 1
export DISABLE_PUBLIC_LOBBIES=true SKIP_BROWSER_OPEN=true npm_config_engine_strict=false
nohup npm run dev > /tmp/openfront-dev.log 2>&1 &
disown 2>/dev/null || true
echo "Starting OpenFront... give it about a minute, then open port 9000."
