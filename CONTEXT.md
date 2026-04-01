# AI Context — How to Interpret This Project

> This file tells any AI how to work with this codebase. Read this BEFORE touching any code.

## What This Project Is
A network audit tool for the Sentinel dVPN protocol. Tests every node on the blockchain by paying real tokens, establishing real VPN tunnels, and measuring real throughput. Also embeddable into consumer dVPN apps for in-app testing.

## Architecture: Domain-Based Modules

```
core/           — Chain interactions, wallet, sessions, credentials (SHARED)
audit/          — Test pipeline, single node test, retry logic (TESTING ONLY)
protocol/       — V3 handshake, V2Ray config, speed test, diagnostics (SHARED)
platforms/      — OS-specific tunnel management (PLATFORM-SPECIFIC)
  windows/      — WireGuard service, V2Ray process, network detection
  macos/        — (planned)
  linux/        — (planned)
csharp-bridge/  — C# SDK CLI wrapper for cross-language testing
server.js       — Express server + SSE (STANDALONE DEPLOYMENT ONLY)
index.html      — Dashboard UI (STANDALONE DEPLOYMENT ONLY)
index.js        — Single entry point for programmatic imports
```

## Key Rules

1. **Iron Rule:** Any node with peers > 0 that fails = OUR BUG. Never dismiss.
2. **Never retest without a fix.** Same code + same node = same result.
3. **Consumer functions ≠ testing functions.** See `docs/CONSUMER-VS-TESTING.md`.
4. **Never wipe results without saving.** Auto-save to `runs/` first.
5. **Never kill node.exe globally.** This kills ALL Node.js processes. Kill by PID only.
6. **All SDK findings → SDK suggestions directory.** Document before fixing.

## Data Flow

```
LCD Chain → getAllNodes() → 1002 nodes
  ↓
Status Scan (30 workers) → online/offline + type + peers + drift
  ↓
Batch Payment (5 nodes/TX) → session IDs → chain confirmation
  ↓
Per-Node Test:
  Status → Price → Payment → Handshake → Tunnel → Speed → Google → Disconnect
  ↓
Results → results.json + failures.jsonl + transport-cache.json
  ↓
Dashboard (SSE) → real-time table + log + progress
```

## File Naming Conventions

| Pattern | Meaning | Example |
|---------|---------|---------|
| `core/*.js` | Shared infrastructure | `chain.js`, `wallet.js`, `session.js` |
| `audit/*.js` | Test-specific orchestration | `pipeline.js`, `node-test.js`, `retry.js` |
| `protocol/*.js` | Protocol implementation | `v3protocol.js`, `speedtest.js` |
| `platforms/{os}/*.js` | Platform-specific | `windows/wireguard.js` |
| `docs/*.md` | Documentation | `BUILD-ON-ME.md`, `FUNCTION-REFERENCE.md` |
| `suggestions/*.md` | Timestamped findings | `2026-03-24-*.md` |
| `results/*.json` | Test data | `results.json`, `transport-cache.json` |
| `results/runs/test-NNN/` | Archived run | `test-001/results.json` |

## Function Naming Conventions

| Pattern | Example | Meaning |
|---------|---------|---------|
| `verbNoun` | `getAllNodes`, `testNode`, `installWgTunnel` | Action functions |
| `isNoun` / `hasNoun` | `isPaid`, `isSessionPoisoned` | Boolean checks |
| `clearNoun` | `clearAllCredentials`, `clearPaidNodes` | Reset state |
| `buildNoun` | `buildV2RayClientConfig`, `buildSessionMap` | Construct objects |
| `extractNoun` | `extractSessionId`, `extractSessionMap` | Parse from response |
| `waitForNoun` | `waitForSessionActive`, `waitForPort` | Async polling |

## Variable Naming

| Convention | Example |
|-----------|---------|
| camelCase for variables | `sessionId`, `clockDriftSec`, `actualMbps` |
| UPPER_SNAKE for constants | `V3_MSG_TYPE`, `LCD_ENDPOINTS`, `NODE_DELAY` |
| kebab-case for files | `node-test.js`, `transport-cache.js` |

## Configuration

```env
# .env (NEVER commit)
MNEMONIC=twelve word mnemonic phrase
RPC=https://rpc.sentinel.co:443
DENOM=udvpn
GAS_PRICE=0.2udvpn
GIGABYTES_PER_NODE=1
TEST_MB=10
MAX_NODES=0
NODE_DELAY_MS=5000
PORT=3001
DNS_SERVERS=              # empty = OpenDNS default
```

## On-Chain Costs (Real Money)

| Action | Cost | When |
|--------|------|------|
| Session (per-GB) | ~40 P2P per node | Every testNode() |
| Gas per TX | 0.2 P2P | Every broadcast |
| Batch (5 nodes) | ~200 P2P | submitBatchPayment() |
| Query (LCD) | FREE | getAllNodes(), getBalance() |
| Status check | FREE | nodeStatusV3() |

## Critical Types

```javascript
// TestResult — what every node test produces
{
  timestamp, address, type, moniker,
  country, countryCode, city,
  peers, maxPeers,
  actualMbps,           // null if failed
  baselineAtTest,
  pass10mbps, pass15mbps,
  googleAccessible, googleLatencyMs,
  sdk, os,
  error,                // null if passed
  diag: { clockDriftSec, v2rayTransport, v2raySecurity, sessionId, ... }
}

// ChainNode — from LCD query
{ address, remoteUrl, remoteAddrs[], gigabyte_prices[], planIds[] }

// NodeStatus — from status endpoint
{ type, moniker, peers, bandwidth: {download, upload}, location: {city, country, country_code}, clockDriftSec, qos }
```

## How to Read the Codebase

1. **Start:** `START-HERE.md` → answers your question in 4 steps
2. **Architecture:** `CONTEXT.md` (this file) → data flow, conventions, costs
3. **Every function:** `docs/FUNCTION-REFERENCE.md` → execution order with I/O
4. **Integration:** `docs/BUILD-ON-ME.md` → working code, one-shot guide
5. **Edge cases:** `docs/TECHNICAL-BLUEPRINT.md` → every detail mapped
6. **What's safe:** `docs/CONSUMER-VS-TESTING.md` → 160 functions categorized
7. **Mission:** `MANIFESTO.md` → why this exists

## How to Modify the Codebase

1. Read the file you're changing FIRST
2. Check `suggestions/` for recent context
3. Follow existing patterns (naming, structure, error handling)
4. Test against real nodes, not mocks
5. Document findings in `suggestions/YYYY-MM-DD-*.md`
6. Update `HANDOFF.md` with what you did
7. Never break what works — 1002 nodes tested, protocol code is battle-tested
