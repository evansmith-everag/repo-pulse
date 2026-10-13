#!/bin/sh
# Starts Repo Pulse and opens it in your browser. Needs Node.js 18 or newer on the PATH.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required. Download it from https://nodejs.org and run this again."
  exit 1
fi
PORT="${PORT:-4317}"
url="http://127.0.0.1:$PORT"
(
  sleep 2
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url"
  elif command -v open >/dev/null 2>&1; then open "$url"
  fi
) >/dev/null 2>&1 &
exec node server.js
