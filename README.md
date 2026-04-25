[![npm version](https://img.shields.io/npm/v/sentinel-node-tester.svg)](https://www.npmjs.com/package/sentinel-node-tester)
[![Tests](https://github.com/Sentinel-Autonomybuilder/sentinel-node-tester/actions/workflows/test.yml/badge.svg)](https://github.com/Sentinel-Autonomybuilder/sentinel-node-tester/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

Stress-test every node on the Sentinel dVPN chain. Admin-gated testing, public-read results.

---

## What it does

Sentinel Node Tester discovers every active dVPN node on the Sentinel blockchain, opens real VPN sessions, measures actual throughput and protocol compliance, and records pass/fail results in a local SQLite database. A built-in Express dashboard lets an operator run audits and publish results. Public visitors can search and filter results — but only the operator can start or stop tests.

---

## Core flow

Admin logs in at `/admin`, clicks the **Public Testing** toggle, and selects a test mode (P2P or subscription). The continuous audit loop starts, cycling through every online node; public visitors see a real-time progress banner on `/` and a live iteration feed at `/live` with only filter and search controls. The operator stops the loop from the same toggle. No public user can trigger any test.

---

## Routes

| Route | Who | Description |
|-------|-----|-------------|
| `/` | Public | Node directory — search, filter, sort, detail drawer. |
| `/live` | Public | Real-time audit progress + results feed via SSE. |
| `/node/:addr` | Public | Single-node result detail page. |
| `/admin` (configurable) | Admin | Full control panel — start/stop audits, public-test toggle, logs. |
| `/api/public/*` | Public | Read-only JSON API: nodes, stats, countries, run summaries, SSE events. |
| `/api/admin/public-test/*` | Admin | Start/stop/status for the continuous loop. Admin session required. |

---

## Quick start (local dev)

```bash
# 1. Clone
git clone https://github.com/Sentinel-Autonomybuilder/sentinel-node-tester.git
cd sentinel-node-tester

# 2. Install dependencies
npm install

# 3. Create .env
cp .env.example .env
# Open .env and set MNEMONIC to your 12-word Cosmos phrase

# 4. Start
npm start
```

Open **http://localhost:3001** in your browser. No `ADMIN_TOKEN` needed for local dev — the admin surface defaults to unauthenticated (safe on localhost only).

---

## CLI for scripting and AI agents

The `sentinel-audit` binary emits JSON on stdout for every command.

```bash
sentinel-audit serve              # Start dashboard (same as npm start)
sentinel-audit nodes --pretty     # List all active dVPN nodes as JSON
sentinel-audit balance            # Check wallet P2P balance
sentinel-audit test <sentnode1...>  # Test a single node end-to-end
sentinel-audit audit              # Full network audit across all nodes
sentinel-audit list               # Enumerate all subcommands
sentinel-audit functions --json   # Enumerate every exported SDK function
```

Full reference: [docs/CLI.md](docs/CLI.md)

---

## Two test modes

### Test ALL (P2P)

Scans every active node on the Sentinel chain and opens a paid session on each. The tester wallet pays gas and bandwidth costs directly from its P2P balance. Suitable for full network audits.

### Test Sub. Plan

Lists all active plan subscriptions held by the tester wallet. Pick a plan; only that plan's nodes are scanned. Each session transaction is broadcast via `broadcastWithFeeGrant` using the plan operator's on-chain fee grant allowance — the tester pays zero gas. This mirrors the flow used by commercial Sentinel apps where end users hold no P2P tokens.

---

## Public deployment

Set `PUBLIC_MODE=true` in your `.env`. This **requires** `ADMIN_TOKEN` to be set — the server will refuse to start without it. Generate a token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put the result in `ADMIN_TOKEN` in your `.env`. This token becomes the password for the `/admin` login page.

Optionally change the admin path to something unguessable:

```bash
ADMIN_PATH=/my-secret-ops-panel
```

Put the application behind a reverse proxy (nginx, Caddy) that terminates HTTPS. The admin surface should not be reachable over plain HTTP in production.

See [docs/OPERATOR-RUNBOOK.md](docs/OPERATOR-RUNBOOK.md) for the full deployment checklist.

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MNEMONIC` | Yes | — | 12-word Cosmos mnemonic. Signs session and gas transactions. Never commit to git. |
| `PORT` | No | `3001` | HTTP port the server listens on. |
| `PUBLIC_MODE` | No | `false` | Set `true` to enable public-facing mode. Enforces `ADMIN_TOKEN`. |
| `ADMIN_TOKEN` | If PUBLIC_MODE | — | Admin login password. Required when `PUBLIC_MODE=true`. |
| `ADMIN_PATH` | No | `/admin` | URL prefix for the admin panel. Change to an unguessable path in production. |
| `ALLOW_PUBLIC_TEST` | No | `false` | Set `true` to allow public visitors to trigger tests (not recommended). |
| `LCD_ENDPOINTS` | No | Built-in list | Comma-separated override for Sentinel LCD endpoints. |
| `DNS_SERVERS` | No | HNS preset | Comma-separated DNS IPs to use inside tunnels. Presets: `hns`, `google`, `cloudflare`, `quad9`, `opendns`. |
| `NODE_DELAY_MS` | No | `5000` | Milliseconds to wait between node tests. Keep >= 5000 to avoid chain rate limits. |
| `MAX_NODES` | No | `0` (all) | Cap on nodes tested per run. `0` means no limit. |
| `TEST_MB` | No | `10` | Megabytes transferred per speed test. |
| `GIGABYTES_PER_NODE` | No | `1` | Gigabytes allocated when opening a session. |
| `INSECURE_COOKIE` | No | `false` | Set `true` to allow admin session cookies over HTTP (local dev only). |

---

## Architecture

Single Express process on port 3001. Two audit paths: `audit/pipeline.js` is the single-pass engine called by the admin "New Test" and "Retest Failed" buttons; `audit/continuous.js` wraps pipeline in a recursive loop with configurable inter-pass delay, emitting `loop:*` and `iteration:*` SSE events consumed by the public `/live` page. All results persist to `audit.db` (SQLite via `better-sqlite3`); raw per-run JSON lands in `runs/`. The public SSE stream (`/api/public/events`) is allow-listed to `public-test:*` events only — wallet addresses, plan IDs, and fee-grant internals are never sent to public consumers.

---

## Testing this tool

```bash
# Unit + smoke suite
npm test

# Public-mode smoke test (start server first, then)
node tools/smoke-public-mode.mjs
```

---

## License

MIT. Part of the [Sentinel dVPN](https://sentinel.co) ecosystem.
