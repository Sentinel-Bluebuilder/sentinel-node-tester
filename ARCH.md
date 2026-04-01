# Architecture

## Module Dependency Graph

```
server.js (Express routes + SSE)
  ├── audit/pipeline.js (orchestrator)
  │     ├── audit/node-test.js (single node test)
  │     │     ├── core/chain.js (LCD queries)
  │     │     ├── core/wallet.js (TX broadcast)
  │     │     ├── core/session.js (credentials, payments)
  │     │     ├── core/csharp-bridge.js (C# SDK wrapper)
  │     │     ├── core/countries.js (flags, codes)
  │     │     ├── protocol/v3protocol.js (handshake, configs)
  │     │     ├── protocol/speedtest.js (speed + connectivity)
  │     │     ├── protocol/diagnostics.js (failure classification)
  │     │     ├── platforms/windows/wireguard.js (tunnel mgmt)
  │     │     └── platforms/windows/v2ray.js (process mgmt)
  │     └── audit/retry.js (timeout + retry logic)
  └── core/constants.js (config, DNS, endpoints)

index.js (programmatic entry point — re-exports everything)
index.html (dashboard UI — standalone only)
```

## Request Flow: Test One Node

```
testNode(client, account, privkey, node, opts, preSessionId, broadcast, state)
  │
  ├─ 1. STATUS CHECK
  │   useCSharp? → bridgeNodeStatus(url)     [core/csharp-bridge.js]
  │   else       → nodeStatusV3(url)          [protocol/v3protocol.js]
  │   Fallback: retry same addr → try alternate remote_addrs
  │
  ├─ 2. V2RAY PORT PRE-CHECK (V2Ray only, before payment)
  │   Probe ports: 8686, 8787, 7874, 7876, 443, 8443...
  │   All dead → throw "V2Ray service dead" (no tokens spent)
  │
  ├─ 3. PAYMENT
  │   signAndBroadcastRetry() → MsgStartSessionRequest     [core/wallet.js]
  │   extractSessionId(txResult)                            [protocol/v3protocol.js]
  │   waitForSessionActive(addr, wallet, 20s, sessionId)    [core/session.js]
  │   Code 105 → queryNodeStatusDirect() across 4 LCDs     [core/chain.js]
  │
  ├─ 4. HANDSHAKE
  │   handshakeWithRetry(fn, makeFn)
  │   ├─ WG: initHandshakeV3() or bridgeHandshakeWG()
  │   └─ V2: initHandshakeV3V2Ray() or bridgeHandshakeV2Ray()
  │   409 → 15s+20s retry → payForFreshSession()
  │   Retest mode → skip waits, immediate fresh session
  │
  ├─ 5. TUNNEL
  │   WG: writeWgConfig() → installWgTunnel()
  │   V2: buildV2RayClientConfig(drift→alterId) → spawnV2Ray()
  │       Gun+grpc dual outbounds for transport_protocol:3
  │
  ├─ 6. SPEED TEST
  │   WG: speedtestDirect() + checkGoogleDirect()
  │   V2: speedtestViaSocks5(socksPort) + checkGoogleViaSocks5()
  │
  ├─ 7. CLEANUP
  │   WG: uninstallWgTunnel() + emergencyCleanupSync()
  │   V2: cleanupV2Ray(proc)
  │
  └─ 8. RESULT → return TestResult object
```

## SSE Event Flow: Server → Dashboard

```
server.js broadcast(type, data)
  │
  ├─ 'state'    → { state }        → Stats grid, progress bar, controls
  ├─ 'result'   → { result, state } → Results table row (upsert by address)
  ├─ 'log'      → { msg }          → Log panel (append, auto-scroll)
  └─ 'progress' → { state }        → Current node display
```

## Persistence Architecture

```
Disk (survives restart)                Memory (lost on restart)
─────────────────────                  ──────────────────────
results/results.json ←→ resultsArr[]   state.testedNodes
results/failures.jsonl (append)        state.failedNodes
results/transport-cache.json           state.baselineMbps
results/session-credentials.json       state.nodeSpeedHistory
results/.state-snapshot.json           state.currentNode
results/.sdk-pref                      credentialCache{}
results/runs/index.json                sessionMap (Map)
results/runs/test-NNN/                 paidNodesThisRun (Set)
                                       poisonedSessions (Set)
```

## Edge Case Decision Tree

```
Node fails → has peers?
  ├─ NO → acceptable failure (0 peers = truly dead)
  └─ YES → OUR BUG. Investigate:
      ├─ Status unreachable → retry + alternate addrs
      ├─ V2Ray ports dead → port scan → rebuild config with discovered ports
      ├─ Clock drift > 120s → alterId=64 (legacy VMess, no AEAD)
      ├─ 409 session exists → payForFreshSession()
      ├─ Code 105 inactive → multi-LCD check → 20s+30s retry
      ├─ Address mismatch → node misconfigured (code 6)
      ├─ No usable transports → C# SDK filtering issue
      ├─ DB error → retry after 15s
      └─ SOCKS5 no connectivity → add more targets, connected-no-throughput fallback
```
