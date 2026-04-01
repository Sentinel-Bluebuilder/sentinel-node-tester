# Sentinel Node Tester

[![npm version](https://img.shields.io/npm/v/sentinel-node-tester.svg)](https://www.npmjs.com/package/sentinel-node-tester)
[![Tests](https://github.com/Sentinel-Autonomybuilder/sentinel-node-tester/actions/workflows/test.yml/badge.svg)](https://github.com/Sentinel-Autonomybuilder/sentinel-node-tester/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

Network audit dashboard for the [Sentinel dVPN](https://sentinel.co) blockchain. Tests every active node for real VPN throughput, protocol compliance, speed, and accessibility.

Built on the [Sentinel dVPN SDK](https://www.npmjs.com/package/sentinel-dvpn-sdk) — the same protocol stack that powers consumer VPN applications.

---

## What It Does

Connects to the Sentinel blockchain, discovers every active dVPN node, pays for bandwidth sessions, establishes real VPN tunnels (WireGuard + V2Ray), and measures actual throughput. Every node gets a PASS or FAIL with full diagnostics.

- **987+ nodes** tested in a single audit run
- **WireGuard + V2Ray** dual-protocol coverage
- **Batch payments** (5 nodes per transaction — 5x gas savings)
- **Zero-skip system** — every node ends as PASS or FAIL
- **Real-time dashboard** with SSE streaming, speed charts, and failure analysis
- **Test run history** — save, compare, and load past audits

---

## What You Can Test

### 1. Node Performance
Test any dVPN node for actual bandwidth. Measures download speed through a real VPN tunnel against Cloudflare CDN with adaptive fallback.

### 2. SDK Validation
Toggle between JavaScript and C# SDK implementations. Same nodes, same protocol, different code paths. Every difference reveals an SDK bug.

### 3. Protocol Compliance
Exercises the full Sentinel v3 pipeline end-to-end:
```
LCD Discovery -> Session Creation -> Handshake -> Tunnel Setup -> Bandwidth Test -> Disconnect
```

### 4. DNS Testing
Configure different DNS resolvers per audit run. Compare results across:
- **Handshake DNS** (103.196.38.38) — decentralized naming
- **Google DNS** (8.8.8.8)
- **Cloudflare DNS** (1.1.1.1)
- **Custom resolvers**

### 5. Operating System Validation
WireGuard and V2Ray behave differently across Windows, macOS, and Linux. Run the same audit on different machines to find OS-specific failures.

### 6. Google Accessibility
Every node is tested for Google.com reachability through the VPN tunnel. Maps which countries and nodes provide uncensored internet access.

### 7. Transport Analysis
V2Ray supports multiple transports: TCP, WebSocket, HTTP, gRPC, gun. The tester tries every variant and builds an intelligence cache that learns which transports work best per node and geography.

### 8. Device Testing
Run audits from different devices — laptops, desktops, VPS, ARM boards — to identify device-specific networking issues, MTU problems, and driver compatibility.

### 9. Failure Forensics
Every failure produces a structured diagnostic:
- Connection timeouts with port scan data
- Clock drift detection for VMess AEAD failures
- Address mismatch analysis across `remote_addrs`
- Chain propagation lag measurement
- Database corruption detection on nodes

---

## Quick Start

### Prerequisites
- **Node.js 20+**
- **WireGuard** installed (optional — V2Ray works without)
- **Administrator/root** for WireGuard tunnel management
- Sentinel wallet with P2P tokens (~1 P2P per 25 node tests)

### Install & Run

```bash
git clone https://github.com/nicxd531/sentinel-node-tester.git
cd sentinel-node-tester
npm install

# Configure wallet
cp .env.example .env
# Edit .env — add your mnemonic

# Launch (as Administrator for WireGuard)
node server.js

# Open dashboard
# http://localhost:3001
```

### Windows (with WireGuard)
```bash
cscript //nologo SentinelAudit.vbs
```
The VBS script handles admin elevation automatically.

---

## Dashboard

Web dashboard at `http://localhost:3001`:

- **Live progress** — SSE streaming as each node is tested
- **Speed charts** — baseline vs node speed history
- **Failure analysis** — categorized breakdown with retest recommendations
- **Test history** — browse and compare past runs
- **DNS config** — switch resolvers mid-audit
- **SDK toggle** — JS or C#
- **Economy mode** — cap tests to balance

### Controls

| Button | Action |
|--------|--------|
| **Start** | New full audit (auto-saves previous) |
| **Resume** | Continue from where last audit stopped |
| **Stop** | Graceful stop after current node |
| **Retest Failed** | Re-test only failed nodes |
| **Auto Retest** | Smart retest based on failure categories |

---

## REST API

All functionality is available programmatically:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/stats` | Quick counters (no results) |
| `GET` | `/api/state` | Full state + all results |
| `GET` | `/api/results?page=1&limit=100` | Paginated results |
| `GET` | `/api/events` | SSE real-time stream |
| `POST` | `/api/start` | Start new audit |
| `POST` | `/api/resume` | Resume current audit |
| `POST` | `/api/stop` | Stop audit |
| `POST` | `/api/retest-fails` | Retest failed nodes |
| `POST` | `/api/auto-retest` | Smart retest (analysis-based) |
| `GET` | `/api/failure-analysis` | Categorized failure breakdown |
| `GET` | `/api/runs` | List all saved test runs |
| `GET` | `/api/runs/:num` | Get specific run results |
| `POST` | `/api/runs/load/:num` | Load historical run |
| `GET/POST` | `/api/dns` | DNS resolver config |
| `GET/POST` | `/api/sdk` | SDK toggle (js/csharp) |
| `GET` | `/api/transport-cache` | Transport intelligence stats |

---

## Embedding in Your Application

Import as a library:

```js
import { testNode } from 'sentinel-node-tester/audit/node-test.js';
import { runAudit, createState } from 'sentinel-node-tester/audit/pipeline.js';
import { nodeStatusV3, buildV2RayClientConfig } from 'sentinel-node-tester/protocol/v3protocol.js';
import { speedtestDirect, speedtestViaSocks5 } from 'sentinel-node-tester/protocol/speedtest.js';
```

See `docs/BUILD-ON-ME.md` for the complete integration guide.

---

## Architecture

```
sentinel-node-tester/
├── server.js              — Express server: routes + SSE (thin, ~300 lines)
├── index.js               — Library entry point
├── index.html             — Dashboard UI
│
├── core/                  — Shared infrastructure
│   ├── constants.js       — Config, env vars, endpoints
│   ├── errors.js          — Typed errors (SDK SentinelError + .diag)
│   ├── wallet.js          — Wallet derivation + signing (SDK adapter)
│   ├── chain.js           — LCD queries + node discovery (SDK adapter)
│   ├── session.js         — Session map, credentials, batch payment
│   └── transport-cache.js — V2Ray transport intelligence
│
├── audit/                 — Audit orchestration
│   ├── pipeline.js        — runAudit, runRetest, state management
│   ├── node-test.js       — Single node test (~450 lines)
│   └── retry.js           — Zero-skip retry with classification
│
├── protocol/              — Network protocol
│   ├── v3protocol.js      — Sentinel v3 handshake (SDK re-exports)
│   ├── speedtest.js       — Bandwidth + Google checks (SDK + local)
│   └── diagnostics.js     — Interference detection, failure classification
│
├── platforms/             — OS-specific
│   └── windows/
│       ├── wireguard.js   — WireGuard service management
│       ├── v2ray.js       — V2Ray process management
│       └── network.js     — VPN adapter detection
│
├── docs/                  — Technical documentation
└── results/               — Runtime data (gitignored)
```

---

## Test Result Schema

```js
{
  timestamp: '2026-03-28T07:34:24Z',
  address: 'sentnode1...',
  type: 'WireGuard',         // or 'V2Ray'
  moniker: 'Node Name',
  country: 'Germany',
  city: 'Frankfurt',
  actualMbps: 45.2,          // null = FAILED
  baselineAtTest: 85.0,
  pass15mbps: true,
  pass10mbps: true,
  peers: 3,
  googleAccessible: true,
  googleLatencyMs: 142,
  sdk: 'js',
  os: 'Windows',
  error: null,               // Error message if failed
  diag: {},                  // Structured diagnostic payload
}
```

**The critical field:** `actualMbps` — if `null`, the node failed. If a number, it passed.

---

## Cost

| Item | Cost |
|------|------|
| Per node (1 GB session) | ~40 P2P (varies by node) |
| Gas per batch (5 nodes) | ~1 P2P |
| Full 987-node audit | ~700-800 P2P |

---

## Principles

1. **Peers > 0 = our fault.** Any node with active users that fails to connect is a bug in our code, not the node.

2. **Zero-skip.** Every node ends as PASS or FAIL. No "skipped" category.

3. **Never lose data.** Auto-save before every new test. Immutable run archives.

4. **Same code + same node = same result.** Never retest without a fix.

---

## Documentation

| Document | Description |
|----------|-------------|
| `docs/BUILD-ON-ME.md` | One-shot integration guide with working code |
| `docs/COMPLETE-INTEGRATION-SPEC.md` | Every button, stat, and platform gotcha |
| `docs/EMBEDDING-GUIDE.md` | JS vs C# vs Swift comparison |
| `docs/FUNCTION-REFERENCE.md` | Every function in execution order |
| `docs/TECHNICAL-BLUEPRINT.md` | Files, data flows, edge cases |
| `docs/UX-FEATURE-PARITY.md` | Features apps must replicate |
| `CONTEXT.md` | Project conventions and rules |
| `ARCH.md` | Module graph and request flow |
| `MANIFESTO.md` | Mission and principles |

---

## License

MIT
