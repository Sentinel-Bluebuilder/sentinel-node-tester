# Node Tester — Complete Function Reference

> Every function the node tester executes, in order, with inputs/outputs and which file owns it. For AI building a standalone tester or integrating testing into an app.
>
> **These are all JavaScript functions.** For C# equivalents, see the mapping table below.

---

## JS → C# Function Mapping

| JS Function (Node Tester) | C# Equivalent (Sentinel SDK) | Notes |
|---------------------------|------------------------------|-------|
| `nodeStatusV3(url)` | `NodeClient.GetStatusAsync(url)` | Different return shape |
| `initHandshakeV3(url, sid, key, wgPub)` | `Handshake.HandshakeAsync(wallet, url, sid, WireGuard)` | C# generates WG keypair internally |
| `initHandshakeV3V2Ray(url, sid, key, uuid)` | `Handshake.HandshakeAsync(wallet, url, sid, V2Ray)` | C# generates UUID internally |
| `signAndBroadcastRetry(client, addr, msgs)` | `TransactionBuilder.BroadcastAsync(msg)` | C# has built-in retry |
| `extractSessionId(txResult)` | Handled internally by `ConnectAsync` | Not exposed in C# |
| `buildV2RayClientConfig(host, meta, uuid)` | Not in C# SDK — Node Tester specific | App uses `SentinelVpnClient` instead |
| `writeWgConfig(key, addrs, pub, ep)` | Not in C# SDK — Node Tester specific | App uses `SentinelVpnClient` instead |
| `speedtestDirect()` | `SpeedTest.DirectAsync()` | Same Cloudflare targets |
| `speedtestViaSocks5(mb, port)` | `SpeedTest.ViaSocks5Async(port)` | Same fallback chain |
| `checkGoogleDirect()` | `GoogleCheck.ExecuteAsync()` | Same targets |
| `getAllNodes(broadcast)` | `ChainClient.GetActiveNodesAsync()` | C# doesn't paginate (single call) |
| `waitForSessionActive(addr, wallet, ms, sid)` | `SessionManager.FindExistingSessionAsync()` | Different polling strategy |
| `installWgTunnel(confPath)` | `SentinelVpnClient.ConnectAsync()` | C# SDK manages tunnel lifecycle |
| `spawnV2Ray(config, ob, port)` | `SentinelVpnClient.ConnectAsync()` | C# SDK manages V2Ray lifecycle |

---

## Execution Flow: Single Node Test

```
1. GET NODE LIST         → chain.js
2. CHECK NODE STATUS     → v3protocol.js / csharp-bridge.js
3. CHECK CLOCK DRIFT     → node-test.js (from status response)
4. CHECK PRICE           → node-test.js (from LCD node data)
5. RESOLVE SESSION       → session.js (cache check)
6. PAY FOR SESSION       → wallet.js → chain TX
7. WAIT FOR CHAIN        → session.js (poll LCD)
8. HANDSHAKE             → v3protocol.js / csharp-bridge.js
9. BUILD TUNNEL CONFIG   → v3protocol.js
10. START TUNNEL          → wireguard.js / v2ray.js
11. CONNECTIVITY CHECK    → speedtest.js
12. SPEED TEST            → speedtest.js
13. GOOGLE CHECK          → speedtest.js
14. STOP TUNNEL           → wireguard.js / v2ray.js
15. RECORD RESULT         → pipeline.js
```

---

## Phase 1: Node Discovery

### `getAllNodes(broadcast)`
**File:** `core/chain.js:44`
**What:** Fetches all active nodes from Sentinel LCD with pagination.
**Input:** `broadcast` — SSE log function
**Output:** `ChainNode[]` — `{ address, remoteUrl, remoteAddrs[], gigabyte_prices[], planIds[] }`
**Chain call:** `GET /sentinel/node/v3/nodes?status=1&pagination.limit=200`
**Cost:** FREE (read-only)
**Cache:** 5-min TTL in memory. `invalidateNodeCache()` clears.

### `findWorkingLcd()`
**File:** `core/chain.js:16`
**What:** Probes 4 LCD endpoints, returns first working one.
**Input:** None
**Output:** `string` — LCD base URL
**Endpoints tried:** lcd.sentinel.co → quokkastake → polkachu → trivium

### `queryNodeStatusDirect(nodeAddr)`
**File:** `core/chain.js`
**What:** Queries a single node's status across ALL LCD endpoints.
**Input:** `nodeAddr` — sentnode1... address
**Output:** `{ active: boolean, status: number }`
**Used for:** Code 105 retry — verify if node is genuinely inactive.

### `fetchPlanMembership(nodes, broadcast)`
**File:** `core/chain.js:91`
**What:** Fetches subscription plans and marks which nodes belong to each.
**Input:** `ChainNode[]`, broadcast
**Output:** Mutates `node.planIds[]` in place
**Cost:** FREE

---

## Phase 2: Node Status Check

### `nodeStatusV3(remoteUrl, agent?)`
**File:** `protocol/v3protocol.js:43`
**What:** HTTP GET to node's status endpoint. Returns type, location, peers, bandwidth, clock drift.
**Input:** `remoteUrl` — `https://IP:PORT`
**Output:**
```javascript
{
  type: 'wireguard' | 'v2ray',
  moniker: string,
  peers: number,
  bandwidth: { download: number, upload: number }, // bytes/s
  location: { city, country, country_code, latitude, longitude },
  qos: { max_peers: number | null },
  clockDriftSec: number | null, // from HTTP Date header vs local time
  _raw: object, // full response
}
```
**Timeout:** 12s
**Cost:** FREE

### `bridgeNodeStatus(remoteUrl)`
**File:** `core/csharp-bridge.js:53`
**What:** Same as nodeStatusV3 but via C# SDK (SentinelBridge.exe status).
**Input:** `remoteUrl`
**Output:** Same shape as nodeStatusV3
**Process:** Spawns `SentinelBridge.exe status <url>`, parses JSON stdout
**Timeout:** 20s (bridge process + HTTP)
**Used when:** `state.activeSDK === 'csharp'`

---

## Phase 3: Payment & Session

### `signAndBroadcastRetry(client, address, messages, fee, broadcast, maxRetries?)`
**File:** `core/wallet.js:94`
**What:** Signs and broadcasts a Cosmos TX with automatic retry on sequence mismatch.
**Input:** CosmJS SigningStargateClient, wallet address, TX messages, fee, broadcast, retries (default 3)
**Output:** `DeliverTxResponse`
**Retries on:** sequence mismatch, wrong signers, query failed
**Cost:** Gas fee (0.2 P2P per TX)

### `extractSessionId(txResult)`
**File:** `protocol/v3protocol.js`
**What:** Parses session ID from MsgStartSession TX result events.
**Input:** `DeliverTxResponse`
**Output:** `BigInt` session ID or null
**Scans:** TX events for `session_id` or `id` attribute

### `extractSessionMap(txResult, nodeAddrs)`
**File:** `core/session.js:185`
**What:** Extracts session IDs from batch TX. Tries to match by node_address (never present in events). Marks orphans for chain lookup.
**Input:** TX result, array of node addresses
**Output:** `Map<nodeAddress, BigInt>` + `._orphanIds[]` + `._needsChainLookup: boolean`
**Note:** Chain events do NOT include node_address. Always falls back to chain query.

### `waitForSessionActive(nodeAddr, walletAddr, maxWaitMs, sessionId?)`
**File:** `core/session.js:314`
**What:** Polls chain until session is confirmed active.
**Input:** Node address, wallet address, timeout, optional session ID
**When sessionId provided:** Direct query `GET /sentinel/session/v3/sessions/{id}` — fast
**When not provided:** Scans all wallet sessions (SLOW with 500+ sessions)
**Cost:** FREE (read-only)

### `buildSessionMap(walletAddress, broadcast)`
**File:** `core/session.js:79`
**What:** Fetches ALL active sessions for wallet. Builds Map<nodeAddr, sessionId>.
**Input:** Wallet address, broadcast
**Output:** In-memory session map
**Cost:** FREE but SLOW (paginates 500+ sessions)

### `submitBatchPayment(client, account, denom, gigabytes, batch, state, broadcast)`
**File:** `core/session.js:219`
**What:** Pays for up to 5 node sessions in one TX.
**Input:** Client, account, denom, GB count, batch array, state, broadcast
**Output:** `Map<nodeAddr, BigInt sessionId>`
**Cost:** ~200 P2P per batch of 5 (40 P2P/node × 5 + gas)
**Post-broadcast:** Queries chain to map session IDs to nodes (events don't include node_address)

---

## Phase 4: Handshake

### `initHandshakeV3(remoteUrl, sessionId, cosmosPrivKey, wgPublicKey, agent?)`
**File:** `protocol/v3protocol.js:116`
**What:** WireGuard V3 handshake. Signs session+peer data, POSTs to node.
**Input:** Node URL, session ID (BigInt), private key (Buffer 32), WG public key (Buffer 32)
**Output:**
```javascript
{
  assignedAddrs: ['10.8.0.2/24'],    // our tunnel IPs
  serverPubKey: 'base64...',          // node's WG public key
  serverEndpoint: 'IP:PORT',          // node's WG endpoint
}
```
**Signature:** `sign(SHA256(BigEndian_uint64(sessionId) + raw_json_bytes))`
**Timeout:** 90s

### `initHandshakeV3V2Ray(remoteUrl, sessionId, cosmosPrivKey, uuid, agent?)`
**File:** `protocol/v3protocol.js:652`
**What:** V2Ray V3 handshake. Same signing, sends UUID as integer byte array.
**Input:** Node URL, session ID, private key, UUID string
**Output:**
```javascript
{
  config: '{"metadata":[...]}',  // base64-decoded V2Ray metadata JSON
  serverEndpoints: string[],
}
```

### `bridgeHandshakeWG(remoteUrl, sessionId)`
**File:** `core/csharp-bridge.js:78`
**What:** WireGuard handshake via C# SDK.
**Process:** `SentinelBridge.exe handshake <url> <sessionId> <mnemonic> wireguard`
**Output:** Same shape as initHandshakeV3 + `clientPrivateKey` (C# generates its own keypair)

### `bridgeHandshakeV2Ray(remoteUrl, sessionId)`
**File:** `core/csharp-bridge.js:98`
**What:** V2Ray handshake via C# SDK.
**Process:** `SentinelBridge.exe handshake <url> <sessionId> <mnemonic> v2ray`
**Output:** `{ config, uuid, serverEndpoints }` — config rebuilt from C# allEntries
**IMPORTANT:** C# transport_security is 0-indexed (0=none, 1=tls). Remapped +1 to match JS (1=none, 2=tls).

---

## Phase 5: Tunnel Config Building

### `writeWgConfig(wgPrivKey, assignedAddrs, serverPubKey, serverEndpoint, splitIPs?)`
**File:** `protocol/v3protocol.js:224`
**What:** Writes WireGuard .conf file to disk.
**Input:** Private key (Buffer), assigned IPs, server pubkey, endpoint, optional split tunnel IPs
**Output:** `string` — path to conf file (`C:\ProgramData\sentinel-wg\wgsent0.conf`)
**DNS:** Uses `ACTIVE_DNS` from constants (configurable: OpenDNS/HNS/Google/Cloudflare)

### `buildV2RayClientConfig(serverHost, metadataJson, uuid, socksPort, opts?)`
**File:** `protocol/v3protocol.js:491`
**What:** Builds complete V2Ray client config JSON from handshake metadata.
**Input:** Server hostname, metadata JSON, UUID, SOCKS port, options (clockDriftSec)
**Output:** V2Ray config object with inbounds, outbounds, routing, dns, policy, stats
**Transport mapping:**
```
2=gun, 3=grpc, 4=http, 5=mkcp, 6=quic, 7=tcp, 8=websocket
```
**Key behaviors:**
- Generates BOTH gun AND grpc outbounds for transport_protocol:3
- Sets `alterId: 64` (legacy VMess) when `|clockDriftSec| > 120`
- Sets `alterId: 0` (AEAD) for normal nodes
- Strips QUIC outbounds (unreliable)
- Sorts outbounds by transport success rate
- Injects DNS from `ACTIVE_DNS` constants
- API port: random 10000-60000
- grpcSettings with empty serviceName for grpc/gun

### `generateWgKeyPair()`
**File:** `protocol/v3protocol.js:93`
**What:** Generates Curve25519 keypair with WireGuard bit clamping.
**Output:** `{ privateKey: Buffer(32), publicKey: Buffer(32) }`

---

## Phase 6: Tunnel Management

### `installWgTunnel(confPath)`
**File:** `platforms/windows/wireguard.js:138`
**What:** Installs WireGuard tunnel as Windows service.
**Steps:**
1. `sc stop WireGuardTunnel$wgsent0`
2. `wireguard.exe /uninstalltunnelservice wgsent0`
3. `sc delete WireGuardTunnel$wgsent0`
4. Poll `sc query` to verify service gone (5 attempts × 500ms)
5. `wireguard.exe /installtunnelservice <confPath>` (3 retries with backoff)
**Requires:** Admin elevation
**Output:** Tunnel name string

### `uninstallWgTunnel(tunnelName?)`
**File:** `platforms/windows/wireguard.js:176`
**What:** Removes WireGuard tunnel service.
**Cleans up:** Service, conf file, state variables

### `emergencyCleanupSync()`
**File:** `platforms/windows/wireguard.js:65`
**What:** Force-kills ALL WireGuard tunnels matching `wgsent*`. Safe in process exit handlers.
**Uses:** `sc stop`, `sc delete` for each matching service

### `spawnV2Ray(v2rayConfig, outbound, socksPort)`
**File:** `platforms/windows/v2ray.js`
**What:** Writes V2Ray config with single outbound, spawns v2ray.exe.
**Input:** Full config, specific outbound to use, SOCKS port
**Output:** `{ proc, getStdout, getStderr }`
**Binary:** `bin/v2ray.exe` (currently V2Ray 5.44.1)

### `killAllV2Ray()` / `killV2RayByPid(pid)`
**File:** `platforms/windows/v2ray.js`
**What:** Kills V2Ray processes. `killAll` finds by process name. `byPid` kills specific PID.

### `nextSocksPort()`
**File:** `platforms/windows/v2ray.js`
**What:** Finds next available SOCKS5 port starting from 10808.
**Output:** `number` — available port

---

## Phase 7: Testing Through Tunnel

### `speedtestViaSocks5(testMb, socksPort)`
**File:** `protocol/speedtest.js`
**What:** Downloads data through SOCKS5 proxy (V2Ray tunnel) and measures throughput.
**Steps:**
1. **Connectivity check:** GET google.com, cloudflare.com, httpbin.org, ifconfig.me, ip-api.com (3 attempts, 5s between)
2. **1MB probe:** Download from Cloudflare CDN, fallback to Tele2/OVH, rescue with google.com page
3. **If connected but can't download:** Returns `{ mbps: 0.01, adaptive: 'connected-no-throughput' }`
4. **Adaptive sizing:** If probe > 3 Mbps, downloads larger chunks (5-50MB) in parallel
**Input:** Test size MB, SOCKS5 port
**Output:** `{ mbps: number, chunks: number, adaptive: string }`
**Timeout:** 15s per connectivity target, 30s per download, 60s rescue

### `speedtestDirect()`
**File:** `protocol/speedtest.js`
**What:** Same as above but without SOCKS5 — tests direct internet speed (baseline).
**Used for:** Comparing tunnel speed vs baseline, detecting ISP bottleneck.

### `checkGoogleViaSocks5(socksPort, timeoutMs)`
**File:** `protocol/speedtest.js`
**What:** Checks if google.com is reachable through the SOCKS5 tunnel.
**Output:** `{ googleAccessible: boolean, googleLatencyMs: number, googleError?: string }`

### `checkGoogleDirect(timeoutMs)`
**File:** `protocol/speedtest.js`
**What:** Same but through direct connection (WireGuard tunnel).

### `resolveSpeedtestIPs()`
**File:** `protocol/speedtest.js`
**What:** Resolves Cloudflare CDN IP for split-tunnel WireGuard routing.
**Output:** `string[]` — IP addresses to route through tunnel

---

## Phase 8: Diagnostics & Recovery

### `classifyFailure(err)`
**File:** `protocol/diagnostics.js:81`
**What:** Categorizes test failure for retry strategy.
**Output:** `'vpn_interference' | 'chain_lag' | 'network_timeout' | 'session_conflict' | 'node_error' | 'fatal'`
**Key mappings:**
- `409 persistent after fresh session` → `node_error` (no retry)
- `clock drift.*AEAD` → `node_error`
- `inactive on chain` → `node_error`
- `address mismatch.*persistent` → `node_error`
- `already exists` → `session_conflict`
- `ETIMEDOUT` / `ECONNREFUSED` → `network_timeout`

### `testWithRetry(testFn, broadcast, state, nodeAddr)`
**File:** `audit/retry.js:33`
**What:** Wraps testNode with retry logic and per-node hard timeout.
**Timeout:** 300s (5 min) via `Promise.race`
**Stop-aware:** Polls `state.stopRequested` every 500ms
**Retries:** Max 2 retries. VPN interference → pause. Chain lag → 10s wait. Session conflict → clear creds. Network timeout → 5s wait.

### `detectVpnInterference()`
**File:** `platforms/windows/network.js`
**What:** Checks for active non-Sentinel VPN adapters, suspicious routes, DNS issues.
**Output:** `string | null` — interference description or null if clear

### Port Discovery (inline in node-test.js)
**What:** When all V2Ray transports fail but node has peers, scans ports near metadata ports + 7000-9000 range.
**If open ports found:** Rebuilds V2Ray config with discovered port, spawns V2Ray, retests.
**Port ranges scanned:** metadata_port ± 200 (step 2) + 7000-9000 (step 2)

---

## Phase 9: Session & Credential Management

### `getCredential(nodeAddr)` / `saveCredential(nodeAddr, data)` / `clearCredential(nodeAddr)`
**File:** `core/session.js:18-30`
**What:** Disk-persistent credential cache. Saves WG/V2Ray config for session reuse.
**Storage:** `results/session-credentials.json`

### `clearAllCredentials()`
**File:** `core/session.js`
**What:** Wipes entire credential cache. Called at audit start to prevent stale session reuse.

### `markSessionPoisoned(nodeAddr, sessionId)` / `isSessionPoisoned()`
**File:** `core/session.js:39-45`
**What:** Tracks sessions that failed handshake. Poisoned sessions are skipped in session map.

### `markPaid(nodeAddr)` / `isPaid(nodeAddr)` / `clearPaidNodes()`
**File:** `core/session.js:52-64`
**What:** Duplicate payment guard. Prevents paying twice for same node in one audit run.

---

## Phase 10: Transport Intelligence

### `reorderOutbounds(nodeAddr, outbounds)`
**File:** `core/transport-cache.js`
**What:** Sorts V2Ray outbounds by learned success rate for this specific node.
**Input:** Node address, outbound array
**Output:** Sorted outbound array (known-good transport first)

### `recordTransportSuccess(nodeAddr, transport)` / `recordTransportFailure(transport)`
**File:** `core/transport-cache.js`
**What:** Records which transport worked/failed. Persists to `results/transport-cache.json`.

### `getCachedTransport(nodeAddr)`
**File:** `core/transport-cache.js`
**What:** Returns the best known transport for a node (if previously tested).
**Output:** `{ key, port, successCount }` or null

---

## Phase 11: Results & Logging

### `upsertResult(result)`
**File:** `audit/pipeline.js`
**What:** Inserts or updates a result in the in-memory results array (by node address).

### `saveResults()`
**File:** `audit/pipeline.js`
**What:** Writes `results/results.json` to disk.

### `logFailure(nodeAddr, error, context)`
**File:** `audit/node-test.js:30`
**What:** Appends failure entry to `results/failures.jsonl` (never overwritten).

### Results JSON shape:
```javascript
{
  timestamp, address, type, moniker, country, countryCode, city,
  reportedDownloadMbps, actualMbps, baselineAtTest, ispBottleneck,
  pass15mbps, pass10mbps, passBaseline,
  peers, maxPeers, gigabytePrices,
  googleAccessible, googleLatencyMs,
  sdk, os, inPlan, planIds,
  error, timedOut, diag: { ... }
}
```

---

## Constants & Configuration

### `core/constants.js`
```javascript
MNEMONIC          // from .env
RPC               // https://rpc.sentinel.co:443
DENOM             // 'udvpn'
GAS_PRICE         // '0.2udvpn'
GIGS              // GB per node (default 1)
TEST_MB           // speedtest size (default 10)
MAX_NODES         // 0 = all
NODE_DELAY        // ms between nodes (default 5000)
PORT              // server port (default 3001)
ACTIVE_DNS        // configurable: ['208.67.222.222', '208.67.220.220']
DNS_PRESETS       // { default, hns, cloudflare, google }
V3_MSG_TYPE       // '/sentinel.node.v3.MsgStartSessionRequest'
LCD_ENDPOINTS     // [lcd.sentinel.co, quokkastake, polkachu, trivium]
RPC_ENDPOINTS     // [rpc.sentinel.co, quokkastake, polkachu]
NODE_TIMEOUT_MS   // 300000 (5 min per node)
```

---

## API Endpoints (server.js)

| Method | Path | Function | Auth |
|--------|------|----------|------|
| POST | /api/start | Start new test | MNEMONIC in .env |
| POST | /api/resume | Resume from last result | |
| POST | /api/stop | Stop (500ms response) | |
| POST | /api/auto-retest | Retest failures. `{"force":true}` = all | |
| GET | /api/state | `{ status, testedNodes, failedNodes, balance, ... }` | |
| GET | /api/failure-analysis | Categorized failures | |
| POST | /api/sdk | `{"sdk":"csharp"}` or `{"sdk":"js"}` | |
| GET | /api/sdk | Current SDK | |
| POST | /api/dns | `{"preset":"hns"}` or `{"servers":[...]}` | |
| GET | /api/dns | Current DNS | |
| GET | /api/runs | List archived runs | |
| POST | /api/runs/save | Save current to archive | |
| GET | /api/runs/:num | Load archived run | |
| POST | /api/runs/load/:num | Load into active | |
| GET | /api/results | Raw results.json | |
| POST | /api/economy | Toggle economy mode | |

---

## Error Codes From Nodes

| Code | Meaning | Our Handling |
|------|---------|-------------|
| 3 | Session already exists | 15s+20s retry → fresh session payment |
| 5 | Session not found | Wait 10s, retry (chain lag) |
| 6 | Node address mismatch | Retry once, then mark persistent |
| 105 | Node inactive on chain | Multi-LCD check → 20s+30s retry |

---

## Files That Cost Tokens (On-Chain TX)

| File | Function | When |
|------|----------|------|
| `core/wallet.js` | `signAndBroadcastRetry` | Every payment TX |
| `core/session.js` | `submitBatchPayment` | Batch: 5 nodes per TX |
| `audit/node-test.js` | `payForFreshSession` | 409 retry: new session |
| `audit/node-test.js` | Individual payment block | Non-batch: 1 node per TX |

Everything else is FREE (queries, local operations, tunnel management).
