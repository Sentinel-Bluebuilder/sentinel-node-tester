# Embedding Node Testing — Platform Comparison

## Two Embedding Approaches

### Approach 1: Native JavaScript (Electron, Node.js, Web)
**Your app runs JavaScript.** Import the node tester directly. No bridge, no subprocess, no IPC. Functions are native.

```javascript
import { testNode, getAllNodes, speedtestDirect } from 'sentinel-node-tester';
// Direct function calls — everything runs in your process
```

### Approach 2: Bridge / Subprocess (C#, Swift, Rust, Kotlin)
**Your app is NOT JavaScript.** You can't import JS functions directly. Two options:

**Option A: Run node tester as a subprocess, control via HTTP API**
```csharp
// Start the node tester server as a child process
Process.Start("node", "sentinel-node-tester/server.js");
// Control via HTTP: POST localhost:3001/api/start
// Read results via: GET localhost:3001/api/state
// Stream events via: SSE localhost:3001/events
```

**Option B: Use the C# bridge for protocol operations, build test logic natively**
```csharp
// C# bridge handles: status, handshake, speedtest
// Your app handles: test orchestration, UI, results storage
var status = await RunBridge("status", nodeUrl);
var handshake = await RunBridge("handshake", nodeUrl, sessionId, mnemonic, "v2ray");
var speed = await RunBridge("speedtest-direct");
```

---

## Comparison Table

| Feature | Electron/JS (Native) | C# .NET (Subprocess) | C# .NET (Bridge) |
|---------|----------------------|---------------------|-------------------|
| **Import** | `import { testNode }` | N/A | `RunBridge("command")` |
| **Function calls** | Direct, in-process | HTTP API calls | CLI subprocess |
| **Dashboard** | Embed `index.html` as webview | Open browser to :3001 | Build native WPF UI |
| **SSE events** | EventSource in renderer | HttpClient SSE stream | N/A (poll or build own) |
| **Speed test** | `speedtestViaSocks5()` | `GET /api/speedtest` | `RunBridge("speedtest")` |
| **Results** | In-memory + `results.json` | `GET /api/results` | Parse bridge JSON stdout |
| **Tunnel management** | Native (WG/V2Ray spawn) | Node.js handles it | App handles it natively |
| **Session payment** | CosmJS in-process | Node.js handles it | C# SDK TransactionBuilder |
| **Startup time** | 0 (already running) | ~3s (Node.js cold start) | ~0.7s (bridge exe) |
| **Memory** | Shared with app | Separate process (~80MB) | Minimal per call |
| **Dependencies** | npm packages | Node.js runtime required | .NET 8 + Sentinel SDK NuGet |

---

## Electron / JavaScript App

This is the easiest path. The node tester IS JavaScript.

### Full Embed (dashboard + testing)
```javascript
// main.js (Electron main process)
import { fork } from 'child_process';

// Start node tester server in background
const tester = fork('sentinel-node-tester/server.js', [], {
  env: { ...process.env, PORT: '3099', MNEMONIC: wallet.mnemonic }
});

// In your app, add a webview to the dashboard
// <webview src="http://localhost:3099" />
```

### Functions Only (no dashboard)
```javascript
// Import individual functions into your app
import { testNode, speedtestDirect, getAllNodes } from 'sentinel-node-tester';
import { ACTIVE_DNS, setActiveDns, DNS_PRESETS } from 'sentinel-node-tester';

// Use your app's existing wallet
const result = await testNode(client, account, privkey, node, opts, null, log, state);

// Build your own UI from result data
updateResultsTable(result);
```

### Renderer Process (React/Vue/Svelte)
```javascript
// Connect to SSE stream from renderer
const es = new EventSource('http://localhost:3099/events');

es.addEventListener('result', e => {
  const { result } = JSON.parse(e.data);
  dispatch({ type: 'ADD_RESULT', result });
});

es.addEventListener('state', e => {
  const { state } = JSON.parse(e.data);
  dispatch({ type: 'UPDATE_STATE', state });
});

es.addEventListener('log', e => {
  const { msg } = JSON.parse(e.data);
  dispatch({ type: 'ADD_LOG', msg });
});
```

---

## C# .NET App (WPF / WinUI / Console)

Three approaches, from easiest to most integrated:

### Approach A: Webview (easiest — 10 min)
Embed the dashboard as a WebView2 control. The node tester runs as a subprocess.

```xml
<!-- MainWindow.xaml -->
<TabItem Header="Node Test">
  <WebView2 x:Name="TestView" Source="http://localhost:3099" />
</TabItem>
```

```csharp
// App.xaml.cs — start node tester on app launch
private Process? _testerProcess;

protected override void OnStartup(StartupEventArgs e)
{
    _testerProcess = Process.Start(new ProcessStartInfo
    {
        FileName = "node",
        Arguments = "sentinel-node-tester/server.js",
        Environment = { ["MNEMONIC"] = Settings.Mnemonic, ["PORT"] = "3099" },
        UseShellExecute = false,
        CreateNoWindow = true,
    });
}

protected override void OnExit(ExitEventArgs e)
{
    _testerProcess?.Kill();
}
```

**Pros:** Full dashboard, zero UI work, real-time updates
**Cons:** Requires Node.js runtime, separate process

### Approach B: HTTP API (medium — 1 hour)
Control the node tester via REST from C# code. Build native WPF UI.

```csharp
public class NodeTesterClient
{
    private readonly HttpClient _http = new() { BaseAddress = new Uri("http://localhost:3099") };

    public async Task StartTestAsync()
        => await _http.PostAsync("/api/start", null);

    public async Task StopAsync()
        => await _http.PostAsync("/api/stop", null);

    public async Task<TestState> GetStateAsync()
    {
        var json = await _http.GetStringAsync("/api/state");
        return JsonSerializer.Deserialize<TestState>(json);
    }

    public async Task<FailureAnalysis> GetFailuresAsync()
    {
        var json = await _http.GetStringAsync("/api/failure-analysis");
        return JsonSerializer.Deserialize<FailureAnalysis>(json);
    }

    public async Task SetDnsAsync(string preset)
        => await _http.PostAsJsonAsync("/api/dns", new { preset });

    public async Task SetSdkAsync(string sdk)
        => await _http.PostAsJsonAsync("/api/sdk", new { sdk });

    // SSE stream for real-time updates
    public async IAsyncEnumerable<TestEvent> StreamEventsAsync()
    {
        using var stream = await _http.GetStreamAsync("/events");
        using var reader = new StreamReader(stream);
        while (await reader.ReadLineAsync() is { } line)
        {
            if (line.StartsWith("data:"))
                yield return JsonSerializer.Deserialize<TestEvent>(line[5..]);
        }
    }
}
```

**Pros:** Native WPF UI, full control
**Cons:** Still requires Node.js subprocess

### Approach C: Bridge Only (most integrated — 2 hours)
No Node.js runtime. Use the C# bridge for protocol ops. Build test orchestration in C#.

```csharp
public class NativeNodeTester
{
    private readonly string _bridgePath = "csharp-bridge/bin/Debug/net8.0/win-x64/SentinelBridge.exe";
    private readonly string _mnemonic;

    // Test a single node using C# SDK (no Node.js)
    public async Task<NodeTestResult> TestNodeAsync(string nodeAddress)
    {
        // 1. Status check via bridge
        var status = await RunBridgeAsync<StatusResult>("status", GetNodeUrl(nodeAddress));
        if (!status.Success) return Fail(nodeAddress, status.Error);

        // 2. Full connect via bridge (pays for session + handshake)
        var connect = await RunBridgeAsync<ConnectResult>("connect", GetNodeUrl(nodeAddress), _mnemonic, "1");
        if (!connect.Success) return Fail(nodeAddress, connect.Error);

        // 3. Speed test via bridge
        var speed = await RunBridgeAsync<SpeedResult>("speedtest-direct");

        // 4. Return result
        return new NodeTestResult
        {
            Address = nodeAddress,
            Moniker = status.Data.Moniker,
            Connected = connect.Success,
            SpeedMbps = speed.Data?.Mbps,
            Protocol = status.Data.Type,
        };
    }

    private async Task<BridgeResponse<T>> RunBridgeAsync<T>(params string[] args)
    {
        var psi = new ProcessStartInfo(_bridgePath, string.Join(" ", args))
        {
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        using var proc = Process.Start(psi);
        var json = await proc!.StandardOutput.ReadToEndAsync();
        await proc.WaitForExitAsync();
        return JsonSerializer.Deserialize<BridgeResponse<T>>(json);
    }
}
```

**Pros:** No Node.js, pure .NET, smallest footprint
**Cons:** No dashboard (build your own), no SSE events, limited to bridge commands

---

## Swift macOS App

```swift
// Option A: WebView (easiest)
import WebKit
let webView = WKWebView()
webView.load(URLRequest(url: URL(string: "http://localhost:3099")!))

// Option B: HTTP API (same as C# Approach B but with URLSession)
let (data, _) = try await URLSession.shared.data(from: URL(string: "http://localhost:3099/api/state")!)
let state = try JSONDecoder().decode(TestState.self, from: data)

// Option C: Port the bridge to Swift using Sentinel Swift SDK
// Similar to C# Approach C but with Swift SDK
```

---

## Decision Tree

```
Q: What language is your app?
│
├── JavaScript/TypeScript (Electron, Node.js)
│   → Import directly: import { testNode } from 'sentinel-node-tester'
│   → Dashboard: embed index.html or use SSE events
│   → EASIEST PATH
│
├── C# .NET (WPF, WinUI, Console)
│   ├── Want full dashboard? → WebView2 + subprocess
│   ├── Want native UI? → HTTP API client + build WPF controls
│   └── Want no Node.js? → C# bridge only (limited features)
│
├── Swift (macOS, iOS)
│   ├── Want full dashboard? → WKWebView + subprocess
│   └── Want native UI? → HTTP API + SwiftUI controls
│
└── Other (Rust, Kotlin, etc.)
    → HTTP API is universal. Start subprocess, call REST endpoints.
```

---

## What Each Approach Gets You

| Feature | JS Native | Webview | HTTP API | Bridge Only |
|---------|-----------|---------|----------|-------------|
| Full dashboard | ✓ | ✓ | Build own | Build own |
| Real-time SSE log | ✓ | ✓ | ✓ | ✗ |
| Results table | ✓ | ✓ | ✓ (build UI) | ✗ (build UI) |
| Speed test | ✓ | ✓ | ✓ | ✓ |
| DNS toggle | ✓ | ✓ | ✓ | ✗ |
| SDK toggle (JS/C#) | ✓ | ✓ | ✓ | C# only |
| Transport cache | ✓ | ✓ | ✓ | ✗ |
| Auto-retest | ✓ | ✓ | ✓ | Build own |
| Node.js required | ✓ | ✓ | ✓ | ✗ |
| Lines of code | 5 | 10 | 100 | 200 |
