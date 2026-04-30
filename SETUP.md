# Setup Guide

Get the Sentinel Node Tester running on Windows, macOS, or Linux. Pick your
platform below — every step covers all three.

---

## 0. Build prerequisites (native modules)

`better-sqlite3` is a native addon. On Windows, prebuilt binaries are bundled
and you can skip this section. On Linux and macOS, prebuilds may be missing
for your Node major version, in which case `npm install` will fall back to
compiling from source — which needs a working toolchain:

| Platform | Command |
|----------|---------|
| macOS    | `xcode-select --install` |
| Debian/Ubuntu | `sudo apt install -y python3 make g++` |
| Fedora   | `sudo dnf install -y python3 make gcc-c++` |
| Arch     | `sudo pacman -S --needed base-devel python` |
| Alpine   | `sudo apk add python3 make g++` |

If `npm install` later complains about `node-gyp`, this section is what you
missed. Once a prebuilt binary exists for your Node major version, the install
skips compilation entirely.

---

## 1. Install Node.js 20+

| Platform | Command |
|----------|---------|
| Windows  | `winget install OpenJS.NodeJS.LTS` |
| macOS    | `brew install node@20` |
| Debian/Ubuntu | `curl -fsSL https://deb.nodesource.com/setup_20.x \| sudo -E bash - && sudo apt install -y nodejs` |
| Fedora   | `sudo dnf install -y nodejs npm` |
| Arch     | `sudo pacman -S nodejs npm` |

Or grab a binary from [nodejs.org](https://nodejs.org/). Verify:

```bash
node --version   # v20.x or higher
npm --version    # v10.x or higher
```

---

## 2. Install WireGuard

WireGuard is required to test ~30% of Sentinel nodes (the rest use V2Ray, which
the postinstall step downloads automatically). Skip this only if you accept
that those nodes will be marked failed.

| Platform | Command |
|----------|---------|
| Windows  | `winget install WireGuard.WireGuard` |
| macOS    | `brew install wireguard-tools` |
| Debian/Ubuntu | `sudo apt install -y wireguard-tools` |
| Fedora   | `sudo dnf install -y wireguard-tools` |
| Arch     | `sudo pacman -S wireguard-tools` |

Verify:

```bash
# Linux/macOS
which wg-quick

# Windows
"C:\Program Files\WireGuard\wireguard.exe" --version
```

> **Note (macOS):** the App Store WireGuard.app does *not* include `wg-quick`.
> Install `wireguard-tools` via Homebrew or MacPorts.

---

## 3. Clone the project

```bash
git clone https://github.com/Sentinel-Autonomybuilder/sentinel-node-tester
cd sentinel-node-tester
```

---

## 4. Install dependencies

```bash
npm install
```

The postinstall step (`scripts/postinstall.js`) downloads the V2Ray binary
matching your platform/arch into `bin/`. If your machine is air-gapped or
behind a firewall that blocks GitHub releases, set `SKIP_POSTINSTALL=1` and
drop the binary in `bin/v2ray` (`bin/v2ray.exe` on Windows) yourself.

---

## 5. Configure `.env`

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```env
MNEMONIC=word1 word2 ... word12
```

The full variable list lives in `.env.example` with inline comments. Most users
only need `MNEMONIC`. Other commonly-tuned values:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3001` | HTTP port |
| `LISTEN_HOST` | `127.0.0.1` | `0.0.0.0` to expose on the network (set `ADMIN_TOKEN` first) |
| `MAX_NODES` | `0` (all) | Cap for quick smoke runs (e.g. `10`) |
| `TEST_MB` | `10` | Speed-test sample size in MB |
| `ADMIN_TOKEN` | unset | Required when `PUBLIC_MODE=true` |

> **Funding:** each node test costs ~0.04 P2P. A full ~950-node audit runs
> ~50 P2P plus ~0.2 P2P gas per batch. Get P2P via
> [Osmosis DEX](https://app.osmosis.zone/).

---

## 6. Launch

WireGuard tunnels need elevated privileges. V2Ray-only audits don't.

### Windows

```cmd
:: Recommended — auto-elevates, opens browser
cscript //nologo SentinelAudit.vbs

:: Or one-shot
start.bat

:: Or in an already-Admin terminal
node server.js
```

### macOS / Linux

```bash
# WireGuard nodes — requires root, -E preserves .env
sudo -E node server.js

# V2Ray-only audit — no sudo needed
node server.js
```

The server listens on http://localhost:3001 by default.

---

## 7. Verify

1. Open http://localhost:3001 — dashboard should load with your wallet
   address and P2P balance.
2. Click **Start Audit** (admin view only) — the live log shows node
   discovery → batch payments → individual node tests.
3. Health check:

   ```bash
   curl http://localhost:3001/health
   ```

   Expected: `{ "status": "ok", "uptime": ... }`.

4. Results land in `results/results.json` and the SQLite DB at `data/audit.db`.

---

## Checklist

- [ ] Node.js 20+
- [ ] WireGuard installed (or accept ~30% failures)
- [ ] `npm install` completed without errors
- [ ] `.env` has a valid `MNEMONIC`
- [ ] Wallet funded with P2P
- [ ] Server reachable at `http://localhost:3001`
- [ ] Audit starts and produces results

If anything fails, see `TROUBLESHOOTING.md`.
