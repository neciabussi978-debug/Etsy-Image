#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="/private/tmp/node-v20.18.1-darwin-arm64/bin/node"

if [ ! -x "$NODE_BIN" ]; then
  echo "Node runtime not found at: $NODE_BIN"
  echo "Ask Codex to reinstall the local Node runtime, or install Node.js 20+ on this Mac."
  exit 1
fi

cd "$ROOT_DIR"
exec "$NODE_BIN" node_modules/next/dist/bin/next dev -H 127.0.0.1 -p 3000
