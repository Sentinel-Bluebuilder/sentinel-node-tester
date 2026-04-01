# Sentinel dVPN Node Tester -- AI Onboarding Document

Generated: 2026-03-23
For: Fresh AI instances working on this project
Project path: `C:\Users\user\Desktop\sentinel-node-tester`

---

## 1. Mission

### What This Project Does

The Sentinel dVPN Node Tester is a **founder-level network audit tool** for the Sentinel decentralized VPN protocol. It systematically tests every active dVPN node on the blockchain for real VPN throughput, protocol compliance, and Google accessibility.

It is **not a consumer VPN app**. It is an operator-grade testing instrument that:

1. **Tests nodes** -- Every active dVPN node on the blockchain for real VPN throughput (WireGuard + V2Ray), Google accessibility, and protocol compliance
2. **Validates SDKs** -- Toggle between JS SDK and C# SDK. Same nodes, different implementations. Every difference between them reveals an SDK bug
3. **Verifies the full v3 protocol pipeline** -- LCD discovery, session creation (with batch payment), handshake, tunnel establishment, bandwidth measurement
4. **Discovers bugs** -- Every failure with active peers is investigated, traced, fixed, retested, and documented. Findings feed back into `Sentinel SDK/suggestions/`

### Why It Exists

Sentinel's decentralized VPN network has ~1,000 nodes across dozens of countries. Nobody was systematically testing whether these nodes actually work. This tool tests all of them, measures real bandwidth, checks Google accessibility (censorship resistance), and compares JS vs C# SDK behavior to find protocol-level bugs.

The project has already found and fixed 10+ critical bugs in the handshake pipeline, batch session mapping, credential caching, transport security mapping, and more. Every bug fixed here improves the SDK for all consumers.

### The Iron Rule

**Any node with peers > 0 that fails to connect = OUR BUG.**

This is the single most important principle. If a node has active peers, it means other clients successfully connected. If our code cannot connect, the problem is in our code -- not the node.

- Never dismiss a failure as "node problem", "protocol limitation", or "node misconfiguration" if the node has peers > 0
- If JS passed for the same node but C# fails, the bug is in the C# code path
- Study V2Ray stderr, clock drift, transport types, connection patterns
- Check: stale credentials, wrong session mapping, missing waits, wrong field formats, timeout too short
- Keep fixing until every node with peers connects successfully
- The ONLY acceptable failures are nodes with 0 peers (truly dead)

**Proof:** On 2026-03-22, AI dismissed 8 failures as "node-side". All 8 were traced to real code bugs: stale cache, batch mapping, premature rejection, missing UUID wait. The Iron Rule was proven correct every time.

### The Fix-Retest-Resume Loop (Mandatory)

When testing and you hit failures with peers > 0:

1. Stop and investigate EVERY failure -- compare JS vs C# for same node
2. Fix the code bug
3. Retest the specific failing nodes (not full audit restart)
4. If they pass, resume main audit
5. If they still fail, dig deeper into the next layer
6. Repeat until resolved. Never stop if peers > 0.

**The #1 goal is finding protocol failures and edge cases.** Every failure is a discovery opportunity. Findings feed into `Sentinel SDK/suggestions/`.

---

## 2. Architecture

### Directory Structure

```
sentinel-node-tester/
|
|-- server.js                      Express API server (~740 lines): routes, SSE, state management
|-- index.html                     Dashboard UI (single-page, SSE-connected)
|-- dictator.html                  Censorship analysis view (Google accessibility by country)
|-- SentinelAudit.vbs              Launch script (elevates to Admin for WireGuard)
|-- SentinelAudit.exe              Compiled launcher helper
|-- start.bat                      Alternative launcher (less reliable than .vbs)
|-- .env                           Wallet mnemonic, RPC config, test params
|-- package.json                   Dependencies (CosmJS, axios, express, socks-proxy-agent)
|
|-- core/                          Shared infrastructure
|   |-- constants.js               Config, env vars, endpoints, paths, batch size, cache TTLs
|   |-- errors.js                  Typed error classes: AuditError, ChainError, HandshakeError,
|   |                              TunnelError, PaymentError, VpnInterferenceError, etc.
|   |-- types.js                   JSDoc type definitions (ChainNode, TestResult, etc.)
|   |-- wallet.js                  Mnemonic -> wallet derivation, signing client with auto-reconnect,
|   |                              broadcast with retry, CosmJS v3 Registry setup
|   |-- chain.js                   LCD/RPC queries: getAllNodes (paginated), plan membership,
|   |                              LCD endpoint failover, queryNodeStatusDirect (multi-LCD)
|   |-- session.js                 Session credential cache (disk-persistent), batch payment,
|   |                              session poisoning, duplicate payment guard, session reuse
|   |-- transport-cache.js         V2Ray transport intelligence: learns which transport works per
|   |                              node, reorders outbounds for faster connection on retests
|   |-- csharp-bridge.js           Wrapper for SentinelBridge.exe -- dispatches status/handshake
|   |                              to C# SDK when toggle is set to csharp
|
|-- audit/                         Audit pipeline
|   |-- pipeline.js                Main audit orchestrator: runAudit, runRetestSkips, runPlanTest,
|   |                              state creation, parallel node scanning, baseline measurement
|   |-- node-test.js               Single-node test function (~800 lines): status check, payment,
|   |                              handshake, tunnel, speedtest, Google check, cleanup
|   |-- retry.js                   Zero-skip retry system: VPN interference pause, chain lag wait,
|   |                              network retry, 3-minute per-node hard timeout
|
|-- protocol/                      Protocol implementations
|   |-- v3protocol.js              v3 handshake, protobuf encoding, V2Ray config builder,
|   |                              WireGuard key generation, signature construction
|   |-- speedtest.js               Cloudflare CDN speedtest (direct + SOCKS5), Google check
|   |-- diagnostics.js             Failure classification, VPN interference detection/pause
|
|-- platforms/                     OS-specific implementations
|   |-- windows/
|   |   |-- wireguard.js           WireGuard service install/uninstall, watchdog, emergency cleanup
|   |   |-- v2ray.js               V2Ray process spawn/kill, SOCKS port rotation, config path
|   |   |-- network.js             VPN adapter detection, DNS check, route inspection
|   |-- macos/README.md            Future placeholder
|   |-- linux/README.md            Future placeholder
|
|-- csharp-bridge/                 C# SDK bridge (separate .NET project)
|   |-- Program.cs                 CLI entry point: dispatches to command handlers
|   |-- SentinelBridge.csproj      .NET 8.0 project (win-x64)
|   |-- Commands/
|   |   |-- ConnectCommand.cs      Handshake via C# SDK (WireGuard + V2Ray)
|   |   |-- StatusCommand.cs       Node status query via C# SDK
|   |   |-- BalanceCommand.cs      Wallet balance query
|   |   |-- SpeedtestCommand.cs    Speed test via C# SDK
|   |   |-- GoogleCheckCommand.cs  Google accessibility check
|   |-- bin/Debug/net8.0/win-x64/SentinelBridge.exe  -- Built executable
|
|-- bin/                           Binaries
|   |-- v2ray.exe                  V2Ray 5.2.1 (V2Fly build, go1.19.4 windows/amd64) -- PRIMARY
|   |-- v2ray-5.44.1.exe           V2Ray 5.44.1 backup
|   |-- geoip.dat, geosite.dat    V2Ray geo data
|
|-- results/                       Generated output (persists across restarts)
|   |-- results.json               Current test results array
|   |-- failures.jsonl             Failure log (one JSON per line)
|   |-- session-credentials.json   Credential cache (disk-persistent)
|   |-- transport-cache.json       Learned transport preferences per node
|   |-- .state-snapshot.json       Volatile state snapshot (balance, baseline, history)
|   |-- .sdk-preference            Active SDK choice ("js" or "csharp")
|   |-- runs/                      Saved test run snapshots
|   |   |-- index.json             Run index (number, label, date, stats)
|   |   |-- test-001/              Per-run directory
|   |   |   |-- results.json       Snapshot of results at save time
|   |   |   |-- summary.txt        Human-readable summary
|   |   |   |-- failures.jsonl     Failure log snapshot
|   |-- audit-*.log                Per-audit log files (timestamped)
|
|-- suggestions/                   SDK feedback and analysis
|   |-- one-shot-buildability-analysis.md
|   |-- undiagnosed-failures.md
|
|-- scripts/                       Utility scripts
|-- lib/                           LEGACY -- originals kept for reference; imports point to new locations
|-- CLAUDE.md                      Project-specific AI rules
|-- HANDOFF.md                     Session handoff document
|-- MANIFESTO.md                   Project manifesto
|-- README.md, SETUP.md            Documentation
```

### How the Audit Pipeline Works

The pipeline is a 4-phase process managed by `audit/pipeline.js`:

**Phase 1: Setup**
- `cachedWalletSetup(MNEMONIC)` -- derive wallet, signing client, private key
- `createFreshClient(wallet)` -- connect to RPC with auto-reconnect
- Fetch balance from chain, check V2Ray/WireGuard availability
- Load transport intelligence cache
- Run baseline speedtest (direct internet speed without VPN)

**Phase 2: Node Discovery + Parallel Status Scan**
- `getAllNodes(broadcast)` -- paginated LCD fetch of all ~1,000 active nodes
- `scanNodesParallel(nodes, 30)` -- 30 concurrent workers query each node's status endpoint
- Returns list of online nodes with type (WireGuard/V2Ray), peers, location, bandwidth

**Phase 3: Batch Payment**
- Nodes are grouped into batches of 5 (`BATCH_SIZE`)
- `submitBatchPayment()` -- single TX with 5 `MsgStartSession` messages
- `extractSessionMap()` -- maps session IDs to node addresses from TX events
- **Critical:** Events are NOT guaranteed in message order. Must match by `node_address`, not array index.

**Phase 4: Sequential Test with Retry**
- For each node in the paid batch:
  - `testWithRetry(testFn, broadcast, state, nodeAddr)` wraps each test
  - `testNode()` performs the actual test:
    1. Status check (with remote_addrs fallback)
    2. Session lookup (reuse if exists, else payment was already made in batch)
    3. Handshake (WireGuard or V2Ray, dispatched through JS or C# SDK)
    4. Tunnel establishment (WireGuard service install or V2Ray SOCKS5 spawn)
    5. Speedtest (Cloudflare CDN download, 10MB)
    6. Google accessibility check
    7. Cleanup (kill tunnel, uninstall service)
  - Result is PASS (with `actualMbps`) or FAIL (with `error`)
  - Zero-skip: every node ends as PASS or FAIL, never "skip"

**Resume mode:** When `resume=true`, the pipeline skips already-tested nodes (checks `results` array for existing entries).

### JS vs C# SDK Toggle

The dashboard has a toggle switch (JS | C#). When set to C#:

1. `state.activeSDK` is set to `'csharp'`
2. `testNode()` checks `useCSharp = state.activeSDK === 'csharp' && BRIDGE_AVAILABLE`
3. If true, status and handshake are dispatched to `core/csharp-bridge.js`:
   - `bridgeNodeStatus(remoteUrl)` -- calls `SentinelBridge.exe status <url>`
   - `bridgeHandshakeWG(remoteUrl, sessionId)` -- calls `SentinelBridge.exe handshake ... wireguard`
   - `bridgeHandshakeV2Ray(remoteUrl, sessionId)` -- calls `SentinelBridge.exe handshake ... v2ray`
4. Payment stays JS (CosmJS) -- TX format is identical regardless of SDK
5. Tunnel management stays JS -- it is OS-level, not SDK-specific

**Important history:** Before 2026-03-22, the C# toggle was cosmetic -- it only changed a label in results. All audit runs labeled "C# SDK" were actually testing JS code. This was fixed by wiring `csharp-bridge.js` into `node-test.js`.

---

## 3. API Commands Reference

All routes are in `server.js`. The server listens on port 3001.

### Audit Control

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/start` | Start a **new** test. Saves current results to `runs/` first, then clears and starts fresh. Returns `{ ok, testNumber }`. Calls `runAudit(false, ...)`. |
| `POST` | `/api/resume` | Resume current test from where it left off. Skips already-tested nodes. Returns `{ ok, testNumber, resumeFrom }`. Calls `runAudit(true, ...)`. |
| `POST` | `/api/stop` | Set `state.stopRequested = true`. The audit loop checks this flag and stops gracefully. |
| `POST` | `/api/retest-skips` | Retest nodes that failed with "unreachable" errors. Calls `runRetestSkips()`. |
| `POST` | `/api/retest-fails` | Retest all failed nodes (or specific addresses via `req.body.addresses`). Filters out `insufficient funds` and `domainsocket` failures. |
| `POST` | `/api/auto-retest` | Analyze all failures, auto-select retestable ones (peers > 0, no permanent failures), retest in one shot. |
| `POST` | `/api/test-plan` | Test all nodes in a specific plan. Requires `{ planId }` in body. Calls `runPlanTest()`. |
| `POST` | `/api/rescan` | Re-fetch node list from chain. Updates `state.totalNodes` with current count. |
| `POST` | `/api/clear` | Clear all results and reset counters. **Use with extreme caution.** |
| `POST` | `/api/economy` | Toggle economy mode (cap nodes to what balance can afford). |

### State & Results

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/state` | Full audit state + all results. Returns `{ state, results }`. |
| `GET` | `/api/stats` | Fast stats-only (no results payload). Returns `{ state }`. Used for instant page load. |
| `GET` | `/api/results` | Paginated results. Query params: `page`, `limit`. Returns `{ total, page, results }`. |
| `GET` | `/api/events` | SSE stream. Sends `init` event with full state, then live updates (`log`, `state`, `result` events). |
| `GET` | `/api/failure-analysis` | Categorized failure analysis: groups failures by type (409, Code 105, timeout, etc.), identifies retestable vs dead nodes. |

### SDK Toggle

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sdk` | Set active SDK. Body: `{ sdk: "js" }` or `{ sdk: "csharp" }`. Persists to disk. |
| `GET` | `/api/sdk` | Get current SDK. Returns `{ sdk: "js" }` or `{ sdk: "csharp" }`. |

### Test Run Management

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/runs` | List all saved test runs. Returns `{ runs, activeRun }`. |
| `POST` | `/api/runs/save` | Save current results as a new test run. Optional `{ label }` in body. Returns `{ ok, number }`. |
| `GET` | `/api/runs/:num` | Load a specific run's data. Returns `{ number, total, passed, failed, pass10, results }`. |
| `POST` | `/api/runs/load/:num` | Load a saved run into active state (replaces current results). Returns `{ ok, number, total }`. |

### Plans

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/plans` | Discover subscription plans with active subscribers. Scans plan IDs 1-100. Returns `{ plans }`. |

### Dictator Mode (Censorship Analysis)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dictator` | Serves the dictator.html page. |
| `GET` | `/api/dictator` | Returns country-grouped results with Google accessibility stats. |

### Other

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check. Returns `{ status: "ok", uptime }`. |
| `GET` | `/api/transport-cache` | Transport intelligence cache stats. |

---

## 4. How to Launch

### The Right Way: SentinelAudit.vbs

**ALWAYS launch via `SentinelAudit.vbs`** from the project directory. Never use `start.bat` or `node server.js` directly.

```
Double-click: SentinelAudit.vbs
```

Or from command line:
```
cscript //nologo SentinelAudit.vbs
```

The VBS script:
1. Launches `cmd.exe` with `runas` (triggers UAC prompt once)
2. Runs `node server.js` as Administrator
3. Waits 4 seconds, then opens `http://localhost:3001` in browser

**Why Admin is required:** WireGuard tunnel installation (`wireguard.exe /installtunnelservice`) requires Administrator privileges. Without it, WireGuard tests are skipped entirely.

**Do NOT:**
- Run `cmd.exe /c "start SentinelAudit.vbs"` -- spawns detached process, UAC may not appear
- Modify Windows UAC settings -- the VBS handles elevation properly
- Use `start.bat` -- less reliable than the VBS approach

### .env Configuration

File: `sentinel-node-tester/.env`

```
MNEMONIC=<24-word cosmos mnemonic>    # Required. Wallet for session payments
RPC=https://rpc.sentinel.co:443      # Primary RPC endpoint
DENOM=udvpn                          # Chain denomination
GAS_PRICE=0.2udvpn                   # Gas price per TX
GIGABYTES_PER_NODE=1                 # GB allocation per session (1 GB)
TEST_MB=10                           # Speedtest download size (10 MB)
MAX_NODES=0                          # 0 = test all nodes
NODE_DELAY_MS=1000                   # Delay between nodes (ms)
PORT=3001                            # Server port (do not change)
```

### Port

The server runs on **port 3001**. Dashboard at `http://localhost:3001`. Dictator mode at `http://localhost:3001/dictator`.

### Requirements

- Node.js v24+ (tested on v24.14.0)
- Windows 11 (WireGuard + V2Ray)
- WireGuard installed at `C:\Program Files\WireGuard\wireguard.exe`
- V2Ray binary at `bin/v2ray.exe` (included in project)
- .NET 8.0 SDK (for C# bridge, optional)

---

## 5. Critical Rules

### Process Safety

**NEVER run `taskkill /F /IM node.exe`** -- Claude Code itself runs on Node.js. Killing all node.exe processes will kill Claude Code. Kill only exact PIDs when needed.

### Results Are Sacred

**NEVER stop or restart a running audit unless the user explicitly asks.** NEVER wipe results without saving first.

Incident (2026-03-23): AI stopped a running C# audit to apply a code fix, then started a new test which wiped `results.json` clean. 130 C# test results (99.2% pass rate) were permanently lost.

Rules:
- Code fixes and UI changes can be applied on the NEXT natural restart -- do not kill a running audit
- If you MUST restart, use Resume (not Start). Start wipes results.
- Before any Start: the route auto-saves current results to `runs/` before clearing
- Never call `/api/stop` unless the user asked for it
- Never truncate `results.json` to `[]` without a backup

### Never Dismiss Failures

If peers > 0, it is our bug. See Section 1 "The Iron Rule".

### V2Ray Config Non-Negotiables

These were hard-won through extensive testing. DO NOT CHANGE:

| Rule | Value | Why |
|------|-------|-----|
| Proxy protocol mapping | `1=VLess, 2=VMess` | iota from 1 in Go SDK |
| Transport mapping | `1=DS, 2=gun, 3=grpc, 4=http, 5=mkcp, 6=quic, 7=tcp, 8=ws` | Go SDK types |
| gun vs grpc | Different protocols | gun=raw H2, grpc=gRPC lib |
| Config format | Must match sentinel-go-sdk client.json.tmpl | Node expects this exact format |
| All metadata entries | Separate outbounds | Each transport is a separate V2Ray outbound |
| VLESS encryption | `encryption: 'none'` | Required |
| VLESS flow | `flow: ''` (empty string) | xtls-rprx-vision is Xray-only; V2Ray rejects it |
| VMess alterId | `alterId: 0` | Required for AEAD |
| VMess user | NO `security` field | V2Ray rejects it |
| UUID format | Integer byte array, field name `uuid` | Go JSON encodes `[16]byte` as int array, not base64 |
| Post-handshake wait | 5 seconds | Node needs time to register UUID in V2Ray API |
| SOCKS5 speedtest | Must use axios | Native fetch silently ignores SOCKS5 agent |
| TLS settings | NO `serverName` per outbound | Causes TLS failures |
| grpc/tls | 0% success rate | Only grpc/none works (58%) |

### SDK Edit Boundary

**Consumer project agents (including Node Tester) MUST NOT edit SDK files directly.** Write findings to `Sentinel SDK/suggestions/` instead. Only SDK-focused sessions edit SDK code. The SDK is shared across all projects -- edits from consumer agents bypass review and risk breaking other consumers.

### Code Style

| Rule | Value |
|------|-------|
| Quotes | Single |
| Semicolons | Always |
| Indent | 2 spaces |
| Line endings | LF |
| Trailing commas | Yes |
| Naming | camelCase (vars), UPPER_SNAKE (constants), kebab-case (files) |
| Modules | ES Modules only (`import`/`export`) |
| Section dividers | `// --- Section Name ---` |
| Error handling | Typed classes with `.code`; `catch {}` is BANNED |

---

## 6. Bug Patterns Discovered (2026-03-22/23)

This is institutional knowledge. Every bug below was found by following the Iron Rule and the fix-retest-resume loop. Study these patterns -- they WILL recur.

### Bug 1: Batch Session Mapping (Events Unordered)

**File:** `core/session.js` -- `extractSessionMap()`
**Impact:** Wrong session assigned to wrong node (address mismatch failures)
**Root cause:** When a batch TX creates 5 sessions, the Cosmos SDK events are NOT guaranteed to arrive in message order. The old code mapped session IDs by array index to nodes. When event order differed from message order, the wrong session was assigned to the wrong node.
**Fix:** New `extractSessionMap(txResult, nodeAddrs)` extracts BOTH `session_id` AND `node_address` from each event and returns `Map<nodeAddress, sessionId>` instead of a flat array.
**Status:** Code fixed, needs fresh full audit to verify live.

### Bug 2: 409 "Session Already Exists" -- No Fresh Session Payment

**File:** `audit/node-test.js` -- handshake retry section
**Impact:** 13 V2Ray nodes stuck with stale sessions
**Root cause:** When a node returns HTTP 409, the code retried 3 times with the same dead session ID. Never paid for a fresh session.
**Fix:** `payForFreshSession()` broadcasts new `MsgStartSession`, poisons old session, retries handshake. In retest mode, skips 35s of waits and goes straight to fresh payment.
**Status:** Verified live -- all 13 nodes pass with fresh sessions.

### Bug 3: Clock Drift Premature Rejection

**File:** `audit/node-test.js` -- post-handshake section
**Impact:** 4 VMess-only V2Ray nodes with 4-66 peers hard-rejected without trying
**Root cause:** Code checked clock drift >120s and immediately skipped the node. But the Iron Rule says: never skip if peers > 0.
**Fix:** Removed hard rejection. Now logs clock drift warning, prefers VLess outbounds when drift detected, still attempts VMess with shorter per-outbound timeout.
**Status:** Verified -- nodes are no longer rejected. VMess AEAD drain is a real protocol limitation (16s per outbound), but the attempt is made. 3-minute per-node timeout catches stuck cases.

### Bug 4: Code 105 -- Stale LCD Cache

**File:** `audit/node-test.js` -- payment section, `core/chain.js`
**Impact:** 2 nodes falsely marked inactive (one had 66 peers)
**Root cause:** Single LCD endpoint returned stale data showing node as inactive.
**Fix:** `queryNodeStatusDirect(nodeAddr)` queries all 4 LCD endpoints. If any confirms active, retries with 20s + 30s waits.
**Status:** Code fixed, blocked by pipeline URL bug (Bug 9) at time of testing.

### Bug 5: WireGuard Tunnel "Already Installed"

**File:** `platforms/windows/wireguard.js` -- `installWgTunnel()`
**Impact:** 1 WG node failed because stale tunnel service was still registered
**Root cause:** The old cleanup only ran `/uninstalltunnelservice`. If the service was in a broken state, uninstall silently failed.
**Fix:** 3-step cleanup: `sc stop` -> `/uninstalltunnelservice` -> `sc delete` -> poll `sc query` to verify gone before installing.
**Status:** Verified live.

### Bug 6: Single remote_addrs -- No Fallback

**File:** `core/chain.js`, `audit/node-test.js`
**Impact:** 1 V2Ray node (Fusion Frontier) timed out on primary address
**Root cause:** Code only used `remote_addrs[0]`. Node had multiple addresses; primary was unreachable but secondary worked.
**Fix:** `chain.js` stores full `remoteAddrs` array. `node-test.js` tries alternate addresses on ETIMEDOUT.
**Status:** Verified -- Fusion Frontier passed at 22.6 Mbps.

### Bug 7: Stale Credential Cache

**File:** `core/session.js` -- credential cache
**Impact:** 10+ nodes failed with expired/invalid cached sessions
**Root cause:** Disk-persisted credentials from previous runs were reused even after sessions expired on chain.
**Fix:** `clearAllCredentials()` at audit start. In retest mode, stale credentials are cleared per-node on failure.
**Status:** Verified.

### Bug 8: Missing UUID Wait for C#

**File:** `core/csharp-bridge.js`, `audit/node-test.js`
**Impact:** 3 V2Ray nodes failed immediately after C# handshake
**Root cause:** After handshake, the node's V2Ray API needs ~5 seconds to register the UUID. The C# bridge returned instantly, and V2Ray was spawned before the UUID was registered.
**Fix:** Added `await sleep(5000)` after C# handshake before spawning V2Ray (matching JS behavior).
**Status:** Verified.

### Bug 9: transport_security 0-Indexed vs 1-Indexed

**File:** `core/csharp-bridge.js`
**Impact:** 2 nodes failed with wrong TLS configuration
**Root cause:** C# SDK uses 0-indexed `transport_security` (0=none, 1=tls). The JS protocol/V2Ray config expects 1-indexed (1=none, 2=tls). When C# returned `transport_security: 0` (meaning "none"), the JS config builder interpreted it as "unspecified".
**Fix:** In `bridgeHandshakeV2Ray()`, remap: `transport_security = (csharp_value) + 1`.
**Status:** Verified.

### Bug 10: Status Check No Retry

**File:** `audit/node-test.js` -- status check section
**Impact:** 1 node failed on transient status check timeout
**Root cause:** Status check had a single attempt with 6s timeout. Transient network issues caused immediate failure.
**Fix:** Status check now tries primary address, retries once after 3s, then tries alternate addresses from `remote_addrs`.
**Status:** Verified.

### Bug 11: DB Error Misclassified

**File:** `protocol/diagnostics.js`
**Impact:** 1 node's transient DB error triggered "fatal" classification (no retry)
**Root cause:** `classifyFailure()` did not recognize database-related errors as `node_error` (non-retriable but not fatal to the entire audit).
**Fix:** Added `database corrupt` pattern to `node_error` classification.
**Status:** Verified.

### Bug 12: C# Bridge Not Wired Into Pipeline (Design Flaw)

**File:** `audit/node-test.js`, `core/csharp-bridge.js`
**Impact:** ALL previous "C# SDK" test runs were actually running JS code
**Root cause:** The dashboard toggle only changed a label. The audit pipeline always called JS functions regardless of toggle. The C# bridge was a standalone CLI never invoked by the pipeline.
**Fix:** Created `core/csharp-bridge.js` wrapper. When `activeSDK === 'csharp'`, dispatches status and handshake to `SentinelBridge.exe`.
**Status:** Verified -- C# bridge is now called for real.

---

## 7. C# Bridge Integration

### Architecture

The C# bridge is in `csharp-bridge/` -- a .NET 8.0 console app that wraps the C# Sentinel SDK. It outputs JSON to stdout for the Node.js caller to parse.

**File:** `core/csharp-bridge.js`

```
const BRIDGE_EXE = path.join(__dirname, '..', 'csharp-bridge', 'bin', 'Debug', 'net8.0', 'win-x64', 'SentinelBridge.exe');
export const BRIDGE_AVAILABLE = existsSync(BRIDGE_EXE);
```

### What the Bridge Handles vs What Stays JS

| Component | JS or C# Bridge | Why |
|-----------|-----------------|-----|
| Node status query | **Bridge** (when toggle=csharp) | Tests C# SDK's HTTP client + response parsing |
| WireGuard handshake | **Bridge** (when toggle=csharp) | Tests C# SDK's handshake + signature construction |
| V2Ray handshake | **Bridge** (when toggle=csharp) | Tests C# SDK's V2Ray metadata parsing |
| Payment (MsgStartSession TX) | **Always JS** (CosmJS) | TX format is identical -- no SDK difference to test |
| WireGuard tunnel install | **Always JS** | OS-level (`wireguard.exe /installtunnelservice`) -- not SDK |
| V2Ray process spawn | **Always JS** | OS-level (`v2ray.exe run`) -- not SDK |
| Speedtest | **Always JS** | HTTP download -- not SDK |
| Google check | **Always JS** | HTTP request -- not SDK |

### Bridge Commands

The bridge is called via `execFile()` with JSON output:

```
SentinelBridge.exe status <remoteUrl>
SentinelBridge.exe handshake <remoteUrl> <sessionId> <mnemonic> wireguard
SentinelBridge.exe handshake <remoteUrl> <sessionId> <mnemonic> v2ray
```

Output format: `{ success: true, data: { ... } }` or `{ success: false, error: "...", code: "..." }`

### transport_security Offset (+1 Remap)

This is the most critical bridge integration detail:

```javascript
// In core/csharp-bridge.js, bridgeHandshakeV2Ray():
const entries = rawEntries.map(e => ({
  ...e,
  transport_security: (e.transport_security ?? 0) + 1,  // C# 0-indexed -> JS 1-indexed
  port: String(e.port),
}));
```

- C# SDK: `0 = none, 1 = tls`
- JS/protocol: `0 = unspecified (treat as none), 1 = none, 2 = tls`
- The +1 remap converts C# values to what `buildV2RayClientConfig()` expects

### UUID Wait Requirement

After any handshake (JS or C#), you MUST wait 5 seconds before spawning V2Ray:

```javascript
await sleep(5_000);  // Node's V2Ray API needs time to register the UUID
```

Without this wait, V2Ray connects but the node rejects traffic because the UUID is not yet registered.

---

## 8. Sentinel Chain v3 Quick Reference

### Chain Info

- **Chain:** Sentinel Hub (Cosmos SDK)
- **Protocol version:** v3 (v2 paths return "Not Implemented" except provider)
- **Token:** Display name is **P2P**. Chain denom: `udvpn`. 1 P2P = 1,000,000 udvpn.
- **RPC:** `https://rpc.sentinel.co:443`

### LCD Failover Endpoints (in order of reliability)

1. `https://sentinel-api.polkachu.com`
2. `https://api.sentinel.quokkastake.io`
3. `https://sentinel-rest.publicnode.com`

Backup endpoints from root CLAUDE.md:
- `https://lcd.sentinel.co`
- `https://sentinel.api.trivium.network:1317`

### LCD Query Paths

| Query | Path |
|-------|------|
| Active nodes | `/sentinel/node/v3/nodes?status=1&pagination.limit=5000` |
| Single node | `/sentinel/node/v3/nodes/{sentnode1...}` |
| Subscriptions | `/sentinel/subscription/v3/accounts/{sent1...}/subscriptions` |
| Sessions | `/sentinel/session/v3/accounts/{sent1...}/sessions` |
| Plan nodes | `/sentinel/node/v3/plans/{planId}/nodes` |
| Plan by ID | `/sentinel/plan/v3/plans/{planId}` |
| Plan subscribers | `/sentinel/plan/v3/plans/{planId}/subscribers` |
| Session allocations | `/sentinel/session/v3/sessions/{sessionId}/allocations` |
| Subscription by ID | `/sentinel/subscription/v3/subscriptions/{id}` |
| Provider | `/sentinel/provider/v2/providers/{sentprov1...}` **(v2 -- NOT migrated to v3)** |
| Balance | `/cosmos/bank/v1beta1/balances/{sent1...}` |
| Fee grants | `/cosmos/feegrant/v1beta1/allowances/{sent1...}` |

### v3 vs v2 Field Name Differences

| Correct (v3) | Wrong (v2) | Notes |
|--------------|------------|-------|
| `service_type` | `type` | |
| `remote_addrs` (array) | `remote_url` (string) | v3 returns array of addresses |
| `acc_address` | `address` | |
| Session wrapped in `base_session` | Session fields are flat | |
| `status=1` | `status=STATUS_ACTIVE` | Numeric, not string enum |

### LCD Pagination Warning

**Never trust `count_total` or `next_key`** from Sentinel LCD. Some endpoints return wrong totals and null `next_key`. Always verify pagination works on each endpoint. If broken, use single request with `limit=5000`.

The Node Tester's `getAllNodes()` in `core/chain.js` uses `pagination.limit=200` with `next_key` chaining and logs a warning if final count mismatches `count_total`.

### Transaction Message Type

```
/sentinel.node.v3.MsgStartSessionRequest
```

Fields: `from`, `node_address`, `gigabytes`, `hours`, `max_price`

The `max_price.base_value` must be in `sdk.Dec` format (multiply by 10^18).

### Handshake Signature Format

```
sign(SHA256(BigEndian_uint64(sessionId) + raw_peer_data_json_bytes))
```

**Sign RAW bytes, not base64.**

In code (`protocol/v3protocol.js`):
```javascript
const idBuf = Buffer.alloc(8);
idBuf.writeBigUInt64BE(BigInt(sessionId));
const msg = Buffer.concat([idBuf, dataBytes]);
const hash = sha256(msg);
const sig = await Secp256k1.createSignature(hash, cosmosPrivKey);
const sigBytes = Buffer.from(sig.toFixedLength()).slice(0, 64);  // EXACTLY 64 bytes
```

Public key encoding:
```javascript
const compressedPubKey = nobleSecp.getPublicKey(cosmosPrivKey, true);  // COMPRESSED 33 bytes
const pubKeyEncoded = 'secp256k1:' + Buffer.from(compressedPubKey).toString('base64');
```

### Session Reuse

Before paying for a new session, check for existing active sessions:
```
GET /sentinel/session/v3/sessions?address=<addr>&status=1&pagination.limit=100
```
Reuse if session exists for the target node AND the allocation has remaining capacity.

### CosmJS Registry Pattern

v3 message types must be registered with a custom encoder:

```javascript
const MsgStartSessionV3 = {
  fromPartial: (value) => value,
  encode: (instance) => ({ finish: () => encodeMsgStartSession(instance) }),
  decode: () => ({}),
};
new Registry([...defaultRegistryTypes, [V3_MSG_TYPE, MsgStartSessionV3]])
```

This is in `core/wallet.js` -- `buildV3Registry()`.

---

## Quick Debug Checklist

### V2Ray Not Connecting

1. Set `loglevel: 'debug'` in `buildV2RayClientConfig` (in `protocol/v3protocol.js`)
2. Check V2Ray stderr for "proxy/vless" or "proxy/vmess" errors
3. `json: cannot unmarshal string` -- UUID sent as string, not int array
4. `failed: VLESS` / `failed: VMess` -- check proxy_protocol mapping (1=VLess, 2=VMess)
5. `gun tunnel > EOF` -- gRPC transport issue; TCP or WS entries preferred
6. `xtls` errors -- set `flow: ''` (not `xtls-rprx-vision`)
7. IP not changing -- wait 5s after handshake; node needs time to register UUID
8. `tunneling request -> 15s silence -> context canceled` -- clock drift (VMess AEAD drain)
9. V2Ray "context canceled" after a SUCCESSFUL request is NORMAL cleanup, NOT an error

### WireGuard Not Connecting

1. Must run as Administrator (use `SentinelAudit.vbs`)
2. Binary at `C:\Program Files\WireGuard\wireguard.exe`
3. Install command: `/installtunnelservice` (NOT `/installtunnel`)
4. Tunnel name: `wgsent0` -- uninstall with `/uninstalltunnelservice wgsent0`

### Session ID Not Found in TX

- Check `txResult.events` for type containing "session"
- Keys may be base64-encoded -- decode with `Buffer.from(key, 'base64').toString('utf8')`
- Look for `session_id` or `id` attribute key
- **Events are NOT in message order** -- match by `node_address`, not array index

### Windows Gotcha: curl `/dev/null` in execSync

Node.js `execSync()` uses cmd.exe where `/dev/null` does not exist. Curl exits with code 23. Use `NUL` or check `error.stdout`. Does NOT affect server.js (uses axios).

---

## Summary of Key File Paths

| What | Path |
|------|------|
| Server entry point | `server.js` |
| Audit pipeline | `audit/pipeline.js` |
| Single node test | `audit/node-test.js` |
| Retry system | `audit/retry.js` |
| v3 Protocol / handshake | `protocol/v3protocol.js` |
| Speedtest | `protocol/speedtest.js` |
| Failure classification | `protocol/diagnostics.js` |
| Constants / config | `core/constants.js` |
| Wallet / signing | `core/wallet.js` |
| Chain queries | `core/chain.js` |
| Session management | `core/session.js` |
| Transport cache | `core/transport-cache.js` |
| C# bridge wrapper | `core/csharp-bridge.js` |
| WireGuard (Windows) | `platforms/windows/wireguard.js` |
| V2Ray (Windows) | `platforms/windows/v2ray.js` |
| Network detection | `platforms/windows/network.js` |
| Error classes | `core/errors.js` |
| Type definitions | `core/types.js` |
| Project rules | `CLAUDE.md` |
| Session handoff | `HANDOFF.md` |
| Memory handoff | `C:\Users\user\.claude\projects\C--Users-Connect\memory\handoff-node-tester.md` |
| Root rules | `C:\Users\user\CLAUDE.md` |
| SDK suggestions | `C:\Users\user\Desktop\Sentinel SDK\suggestions\` |
