#!/bin/sh
# Starts Repo Pulse and opens it in your browser. Needs Node.js 22 or newer on the PATH.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required. Download it from https://nodejs.org and run this again."
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
# Exit code 75 means "I installed an update, start me again".
while :; do
  node server.js
  code=$?
  [ "$code" -eq 75 ] || exit "$code"
done
