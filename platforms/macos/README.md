# macOS Platform Support

Implemented. The tester runs on macOS 12+ (Intel and Apple Silicon).

## Modules

- `wireguard.js` — WireGuard tunnel management via `wg-quick up/down`. Requires
  root (`sudo`). Detects `wg` / `wg-quick` from `/usr/local/bin` (Intel
  Homebrew), `/opt/homebrew/bin` (Apple Silicon Homebrew), `/usr/bin`, or
  `$WIREGUARD_PATH`.
- `v2ray.js` — V2Ray process lifecycle. Uses the binary placed at `bin/v2ray`
  by `scripts/postinstall.js`. Termination via POSIX signals.

## System dependencies

```bash
# Homebrew (recommended)
brew install wireguard-tools

# MacPorts
sudo port install wireguard-tools
```

The official **WireGuard.app** from the Mac App Store is GUI-only and does not
expose `wg-quick` — install `wireguard-tools` separately even if you have the
app.

## Running

```bash
# WireGuard nodes require root
sudo -E node server.js

# V2Ray-only audits run unprivileged
node server.js
```

`-E` preserves environment variables so `.env` is picked up.

## Notes

- `IS_ADMIN` is detected via `process.getuid() === 0`.
- Apple Silicon ships `wireguard-tools` under `/opt/homebrew/bin`; Intel Macs
  use `/usr/local/bin`. Both paths are searched.
- macOS uses `utun` interfaces — `wg-quick` picks the first free `utunN`
  automatically. The tester registers the chosen name for emergency cleanup.
- If `wg-quick up` hangs at "Adding peer", check the system log
  (`log show --last 1m --predicate 'process == "wg"'`) for routing-table
  conflicts with another VPN.
