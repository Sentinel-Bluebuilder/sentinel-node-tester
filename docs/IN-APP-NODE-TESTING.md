# In-App Node Testing — Universal Design Spec

> **Status: DESIGN DOCUMENT — NOT YET IMPLEMENTED.** This describes the target architecture for integrating node testing into consumer dVPN apps. The Node Tester CLI (Level 1) is working. This in-app module (Level 2) has not been built yet.

## What This Will Be

A node testing capability that will be integrated into consumer apps built on the Sentinel SDK. Any application — C# WPF, Electron JS, Swift macOS, React Native — will run automated node tests using its own connect/disconnect functions.

This is NOT a standalone tool. It will be an SDK module that wraps the application's own VPN backend.

## Two-Level Testing

| Level | Where | What It Tests | Who Uses It |
|-------|-------|---------------|-------------|
| **Level 1** | CLI (Node Tester at `sentinel-node-tester/`) | Raw protocol: handshake, config building, transport selection, edge cases | SDK developers, protocol engineers |
| **Level 2** | Inside ANY consumer app | The app's own connect/disconnect against real nodes | App developers, QA, end users (power mode) |

Level 1 finds SDK/protocol bugs → fixed in SDK.
Level 2 verifies the app handles those fixes correctly.

**This document defines Level 2.**

## Design Principle

The SDK provides a `NodeTester` class. The application gives it a **backend adapter** — an interface with `Connect()`, `Disconnect()`, `IsConnected()`. The tester calls those functions exactly as a user would. It does NOT bypass the app's VPN stack.

```
┌─────────────────────────────────┐
│  Application (C#, JS, Swift)    │
│  ┌───────────────────────────┐  │
│  │  NodeTester (SDK module)  │  │
│  │  ┌─────────────────────┐  │  │
│  │  │  IVpnTestAdapter    │──┼──┼──→ app.Connect(node)
│  │  │  (app implements)   │──┼──┼──→ app.Disconnect()
│  │  │                     │──┼──┼──→ app.IsConnected()
│  │  └─────────────────────┘  │  │
│  │           │               │  │
│  │     ConnectivityCheck     │  │   ← HTTP GET through tunnel
│  │     SpeedTest             │  │   ← Download through tunnel
│  │     DnsTest               │  │   ← Resolve through tunnel
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

## Interface: IVpnTestAdapter

Every application implements this interface in its own language. The SDK NodeTester calls it.

### C# (.NET)
```csharp
public interface IVpnTestAdapter
{
    Task ConnectAsync(string nodeAddress, CancellationToken ct);
    Task DisconnectAsync();
    bool IsConnected { get; }
    string? ConnectedNodeAddress { get; }
    string? TunnelType { get; } // "wireguard" or "v2ray"
}
```

### JavaScript (Electron/Node)
```javascript
// The adapter wraps whatever the app uses to connect
const adapter = {
  connect: async (nodeAddress) => { /* app's connect logic */ },
  disconnect: async () => { /* app's disconnect logic */ },
  get isConnected() { /* return bool */ },
  get connectedNode() { /* return address or null */ },
  get tunnelType() { /* "wireguard" or "v2ray" */ },
};
```

### Swift (macOS/iOS)
```swift
protocol VpnTestAdapter {
    func connect(nodeAddress: String) async throws
    func disconnect() async throws
    var isConnected: Bool { get }
    var connectedNodeAddress: String? { get }
    var tunnelType: String? { get }
}
```

## NodeTester Core Logic (language-agnostic pseudocode)

```
class NodeTester:
    adapter: IVpnTestAdapter
    results: List<NodeTestResult>

    async testNode(nodeAddress, options):
        result = new NodeTestResult(nodeAddress)
        timer.start()

        try:
            // Phase 1: CONNECT — call the app's own connect
            await adapter.connect(nodeAddress)
            result.connectTimeMs = timer.elapsed()

            if not adapter.isConnected:
                result.error = "Connect returned but tunnel not active"
                return result

            // Phase 2: CONNECTIVITY — can we reach the internet?
            result.connectivity = await checkConnectivity(options.targets)

            // Phase 3: DNS — can we resolve domains?
            if options.testDns:
                result.dns = await checkDns(options.dnsTargets)

            // Phase 4: SPEED — how fast is the tunnel?
            if result.connectivity.reachable:
                result.speed = await measureSpeed()

            // Phase 5: DISCONNECT — call the app's own disconnect
            await adapter.disconnect()
            result.disconnectClean = not adapter.isConnected

            result.success = result.connectivity.reachable
            result.totalTimeMs = timer.elapsed()

        catch error:
            result.error = error.message
            result.totalTimeMs = timer.elapsed()
            try: await adapter.disconnect()
            catch: result.disconnectClean = false

        return result

    async testAll(nodes, options):
        for node in nodes:
            if stopped: break
            result = await testNode(node.address, options)
            results.add(result)
            emit("result", result)
        emit("complete", summary)
```

## Connectivity Check

Once the app has connected to a node, ALL network traffic goes through the tunnel. The test just makes normal HTTP requests:

```
targets = [
    "https://www.google.com",
    "https://www.cloudflare.com",
    "https://httpbin.org/ip",
    "https://ifconfig.me",
]

for target in targets:
    try:
        response = HTTP.GET(target, timeout=15s)
        return { reachable: true, target, latencyMs, statusCode, publicIp }
    catch: continue

return { reachable: false }
```

No SOCKS5 proxy needed. No special routing. The app's tunnel handles everything.

## Speed Test

Download a known file through the tunnel:

```
url = "https://speed.cloudflare.com/__down?bytes=5000000"  // 5 MB
start = now()
data = HTTP.GET(url)
elapsed = now() - start
mbps = (data.length * 8) / elapsed / 1_000_000
```

Fallback targets if Cloudflare is blocked:
- `http://speedtest.tele2.net/1MB.zip`
- `https://proof.ovh.net/files/1Mb.dat`

## DNS Test

Resolve domains through the tunnel's DNS to verify DNS provider works:

```
// Standard domains (should always resolve)
standardTargets = ["google.com", "cloudflare.com", "sentinel.co"]

// HNS domains (only resolve with Handshake DNS)
hnsTargets = ["welcome.nb", "letsdane", "3b"]

for domain in targets:
    try:
        ip = DNS.resolve(domain, timeout=5s)
        return { domain, resolved: true, ip, latencyMs }
    catch:
        return { domain, resolved: false }
```

## Result Data Model

```
NodeTestResult:
    nodeAddress: string
    moniker: string
    country: string
    countryCode: string
    city: string
    nodeType: string          // "wireguard" or "v2ray"
    peers: int

    success: bool
    error: string?
    errorCode: string?

    connectTimeMs: int
    totalTimeMs: int
    disconnectClean: bool

    connectivity:
        reachable: bool
        target: string
        latencyMs: int
        publicIp: string?

    speed:
        mbps: float
        bytes: int
        seconds: float

    dns:
        results: [{domain, resolved, ip, latencyMs}]
        hnsWorking: bool       // true if any .hns domain resolved

    // Comparison with Level 1
    level1Pass: bool?          // did Node Tester CLI pass this node?
    level1Mbps: float?         // what speed did CLI get?
    discrepancy: bool          // Level 1 passed but Level 2 failed = APP BUG
```

## Test Options

```
NodeTestOptions:
    connectTimeoutMs: 120000    // 2 min per node
    maxNodes: 0                 // 0 = all
    nodeTypes: ["wireguard", "v2ray"]  // or one only
    countries: []               // filter by country code
    minPeers: 1                 // skip nodes with 0 peers

    // What to test
    testConnectivity: true
    testSpeed: true
    testDns: false
    dnsPreset: "default"        // "default", "hns", "google", "cloudflare"

    // DNS targets
    standardDnsTargets: ["google.com", "sentinel.co"]
    hnsDnsTargets: ["welcome.nb"]

    // Level 1 comparison
    level1ResultsPath: null     // path to Node Tester results.json for comparison
```

## Platform Implementation Notes

### C# (.NET / WPF)
- HttpClient for connectivity/speed (uses system proxy = tunnel)
- Dns.GetHostEntryAsync() for DNS test
- CancellationToken for timeouts
- BackgroundWorker or async Task for non-blocking UI

### JavaScript (Electron)
- fetch() or axios for connectivity/speed (Electron routes through system proxy)
- dns.resolve() for DNS test
- AbortController for timeouts
- Web Workers or main process IPC

### Swift (macOS)
- URLSession for connectivity/speed (uses system VPN routing)
- CFHost or dnssd for DNS test
- Task cancellation for timeouts
- async/await with MainActor for UI updates

## UI Requirements

The test results should appear in a **separate tab** within the app (not a popup or modal). The tab must:

1. **Match the app's theme** — use the app's background color, font family, font sizes, border styles. Do NOT hardcode a black background. Read from the app's CSS variables / resource dictionary.
2. **Mirror the Node Tester dashboard layout** — same columns: SDK, Transport, Node, Country, City, Peers, Speed, Total BW, Baseline, Result (FAST/SLOW/FAIL badges)
3. **Country flags** — ISO code to flag emoji, same as Node Tester (`🇺🇸 US`)
4. **DNS test toggle** — checkbox or switch: "Test DNS" on/off. When enabled, shows additional columns: DNS Provider, HNS Resolved, Standard Resolved, DNS Latency
5. **DNS provider selector** — dropdown: HNS, Google, Cloudflare. Tests resolution through the tunnel with selected DNS
6. **Start/Stop controls** — Start Test, Stop, progress bar (X/Total)
7. **Filters** — country, node type (WG/V2Ray), min peers
8. **Export** — CSV/JSON download of results
9. **Level 1 comparison column** — if Level 1 results are available, show pass/fail comparison. Highlight discrepancies in red.

## Integration Checklist

For any app implementing Level 2:

- [ ] Implement `IVpnTestAdapter` wrapping the app's connect/disconnect
- [ ] Add `NodeTester` instance with adapter
- [ ] Add "Node Test" tab in app navigation
- [ ] Results table matching app theme (NOT hardcoded colors)
- [ ] Country flags from ISO codes
- [ ] DNS test toggle (on/off) with provider selector (HNS/Google/Cloudflare)
- [ ] Start/Stop + progress bar
- [ ] Filters: country, node type, min peers
- [ ] Export (CSV/JSON)
- [ ] Always disconnect after each node (even on error)
- [ ] Compare with Level 1 results when available
- [ ] Highlight discrepancies (Level 1 pass + Level 2 fail = APP BUG)
- [ ] Handle edge cases: timeout, tunnel leak, double-connect

## What The SDK Provides vs What The App Provides

| Component | SDK Provides | App Provides |
|-----------|-------------|-------------|
| NodeTester orchestrator | ✓ | |
| Connectivity check | ✓ | |
| Speed test | ✓ | |
| DNS test | ✓ | |
| Result data models | ✓ | |
| IVpnTestAdapter interface | ✓ | |
| **Adapter implementation** | | ✓ (wraps app's connect/disconnect) |
| **Node list** | | ✓ (app already has this) |
| **UI** | | ✓ (app-specific) |
| **Tunnel management** | | ✓ (app already has this) |

The SDK provides the testing logic. The app provides the VPN backend and UI.
