# One-Shot Integration Guide

> Read this ONE file. Import ONE module. Add node testing to any app in 30 minutes.

## Install

```bash
# From your app's directory:
npm install ../sentinel-node-tester
# OR copy the folder and reference it
```

## Import

```javascript
import { testNode, speedtestDirect, speedtestViaSocks5, getAllNodes } from 'sentinel-node-tester';
```

## Option A: Standalone Tester (Electron/Web)

Run the full server with dashboard:

```javascript
import { fork } from 'child_process';
const server = fork('sentinel-node-tester/server.js');
// Dashboard at http://localhost:3001
// Control via API: POST /api/start, /api/stop, /api/resume
```

## Option B: Embed Testing in Your App

### Step 1: Get nodes

```javascript
import { getAllNodes, findWorkingLcd } from 'sentinel-node-tester';

await findWorkingLcd();
const nodes = await getAllNodes(msg => console.log(msg));
```

### Step 2: Test a single node

```javascript
import { testNode } from 'sentinel-node-tester';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';

// Setup wallet (your app already has this)
const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: 'sent' });
const [account] = await wallet.getAccounts();
const client = await SigningStargateClient.connectWithSigner(rpc, wallet);
const privkey = /* derive from mnemonic */;

// Test one node
const result = await testNode(client, account, privkey, node, {
  testMb: 10,
  gigabytes: 1,
  denom: 'udvpn',
  v2rayAvailable: true,
  baselineMbps: 30,
}, null, msg => console.log(msg), { activeSDK: 'js' });

// result.actualMbps, result.googleAccessible, result.type, result.error
```

### Step 3: Speed test only (no session/payment needed)

```javascript
import { speedtestDirect, speedtestViaSocks5 } from 'sentinel-node-tester';

// Direct baseline
const baseline = await speedtestDirect();
console.log('Baseline:', baseline.mbps, 'Mbps');

// Through V2Ray SOCKS5 tunnel (your app manages the tunnel)
const tunnel = await speedtestViaSocks5(10, 10808);
console.log('Tunnel:', tunnel.mbps, 'Mbps');
```

### Step 4: Google reachability check

```javascript
import { checkGoogleDirect, checkGoogleViaSocks5 } from 'sentinel-node-tester';

// Through WireGuard (routes all traffic)
const wg = await checkGoogleDirect(10000);

// Through V2Ray SOCKS5
const v2 = await checkGoogleViaSocks5(10808, 10000);
```

## Option C: C# App via Bridge

```csharp
// Your C# app calls SentinelBridge.exe for SDK operations
// The bridge wraps the C# Sentinel SDK

// Status check
Process.Start("SentinelBridge.exe", "status https://node-ip:port");
// Returns: {"success":true,"data":{"type":"v2ray","peers":12,...}}

// Handshake
Process.Start("SentinelBridge.exe", "handshake https://node-ip:port 12345 mnemonic v2ray");
// Returns: {"success":true,"data":{"type":"v2ray","uuid":"...","allEntries":[...]}}

// Speed test
Process.Start("SentinelBridge.exe", "speedtest-direct");
// Returns: {"success":true,"data":{"mbps":34.21}}
```

## Option D: Control via HTTP API

If running the server, use REST:

```bash
# Start test
curl -X POST localhost:3001/api/start

# Check progress
curl localhost:3001/api/state

# Get failures
curl localhost:3001/api/failure-analysis

# Toggle SDK
curl -X POST localhost:3001/api/sdk -d '{"sdk":"csharp"}'

# Set DNS
curl -X POST localhost:3001/api/dns -d '{"preset":"hns"}'

# Stop
curl -X POST localhost:3001/api/stop
```

## Option E: SSE Event Stream

```javascript
const es = new EventSource('http://localhost:3001/events');
es.addEventListener('result', e => {
  const { result } = JSON.parse(e.data);
  // result.address, result.actualMbps, result.type, result.error
});
es.addEventListener('log', e => {
  const { msg } = JSON.parse(e.data);
  // Real-time log message
});
es.addEventListener('state', e => {
  const { state } = JSON.parse(e.data);
  // state.testedNodes, state.failedNodes, state.status
});
```

---

## Test Result Shape

```javascript
{
  timestamp: '2026-03-24T10:00:00Z',
  address: 'sentnode1abc...',
  type: 'WireGuard' | 'V2Ray',
  moniker: 'NodeName',
  country: 'United States',
  countryCode: 'US',
  city: 'New York',
  peers: 12,
  maxPeers: 200,
  actualMbps: 34.21,           // null if failed
  reportedDownloadMbps: 100.5,
  baselineAtTest: 30.0,
  pass10mbps: true,
  pass15mbps: true,
  googleAccessible: true,
  googleLatencyMs: 120,
  sdk: 'js' | 'csharp',
  os: 'Windows' | 'macOS' | 'Linux',
  error: null,                  // string if failed
  diag: {
    clockDriftSec: -1,
    v2rayTransport: 'grpc',
    v2raySecurity: 'none',
    v2rayPort: 8686,
    sessionId: '12345',
    v2rayAttempts: [...],
    discoveredPorts: [7874],
  },
}
```

## Dashboard Layout

```
┌─ Header ──────────────────────────────────────────────────────┐
│ [Logo] SENTINEL AUDIT  [JS|C#] [DNS▼]                        │
├─ Stats ───────────────────────────────────────────────────────┤
│ Total: 1002 | Tested: 975 | Remaining: 27 | Rate: 97.2%      │
│ [New Test] [Resume] [Rescan] [Retest Failed] [Stop] [Economy] │
├─ Speed History ───────────────────────────────────────────────┤
│ [34.2] [21.5] [8.9] [42.1] [15.3]  (last 10, color-coded)   │
├─ Results Table ───────────────────────────────────────────────┤
│ SDK | Transport | Node | Country | City | Peers | Speed | ... │
│ JS WG| WireGuard |abc1..|🇺🇸 US  |NYC   |  12  |34 Mbps|FAST │
│ C# V2| grpc/none |def2..|🇩🇪 DE  |Frank |   8  |21 Mbps|FAST │
│ C# V2| tcp/tls   |ghi3..|🇫🇷 FR  |Paris |   3  | 2 Mbps|SLOW │
│ JS V2|           |jkl4..|🇬🇧 GB  |London|   0  |  --   |FAIL │
├─ Log ─────────────────────────────────────────────────────────┤
│ 10:32:15 [C# SDK]                                             │
│ 10:32:15 → V2Ray | New York, US | 34.2 Mbps | Cost: pre-paid │
│ 10:32:20 Handshake OK — UUID: abc123 (SOCKS:10808)            │
│ 10:32:30 Speed: 34.21 Mbps                                    │
│ 10:32:31 Google: ✓ reachable (120ms)                          │
└───────────────────────────────────────────────────────────────┘
```

### Badges
- **FAST** (green): ≥10 Mbps
- **SLOW** (yellow): connected, <10 Mbps
- **FAIL** (red): no connection

### Country Flags
```javascript
// ISO code → flag emoji
const flag = cc.length === 2
  ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65))
  : '';
```

---

## Files You Get

```
sentinel-node-tester/
├── index.js              ← IMPORT FROM HERE
├── server.js             ← Run for dashboard
├── core/                 ← Chain, wallet, sessions
├── audit/                ← Test pipeline
├── protocol/             ← Handshake, speed test, V2Ray config
├── platforms/windows/    ← WireGuard, V2Ray process mgmt
├── csharp-bridge/        ← C# SDK bridge CLI
├── bin/v2ray.exe         ← V2Ray 5.44.1
└── results/              ← Test data
```

## What Costs Tokens

| Action | Cost | When |
|--------|------|------|
| `testNode()` | ~40 P2P per node | Creates session + gas |
| `speedtestDirect()` | FREE | No chain call |
| `getAllNodes()` | FREE | LCD query |
| `nodeStatusV3()` | FREE | HTTP to node |
| `checkGoogleDirect()` | FREE | HTTP through tunnel |
