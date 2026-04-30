# Linux Platform Support

Implemented. The tester runs on any modern Linux distribution.

## Modules

- `wireguard.js` — WireGuard tunnel management via `wg-quick up/down`. Requires
  root (the server must be launched with `sudo` or as root). Detects `wg` /
  `wg-quick` from `/usr/bin`, `/usr/local/bin`, `/usr/sbin`, or `$WIREGUARD_PATH`.
  Emergency cleanup walks `ip -o link show` and tears down any leftover
  `wgsent*` interfaces.
- `v2ray.js` — V2Ray process lifecycle. Spawns the binary downloaded by
  `scripts/postinstall.js` into `bin/v2ray`. Termination uses signals
  (SIGTERM → SIGKILL); no `taskkill` calls.

## System dependencies

```bash
# Debian / Ubuntu
sudo apt update
sudo apt install -y wireguard-tools iproute2

# Fedora / RHEL
sudo dnf install -y wireguard-tools iproute

# Arch
sudo pacman -S wireguard-tools iproute2
```

## Running

```bash
# WireGuard nodes require root
sudo -E node server.js

# V2Ray-only audits run unprivileged (~70% of nodes)
node server.js
```

`-E` preserves your environment so the server picks up `MNEMONIC` and other
variables from `.env`.

## Notes

- `IS_ADMIN` is detected via `process.getuid() === 0`. Without root the WG
  install path throws with a clear message; V2Ray nodes still test fine.
- The `WIREGUARD_PATH` env var overrides the `wg` binary search path. Useful if
  you've installed WireGuard outside the standard prefixes.
- DNS leak protection during a session is handled at the WG config level
  (`DNS = ...` directives) — the tester does not modify `/etc/resolv.conf`.
