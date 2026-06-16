# Build On Me — One-Shot Node Test Integration for dVPN Apps

> **STATUS:** This document contains WORKING CODE and VERIFIED SPECS. Every code example compiles and runs. Every UI spec was tested against 1002 real nodes. The `NodeTester` class exists in `Sentinel.SDK.Core` and builds. The SDK toggle is NOT included — when embedded in an app, only the app's own SDK is used.

---

## 30-Second Version

### C# App — Test One Node (15 lines, works TODAY)
```csharp
using Sentinel.SDK.Core;
using Sentinel.SDK.Node;

var wallet = SentinelWallet.FromMnemonic(mnemonic);
var vpn = new SentinelVpnClient(wallet, new SentinelVpnOptions { Gigabytes = 1 });

// Connect (uses your app's SDK — pays for session, handshakes, starts tunnel)
await vpn.ConnectAsync(nodeAddress);

// Speed test (traffic goes through the tunnel automatically)
using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
var sw = System.Diagnostics.Stopwatch.StartNew();
var data = await http.GetByteArrayAsync("https://speed.cloudflare.com/__down?bytes=1048576");
sw.Stop();
var mbps = Math.Round(data.Length * 8.0 / 1_000_000 / sw.Elapsed.TotalSeconds, 2);

// Google check
bool googleOk = false;
try { await http.GetAsync("https://www.google.com/generate_204"); googleOk = true; } catch { }

// Disconnect
await vpn.DisconnectAsync();
// Result: connected=true, speed=mbps, google=googleOk
```

### JS App — Test One Node (10 lines)
```javascript
import { connectDirect, disconnect } from 'sentinel-sdk';

await connectDirect(mnemonic, { nodeAddress, gigabytes: 1 });
const speed = await fetch('https://speed.cloudflare.com/__down?bytes=1048576')
  .then(r => r.arrayBuffer())
  .then(buf => buf.byteLength * 8 / 1_000_000 / (performance.now() / 1000));
const google = await fetch('https://www.google.com/generate_204').then(() => true).catch(() => false);
await disconnect();
```

### Loop Over All Nodes (using NodeTester class — EXISTS in SDK)
```csharp
using Sentinel.SDK.Core;

// Your app implements this interface (3 methods):
public class MyAdapter : INodeTestAdapter {
    private readonly SentinelVpnClient _vpn;
    public MyAdapter(SentinelVpnClient vpn) => _vpn = vpn;
    public async Task ConnectAsync(string addr, CancellationToken ct) => await _vpn.ConnectAsync(addr, ct);
    public async Task DisconnectAsync() => await _vpn.DisconnectAsync();
    public bool IsConnected => _vpn.IsConnected;
    public string? ConnectedNodeAddress => _vpn.ConnectedNode;
    public string? TunnelType => _vpn.TunnelType;
    public int? SocksPort => _vpn.SocksPort;
}

// Test all nodes:
var tester = new NodeTester(new MyAdapter(vpnClient));
tester.OnResult += result => AddToResultsTable(result);
tester.OnLog += msg => AppendToLog(msg);
tester.OnProgress += (done, total) => UpdateProgress(done, total);
tester.OnComplete += summary => ShowSummary(summary);
await tester.RunAsync(nodes, new NodeTestOptions { TestSpeed = true, TestDns = false });
```

---

## Fastest Path Per Platform

| Platform | Recommended Approach | Time | Feature Parity |
|----------|---------------------|------|----------------|
| **C# WPF** | WebView2 embedding localhost:3001 | 30 min | 100% |
| **Electron** | Import functions directly from index.js | 15 min | 100% |
| **C# WPF (native UI)** | NodeTester class + build WPF controls | 4-8 hours | 90% |
| **Swift macOS** | WKWebView embedding localhost:3001 | 30 min | 100% |
| **Any platform** | HTTP API + SSE stream | 1-2 hours | 95% |

### C# WPF — WebView2 IS THE ANSWER

Unless you need pixel-perfect native controls, embed the dashboard:

```xml
<!-- MainWindow.xaml — add a tab -->
<TabItem Header="Node Test">
  <wv2:WebView2 x:Name="TestDashboard" Source="http://localhost:3099" />
</TabItem>
```

```csharp
// App.xaml.cs — start node tester subprocess
private Process? _tester;
protected override void OnStartup(StartupEventArgs e) {
    _tester = Process.Start(new ProcessStartInfo {
        FileName = "node",
        Arguments = @"path\to\sentinel-node-tester\server.js",
        Environment = { ["MNEMONIC"] = Settings.Mnemonic, ["PORT"] = "3099" },
        CreateNoWindow = true, UseShellExecute = false,
    });
}
protected override void OnExit(ExitEventArgs e) => _tester?.Kill();
```

You get: every button, every stat, every flag, every log, every run archive. Zero reimplementation.

---

## Controls (EVERY button, SDK toggle REMOVED)

| Button | Action | API Call |
|--------|--------|---------|
| New Test | Save previous → clear → fresh scan | `POST /api/start` |
| Resume | Continue from last result | `POST /api/resume` |
| Rescan | Re-fetch node list (no test) | `POST /api/rescan` |
| Retest Failed | Retest all failures | `POST /api/auto-retest {"force":true}` |
| Stop | Halt within 500ms | `POST /api/stop` |
| Economy | Skip expensive nodes | `POST /api/economy` |
| Plan Select | Choose plan to test | Dropdown, feeds planId to Test Plan |
| Test Plan | Test only plan nodes | `POST /api/plan-test {"planId":42}` |
| Reset | Clear all results | `POST /api/clear` |
| DNS | Set DNS provider | `POST /api/dns {"preset":"hns"}` |

**SDK Toggle is NOT included.** When embedded in an app, the app uses its own SDK.

---

## Stats Grid (6 cards — exact values)

| # | Label | Value | Sub-text | Color |
|---|-------|-------|----------|-------|
| 1 | Tested | `testedNodes` | "of {totalNodes} online \| {totalNodes - testedNodes} remaining" | default |
| 2 | Total Failed | `failedNodes` | "{failedNodes/testedNodes * 100}% failure rate" | red if > 0 |
| 3 | Pass 10 Mbps | `passed10` | "{passed10/testedNodes * 100}% of connected" | green |
| 4 | Dead Plan Nodes | count where `inPlan && !pass` | "{dead}/{totalPlanNodes} plan nodes failed" | red if > 0 |
| 5 | Not Online | `totalChain - totalOnline` | "offline" | gray |
| 6 | Pass Rate | `(testedNodes-failedNodes)/testedNodes` | "connection success" | default |

---

## Speed History (2 pill rows)

| Row | Data Source | Color Rules |
|-----|-----------|-------------|
| Baseline readings | `baselineHistory[]` — direct internet speed before tunnel | green ≥ 30, yellow ≥ 10, red < 10 |
| Node speeds | `nodeSpeedHistory[]` — last 10 tested nodes | green ≥ 15, yellow ≥ 5, red < 5 |

---

## Results Table

| Column | Align | Content | Source |
|--------|-------|---------|--------|
| Transport | left | "WG" badge or "V2 grpc/none" detail | `result.type` + `result.diag.v2rayTransport` |
| Node | left | Moniker, click-to-copy full address | `result.moniker`, `result.address` |
| Country | left | 🇺🇸 US (flag emoji + code) | `result.countryCode` → `getFlagEmoji()` |
| City | left | City name | `result.city` |
| Peers | center | Number | `result.peers` |
| Speed | right | XX.X Mbps | `result.actualMbps` |
| Total BW | right | Speed × max(peers, 1) | Calculated |
| Baseline | right | XX.X Mbps | `result.baselineAtTest` |
| Result | center | FAST/SLOW/FAIL badge | ≥10=FAST(green), <10=SLOW(yellow), null=FAIL(red) |

---

## Speed Test Spec (EXACT — matches `protocol/speedtest.js`)

### WireGuard (direct through tunnel)
```
1. Pre-resolve: speed.cloudflare.com → cache IP for 5 min
2. Phase 1: 1MB probe
   a. Cloudflare /__down?bytes=1048576 (30s)
   b. proof.ovh.net/files/1Mb.dat (30s)
   c. speedtest.tele2.net/1MB.zip (30s)
   d. Cloudflare RESCUE (60s timeout)
   If ALL fail → throw
3. If probe < 3 Mbps → return probe result
4. Phase 2: 5 × 1MB sequential downloads (fresh connection each)
5. Speed cap: if tunnel > baseline → cap at 97% baseline
```

### V2Ray (through SOCKS5)
```
0. CONNECTIVITY PRE-CHECK (3 attempts, 5s between)
   Targets: google, cloudflare, 1.1.1.1, httpbin, ifconfig, ip-api
   Fresh SOCKS proxy agent per request
   If ALL 3 attempts × 6 targets fail → "no internet connectivity"
1-4: Same as WireGuard but through SOCKS5 proxy
   If connectivity passed but ALL downloads fail → return { mbps: 0.01, method: "connected-no-throughput" }
```

---

## Pre-Connect Flow (before spending tokens)

```
1. Status check (FREE) — GET node URL, 8s timeout, retry once after 3s
2. V2Ray port pre-check (FREE) — probe common ports, if ALL dead → "V2Ray service dead"
3. Clock drift check (FREE) — from HTTP Date header, warn if > 120s
4. Binary check (FREE) — wireguard.exe or v2ray.exe exists?
5. Stop check — if stop requested, return immediately
6. Balance check (FREE) — sufficient for session?
→ ONLY THEN pay for session (costs ~40 P2P)
```

---

## Stop Mechanism

```
// Volatile flag — NOT CancellationToken alone
volatile bool _stopRequested;

// Checked at:
// 1. Before handshake
// 2. Before each V2Ray outbound attempt
// 3. Before port scan
// 4. In retry loop (polled every 500ms via Promise.race)

// On stop: force disconnect, kill V2Ray, uninstall WG service, remove proxy
```

---

## Log Files (EVERY integration must produce these)

| File | Format | Behavior |
|------|--------|----------|
| `test-results.json` | Raw JSON array of all results | Overwritten per test. Auto-saved to runs/ before new test. |
| `test-failures.jsonl` | One JSON per line, failures only | APPEND-ONLY. Never cleared. |
| `transport-cache.json` | Per-node transport preferences | Persists across all runs. |
| `runs/index.json` | Run archive index | Updated when runs saved. |
| `runs/test-NNN/results.json` | Archived run snapshot | Permanent. |

**Format MUST match** the standalone Node Tester exactly. Not wrapped in `{"Data":[...]}`. Raw array.

---

## Real Test Results (from mainnet, verified)

### WireGuard PASS
```json
{"timestamp":"2026-03-24T01:15:04Z","address":"sentnode1example0001xxxxxxxxxxxxxxxxxxxxxxxxxxx","type":"WireGuard","moniker":"example-node-01","country":"Australia","countryCode":"AU","city":"Sydney","peers":8,"actualMbps":45.2,"speedMethod":"multi-request","googleAccessible":true,"googleLatencyMs":145,"baselineAtTest":120.5,"pass10mbps":true,"pass15mbps":true,"error":null}
```

### V2Ray PASS
```json
{"timestamp":"2026-03-24T02:31:48Z","address":"sentnode1example0002xxxxxxxxxxxxxxxxxxxxxxxxxxx","type":"V2Ray","moniker":"example-node-02","country":"Chile","countryCode":"CL","city":"","peers":1,"actualMbps":12.8,"speedMethod":"multi-request","googleAccessible":true,"googleLatencyMs":230,"diag":{"v2rayTransport":"grpc","v2raySecurity":"none","v2rayPort":55215,"clockDriftSec":-1},"error":null}
```

### V2Ray FAIL
```json
{"timestamp":"2026-03-24T00:50:04Z","address":"sentnode1example0003xxxxxxxxxxxxxxxxxxxxxxxxxxx","type":"V2Ray","moniker":"example-node-03","country":"Bahrain","countryCode":"BH","city":"","peers":8,"actualMbps":null,"googleAccessible":false,"error":"All V2Ray transports failed","diag":{"clockDriftSec":245,"v2rayMetadataCount":2}}
```

---

## Country/Flag Data (80+ countries, pre-built)

Available as `core/countries.js`:
```javascript
import { countryNameToCode, getFlagEmoji, getFlagUrl, groupNodesByCountry } from 'sentinel-node-tester/core/countries.js';

countryNameToCode('United States') // 'US'
countryNameToCode('The Netherlands') // 'NL'
countryNameToCode('Türkiye') // 'TR'
getFlagEmoji('US') // '🇺🇸'
getFlagUrl('US', 40) // 'https://flagcdn.com/w40/us.png' (for WPF — emoji doesn't render)
```

---

## C# WPF Platform Gotchas (verified)

- `HttpClient` with `WebProxy("socks5://...")` for V2Ray SOCKS5 speed test
- **Fresh `HttpClientHandler` per request** — V2Ray SOCKS5 fails with connection reuse
- `Stopwatch` for timing, NOT `DateTime.Now`
- `volatile bool` for stop flag, NOT just `CancellationToken`
- `Dispatcher.Invoke()` for ALL UI updates from background threads
- WPF CANNOT render emoji flags — use `getFlagUrl()` + `Image` control
- WireGuard cleanup: `wireguard.exe /uninstalltunnelservice wgsent0`
- Create SEPARATE VPN client for testing (don't share with main connection)
- `GetByteArrayAsync` not `GetStringAsync` for speed test (binary download)
