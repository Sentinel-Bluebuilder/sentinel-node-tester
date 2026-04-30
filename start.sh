#!/usr/bin/env bash
# Sentinel Node Tester — Linux/macOS launcher.
# Re-execs with sudo (preserving env) so WireGuard tunnels can install.
# For V2Ray-only audits, run `node server.js` directly without this script.

set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "[start.sh] No .env found. Copy .env.example and set MNEMONIC first:"
  echo "  cp .env.example .env"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "[start.sh] Re-executing under sudo (required for WireGuard)…"
  exec sudo -E "$0" "$@"
fi

exec node server.js "$@"
