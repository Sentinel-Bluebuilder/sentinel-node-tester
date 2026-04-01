# Sentinel dVPN Node Testing — Complete Reference

> **Status:** The Node Tester CLI (Level 1) is a working development tool used daily. It is NOT packaged as an SDK module yet. The in-app testing spec (Level 2) is a design document for future integration — not implemented.

## Overview

Node testing has two levels, at different stages of maturity.

**Level 1 (Protocol Testing) — WORKING** — A standalone CLI tool (`sentinel-node-tester`) that tests raw protocol mechanics: handshake construction, V2Ray config building, transport selection, blockchain edge cases. Runs independently. Found 17+ bugs across JS and C# SDKs. This is the primary tool for SDK development and network auditing.

**Level 2 (Application Testing) — SPEC ONLY** — A future SDK module that consumer apps will integrate. Tests the app's own connect/disconnect functions against real nodes. Design doc at `AI-BUILD-NODE-TEST.md` and `IN-APP-NODE-TESTING.md`. Not yet implemented in any app.

This document covers both levels. Level 1 is reference material. Level 2 is the build target.

---

## Level 1: Node Tester CLI

### Location
`Desktop/sentinel-node-tester/`

### What It Does
Tests every active node on the Sentinel blockchain:
1. Queries all active nodes from LCD
2. Pays for sessions (batch: 5 nodes per TX)
3. Performs V3 handshake (JS or C# SDK)
4. Establishes WireGuard or V2Ray tunnel
5. Runs connectivity check + speed test through tunnel
6. Records results with full diagnostics

### API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/start | New test (saves previous results first) |
| POST | /api/resume | Resume from where left off |
| POST | /api/stop | Stop current audit (responds within 500ms) |
| POST | /api/auto-retest | Retest failed nodes. `{"force":true}` retests all including "permanent" failures |
| GET | /api/state | Current audit state (tested, failed, status, balance) |
| GET | /api/failure-analysis | Categorized failures with error details |
| POST/GET | /api/sdk | Toggle JS/C# SDK. `{"sdk":"csharp"}` or `{"sdk":"js"}` |
| GET/POST | /api/dns | Get/set DNS. `{"preset":"hns"}` or `{"servers":["1.1.1.1"]}` |
| GET | /api/runs | List saved test runs |
| POST | /api/runs/save | Save current run to archive |
| GET | /api/runs/:num | Load specific run results |

### Launch
```bash
# Windows (requires Admin for WireGuard):
cscript //nologo SentinelAudit.vbs

# NEVER use: node server.js (no admin elevation)
# NEVER use: start.bat (deprecated)
```
Dashboard: http://localhost:3001

### SDK Toggle (JS vs C#)
When SDK is set to `csharp`, the audit pipeline calls `SentinelBridge.exe` for status checks and handshakes. Payment and tunnel management stay in JS. This tests the actual C# SDK code path.

### Architecture
```
sentinel-node-tester/
├── server.js                  — Express server, routes, SSE
├── index.html                 — Dashboard UI
├── core/
│   ├── constants.js           — Config, DNS presets, endpoints
│   ├── wallet.js              — CosmJS wallet, broadcast retry
│   ├── chain.js               — LCD queries, node list, multi-LCD failover
│   ├── session.js             — Session map, credentials, batch payment, extractSessionMap
│   ├── csharp-bridge.js       — Wrapper for SentinelBridge.exe calls
│   └── transport-cache.js     — Learned transport preferences per node
├── audit/
│   ├── pipeline.js            — Main audit loop, auto-retest at end
│   ├── node-test.js           — Single node test (WG or V2Ray)
│   └── retry.js               — Zero-skip retry, per-node 5-min timeout, stop-aware
├── protocol/
│   ├── v3protocol.js          — V3 handshake, V2Ray config builder, WG config
│   ├── speedtest.js           — Cloudflare download, SOCKS5, connectivity check
│   └── diagnostics.js         — Failure classification, VPN interference detection
├── platforms/windows/
│   ├── wireguard.js           — WG service install/uninstall with sc stop/verify
│   ├── v2ray.js               — V2Ray process spawn/kill
│   └── network.js             — VPN adapter detection
├── csharp-bridge/             — .NET 8 CLI bridge to C# SDK
│   ├── Commands/ConnectCommand.cs  — Handshake + full connect flow
│   ├── Commands/StatusCommand.cs   — Node status query
│   └── Commands/SpeedtestCommand.cs
├── bin/
│   ├── v2ray.exe              — V2Ray 5.44.1
│   └── v2ray-5.2.1.exe       — Backup
└── results/
    ├── results.json           — Current test results
    ├── failures.jsonl         — Detailed failure log
    ├── session-credentials.json
    ├── transport-cache.json
    └── runs/                  — Archived test runs
```

### Bugs Found (17+)
Full details: `suggestions/node-tester-bugs-2026-03-22.md`

| # | Bug | Impact | Root Cause |
|---|-----|--------|------------|
| 1 | Batch session mapping | Wrong session → wrong node | TX events unordered, index-based guess |
| 2 | 409 no fresh session | 13 nodes stuck | Retried with same dead session |
| 3 | Clock drift rejection | 4 nodes rejected without trying | Pre-reject based on HTTP Date header |
| 4 | Code 105 stale cache | 66-peer node marked inactive | Single LCD, no re-query |
| 5 | WG tunnel collision | Service already installed | No sc stop before uninstall |
| 6 | Single remote_addrs | ETIMEDOUT on fallback address | Only used [0] of array |
| 7 | Wrong classifications | Wasteful retries | Fatal errors classified as retriable |
| 8 | No per-node timeout | V2Ray hangs forever | No hard deadline |
| 9 | Pipeline URL format | "undefined" in URL | v2 field name in v3 code |
| 10 | Duplicate payment guard | Blocks retests | Stale paid state across retests |
| 11 | C# bridge not wired | Toggle was cosmetic | Pipeline always used JS |
| 12 | Missing UUID wait | All C# V2Ray failed | No 10s sleep after handshake |
| 13 | transport_security offset | TLS mapped as none | C# 0-indexed vs JS 1-indexed |
| 14 | Status no retry | Transient failures permanent | Single attempt |
| 15 | DB error misclassified | "retrieving session" fatal | Should retry after 15s |
| 16 | Stale credential cache | Expired sessions reused | Disk cache not cleared |
| 17 | Results wiped no save | 130 results lost | No snapshot before clearing |

### Edge Cases Discovered
- **Peer count ≠ VPN peers:** `peers` field counts sentinel protocol connections, not active tunnels. A node with 8 "peers" can have 0 working VPN tunnels.
- **V2Ray port migration:** Some nodes (kfmg operator) run V2Ray on different ports than metadata advertises. Port scanning finds the real ports.
- **VMess alterId:** alterId=0 (AEAD) fails with clock drift >120s. alterId=64 (legacy) has no clock check. Official apps may use legacy mode.
- **gun vs grpc:** V2Ray `transport_protocol:3` maps to 'grpc' but sentinel-go-sdk nodes may use 'gun' internally. Generate both outbounds.
- **Batch event ordering:** Cosmos SDK TX events don't include node_address. Session IDs extracted from events can't be mapped to nodes by index. Must query chain after broadcast.

---

## Level 2: In-App Node Testing

### Location
`Sentinel SDK/docs/AI-BUILD-NODE-TEST.md` — Full AI build instructions
`Sentinel SDK/docs/IN-APP-NODE-TESTING.md` — Spec and interface definitions

### What It Does
Tests the APPLICATION'S OWN connect/disconnect functions against real nodes. The app is a black box — the test layer calls the same functions the user calls.

### How It Works
1. App implements `IVpnTestAdapter` (5 methods: connect, disconnect, isConnected, connectedNode, tunnelType)
2. SDK `NodeTester` takes the adapter and a node list
3. For each node: connect → check connectivity → DNS test → speed test → disconnect
4. Results displayed in a dashboard tab within the app

### Supported Platforms
| Platform | Language | Adapter Pattern | HTTP Routing |
|----------|----------|-----------------|-------------|
| Windows WPF | C# | Interface + class | HttpClient (system proxy) |
| Windows Electron | JS | Object with methods | fetch (system proxy) |
| macOS | Swift | Protocol + class | URLSession (system VPN) |
| Linux Electron | JS | Same as Windows | fetch (system proxy) |
| iOS | Swift | Protocol + NEVPNManager | URLSession (VPN routing) |
| Android | Kotlin | Interface + VpnService | HttpURLConnection |

### Dashboard Tab Requirements
- Separate tab in app navigation
- Matches app theme (colors, fonts, spacing from app's style system)
- Same columns as Node Tester: Type, Node, Country (flag+code), City, Peers, Speed, Result
- FAST (green ≥10Mbps), SLOW (yellow <10Mbps), FAIL (red)
- DNS test toggle with provider selector (HNS, Google, Cloudflare)
- Start/Stop, progress bar, filters, CSV/JSON export
- Level 1 comparison column when available

### Files Created Per Integration
```
Services/
  NodeTestAdapter.{cs,js,swift}      — 50 lines (wraps app backend)
  NodeTestService.{cs,js,swift}      — 200 lines (orchestrator)
  ConnectivityCheck.{cs,js,swift}    — 50 lines (HTTP probe)
  SpeedTest.{cs,js,swift}            — 60 lines (download measurement)
  DnsTest.{cs,js,swift}              — 80 lines (resolution test)
Views/
  NodeTestTab.{xaml,html,swift}      — 150 lines (dashboard UI)
Models/
  NodeTestModels.{cs,js,swift}       — 60 lines (result types)

Total: ~500-800 lines. No new dependencies.
```

---

## DNS Testing

### Purpose
Validate Handshake (HNS) DNS as default DNS for the SDK. Compare resolution reliability through VPN tunnels across providers.

### Presets
| Provider | Servers | HNS Domains |
|----------|---------|-------------|
| HNS (Handshake) | 198.51.100.1, 198.51.100.1 | Resolves .hns TLDs |
| Google | 8.8.8.8, 8.8.4.4 | Standard only |
| Cloudflare | 1.1.1.1, 1.0.0.1 | Standard only |
| OpenDNS (default) | 208.67.222.222, 208.67.220.220 | Standard only |

### Test Targets
- Standard: google.com, sentinel.co, cloudflare.com
- HNS: welcome.nb, 3b, letsdane

### Integration
- Level 1: `POST /api/dns {"preset":"hns"}` — changes V2Ray + WireGuard DNS config
- Level 2: DNS test toggle in app dashboard, per-node DNS resolution results

---

## Iron Rule

**Any node with peers > 0 that fails to connect = OUR BUG.**

Never dismiss as "node-side", "protocol limitation", or "node misconfiguration". If other clients connect (peers > 0), our code is wrong. Trace every code path. Compare JS vs C# results for the same node.

This rule was proven on 2026-03-22 when 8 failures initially dismissed as "node issues" were all traced to real code bugs: stale cache, batch mapping, premature rejection, missing UUID wait, transport_security offset.

### The Loop
When testing hits failures with peers > 0:
1. Deep inspect every failure — compare JS vs C# for same node
2. Fix the code
3. Retest specific failing nodes
4. If pass → continue audit
5. If still fail → dig deeper
6. Repeat until resolved or every code path exhausted

---

## Chain v3 Quick Reference

### LCD Endpoints (ordered by reliability)
1. `https://lcd.sentinel.co`
2. `https://api.sentinel.quokkastake.io`
3. `https://sentinel-api.polkachu.com`
4. `https://sentinel.api.trivium.network:1317`

### Query Paths
| Query | Path |
|-------|------|
| Active nodes | `/sentinel/node/v3/nodes?status=1&pagination.limit=5000` |
| Single node | `/sentinel/node/v3/nodes/{sentnode1...}` |
| Sessions by account | `/sentinel/session/v3/sessions?address={sent1...}&status=1` |
| Sessions by node | `/sentinel/session/v3/nodes/{sentnode1...}/sessions?status=1` |
| Single session | `/sentinel/session/v3/sessions/{id}` |
| Provider | `/sentinel/provider/v2/providers/{sentprov1...}` (v2 — NOT v3) |
| Balance | `/cosmos/bank/v1beta1/balances/{sent1...}` |

### v3 Field Names
| Correct (v3) | Wrong (v2) |
|--------------|------------|
| `service_type` | `type` |
| `remote_addrs` (array) | `remote_url` (string) |
| `acc_address` | `address` |
| Session in `base_session` wrapper | flat |
| `status=1` (active) | `status=STATUS_ACTIVE` |

### Handshake Signature
`sign(SHA256(BigEndian_uint64(sessionId) + raw_peer_data_json_bytes))`
Sign RAW JSON bytes, not base64.

### Token
Display: **P2P**. Chain denom: `udvpn`. 1 P2P = 1,000,000 udvpn.
