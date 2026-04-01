# CRITICAL: Consumer Functions vs Testing Functions

> **READ THIS BEFORE BUILDING ANYTHING.** Using the wrong functions will drain wallets, confuse users, and break apps.

## The Rule

The Sentinel SDK exports 160+ functions. They serve TWO completely different audiences. **Never mix them.**

| Audience | Purpose | Session Count | Token Cost | Example |
|----------|---------|--------------|------------|---------|
| **Consumer App** | One user connects to one node | 1 session | ~40 P2P/GB | `connectDirect()` |
| **Testing/Audit** | Test hundreds of nodes in parallel | 100+ sessions | ~4,000+ P2P | `batchStartSessions()` |

**If you are building a VPN app for end users: use ONLY consumer functions.**
**If you are building a network audit tool: you may use testing functions.**
**If you are adding a "Node Test" tab to a consumer app: testing functions go ONLY in that tab, never in the main VPN flow.**

---

## Consumer Functions (Safe for End Users)

These functions handle ONE user, ONE node, ONE session. They are designed for the main VPN flow.

### Connection (on-chain TX — costs tokens)
```
connectDirect(nodeAddress)        — Pay per GB, one session
connectViaSubscription(planId)    — Use existing plan (no extra cost)
connectAuto()                     — Best strategy automatically
disconnect()                      — End session, clean tunnel
```

### Node Browsing (read-only — FREE)
```
queryOnlineNodes()                — Get all active nodes
filterNodes(country, type)        — Filter by location/protocol
getNodePrices(nodeAddress)        — Check pricing
getBalance()                      — Check wallet P2P balance
```

### Session Management (read-only — FREE)
```
findExistingSession(nodeAddr)     — Check for active session
querySessions()                   — List user's sessions
querySessionAllocation(id)        — Check bandwidth usage
```

### Plan/Subscription (on-chain TX for subscribe only)
```
subscribeToPlan(planId)           — Purchase plan (costs tokens)
querySubscriptions()              — List subscriptions (free)
hasActiveSubscription(planId)     — Check if active (free)
```

### Tunnel Management (local — FREE)
```
connectWireGuard()                — Start WG tunnel
disconnectWireGuard()             — Stop WG tunnel
installWgTunnel(confPath)         — Install WG service
uninstallWgTunnel()               — Remove WG service
```

### State & Credentials (local — FREE)
```
saveState() / loadState()         — Persist/restore sessions
saveCredentials() / loadCredentials() — Tunnel configs
clearState() / clearCredentials() — Cleanup
```

### Helpers (local — FREE)
```
formatP2P(udvpn)                  — "1.50 P2P"
formatBytes(bytes)                — "2.34 GB"
groupNodesByCountry(nodes)        — Organize for UI
getFlagEmoji(countryCode)         — "🇺🇸"
estimateSessionPrice(node, gb)    — Cost estimate
```

---

## Testing Functions (NEVER in Consumer Flow)

These functions are for the Node Tester CLI, network auditing, and the "Node Test" tab in apps. They create many sessions, cost many tokens, and are not designed for end users.

### Batch Operations (on-chain TX — EXPENSIVE)
```
⚠️ batchStartSessions(nodes, 5)   — 5 sessions per TX, 100+ nodes
⚠️ buildBatchStartSession(msgs)    — Build batch TX messages
⚠️ buildBatchSend(recipients)      — Bulk token transfers
⚠️ buildBatchLink(nodes, planId)   — Bulk node linking
```
**Cost:** 5 nodes × 40 P2P/GB = 200 P2P per batch. 200 batches = 40,000 P2P.

### Protocol Testing (no TX — but exposes internals)
```
initHandshakeV3(url, sessionId)   — Raw WG handshake
initHandshakeV3V2Ray(url, sid)    — Raw V2Ray handshake
buildV2RayClientConfig(host, meta) — Build V2Ray config manually
nodeStatusV3(url)                  — Direct node status query
generateWgKeyPair()                — WG keypair generation
```

### Operator/Plan Admin (on-chain TX — requires operator keys)
```
⚠️ encodeMsgCreatePlan()           — Create subscription plan
⚠️ encodeMsgRegisterProvider()     — Register as provider
⚠️ encodeMsgLinkNode(node, plan)   — Add node to plan
⚠️ encodeMsgStartLease()           — Start node lease
⚠️ grantPlanSubscribers()          — Grant fee subsidies to ALL subscribers
⚠️ renewExpiringGrants()           — Extend expiring grants
```

### Audit Functions
```
testNode(client, node)             — Full single-node test
auditNetwork(nodes)                — Test all nodes in parallel
recordTransportSuccess/Failure()   — Transport learning
reorderOutbounds()                 — Sort by success rate
```

### Raw TX (developer tools)
```
⚠️ broadcast(client, addr, msgs)   — Send any TX
⚠️ sendTokens(to, amount)          — Transfer P2P tokens
⚠️ broadcastWithFeeGrant()         — TX with sponsor
```

---

## In-App Node Testing: How To Keep It Separate

If your consumer app has a "Node Test" tab:

### DO:
- Put ALL testing logic in a separate `NodeTestService` class
- Use the app's own `connect()` / `disconnect()` through an adapter
- Show results in a dedicated tab, not the main VPN screen
- Warn the user: "Testing will use P2P tokens for each node tested"
- Let the user set a max node count
- Log everything to a separate test log file

### DO NOT:
- Import `batchStartSessions` anywhere in the main app code
- Call `encodeMsgCreatePlan` or any operator function from the consumer UI
- Use `broadcast()` directly — always go through `connectDirect()` or equivalent
- Mix test results with the user's VPN connection state
- Auto-start testing without user confirmation

### Architecture:
```
MyVpnApp/
├── Services/
│   ├── VpnService.cs              ← CONSUMER: connect, disconnect, status
│   └── NodeTestService.cs         ← TESTING: only used by test tab
├── Views/
│   ├── MainPage.xaml              ← CONSUMER: VPN on/off, node picker
│   └── NodeTestTab.xaml           ← TESTING: results table, start/stop
└── Models/
    ├── VpnState.cs                ← CONSUMER: connection state
    └── NodeTestResult.cs          ← TESTING: test results
```

The two never share state. The test tab has its own service instance.

---

## On-Chain Transaction Summary

### Transactions That Cost P2P (Real Money)

| Function | Who Uses It | Approx Cost | Frequency |
|----------|-------------|-------------|-----------|
| `connectDirect()` | Consumer | ~40 P2P/GB | Per connect |
| `subscribeToPlan()` | Consumer | Plan price | Once |
| `disconnect()` | Consumer | ~0.2 P2P gas | Per disconnect |
| `batchStartSessions()` | Testing ONLY | ~200 P2P per batch of 5 | Per audit |
| `sendTokens()` | Developer ONLY | Amount + gas | Manual |
| `grantPlanSubscribers()` | Operator ONLY | Gas × subscribers | Monthly |
| `encodeMsgCreatePlan()` | Operator ONLY | Gas | Once |

### Read-Only Queries (FREE — No Tokens)

| Function | Description |
|----------|-------------|
| `queryOnlineNodes()` | Node list from LCD |
| `getBalance()` | Wallet balance |
| `querySessions()` | Active sessions |
| `querySubscriptions()` | User subscriptions |
| `filterNodes()` | Client-side filter |
| `nodeStatusV3()` | Direct node status |
| `findExistingSession()` | Session lookup |

### Local Operations (FREE — No Chain)

| Function | Description |
|----------|-------------|
| `installWgTunnel()` | OS-level WG service |
| `buildV2RayClientConfig()` | Generate V2Ray config |
| `saveState()` / `loadState()` | Disk persistence |
| `formatP2P()` | Display formatting |
| `groupNodesByCountry()` | UI helpers |

---

## Logs Management

### Type 1 (CLI Node Tester)
```
results/
├── results.json              — Current test results (live, overwritten per test)
├── failures.jsonl            — Append-only failure log (every failure ever)
├── session-credentials.json  — Cached session data
├── transport-cache.json      — Learned transport preferences
├── audit-{timestamp}.log     — Per-audit text log
├── retest-{timestamp}.log    — Per-retest text log
└── runs/
    ├── index.json            — Run index (number, date, passed/failed, sdk)
    ├── test-001/results.json — Archived run 1
    ├── test-002/results.json — Archived run 2
    └── ...
```

- `results.json` is auto-saved to `runs/` before any new test starts
- `failures.jsonl` is append-only — never cleared, searchable by node address
- Audit logs include timestamps, per-node results, balance changes
- Transport cache persists across runs (learned transport preferences)

### Type 2 (In-App Node Tester)
```
{app_data_dir}/node-tests/
├── latest.json               — Most recent test results
├── history/
│   ├── {timestamp}.json      — Each completed test run
│   └── ...
├── failures.log              — Append-only failure log
└── export/
    ├── {timestamp}.csv       — CSV exports
    └── {timestamp}.json      — JSON exports
```

- Results stored in app's data directory (not app install dir)
- Each test run saved with timestamp
- Failure log is append-only for trend analysis
- Export directory for user-requested exports
- App should show "X test runs saved" in the test tab
- Old runs prunable by user ("Clear history older than 30 days")

### Log Format Per Result
```json
{
  "timestamp": "2026-03-23T10:00:00Z",
  "nodeAddress": "sentnode1abc...",
  "moniker": "FastNode",
  "country": "US",
  "countryCode": "US",
  "city": "New York",
  "type": "wireguard",
  "peers": 12,
  "success": true,
  "connectTimeMs": 3200,
  "totalTimeMs": 15400,
  "disconnectClean": true,
  "speed": { "mbps": 34.21, "bytes": 5000000, "seconds": 1.17 },
  "connectivity": { "reachable": true, "target": "google.com", "latencyMs": 120, "publicIp": "1.2.3.4" },
  "dns": { "standard": true, "hns": true, "provider": "hns", "latencyMs": 45 },
  "error": null,
  "sdk": "csharp",
  "platform": "windows",
  "app": "HandshakeDVPN",
  "appVersion": "1.0.0"
}
```
