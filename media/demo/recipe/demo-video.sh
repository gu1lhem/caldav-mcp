#!/usr/bin/env bash
# Remakes the demo video in media/demo/ (see README.md here).
#
#   media/demo/recipe/demo-video.sh          # replay the committed exchange.json, record, encode
#   media/demo/recipe/demo-video.sh --live   # first a new real exchange (Docker, claude)
#
# --live starts a throwaway Radicale in Docker, seeds the demo calendar (seed.ts) and runs the
# real exchange through `claude -p` and this checkout's caldav-mcp (exchange.ts), then replaces
# exchange.json. Either way it records the replay (record.ts) into media/demo/.take/ and encodes
# it (encode-demo.ts). The container, its volume and the temp directory go on success, failure
# and Ctrl-C.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
config="$here/deno.jsonc"
take="$here/../.take"
name="caldav-mcp-demo-$$"
tmp=$(mktemp -d)

cleanup() {
  docker rm -f -v "$name" >/dev/null 2>&1 || true
  find "$tmp" -delete 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [[ "${1:-}" == "--live" ]]; then
  mkdir -p "$tmp/radicale"
  printf '[server]\nhosts = 0.0.0.0:5232\n[auth]\ntype = none\n[storage]\nfilesystem_folder = /data/collections\n' >"$tmp/radicale/config"
  # Anonymous volume (-v on rm deletes it), loopback only, a random free port.
  docker run -d --name "$name" --pids-limit=500 --memory=1g -p 127.0.0.1::5232 \
    -v "$tmp/radicale:/config:ro,Z" docker.io/tomsquest/docker-radicale:3.8.1.1 >/dev/null
  port=$(docker port "$name" 5232/tcp | head -1 | sed 's/.*://')
  for _ in $(seq 1 30); do
    curl -fs -o /dev/null "http://127.0.0.1:$port/.web/" 2>/dev/null && break
    sleep 1
  done
  deno run --config "$config" --allow-net=127.0.0.1 "$here/seed.ts" "http://127.0.0.1:$port/demo"
  deno run -A --config "$config" "$here/exchange.ts" "http://127.0.0.1:$port/demo/" "$tmp/exchange"
  cp "$tmp/exchange/exchange.json" "$here/exchange.json"
fi

deno run -A --config "$config" "$here/record.ts" "$take"
deno run -A --config "$config" "$here/encode-demo.ts" "$take"
