# Sentinel Node Tester — CLI Reference

The `sentinel-audit` CLI provides direct command-line access to the Sentinel dVPN network. It targets two audiences: **developers** who want scriptable chain queries without writing code, and **AI agents** that need structured JSON output to discover nodes, check balances, run audits, and enumerate available SDK functions.

Every command writes JSON to stdout by default. Errors go to stderr. Exit codes are strict (see [Exit Codes](#exit-codes)).

---

## Installation

**Global install (recommended for regular use):**
```bash
npm install -g sentinel-node-tester
sentinel-audit <subcommand> [flags]
```

**One-shot via npx (no install):**
```bash
npx sentinel-node-tester <subcommand> [flags]
```

**Local development:**
```bash
node bin/cli.js <subcommand> [flags]
```

---

## Configuration

Copy `.env.example` to `.env` and set your mnemonic:

```bash
cp .env.example .env
```

```
MNEMONIC=word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12
```

The mnemonic is the 12- or 24-word Cosmos seed phrase for the wallet that signs on-chain transactions. The derived address will have prefix `sent1...`.

**Commands that work without a mnemonic** (read-only chain queries): `list`, `nodes`, `node`, `speed`, `plans`, `functions`

**Commands that require a mnemonic**: `balance`, `subscriptions`, `test`, `audit`, `serve`

For read-only commands you can also pass a wallet address explicitly via `--address` rather than setting a mnemonic.

---

## Global Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--help`, `-h` | — | Print help for the current subcommand and exit. |
| `--version`, `-v` | — | Print package version and exit. |
| `--json` | on | Output raw JSON (default; machine-readable). |
| `--pretty` | off | Pretty-print JSON with 2-space indent. |
| `--lcd <url>` | auto | Override the LCD endpoint (skips automatic failover). |
| `--sdk <name>` | js | SDK backend to use: `js` or `csharp`. |

---

## Subcommands

### `list`

List all available CLI subcommands with one-line descriptions.

**Syntax:**
```bash
sentinel-audit list [--pretty]
```

**Flags:** none beyond globals.

**Example:**
```bash
sentinel-audit list --pretty
```

**Example output:**
```json
{
  "commands": [
    { "name": "list",          "description": "List available CLI subcommands" },
    { "name": "nodes",         "description": "Query active nodes from the chain" },
    { "name": "node",          "description": "Query a single node by address" },
    { "name": "speed",         "description": "Run a direct internet speed test (no VPN)" },
    { "name": "balance",       "description": "Show wallet balance in udvpn and P2P" },
    { "name": "subscriptions", "description": "List active subscriptions for the wallet" },
    { "name": "plans",         "description": "Discover active subscription plans on-chain" },
    { "name": "test",          "description": "Test a single node end-to-end" },
    { "name": "audit",         "description": "Run a full network audit across all nodes" },
    { "name": "serve",         "description": "Start the dashboard server" },
    { "name": "functions",     "description": "List all exported SDK functions" }
  ]
}
```

**Cost:** FREE (local, no chain query)

---

### `nodes`

Fetch every active dVPN node from the Sentinel chain. Results are cached in memory for 5 minutes.

**Syntax:**
```bash
sentinel-audit nodes [--limit <n>] [--country <code>] [--type <wireguard|v2ray>] [--pretty]
```

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--limit <n>` | 0 (all) | Return at most N nodes. |
| `--country <code>` | — | Filter to a two-letter ISO country code (e.g. `US`, `DE`). |
| `--type <name>` | — | Filter by protocol: `wireguard` or `v2ray`. |

**Example:**
```bash
sentinel-audit nodes --country DE --type wireguard --limit 5 --pretty
```

**Example output:**
```json
{
  "count": 5,
  "nodes": [
    {
      "address": "sentnode1abc123def456ghi789jkl012mno345pqr678stu",
      "moniker": "de-node-01",
      "remoteUrl": "https://198.51.100.42:8080",
      "remoteAddrs": ["198.51.100.42:8080"],
      "country": "Germany",
      "countryCode": "DE",
      "city": "Frankfurt",
      "type": "wireguard",
      "peers": 3,
      "gigabyte_prices": [
        { "denom": "udvpn", "quote_value": "52000000" }
      ],
      "planIds": [14, 27]
    }
  ]
}
```

**Cost:** FREE (read-only chain query)

---

### `node`

Query a single node by its on-chain address. Includes status, location, price, and live connectivity info.

**Syntax:**
```bash
sentinel-audit node <sentnode1...> [--pretty]
```

**Flags:** none beyond globals.

**Example:**
```bash
sentinel-audit node sentnode1abc123def456ghi789jkl012mno345pqr678stu --pretty
```

**Example output:**
```json
{
  "address": "sentnode1abc123def456ghi789jkl012mno345pqr678stu",
  "moniker": "de-node-01",
  "remoteUrl": "https://198.51.100.42:8080",
  "type": "wireguard",
  "peers": 3,
  "bandwidth": {
    "download": 104857600,
    "upload": 52428800
  },
  "location": {
    "city": "Frankfurt",
    "country": "Germany",
    "country_code": "DE",
    "latitude": 50.1109,
    "longitude": 8.6821
  },
  "gigabyte_prices": [
    { "denom": "udvpn", "quote_value": "52000000" }
  ],
  "clockDriftSec": 0.4,
  "active": true
}
```

**Cost:** FREE (read-only)

---

### `speed`

Run a direct internet speed test (no VPN tunnel). Downloads from Cloudflare CDN targets and measures throughput. Useful as a baseline before comparing tunnel speeds.

**Syntax:**
```bash
sentinel-audit speed [--mb <megabytes>] [--pretty]
```

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--mb <n>` | 10 | Megabytes to download during the test. |

**Example:**
```bash
sentinel-audit speed --mb 20 --pretty
```

**Example output:**
```json
{
  "mbps": 94.7,
  "chunks": 4,
  "adaptive": "parallel-20mb",
  "durationMs": 1688
}
```

**Cost:** FREE (no chain interaction)

---

### `balance`

Show the P2P token balance for the configured wallet.

**Syntax:**
```bash
sentinel-audit balance [--address <sent1...>] [--pretty]
```

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--address <sent1...>` | derived from MNEMONIC | Query this address instead of the wallet's own address. |

**Example:**
```bash
sentinel-audit balance --pretty
```

**Example output:**
```json
{
  "address": "sent1qk2d3f5g6h7j8k9l0m1n2o3p4q5r6s7t8u9v0",
  "udvpn": "4823000000",
  "p2p": "4823.00"
}
```

**Cost:** FREE (read-only chain query). Requires `MNEMONIC` in `.env` or `--address`.

---

### `subscriptions`

List all active plan subscriptions held by the configured wallet.

**Syntax:**
```bash
sentinel-audit subscriptions [--address <sent1...>] [--pretty]
```

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--address <sent1...>` | derived from MNEMONIC | Query subscriptions for this address instead. |

**Example:**
```bash
sentinel-audit subscriptions --pretty
```

**Example output:**
```json
{
  "address": "sent1qk2d3f5g6h7j8k9l0m1n2o3p4q5r6s7t8u9v0",
  "count": 2,
  "subscriptions": [
    {
      "id": 1042,
      "plan_id": 14,
      "status": "active",
      "expiry": "2026-07-01T00:00:00Z",
      "allocated_bytes": 1073741824,
      "used_bytes": 215674882
    },
    {
      "id": 1187,
      "plan_id": 27,
      "status": "active",
      "expiry": "2026-08-15T00:00:00Z",
      "allocated_bytes": 5368709120,
      "used_bytes": 0
    }
  ]
}
```

**Cost:** FREE (read-only). Requires `MNEMONIC` in `.env` or `--address`.

---

### `plans`

Discover active subscription plans on the Sentinel chain. Each plan bundles a set of nodes and a bandwidth price that the plan operator pre-pays on behalf of subscribers.

**Syntax:**
```bash
sentinel-audit plans [--limit <n>] [--pretty]
```

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--limit <n>` | 0 (all) | Return at most N plans. |

**Example:**
```bash
sentinel-audit plans --limit 3 --pretty
```

**Example output:**
```json
{
  "count": 3,
  "plans": [
    {
      "id": 14,
      "status": "active",
      "subscribers": 284,
      "nodeCount": 47,
      "price": [{ "denom": "udvpn", "amount": "0" }],
      "provider": "sentprov1aaabbbcccdddeeefffggghhh"
    },
    {
      "id": 27,
      "status": "active",
      "subscribers": 103,
      "nodeCount": 12,
      "price": [{ "denom": "udvpn", "amount": "1000000" }],
      "provider": "sentprov1zzzyyyxxxwwwvvvuuutttss"
    },
    {
      "id": 31,
      "status": "active",
      "subscribers": 58,
      "nodeCount": 8,
      "price": [{ "denom": "udvpn", "amount": "500000" }],
      "provider": "sentprov1mmmnnnooopppqqqrrrsss"
    }
  ]
}
```

**Cost:** FREE (read-only chain query)

---

### `test`

Test a single node end-to-end: status check, session payment, handshake, tunnel setup, speed test, and result summary. This is the same pipeline that `audit` runs per-node.

**Syntax:**
```bash
sentinel-audit test <sentnode1...> [--sdk <js|csharp>] [--mb <megabytes>] [--pretty]
```

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--sdk <name>` | js | SDK backend: `js` or `csharp`. |
| `--mb <n>` | 10 | Megabytes to use in speed test. |

**Example:**
```bash
sentinel-audit test sentnode1abc123def456ghi789jkl012mno345pqr678stu --pretty
```

**Example output:**
```json
{
  "address": "sentnode1abc123def456ghi789jkl012mno345pqr678stu",
  "moniker": "de-node-01",
  "country": "Germany",
  "countryCode": "DE",
  "type": "wireguard",
  "pass": true,
  "actualMbps": 41.3,
  "baselineAtTest": 94.7,
  "ispBottleneck": false,
  "pass15mbps": true,
  "pass10mbps": true,
  "passBaseline": true,
  "googleAccessible": true,
  "googleLatencyMs": 112,
  "peers": 3,
  "sdk": "js",
  "sessionId": "8842",
  "error": null,
  "durationMs": 18430
}
```

**Cost:** PAID — opens one on-chain session (~40 P2P for 1 GB). Requires `MNEMONIC` in `.env`.

---

### `audit`

Run a full network audit across all active nodes (or a subset). Each node is tested using the same pipeline as `test`. Results are written to `results/results.json` as tests complete.

**Syntax:**
```bash
sentinel-audit audit [--limit <n>] [--country <code>] [--type <wireguard|v2ray>] [--delay <ms>] [--sdk <js|csharp>] [--pretty]
```

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--limit <n>` | 0 (all) | Stop after testing N nodes. |
| `--country <code>` | — | Only test nodes in this country (ISO two-letter code). |
| `--type <name>` | — | Only test `wireguard` or `v2ray` nodes. |
| `--delay <ms>` | 5000 | Milliseconds to wait between node tests. |
| `--sdk <name>` | js | SDK backend: `js` or `csharp`. |

**Example:**
```bash
sentinel-audit audit --country US --limit 20 --delay 7000 --pretty
```

**Example output (streaming — one object per node as it completes, then a final summary):**
```json
{ "event": "node_done", "address": "sentnode1...", "pass": true,  "actualMbps": 38.1 }
{ "event": "node_done", "address": "sentnode1...", "pass": false, "error": "ETIMEDOUT" }
{ "event": "complete", "total": 20, "passed": 14, "failed": 6, "resultsFile": "results/results.json" }
```

**Cost:** PAID — approximately 40 P2P per node tested (~700–800 P2P for a full audit of ~1,000 nodes). Requires `MNEMONIC` in `.env`.

---

### `serve`

Start the web dashboard server. This is the original dashboard-boot behavior: opens a browser-accessible UI at `http://localhost:<port>` that lets you trigger audits, browse results, and view live logs.

**Syntax:**
```bash
sentinel-audit serve [--port <n>]
```

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | 3001 (or `PORT` env var) | Port to listen on. |

**Example:**
```bash
sentinel-audit serve --port 3005
```

**Output:**
```
Sentinel Node Tester dashboard running at http://localhost:3005
```

This subcommand does not exit on its own. Send `CTRL+C` to stop.

**Cost:** FREE (no chain interaction until an audit is started from the UI)

---

### `functions`

List all functions exported from the package's programmatic API. Useful for AI agents or scripts that want to discover what is available before importing.

**Syntax:**
```bash
sentinel-audit functions [--pretty]
```

**Flags:** none beyond globals.

**Example:**
```bash
sentinel-audit functions --pretty
```

**Example output:**
```json
{
  "count": 62,
  "functions": [
    { "name": "testNode",              "module": "audit/node-test",      "cost": "paid" },
    { "name": "testWithRetry",         "module": "audit/retry",          "cost": "paid" },
    { "name": "runAudit",              "module": "audit/pipeline",       "cost": "paid" },
    { "name": "runRetestSkips",        "module": "audit/pipeline",       "cost": "paid" },
    { "name": "getAllNodes",           "module": "core/chain",           "cost": "free" },
    { "name": "findWorkingLcd",        "module": "core/chain",           "cost": "free" },
    { "name": "getActiveLcd",          "module": "core/chain",           "cost": "free" },
    { "name": "queryNodeStatusDirect", "module": "core/chain",           "cost": "free" },
    { "name": "invalidateNodeCache",   "module": "core/chain",           "cost": "free" },
    { "name": "discoverPlans",         "module": "core/chain",           "cost": "free" },
    { "name": "querySubscriptions",    "module": "core/chain",           "cost": "free" },
    { "name": "hasActiveSubscription", "module": "core/chain",           "cost": "free" },
    { "name": "signAndBroadcastRetry", "module": "core/wallet",         "cost": "paid" },
    { "name": "speedtestDirect",       "module": "protocol/speedtest",   "cost": "free" },
    { "name": "speedtestViaSocks5",    "module": "protocol/speedtest",   "cost": "free" },
    { "name": "nodeStatusV3",          "module": "protocol/v3protocol",  "cost": "free" },
    { "name": "generateWgKeyPair",     "module": "protocol/v3protocol",  "cost": "free" },
    { "name": "initHandshakeV3",       "module": "protocol/v3protocol",  "cost": "free" },
    { "name": "classifyFailure",       "module": "protocol/diagnostics", "cost": "free" }
  ]
}
```

The `cost` field is `"free"` for read-only operations and `"paid"` for functions that broadcast on-chain transactions.

**Cost:** FREE (local, no chain query)

---

## AI Agent Discovery Pattern

An AI agent with no prior knowledge of this package can discover its full capability in three steps:

**Step 1 — Enumerate subcommands:**
```bash
npx sentinel-node-tester list --json
```
Returns a machine-readable list of every CLI command with a one-line description.

**Step 2 — Enumerate programmatic functions:**
```bash
npx sentinel-node-tester functions --json
```
Returns every exported function, its module path, and whether it costs tokens. The agent can then decide which functions to import for a custom script vs. which CLI commands cover the same need.

**Step 3 — Pick a command and act:**
```bash
# Find nodes in Japan with wireguard protocol
npx sentinel-node-tester nodes --country JP --type wireguard --json

# Check wallet balance before spending
npx sentinel-node-tester balance --json

# Test a specific node
npx sentinel-node-tester test sentnode1abc123def456ghi789jkl012mno345pqr678stu --json
```

All commands emit JSON on stdout and errors on stderr, so the agent can pipe output directly into `JSON.parse()` or `jq`.

**Recommended agent flow:**
```
list → understand what's available
nodes --limit 5 → get sample nodes to work with
balance → confirm wallet has funds before testing
test <address> → validate a single node before running audit
audit --limit 20 → run a bounded audit and inspect results/results.json
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success — command completed, JSON written to stdout. |
| `1` | Runtime error — chain unreachable, mnemonic missing, node test failed. Details on stderr. |
| `2` | Bad usage — unknown subcommand, missing required argument, invalid flag value. |
