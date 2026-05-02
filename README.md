[![npm version](https://img.shields.io/npm/v/sentinel-node-tester.svg)](https://www.npmjs.com/package/sentinel-node-tester)
[![Tests](https://github.com/Sentinel-Bluebuilder/sentinel-node-tester/actions/workflows/test.yml/badge.svg)](https://github.com/Sentinel-Bluebuilder/sentinel-node-tester/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

Stress-test every node on the Sentinel dVPN chain. Admin-gated testing, public-read results.

---

## What it does

Sentinel Node Tester discovers every active dVPN node on the Sentinel blockchain, opens real VPN sessions, measures actual throughput and protocol compliance, and records pass/fail results in a local SQLite database. A built-in Express dashboard lets an operator run audits and publish results. Public visitors can search and filter results — but only the operator can start or stop tests.

---

## Core flow

Admin logs in at `/admin`, optionally flips the **Broadcast Live** toggle (controls whether public surfaces show the live in-flight audit or the last-completed snapshot), and starts an audit via `POST /api/start`. The continuous loop cycles through every online node; public visitors at `/` browse the node directory and at `/live` watch the real-time iteration feed via SSE — both are read-only. The operator stops the loop with `POST /api/stop`. No public user can trigger any test.

---

## Routes

| Route | Who | Description |
|-------|-----|-------------|
| `/` | Public | Node directory — search, filter, sort, detail drawer. |
| `/live` | Public | Real-time audit progress + results feed via SSE. |
| `/node/:addr` | Public | Single-node result detail page. |
| `/admin` (configurable) | Admin | Full control panel — start/stop audits, broadcast toggle, logs. |
| `/api/public/*` | Public | Read-only JSON API: nodes, stats, countries, run summaries, SSE events. |
| `/api/start`, `/api/stop`, `/api/broadcast` | Admin | Audit lifecycle + broadcast-live toggle. Admin session required. |

---

## Quick start (local dev)

```bash
# 1. Clone
git clone https://github.com/Sentinel-Bluebuilder/sentinel-node-tester.git
cd sentinel-node-tester

# 2. Install dependencies (downloads V2Ray binary for your platform)
npm install

# 3. Create .env and set MNEMONIC to your 12-word Cosmos phrase
cp .env.example .env

# 4. Start
#    Windows:    cscript //nologo SentinelAudit.vbs   (auto-elevates to Admin)
#    macOS:      sudo -E node server.js               (root for WireGuard)
#    Linux:      sudo -E node server.js
#    Any OS:     npm start                            (V2Ray-only, ~70% nodes)
```

Open **http://localhost:3001** in your browser. No `ADMIN_TOKEN` needed for local dev — the admin surface defaults to unauthenticated (safe on localhost only).

> **WireGuard requires admin/root.** Without elevation, V2Ray-only audits still run (~70% of nodes). Full setup walkthrough for all three platforms: [`SETUP.md`](SETUP.md).

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

## Audit modes

### P2P (default)

Scans every active node on the Sentinel chain and opens a paid session on each. The tester wallet pays gas and bandwidth costs directly from its P2P balance. Suitable for full network audits. This is what `POST /api/start` does with no plan/subscription params.

### Subscription / fee-granted

Pass `subscriptionId` + `subscriptionGranter` (or `planId`) to `POST /api/start`. Only nodes attached to that plan are scanned. Each session transaction is broadcast via `broadcastWithFeeGrant` using the plan operator's on-chain fee-grant allowance — the tester pays zero gas. This mirrors the flow used by commercial Sentinel apps where end users hold no P2P tokens.

### TEST RUN

Pass `testRun: true` in the body or `?testRun=1` to `POST /api/start`. The pipeline skips chain operations and payments and writes a `mode='test'` run row. Used for demos and UI smoke checks. See `CLAUDE.md` — TEST RUN code paths are immutable.

---

## Public deployment

Set `ADMIN_TOKEN` in `.env` to enable the admin login page. Generate a token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Optionally change the admin path to something unguessable:

```bash
ADMIN_PATH=/my-secret-ops-panel
```

Put the application behind a reverse proxy (nginx, Caddy) that terminates HTTPS. The admin surface should not be reachable over plain HTTP in production. The `Broadcast Live` toggle (`POST /api/broadcast`) controls whether the public `/` and `/live` pages stream the in-flight audit or only the last-completed snapshot.

See [docs/OPERATOR-RUNBOOK.md](docs/OPERATOR-RUNBOOK.md) for the full deployment checklist.

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MNEMONIC` | Yes | — | 12-word Cosmos mnemonic. Signs session and gas transactions. Never commit to git. |
| `RPC` | No | `https://rpc-sentinel.busurnode.com` | Primary RPC endpoint for chain queries and broadcasts. (rpc.sentinel.co was the old default but stalled behind tip while reporting `catching_up=false`, returning stale balances — kept last in `core/constants.js` as a fallback only.) |
| `DENOM` | No | `udvpn` | Token denomination. Do not change. |
| `GAS_PRICE` | No | `0.2udvpn` | Gas price for transactions. |
| `PORT` | No | `3001` | HTTP port the server listens on. |
| `LISTEN_HOST` | No | `127.0.0.1` | Bind address. Set `0.0.0.0` to expose on the network (with `ADMIN_TOKEN`). |
| `ADMIN_TOKEN` | Recommended | — | Admin login password. If unset, admin surface is unauthenticated (localhost dev only). |
| `ADMIN_PATH` | No | `/admin` | URL prefix for the admin panel. Change to an unguessable path in production. |
| `PUBLIC_MODE` | No | `false` | When `true`, root path serves the public dashboard; admin moves to `ADMIN_PATH`. Requires `ADMIN_TOKEN`. |
| `INSECURE_COOKIE` | No | `false` | Allow admin session cookies over HTTP (local dev only — production must use HTTPS). |
| `ENABLE_HSTS` | No | `false` | Send `Strict-Transport-Security` header (set behind HTTPS proxy in production). |
| `LCD_ENDPOINTS` | No | Built-in fallback | Comma-separated LCD URLs used only if RPC fails. |
| `DNS_SERVERS` | No | unset | Comma-separated DNS IPs to use inside tunnels. |
| `NODE_DELAY_MS` | No | `5000` | Milliseconds between node tests. Keep ≥ 5000 to avoid chain rate limits. |
| `MAX_NODES` | No | `0` (all) | Cap on nodes tested per run. `0` = no limit. |
| `TEST_MB` | No | `10` | Megabytes transferred per speed test. |
| `GIGABYTES_PER_NODE` | No | `1` | Gigabytes allocated per opened session. |
| `ALLOW_PUBLIC_TEST` | No | `false` | If `true`, public visitors can trigger a pre-configured test against `PUBLIC_TEST_PLAN_ID` / `PUBLIC_TEST_SUB_ID` / `PUBLIC_TEST_SUB_GRANTER`. Off by default — leave off unless you intend to spend your wallet on visitor traffic. |
| `WIREGUARD_PATH` | No | auto-detected | Override the `wg`/`wg-quick` binary path on Linux/macOS. |

---

## Architecture

Single Express process on port 3001. Two audit paths: `audit/pipeline.js` is the single-pass engine called by the admin "New Test" and "Retest Failed" buttons; `audit/continuous.js` wraps pipeline in a recursive loop with configurable inter-pass delay, emitting `loop:*` and `iteration:*` SSE events consumed by the public `/live` page. All results persist to `audit.db` (SQLite via `better-sqlite3`); raw per-run JSON lands in `results/`. The public SSE stream (`/api/public/events`) only forwards events while the `broadcastLive` toggle is on, and the redaction path strips wallet addresses, plan IDs, and fee-grant internals before fan-out.

For module dependency graph + per-stage flow, see [`ARCH.md`](ARCH.md). For decisions and "why we did X", see [`DECISIONS.md`](DECISIONS.md). For all reference docs, see [`docs/INDEX.md`](docs/INDEX.md).

---

## Testing this tool

```bash
npm test
```

---

## License

MIT. Part of the [Sentinel dVPN](https://sentinel.co) ecosystem.
