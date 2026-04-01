# AI Instructions: Add Node Testing to Any Sentinel dVPN App

> **Status: DESIGN SPEC — NOT WORKING CODE.** The classes and interfaces described below (NodeTester, IVpnTestAdapter, NodeTestService) DO NOT EXIST yet. They are the target architecture. To test nodes TODAY with working code, use the Node Tester CLI at localhost:3001 or embed via WebView/HTTP API (see EMBEDDING-GUIDE.md). For the COMPLETE tested integration spec with every button, stat, speed test detail, and platform gotcha, see **COMPLETE-INTEGRATION-SPEC.md**.

## Your Task

You are adding Level 2 node testing to an existing Sentinel dVPN application. The app already connects to and disconnects from dVPN nodes. You are adding automated testing of those functions against real nodes, with results displayed in a dashboard tab.

**Do NOT reimplement VPN logic.** The app already has connect/disconnect. You wrap it.

---

## Step 0: Scan The Project

Before writing any code, scan the project to understand its structure.

### Detect Language & Platform
```
Scan for:
  *.csproj, *.sln          → C# (.NET)
  package.json              → JavaScript/TypeScript (Electron, Node)
  *.xcodeproj, Package.swift → Swift (macOS/iOS)
  Cargo.toml                → Rust
  build.gradle, *.kt        → Kotlin (Android)
  pubspec.yaml              → Dart (Flutter)
```

### Detect OS Target
```
Scan for:
  WPF, WinUI, app.manifest              → Windows
  NSApplication, AppKit, SwiftUI         → macOS
  UIKit, UIApplication                   → iOS
  electron, BrowserWindow                → Cross-platform (Electron)
  Activity, AndroidManifest              → Android
```

### Find The VPN Backend
Search the project for these patterns — this is what you wrap:

```
Connect patterns:
  ConnectAsync, connectAsync, connect(, Connect(
  connectToNode, connectDirect, connectVia
  startVpn, startTunnel, startConnection

Disconnect patterns:
  DisconnectAsync, disconnectAsync, disconnect(, Disconnect(
  stopVpn, stopTunnel, stopConnection

Status patterns:
  IsConnected, isConnected, connected, connectionState
  tunnelStatus, vpnStatus, getStatus

Node list patterns:
  GetNodes, getNodes, fetchNodes, getAllNodes
  nodeList, activeNodes, onlineNodes
```

### Find The UI Framework
```
WPF:        MainWindow.xaml, UserControl, <Window>, <Page>
WinUI:      MainWindow.xaml, Microsoft.UI
Electron:   index.html, BrowserWindow, renderer.js
SwiftUI:    ContentView.swift, @State, some View
UIKit:      ViewController.swift, UITableView
React:      App.jsx, App.tsx, useState
```

### Find Theme/Style System
```
C# WPF:     App.xaml <ResourceDictionary>, Brushes, Styles
Electron:   styles.css, :root variables, theme
SwiftUI:    Color(.systemBackground), .font(.body)
React:      theme.js, styled-components, CSS modules
```

---

## Step 1: Create The Adapter

Create a file that wraps the app's VPN backend into the test adapter interface.

### Adapter Location
```
C#:      Services/NodeTestAdapter.cs
JS:      src/services/node-test-adapter.js (or .ts)
Swift:   Services/NodeTestAdapter.swift
Rust:    src/testing/adapter.rs
```

### Adapter Template

The adapter has exactly 5 properties/methods. Find the app's equivalents and wrap them.

#### C# (.NET)
```csharp
using System.Threading;
using System.Threading.Tasks;

public interface INodeTestAdapter
{
    Task ConnectAsync(string nodeAddress, CancellationToken ct = default);
    Task DisconnectAsync();
    bool IsConnected { get; }
    string? ConnectedNodeAddress { get; }
    string? TunnelType { get; } // "wireguard" or "v2ray"
}

// Scan the project for the VPN backend class and wrap it:
public class NodeTestAdapter : INodeTestAdapter
{
    private readonly /* AppVpnBackend */ _backend;

    public NodeTestAdapter(/* AppVpnBackend */ backend) => _backend = backend;

    public async Task ConnectAsync(string nodeAddress, CancellationToken ct)
        => await _backend./* ConnectDirectAsync or equivalent */(nodeAddress, ct);

    public async Task DisconnectAsync()
        => await _backend./* Disconnect or equivalent */();

    public bool IsConnected => _backend./* IsConnected or equivalent */;
    public string? ConnectedNodeAddress => _backend./* CurrentNode or equivalent */;
    public string? TunnelType => _backend./* TunnelType or equivalent */;
}
```

#### JavaScript / TypeScript
```javascript
// Scan for the app's VPN client/service and wrap it:
export function createNodeTestAdapter(vpnClient) {
  return {
    connect: async (nodeAddress) => {
      await vpnClient./* connect or equivalent */(nodeAddress);
    },
    disconnect: async () => {
      await vpnClient./* disconnect or equivalent */();
    },
    get isConnected() {
      return vpnClient./* isConnected or equivalent */;
    },
    get connectedNode() {
      return vpnClient./* currentNode or equivalent */;
    },
    get tunnelType() {
      return vpnClient./* tunnelType or equivalent */;
    },
  };
}
```

#### Swift
```swift
protocol NodeTestAdapter {
    func connect(nodeAddress: String) async throws
    func disconnect() async throws
    var isConnected: Bool { get }
    var connectedNodeAddress: String? { get }
    var tunnelType: String? { get }
}

// Wrap the app's VPN manager:
class AppNodeTestAdapter: NodeTestAdapter {
    private let vpn: /* AppVpnManager */

    func connect(nodeAddress: String) async throws {
        try await vpn./* connect or equivalent */(nodeAddress)
    }
    func disconnect() async throws {
        try await vpn./* disconnect or equivalent */()
    }
    var isConnected: Bool { vpn./* isConnected */ }
    var connectedNodeAddress: String? { vpn./* currentNode */ }
    var tunnelType: String? { vpn./* tunnelType */ }
}
```

---

## Step 2: Create The Test Service

### File Location
```
C#:      Services/NodeTestService.cs
JS:      src/services/node-test-service.js
Swift:   Services/NodeTestService.swift
```

### Core Logic (all languages follow this)

```
class NodeTestService:
    adapter: INodeTestAdapter
    results: []
    isRunning: bool
    tested: 0
    passed: 0
    failed: 0

    events: onResult, onLog, onComplete, onProgress

    async testNode(node, options):
        result = { address: node.address, moniker: node.moniker, ... }
        startTime = now()

        try:
            // 1. CONNECT — app's own function
            await adapter.connect(node.address)    [timeout: options.connectTimeoutMs]
            result.connectTimeMs = elapsed()

            if not adapter.isConnected:
                throw "Connect succeeded but tunnel not active"

            result.tunnelType = adapter.tunnelType

            // 2. CONNECTIVITY CHECK
            result.connectivity = await checkConnectivity(options.targets)

            // 3. DNS TEST (if enabled)
            if options.testDns:
                result.dns = await checkDns(options.dnsProvider, options.dnsTargets)

            // 4. SPEED TEST (if connectivity passed)
            if result.connectivity.reachable:
                result.speed = await measureSpeed()

            // 5. DISCONNECT — app's own function
            await adapter.disconnect()
            result.disconnectClean = not adapter.isConnected

            result.success = result.connectivity.reachable

        catch error:
            result.success = false
            result.error = error.message
            try: await adapter.disconnect()
            catch: result.disconnectClean = false

        result.totalTimeMs = now() - startTime
        return result

    async runAll(nodes, options):
        isRunning = true
        for node in nodes:
            if stopped: break
            result = await testNode(node, options)
            results.push(result)
            tested++
            if result.success: passed++ else failed++
            emit onResult(result)
            emit onProgress(tested, nodes.length)
        isRunning = false
        emit onComplete({ tested, passed, failed })

    stop():
        stopped = true
```

### Connectivity Check
```
// No SOCKS5 needed — the app's tunnel routes all traffic
targets = ["https://www.google.com", "https://www.cloudflare.com", "https://httpbin.org/ip"]
for target in targets:
    try:
        start = now()
        response = HTTP.GET(target, timeout=15s)
        return { reachable: true, target, latencyMs: elapsed(), publicIp: parseIp(response) }
    catch: continue
return { reachable: false }
```

### DNS Test
```
providers = {
    "hns":        ["198.51.100.1", "198.51.100.1"],
    "google":     ["8.8.8.8", "8.8.4.4"],
    "cloudflare": ["1.1.1.1", "1.0.0.1"],
}

standardTargets = ["google.com", "sentinel.co", "cloudflare.com"]
hnsTargets = ["welcome.nb", "3b"]

// Test standard domain resolution
for domain in standardTargets:
    result = DNS.resolve(domain, timeout=5s)

// Test HNS resolution (only works with HNS DNS)
if provider == "hns":
    for domain in hnsTargets:
        result = DNS.resolve(domain, timeout=5s)
```

### Speed Test
```
url = "https://speed.cloudflare.com/__down?bytes=5000000"
fallbacks = ["http://speedtest.tele2.net/1MB.zip", "https://proof.ovh.net/files/1Mb.dat"]

start = now()
data = HTTP.GET(url, timeout=30s)
mbps = (data.length * 8) / elapsed_seconds / 1_000_000

// Fallback if Cloudflare blocked
if failed:
    for fb in fallbacks:
        try: data = HTTP.GET(fb); break
```

---

## Step 3: Create The Dashboard Tab

### Requirements
- **Separate tab** in the app's navigation (not popup/modal)
- **Match app theme** — read colors, fonts, spacing from app's style system
- **DO NOT hardcode colors** — use CSS variables (JS), ResourceDictionary (C#), Color.systemBackground (Swift)

### Layout
```
┌──────────────────────────────────────────────────────┐
│ Node Test                                    [DNS ▼] │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐  │
│ │ Start    │ │ Stop     │ │ Export   │ │ Filter ▼│  │
│ └──────────┘ └──────────┘ └──────────┘ └─────────┘  │
│                                                      │
│ Progress: ████████░░░░░░░░░░░░  142/1002  97.2%      │
│ Passed: 139  Failed: 3  Speed avg: 18.4 Mbps        │
│                                                      │
│ ┌──────────────────────────────────────────────────┐ │
│ │ Type │ Node    │ 🏳 │ City      │Peers│ Speed  │R│ │
│ │──────│─────────│────│───────────│─────│────────│─│ │
│ │ WG   │ abc1... │🇺🇸US│ New York  │  12 │ 34 Mbps│✓│ │
│ │ V2   │ def2... │🇩🇪DE│ Frankfurt │   8 │ 21 Mbps│✓│ │
│ │ V2   │ ghi3... │🇫🇷FR│ Paris     │   3 │  0 Mbps│✗│ │
│ └──────────────────────────────────────────────────┘ │
│                                                      │
│ ┌─ DNS Test Results (when enabled) ─────────────────┐│
│ │ Provider: HNS  google.com: ✓  sentinel.co: ✓     ││
│ │ welcome.nb: ✓ (HNS)  3b: ✗ (timeout)             ││
│ └───────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

### Result Badges
- **FAST** (green) — connected, ≥10 Mbps
- **SLOW** (yellow) — connected, <10 Mbps
- **FAIL** (red) — could not connect or no internet

### Country Flags
Convert ISO country code to emoji flag:
```
C#:     char.ConvertFromUtf32(0x1F1E6 + code[0] - 'A') + char.ConvertFromUtf32(0x1F1E6 + code[1] - 'A')
JS:     String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65))
Swift:  code.unicodeScalars.map { String(UnicodeScalar(127397 + $0.value)!) }.joined()
```

---

## Step 4: Wire It Up

### Find the app's entry point / main window
```
C# WPF:    MainWindow.xaml.cs or App.xaml.cs
Electron:  main.js / renderer.js / App.jsx
Swift:     ContentView.swift or AppDelegate.swift
```

### Add the test tab
1. Add a navigation item: "Node Test" or "Network Audit"
2. Create the tab view with the layout above
3. Instantiate `NodeTestService` with the adapter
4. Wire Start/Stop buttons to `runAll()` / `stop()`
5. Wire `onResult` event to add rows to the table
6. Wire `onProgress` event to update progress bar

### Get the node list
The app already has a function to get nodes. Find it and pass to `runAll()`:
```
C#:     var nodes = await backend.GetAllNodesAsync();
JS:     const nodes = await client.getOnlineNodes();
Swift:  let nodes = try await client.getActiveNodes()
```

---

## Step 5: Test Options UI

### Controls
```
┌─ Test Settings ─────────────────────────────┐
│ Connect timeout:  [120s ▼]                  │
│ Max nodes:        [All  ▼]  (or number)     │
│ Node type:        [All  ▼]  WG / V2Ray      │
│ Min peers:        [1    ▼]                  │
│                                              │
│ ☑ Test connectivity                          │
│ ☑ Test speed                                 │
│ ☐ Test DNS                                   │
│   DNS Provider: [HNS ▼] Google / Cloudflare  │
│                                              │
│ ☐ Compare with Level 1 results               │
│   Results file: [Browse...]                  │
└──────────────────────────────────────────────┘
```

---

## Step 6: Data Export

### CSV Format
```csv
Node,Moniker,Country,City,Type,Peers,Connected,ConnectTime,Speed,DNS_Standard,DNS_HNS,Error
sentnode1abc...,MyNode,US,New York,WireGuard,12,true,3200,34.21,true,true,
sentnode1def...,BadNode,DE,Berlin,V2Ray,0,false,0,0,false,false,Connection refused
```

### JSON Format
```json
{
  "timestamp": "2026-03-23T10:00:00Z",
  "app": "HandshakeDVPN",
  "platform": "windows",
  "sdk": "csharp",
  "total": 1002,
  "passed": 975,
  "failed": 27,
  "results": [ ... ]
}
```

---

## Platform-Specific Notes

### Windows (C# WPF / WinUI)
- HttpClient uses system proxy → tunnel routes traffic automatically
- Dns.GetHostEntryAsync() for DNS resolution
- WireGuard service cleanup: always call Disconnect even on crash
- Admin required for WireGuard tunnel install

### Windows (Electron)
- fetch() in renderer uses system proxy → tunnel routes traffic
- Node.js dns.resolve() for DNS test
- V2Ray process cleanup: register exit handler

### macOS (Swift)
- URLSession uses system VPN routing automatically
- CFHost or Network.framework for DNS resolution
- WireGuard via NetworkExtension (NEPacketTunnelProvider)
- No admin needed — uses system VPN framework

### Linux (Electron / GTK)
- Same as Electron Windows but wg-quick instead of wireguard.exe
- V2Ray binary is linux-amd64 or linux-arm64
- May need sudo for WireGuard (pkexec)

### iOS (Swift)
- Same adapter pattern but connect/disconnect via NEVPNManager
- No V2Ray on iOS — WireGuard only via NetworkExtension
- Speed test uses URLSession (routed through tunnel)

### Android (Kotlin)
- VpnService for tunnel management
- HttpURLConnection for speed test (routed through VPN)
- DnsResolver for DNS test

---

## File Structure Summary

After integration, the app should have:

```
project/
├── Services/           (or src/services/)
│   ├── NodeTestAdapter.{cs,js,swift}     ← Wraps app's VPN backend
│   ├── NodeTestService.{cs,js,swift}     ← Orchestrator
│   ├── ConnectivityCheck.{cs,js,swift}   ← HTTP connectivity test
│   ├── SpeedTest.{cs,js,swift}           ← Download speed measurement
│   └── DnsTest.{cs,js,swift}             ← DNS resolution test
├── Views/              (or components/)
│   └── NodeTestTab.{xaml,html,swift}     ← Dashboard UI
└── Models/             (or types/)
    └── NodeTestModels.{cs,js,swift}      ← Result data types
```

Total new code: ~500-800 lines depending on language. No new dependencies.
