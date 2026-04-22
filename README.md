# Sentinel Node Tester

[![npm version](https://img.shields.io/npm/v/sentinel-node-tester.svg)](https://www.npmjs.com/package/sentinel-node-tester)
[![Tests](https://github.com/Sentinel-Autonomybuilder/sentinel-node-tester/actions/workflows/test.yml/badge.svg)](https://github.com/Sentinel-Autonomybuilder/sentinel-node-tester/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

---

## What It Is

A network audit dashboard for the [Sentinel dVPN](https://sentinel.co) blockchain. It discovers every active dVPN node on the chain, opens real VPN sessions, and reports actual throughput, protocol compliance, and pass/fail status for each node.

Built on the [Blue JS SDK](https://github.com/Sentinel-Autonomybuilder/blue-js-sdk) — the same protocol stack that powers consumer VPN applications.

---

## Prerequisites

- **[Node.js](https://nodejs.org/) >=18**
- **Git**
- **[WireGuard for Windows](https://www.wireguard.com/install/)** _(optional)_ — required only for WireGuard-protocol nodes. V2Ray nodes (~70% of the network) work without it.
- **Admin / root** _(optional)_ — needed only to actually tunnel traffic through the VPN. Node scan, discovery, and listing all work without elevated privileges.
- **~5 P2P tokens** _(optional)_ — only needed for **Test ALL** mode where the tester pays for sessions. **Sub. Plan** mode is free for the tester because the plan operator covers gas via an on-chain fee grant.

---

## Quick Start

```bash
git clone https://github.com/Sentinel-Autonomybuilder/sentinel-node-tester.git
cd sentinel-node-tester
npm install
npm start
```

Open **http://localhost:3001** in your browser.

The `sentinel-audit` binary also accepts subcommands for scripting and AI agent use. Run `sentinel-audit serve` to start the dashboard (equivalent to `npm start`), or use any other subcommand directly:

```bash
sentinel-audit serve            # Start dashboard (same as npm start)
sentinel-audit nodes --pretty   # List all active dVPN nodes as JSON
sentinel-audit balance          # Check wallet balance
sentinel-audit test <sentnode1...>  # Test a single node end-to-end
```

See [docs/CLI.md](docs/CLI.md) for the full subcommand reference.

---

## CLI for AI agents

The `sentinel-audit` CLI emits JSON on stdout for every command, making it straightforward to drive from scripts or autonomous agents. An agent can run `sentinel-audit list --json` to enumerate all subcommands, then `sentinel-audit functions --json` to enumerate every exported SDK function, then issue targeted queries or tests without writing any application code.

| Command | Description |
|---------|-------------|
| `sentinel-audit list` | Enumerate all available subcommands |
| `sentinel-audit nodes` | Fetch all active dVPN nodes from the chain |
| `sentinel-audit balance` | Show wallet P2P token balance |
| `sentinel-audit test <node>` | Test a single node end-to-end (paid) |
| `sentinel-audit audit` | Full network audit across all nodes (paid) |
| `sentinel-audit serve` | Start the web dashboard |

Full reference: [docs/CLI.md](docs/CLI.md)

---

## Configuration

Copy the example env file and add your mnemonic:

```bash
cp .env.example .env
```

Open `.env` and set the one required variable:

```
MNEMONIC=your twelve word mnemonic phrase goes here
```

This is the 12-word Cosmos mnemonic for the Sentinel wallet that signs session transactions. You can generate a fresh wallet from any Sentinel-compatible wallet app (e.g. [Keplr](https://www.keplr.app/), [Leap](https://www.leapwallet.io/)), or import an existing Cosmos mnemonic — the address prefix will be `sent1...`.

- **Sub. Plan mode:** no balance needed — the plan operator pays gas for you via an on-chain fee grant.
- **Test ALL mode:** send a small amount of P2P (~5 P2P) to the derived `sent1...` address to cover session and gas costs.

**Never commit your `.env` file.** It is already listed in `.gitignore`.

---

## Two Test Modes

### Test ALL (P2P)

Scans every active node on the Sentinel chain and opens a paid session on each. The tester's wallet pays gas and bandwidth costs directly. Good for a full network audit.

### Test Sub. Plan

Lists all active plan subscriptions held by your wallet. Pick a plan, and the tester scans only that plan's nodes. Each session transaction is broadcast via `broadcastWithFeeGrant` — the plan operator's pre-configured on-chain allowance covers all gas, so the tester pays nothing.

This is the same flow used by commercial Sentinel apps (Android, iOS) where end users hold no P2P tokens.

---

## Running as Admin (Optional)

WireGuard tunnel creation requires elevated privileges. Without admin, WireGuard node tests skip the tunnel phase but still record handshake and protocol results.

**Windows:** Double-click `run-admin.vbs` in the project root. It triggers UAC elevation and launches the server automatically.

**macOS / Linux:**

```bash
sudo npm start
```

---

## Troubleshooting

**"V2Ray binary not available"**
The `postinstall` script could not fetch the V2Ray binary for your platform. WireGuard-only nodes will still work. Re-run `npm install` or download the binary manually into `platforms/`.

**"No subscriptions found" in Sub. Plan mode**
Your wallet has no active plan subscriptions on-chain. Switch to **Test ALL** mode, or subscribe to a plan first from a Sentinel app.

**Port 3001 already in use**
Set `PORT=3002` (or any free port) in your `.env` file, then restart.

**`npm install` prints audit warnings**
You will see a handful of low/high-severity warnings from `@cosmjs/*` transitive dependencies. These come from upstream CosmJS and affect every Cosmos project; they are tracked by the CosmJS team and do not impact Node Tester. Safe to ignore.

---

## License

MIT
