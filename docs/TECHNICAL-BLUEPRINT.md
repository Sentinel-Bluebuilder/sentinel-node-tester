# Technical Blueprint — Every Detail Mapped

> This document maps every working, verified behavior of the node tester. Every file, every function, every data flow, every edge case handling, every persistence mechanism. An AI reading this can rebuild the entire system from scratch or integrate it into any application.

---

## Project Inventory

### Source Files (14 core + server + UI)
```
server.js              760 lines  — Express routes, SSE, state management, run archiving
index.html            1492 lines  — Dashboard: stats, results table, log, controls
index.js                50 lines  — Single entry point for imports

core/
  constants.js          71 lines  — Env config, DNS presets, chain endpoints, message types
  chain.js             167 lines  — LCD queries, node list with pagination, multi-LCD failover
  wallet.js            124 lines  — CosmJS client, signAndBroadcastRetry (3 retries)
  session.js           336 lines  — Credential cache, session map, batch payment, extractSessionMap
  csharp-bridge.js     123 lines  — SentinelBridge.exe wrapper, transport_security remap
  transport-cache.js   187 lines  — Learned transport preferences per node
  errors.js             78 lines  — Typed error classes
  types.js              85 lines  — JSDoc type definitions

audit/
  pipeline.js          897 lines  — Main audit loop, batch payment, auto-retest, run management
  node-test.js         745 lines  — Single node test (WG + V2Ray), port pre-check, port discovery
  retry.js             119 lines  — Per-node 5-min timeout, stop-aware, failure classification

protocol/
  v3protocol.js        738 lines  — V3 handshake, V2Ray config builder, WG config writer
  speedtest.js         608 lines  — Cloudflare download, SOCKS5, connectivity check, fallbacks
  diagnostics.js       118 lines  — Failure classification, VPN interference detection

platforms/windows/
  wireguard.js         225 lines  — WG service install/uninstall, sc stop/delete, emergency cleanup
  v2ray.js             124 lines  — V2Ray process spawn/kill, SOCKS port management
  network.js           121 lines  — VPN adapter detection, route inspection

csharp-bridge/
  Program.cs           179 lines  — CLI entry, command router, JSON output envelope
  Commands/
    ConnectCommand.cs  446 lines  — Handshake + full connect + 409 retry + Code 105 retry
    StatusCommand.cs    48 lines  — Node status query
    SpeedtestCommand.cs 56 lines  — Direct + SOCKS5 speed test
    GoogleCheckCommand.cs 75 lines — Google reachability
    BalanceCommand.cs   38 lines  — Wallet balance query
```

### Total: ~6,500 lines of core code + 1,500 lines of UI

---

## Data Persistence (EVERYTHING that gets saved to disk)

### results/results.json
**What:** Array of all test results for the current run.
**Written by:** `saveResults()` in pipeline.js after every node test.
**Read by:** server.js on startup to restore state.
**Auto-saved:** To `runs/test-NNN/results.json` before any new test starts.
**Shape:** Array of TestResult objects (see INTEGRATION.md for full schema).
**CRITICAL:** Never manually delete. Auto-save protects it.

### results/failures.jsonl
**What:** Append-only log of every failure ever. One JSON object per line.
**Written by:** `logFailure()` in node-test.js.
**Never cleared.** Grows over time. Searchable by node address.
**Shape:** `{ ts, node, error, type, sessionId, diag, location }`

### results/session-credentials.json
**What:** Cached WG/V2Ray credentials for session reuse.
**Written by:** `saveCredential()` after successful handshake.
**Cleared by:** `clearAllCredentials()` at audit start.
**Shape:** `{ "sentnode1...": { type, sessionId, wgPrivateKey, uuid, v2rayConfig, savedAt } }`

### results/transport-cache.json
**What:** Learned transport preferences. Which transport works for each node.
**Written by:** `saveTransportCache()` after audit completes.
**Persists across runs.** Never cleared automatically.
**Shape:** `{ "sentnode1...": { key: "vmess/grpc/none", port: 8686, successCount: 3, lastSuccess: "..." } }`

### results/audit-{timestamp}.log
**What:** Human-readable text log of each audit run.
**Created:** One per audit start (including resume).
**Contains:** Wallet address, balance, node count, per-node results, timing.

### results/retest-{timestamp}.log
**What:** Human-readable text log of each retest.
**Contains:** Per-node PASS/FAIL with speed, location, SLA status.

### results/runs/index.json
**What:** Index of all archived test runs.
**Shape:**
```json
{
  "runs": [
    { "number": 1, "label": "...", "date": "...", "total": 1017, "passed": 990, "failed": 27, "pass10": 260, "sdk": "js" }
  ],
  "activeRun": 8
}
```

### results/runs/test-NNN/
**What:** Snapshot of a completed run.
**Contains:** `results.json`, `failures.jsonl`, optionally `summary.txt`.

### results/.state-snapshot.json
**What:** Volatile state backup (baseline history, speed history, total nodes).
**Written by:** server.js periodically.
**Read by:** server.js on startup to restore dashboard state.

### .env
**What:** Wallet mnemonic + config overrides.
**Shape:**
```
MNEMONIC=twelve word mnemonic here
RPC=https://rpc.sentinel.co:443
DENOM=udvpn
GAS_PRICE=0.2udvpn
GIGABYTES_PER_NODE=1
TEST_MB=10
MAX_NODES=0
NODE_DELAY_MS=5000
DNS_SERVERS=           # empty = OpenDNS default
```

### SDK preference file
**Location:** `results/.sdk-pref`
**What:** Single line: `js` or `csharp`.
**Read by:** server.js on startup to set `state.activeSDK`.

---

## Server State Object (in-memory, broadcast via SSE)

```javascript
state = {
  status: 'idle' | 'running' | 'paused' | 'done' | 'error',
  activeSDK: 'js' | 'csharp',
  activeRunNumber: 8,
  totalNodes: 1002,
  testedNodes: 975,
  failedNodes: 27,
  passed15: 140,
  passed10: 200,
  passedBaseline: 180,
  baselineMbps: 35.0,
  baselineHistory: [{ mbps, ts }],
  nodeSpeedHistory: [{ mbps, addr, ts }],  // last 10
  balance: '57142.2571 DVPN',
  balanceUdvpn: 57142257100,
  spentUdvpn: 40000000,
  estimatedTotalCost: '40.0000 DVPN',
  walletAddress: 'sent1your...',
  currentNode: 'sentnode1abc...',
  currentType: 'V2Ray',
  currentLocation: 'New York, United States',
  retryCount: 4,
  stopRequested: false,
  errorMessage: null,
  economyMode: false,
  // Retest state
  retestMode: false,
  retestTotal: 24,
  retestTested: 15,
  retestPassed: 2,
  retestFailed: 12,
  // Timing
  startedAt: '2026-03-24T00:00:00Z',
  completedAt: null,
  lowBalanceWarning: false,
}
```

---

## SSE Event Types (server.js → index.html)

| Event | Payload | When | UI Update |
|-------|---------|------|-----------|
| `state` | `{ state }` | State changes (status, counters) | Stats grid, progress bar |
| `result` | `{ result, state }` | Each node test completes | Results table row |
| `log` | `{ msg }` | Every log message | Log panel append |
| `progress` | `{ state }` | Node test starts | Current node display |
| `baseline` | `{ mbps }` | Baseline speed measured | Baseline display |

---

## Audit Pipeline Flow (pipeline.js)

```
runAudit(resume, state, broadcast):
  1. clearPoisonedSessions()
  2. clearPaidNodes()
  3. clearAllCredentials()           ← wipes stale sessions
  4. invalidateSessionCache()        ← forces fresh session lookups
  5. Setup wallet (cachedWalletSetup)
  6. Get balance
  7. Check V2Ray + WireGuard available
  8. Load transport cache
  9. Run baseline speed test
  10. Fetch node list (getAllNodes)   ← paginated, 200/page
  11. Fetch plan membership
  12. Phase 2: Parallel status scan (30 workers)
      - For each node: nodeStatusV3() or bridgeNodeStatus()
      - Records: type, peers, location, clock drift
      - Filters: online only
  13. Phase 3: Batch payment (5 nodes per TX)
      - submitBatchPayment() → extractSessionMap() → chain query for mapping
      - waitForBatchSessions() → confirm on chain
  14. Phase 4: Sequential test (one at a time)
      - For each node in batch:
        - testWithRetry() → testNode()
        - upsertResult() → saveResults()
        - broadcast('result')
      - Between nodes: uninstallWgTunnel() + emergencyCleanupSync() + NODE_DELAY
  15. After all batches: Auto-retest failures with peers (Iron Rule)
  16. Save transport cache
  17. Set status = 'done'
```

### Resume Flow
```
runAudit(resume=true, ...):
  - Skips steps 1-4 (keeps existing state)
  - Reads results.json from disk
  - Finds first untested node
  - Continues from there
```

### Stop Flow
```
POST /api/stop:
  - Sets state.stopRequested = true
  - retry.js polls every 500ms → rejects with "Stop requested"
  - node-test.js checks before each V2Ray outbound
  - handshakeWithRetry checks before retry attempts
  - Pipeline loop checks between nodes
  - Response within 500ms
```

---

## Single Node Test Flow (node-test.js)

```
testNode(client, account, privkey, node, opts, preSessionId, broadcast, state):

  1. ONLINE CHECK
     - useCSharp? bridgeNodeStatus() : nodeStatusV3()
     - 6s timeout race
     - On fail: try alternate remote_addrs
     - On fail all: throw "Node unreachable"

  2. V2RAY PORT PRE-CHECK (before payment!)
     - Probe common ports: 8686, 8787, 7874, 7876, 443, 8443, 55215, 55216
     - If ALL dead: throw "V2Ray service dead" (saves tokens)

  3. CLOCK DRIFT
     - From HTTP Date header vs local time
     - >120s: log warning, set extremeDrift flag

  4. PRICE CHECK
     - gigabyte_prices from LCD data
     - Must have udvpn pricing

  5. SESSION RESOLUTION
     - Check credential cache → reuse if valid
     - Check duplicate payment guard
     - Check balance sufficient

  6. PAYMENT (if needed)
     - signAndBroadcastRetry() with MsgStartSessionRequest
     - extractSessionId() from TX events
     - waitForSessionActive(sessionId) — direct ID query (fast)
     - 5s wait for node to index session
     - On Code 105: queryNodeStatusDirect() across all LCDs → retry 20s+30s

  7. HANDSHAKE
     - handshakeWithRetry(fn, makeFn):
       - Try once
       - "already exists" → retest mode? payForFreshSession immediately
         normal mode? wait 15s → retry → wait 20s → retry → payForFreshSession
       - "address mismatch" → retry once after 5s
       - "ABCI query failed" → retry after 20s
       - "database" errors → retry after 15s
       - "does not exist" → retry after 10s
     - WireGuard: initHandshakeV3() or bridgeHandshakeWG()
     - V2Ray: initHandshakeV3V2Ray() or bridgeHandshakeV2Ray()

  8. BUILD CONFIG
     - WireGuard: writeWgConfig() with ACTIVE_DNS
     - V2Ray: buildV2RayClientConfig() with:
       - clockDriftSec → alterId 0 (AEAD) or 64 (legacy)
       - gun+grpc dual outbounds for transport_protocol:3
       - QUIC stripped
       - Transport sort by success rate
       - DNS from ACTIVE_DNS

  9. TUNNEL + TEST
     - WireGuard:
       - installWgTunnel() (3-step cleanup + verify)
       - speedtestDirect() through tunnel
       - checkGoogleDirect()
       - uninstallWgTunnel()
     - V2Ray:
       - For each outbound (sorted by transport cache):
         - TCP port probe (warn but don't skip)
         - spawnV2Ray(config, outbound, socksPort)
         - waitForPort(socksPort)
         - speedtestViaSocks5()
         - checkGoogleViaSocks5()
         - On success: recordTransportSuccess(), break
         - On fail: recordTransportFailure(), try next
       - If ALL fail + peers > 0:
         - Port scan (metadata ± 200 + 7000-9000)
         - If discovered: rebuild config with new port, retry
       - If still fail: throw

  10. RESULT
      - Build TestResult object with all metrics
      - Return to pipeline
```

---

## Speed Test Flow (speedtest.js)

```
speedtestViaSocks5(testMb, socksPort):

  Phase 0: CONNECTIVITY CHECK (must pass before speed test)
    targets: google.com, cloudflare.com, one.one.one.one, httpbin.org, ifconfig.me, ip-api.com
    3 attempts, 5s between
    15s timeout per target
    If ALL fail → "SOCKS5 tunnel has no internet connectivity"

  Phase 1: 1MB PROBE
    Primary: speed.cloudflare.com/__down?bytes=1048576
    Fallback: proof.ovh.net/files/1Mb.dat, speedtest.tele2.net/1MB.zip
    Rescue: google.com page download (rough estimate)
    Last resort: return { mbps: 0.01, adaptive: 'connected-no-throughput' }

  Phase 2: ADAPTIVE (if probe >= 3 Mbps)
    5 × 1MB parallel downloads from winning target
    Result: average Mbps across all chunks

  Phase 3: SPEED CAP
    If tunnel speed > baseline: cap at 97% of baseline (ISP bottleneck indicator)
```

---

## V2Ray Config Builder (v3protocol.js)

```
buildV2RayClientConfig(serverHost, metadataJson, uuid, socksPort, opts):

  Input metadata: [{ proxy_protocol, transport_protocol, transport_security, port }]

  Protocol mapping:
    proxy_protocol: 1=VLess, 2=VMess
    transport_protocol: 2=gun, 3=grpc, 4=http, 5=mkcp, 6=quic, 7=tcp, 8=websocket
    transport_security: 1=none, 2=TLS (JS notation). C# bridge adds +1.

  Steps:
    1. Filter: remove domainsocket (transport_protocol:1)
    2. Sort: tcp > websocket > http > gun > mkcp > grpc/none > grpc/tls > quic
    3. For transport_protocol:3 (grpc): generate BOTH gun AND grpc outbounds
    4. For VMess + |clockDrift| > 120: set alterId=64 (legacy, no AEAD)
    5. For each outbound:
       - protocol: vless or vmess
       - streamSettings: network, security, tlsSettings (if tls), grpcSettings (if grpc/gun)
       - VMess: { id: uuid, alterId: 0 or 64 }
       - VLess: { id: uuid, encryption: 'none' }
    6. Wrap in config:
       - dns: { servers: ACTIVE_DNS }
       - inbounds: [dokodemo-door API, socks proxy with sniffing]
       - outbounds: sorted outbounds + freedom (direct)
       - routing: proxy inbound → first outbound
       - policy + stats for bandwidth tracking
```

---

## WireGuard Config (v3protocol.js)

```
writeWgConfig(wgPrivKey, assignedAddrs, serverPubKey, serverEndpoint, splitIPs):

  [Interface]
  PrivateKey = <base64>
  Address = <assigned IPs>
  MTU = 1420
  DNS = <ACTIVE_DNS>           ← only for full tunnel (no split IPs)

  [Peer]
  PublicKey = <server pubkey>
  Endpoint = <server IP:port>
  AllowedIPs = <split IPs or 0.0.0.0/0>
  PersistentKeepalive = 25

  Written to: C:\ProgramData\sentinel-wg\wgsent0.conf
```

---

## WireGuard Service Management (wireguard.js)

```
installWgTunnel(confPath):
  1. sc stop WireGuardTunnel$wgsent0
  2. wireguard.exe /uninstalltunnelservice wgsent0
  3. sc delete WireGuardTunnel$wgsent0
  4. Poll sc query (5 × 500ms) until service gone
  5. wireguard.exe /installtunnelservice <confPath>  (3 retries: 1.5s, 1.5s, 2s)
  6. Wait 1.5s for tunnel to establish

uninstallWgTunnel():
  1. wireguard.exe /uninstalltunnelservice <name>
  2. Delete conf file
  3. Reset state vars

emergencyCleanupSync():
  1. Uninstall known tunnel names (wgsent0 + active)
  2. sc query all services → find WireGuardTunnel$wgsent*
  3. sc stop + sc delete each
```

---

## C# Bridge Protocol (csharp-bridge.js)

```
bridgeNodeStatus(remoteUrl):
  Spawns: SentinelBridge.exe status <url>
  Timeout: 20s
  Maps C# output → JS nodeStatusV3 shape

bridgeHandshakeWG(remoteUrl, sessionId):
  Spawns: SentinelBridge.exe handshake <url> <sessionId> <mnemonic> wireguard
  Returns: { assignedAddrs, serverPubKey, serverEndpoint, clientPrivateKey }

bridgeHandshakeV2Ray(remoteUrl, sessionId):
  Spawns: SentinelBridge.exe handshake <url> <sessionId> <mnemonic> v2ray
  REMAPS: transport_security += 1 (C# 0-indexed → JS 1-indexed)
  REMAPS: port → String(port)
  Returns: { config: fakeMetadataJson, uuid }
```

---

## Retry & Timeout System (retry.js)

```
testWithRetry(testFn, broadcast, state, nodeAddr):
  Hard timeout: 300s (5 min) per node via Promise.race
  Stop-aware: polls state.stopRequested every 500ms
  Max retries: 2

  Classification → action:
    vpn_interference → pause, wait for clear
    chain_lag → wait 10s, retry
    session_conflict → clear creds, wait 2s, retry
    network_timeout → wait 5s, retry
    node_error → no retry (fatal for this node)
    fatal → no retry
```

---

## Dashboard UI (index.html)

### Layout Sections
1. **Header:** Logo, Windows badge, SDK toggle (JS/C#), DNS dropdown, Dictator Mode link
2. **Stats grid:** Total, Tested, Remaining, Pass Rate, >10Mbps, Balance
3. **Controls:** New Test, Resume, Rescan, Retest Failed, Stop, Economy, Plan Test, Reset
4. **Speed history:** Last 10 speeds as color-coded pills (green ≥15, yellow ≥5, red <5)
5. **Results table:** SDK, Transport, Node, Country, City, Peers, Speed, Total BW, Baseline, Result
6. **Log panel:** Scrolling real-time log with timestamps, color-coded (warn=yellow, ok=green, err=red)
7. **Run selector:** Dropdown to load archived test runs

### Result Badges
- **FAST** (green, `badge-pass`): ≥10 Mbps
- **SLOW** (yellow, `badge-slow`): connected, <10 Mbps
- **FAIL** (red, `badge-fail`): no connection/speed

### Country Flags
```javascript
const flag = cc.length === 2
  ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65))
  : '';
```

### Total BW Calculation
```javascript
const effectivePeers = (peerCount >= 1) ? peerCount : 1;
const totalBw = actualMbps * effectivePeers;
```

### Column Alignment
- Left: SDK, Transport, Node, Country, City
- Center: Peers, Result
- Right: Speed, Total BW, Baseline

### Cell Padding
- `td`: 6px 6px, white-space: nowrap, vertical-align: middle
- `th`: 6px 6px
- Table: border-spacing 0 4px
- Main: max-width 1920px, padding 20px

---

## API Endpoints (server.js)

### Audit Control
| Method | Path | Body | Response | Notes |
|--------|------|------|----------|-------|
| POST | /api/start | — | `{ ok, testNumber }` | Auto-saves previous results to runs/ |
| POST | /api/resume | — | `{ ok, testNumber, resumeFrom }` | Resumes from last result |
| POST | /api/stop | — | `{ ok }` | Responds in <500ms |
| POST | /api/auto-retest | `{ force?: true }` | `{ ok, retesting, addresses }` | `force` retests ALL including "permanent" |

### State & Results
| Method | Path | Response |
|--------|------|----------|
| GET | /api/state | `{ state: { status, testedNodes, failedNodes, ... } }` |
| GET | /api/failure-analysis | `{ total, passed, failed, successRate, categories, retestable, dead }` |
| GET | /api/results | Raw results array |
| GET | /events | SSE stream (result, state, log, progress events) |

### Configuration
| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | /api/sdk | `{ sdk: "js"|"csharp" }` | `{ ok }` |
| GET | /api/sdk | — | `{ sdk }` |
| POST | /api/dns | `{ preset: "hns"|"google"|"cloudflare"|"default" }` | `{ ok, servers }` |
| GET | /api/dns | — | `{ servers, presets }` |
| POST | /api/economy | — | `{ ok, economyMode }` |

### Run Management
| Method | Path | Response |
|--------|------|----------|
| GET | /api/runs | `{ runs: [...], activeRun }` |
| POST | /api/runs/save | `{ ok }` |
| GET | /api/runs/:num | Run results |
| POST | /api/runs/load/:num | Loads run into active results |

---

## Edge Cases Handled (verified working)

| Edge Case | Detection | Fix | File:Line |
|-----------|-----------|-----|-----------|
| 409 session exists | `/already exists/` in handshake error | 15s+20s retry → payForFreshSession | node-test.js:290-310 |
| Code 105 inactive | `/Code: 105/` in broadcast error | queryNodeStatusDirect across 4 LCDs → 20s+30s retry | node-test.js:170-210 |
| Clock drift >120s | HTTP Date header comparison | alterId=64 (legacy VMess, no AEAD) | v3protocol.js:580 |
| Stale credentials | Session expired on chain | clearAllCredentials() at audit start | pipeline.js:176 |
| WG service stuck | Install fails with "already installed" | sc stop → uninstall → sc delete → verify gone | wireguard.js:142-157 |
| V2Ray port dead | TCP probe ECONNREFUSED | Pre-check before payment → "V2Ray service dead" | node-test.js:108-120 |
| Port migration | Metadata ports ≠ actual ports | Post-failure port scan → config rebuild → retry | node-test.js:617-650 |
| Batch session mapping | Events lack node_address | Chain query after broadcast (not index-based) | session.js:245-265 |
| transport_security | C# 0-indexed, JS 1-indexed | Bridge wrapper remaps +1 | csharp-bridge.js:114 |
| UUID wait | Node needs time to register UUID | 10s sleep after handshake | node-test.js:440 |
| gun vs grpc | transport_protocol:3 ambiguous | Generate BOTH outbounds, gun first | v3protocol.js:587-600 |
| DB error | "retrieving session" | Retry after 15s (not fatal) | node-test.js:275-280 |
| Status transient fail | Node briefly unreachable | Retry same addr after 3s, then alternates | node-test.js:62-82 |
| Duplicate payment | Already paid in this run | Guard in normal mode, bypass in retest mode | node-test.js:124-130 |
| Results wipe | New test clears results.json | Auto-save to runs/ before clearing | server.js:284-310 |
| Stop latency | Stop takes 5 min | 500ms polling in retry.js Promise.race | retry.js:53-57 |

---

## DNS Configuration

```javascript
DNS_PRESETS = {
  default:    ['208.67.222.222', '208.67.220.220'],  // OpenDNS
  hns:        ['103.196.38.38', '103.196.38.39'],    // Handshake HDNS
  cloudflare: ['1.1.1.1', '1.0.0.1'],
  google:     ['8.8.8.8', '8.8.4.4'],
};
```

Injected into:
- V2Ray config: `dns.servers` array
- WireGuard config: `DNS = ...` line
- Changed via: `POST /api/dns {"preset":"hns"}` or dashboard dropdown

---

## Launch Sequence

```
1. SentinelAudit.vbs    → elevates to Admin (WireGuard requires it)
2. node server.js       → Express on port 3001
3. Loads .env           → MNEMONIC, RPC, DNS
4. Loads results.json   → restores previous results
5. Loads .state-snapshot → restores baseline, speed history, totalNodes
6. Loads .sdk-pref      → sets activeSDK
7. Loads transport-cache → learned transport preferences
8. Dashboard ready at http://localhost:3001
```

---

## Process Safety

- **NEVER** `taskkill /F /IM node.exe` — kills ALL Node.js processes
- **NEVER** `taskkill /F /IM v2ray.exe` during audit — kills active test
- Kill by PID only: `taskkill //F //PID <exact_pid>`
- V2Ray watchdog: 45s max tunnel lifetime for WireGuard
- Emergency cleanup on process exit: `emergencyCleanupSync()`
