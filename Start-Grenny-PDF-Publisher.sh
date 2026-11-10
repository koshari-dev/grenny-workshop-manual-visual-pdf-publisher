#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "Grenny Workshop Manual Visual PDF Publisher"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed. Install Node.js 20 or later."
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: Node.js 20 or later is required."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is not installed."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: Docker Compose plugin is unavailable."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker is not running or this user cannot access it."
  echo "Check that the Docker service is running and that your user has permission."
  exit 1
fi

if [ ! -f "$ROOT/engine/Dockerfile" ]; then
  echo "ERROR: Engine submodule is missing."
  echo "Run: git submodule update --init --recursive"
  exit 1
fi

if [ ! -f "$ROOT/.env.example" ]; then
  echo "ERROR: .env.example is missing."
  exit 1
fi

if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  chmod 600 "$ROOT/.env"
  echo "Created .env from .env.example."
  echo "Edit .env and set your workshop source, runtime, tree, output and work paths."
  exit 1
fi

chmod 600 "$ROOT/.env"

echo "Starting local control panel..."
echo "Open http://127.0.0.1:4177 in your browser."
echo "Keep this terminal open while using the publisher."
echo "Press Ctrl+C to stop the control panel."
echo

exec node "$ROOT/control-panel/server.mjs"
