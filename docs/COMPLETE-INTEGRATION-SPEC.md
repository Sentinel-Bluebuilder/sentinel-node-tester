# Complete Integration Spec — What's Actually Needed to Integrate Node Testing

**Date:** 2026-03-24
**Source:** 12+ hours failing to integrate Node Tester into Handshake dVPN
**Goal:** Make it possible for any app to have an IDENTICAL test dashboard — every button, every field, every data point

---

## Two Modes: Standalone vs Integrated

### Mode 1: Standalone
Run the Node Tester as-is on localhost:3001. The existing project works. No changes needed.

### Mode 2: Integrated Into App
The test dashboard runs INSIDE another app (WPF, Electron, React, Swift). This is what Handshake dVPN tried and failed to do. This document specifies EXACTLY what the integrated version needs.

---

## What Must Be Identical (No Exceptions)

### Controls Bar
Every button from the standalone dashboard must exist in the integrated version:

| Button | Standalone | Integrated | Difference |
|--------|-----------|-----------|------------|
| New Test | Start fresh scan of all online nodes | Same | None |
| Resume | Continue interrupted scan | Same | None |
| Rescan | Re-fetch node list from chain | Same | None |
| Retest Failed | Re-test only failed nodes | Same | None |
| Stop | Halt current scan immediately, kill tunnel | Same | Must force-kill tunnel + process |
| Economy | Toggle economy mode (skip expensive nodes) | Same | None |
| SDK Toggle | Switch between JS and C# SDK | **REMOVED** | App tests its own code only |
| Plan Select | Dropdown of available plans | Same | None |
| Test Plan | Test only nodes in selected plan | Same | None |
| Reset | Clear all results | Same | None |

**The SDK Toggle is the ONLY button removed.** Everything else must exist and function identically.

### Stats Grid (6 Cards)

| Stat | Label | Value Source | Sub-text | Color |
|------|-------|-------------|----------|-------|
| 1 | Tested | completedCount / totalOnline | "of {totalOnline} online" | default |
| 2 | Total Failed | count where !pass | "{failedPct}%" | red |
| 3 | Pass 10 Mbps SLA | count where speed >= 10 | "{passPct}%" | green |
| 4 | Dead Plan Nodes | failed nodes that are in a plan | "{deadPlanPct}%" | red |
| 5 | Not Online | totalChain - totalOnline | "offline" | gray |
| 6 | Pass Rate | passedCount / testedCount | "connected / tested" | default |

**All 6 must be present.** "Dead Plan Nodes" requires knowing which nodes belong to plans — query `GetPlanNodesAsync()` for subscribed plans and cross-reference with failed results.

### Speed History (2 Sections)

| Section | Content | Format |
|---------|---------|--------|
| Last 10 Baseline Readings | Direct connection speeds (no tunnel) | Colored pills: green >= 30 Mbps, yellow >= 15, red < 15 |
| Last 10 Node Speeds | Most recent test results | Colored pills: green >= 10 Mbps, yellow >= 5, red < 5 |

**Baseline measurement:** Before testing through tunnel, measure direct internet speed. This is the reference for "is the VPN slow or is our internet slow?"

### Progress Bar

| Element | Value |
|---------|-------|
| Title | "Audit Progress" |
| Percentage | "{done}/{total} = X%" |
| ETA | Calculate from: elapsed / done * remaining |
| Fill bar | Proportional width |
| Count | "X / Y Available Nodes" |
| Current action | "Testing {moniker}..." or "Standby" or "Stopped" |

### Node Performance Matrix TABLE

| Column | Width | Align | Content | Notes |
|--------|-------|-------|---------|-------|
| Transport | 80px | left | "WG" or "V2 tcp/tls" or "V2 grpc/none" etc | Show full transport detail for V2Ray |
| Node | flex | left | Moniker (click to copy full address) | Truncate to fit |
| Country | 80px | left | Flag + country code | Use flag images |
| City | 100px | left | City name | From node status |
| Peers | 50px | center | Number | From pre-connect status check |
| Speed | 70px | right | "XX.X Mbps" | Color: green >= 10, yellow >= 5, red < 5 |
| Baseline | 70px | right | "XX.X Mbps" | Direct speed at time of test |
| Result | 60px | center | "PASS" or "FAIL" | Green badge or red badge |

**SDK column removed** (integrated mode tests app's own code only).

### Live Log Panel
- Scrolling text log at bottom of dashboard
- Timestamp + message per line
- Errors in red
- Auto-scroll to bottom
- Show [TEST] prefixed messages
- Max 200 lines, remove oldest when exceeded

---

## Speed Test — COMPLETE Specification

The speed test MUST match the Node Tester's implementation. Not an approximation. Not "download a file and measure." The EXACT flow:

### For WireGuard (Direct Through Tunnel)

```
1. PRE-RESOLVE DNS
   - Resolve speed.cloudflare.com to IP
   - Resolve fallback hosts (proof.ovh.net, speedtest.tele2.net)
   - Cache resolved IPs for 5 minutes
   - This prevents DNS failures behind WireGuard tunnels

2. PHASE 1: 1MB PROBE
   Try in order:
   a. https://{cached_cf_ip}/__down?bytes=1048576 (30s timeout)
   b. https://speed.cloudflare.com/__down?bytes=1048576 (30s timeout)
   c. https://proof.ovh.net/files/1Mb.dat (30s timeout)
   d. https://speedtest.tele2.net/1MB.zip (30s timeout)
   e. RESCUE: https://speed.cloudflare.com/__down?bytes=1048576 (60s timeout, keep-alive)

   If ALL fail → throw "Speed test failed"

   Calculate: probeMbps = (bytes * 8 / 1_000_000) / seconds

3. PHASE 2: DECISION
   If probeMbps < 3 → return { mbps: probeMbps, method: "probe-only", chunks: 1 }
   If probeMbps >= 3 → proceed to multi-request

4. PHASE 2: MULTI-REQUEST (5 × 1MB)
   - 5 sequential downloads of 1MB each
   - FRESH TCP+TLS connection per download (no connection reuse)
   - Each has 30s timeout
   - Calculate: totalMbps = (totalBytes * 8 / 1_000_000) / totalSeconds

   If multi-request fails but probe worked → return { mbps: probeMbps, method: "probe-fallback", chunks: 1 }
   If multi-request succeeds → return { mbps: totalMbps, method: "multi-request", chunks: successCount }
```

### For V2Ray (Through SOCKS5 Proxy)

```
0. CONNECTIVITY PRE-CHECK (CRITICAL)
   V2Ray SOCKS5 binding is asynchronous. The proxy may not be ready even after port accepts TCP.

   Try up to 3 attempts with 5s pause between:
     For each target in [google.com, cloudflare.com, 1.1.1.1, httpbin.org/ip, ifconfig.me, ip-api.com/json]:
       HTTP GET via SOCKS5 proxy (15s timeout)
       If ANY succeed → tunnel connected, proceed

   If ALL 3 attempts fail → throw "SOCKS5 tunnel has no internet connectivity"

   IMPORTANT: Create FRESH SocksProxyAgent/WebProxy per request. V2Ray SOCKS5 fails with connection reuse.

1. PHASE 1: 1MB PROBE (via SOCKS5)
   Same fallback chain as direct but through SOCKS5:
   a. Cloudflare via SOCKS5 (30s timeout)
   b. OVH via SOCKS5 (30s timeout)
   c. Tele2 via SOCKS5 (30s timeout)
   d. Cloudflare RESCUE via SOCKS5 (60s timeout)
   e. Google page as rough estimate via SOCKS5 (15s timeout)

   If e works → return { mbps: estimated, method: "google-fallback", chunks: 1 }
   If ALL fail but connectivity check passed → return { mbps: 0.01, method: "connected-no-throughput", chunks: 0 }

2. PHASE 2: Same as direct (5 × 1MB multi-request through SOCKS5)
   FRESH proxy agent per request
```

### Baseline Measurement

Before testing any node, measure direct internet speed (no tunnel):
```
1. Ensure no VPN tunnel is active
2. Run speedtestDirect() → baselineMbps
3. Store in baselineHistory (last 10 readings)
4. Use for comparison: passBaseline = actualMbps >= (baselineMbps * 0.5)
```

### Speed Test Result Object

```json
{
  "mbps": 45.2,
  "chunks": 5,
  "method": "multi-request",     // or "probe-only", "probe-fallback", "google-fallback", "connected-no-throughput", "rescue"
  "fallbackHost": null            // or "proof.ovh.net" if fallback was used
}
```

---

## Pre-Connect Flow — COMPLETE

Before paying for a session and connecting, the following checks MUST happen:

```
1. NODE STATUS CHECK (FREE — no tokens)
   GET node's remote URL → returns: type, moniker, peers, bandwidth, location, clockDriftSec
   Timeout: 8-12 seconds
   Retry: once after 3s, then try alternate remote_addrs
   If unreachable → FAIL (no tokens spent)

2. BINARY AVAILABILITY CHECK (FREE)
   WireGuard node → check wireguard.exe exists
   V2Ray node → check v2ray.exe exists
   If missing → SKIP (cannot test this protocol)

3. CLOCK DRIFT CHECK (V2Ray only, FREE)
   If abs(clockDriftSec) > 120 → WARN (VMess AEAD may fail)
   Still attempt connection (peers > 0 means it works for others)

4. STOP CHECK
   If stop requested → return immediately (no tokens spent)
```

Only after ALL pre-checks pass → create session (costs tokens) → handshake → tunnel → speed test.

---

## Test Result — COMPLETE Schema

Every test MUST produce this result:

```json
{
  // Identity
  "timestamp": "2026-03-24T01:00:15Z",
  "address": "sentnode1abc...",
  "moniker": "busurnode au 001",
  "country": "Australia",
  "countryCode": "AU",
  "city": "Sydney",

  // Connection
  "type": "WireGuard",              // or "V2Ray"
  "transport": "wg",                 // or "tcp/tls", "grpc/none", "websocket/tls" etc
  "connected": true,
  "connectSeconds": 12.3,
  "sessionId": "37595302",
  "error": null,                     // or error message string

  // Peers
  "peers": 8,
  "maxPeers": null,

  // Speed
  "actualMbps": 45.2,
  "baselineAtTest": 120.5,
  "speedMethod": "multi-request",
  "ispBottleneck": false,            // actualMbps >= 85% of baseline

  // Thresholds
  "pass10mbps": true,
  "pass15mbps": true,
  "passBaseline": true,              // actualMbps >= 50% of baseline
  "baselineViable": true,            // baseline >= 30 Mbps
  "dynamicThreshold": 60.25,         // 50% of baseline

  // Connectivity
  "googleAccessible": true,
  "googleLatencyMs": 145,

  // Verdict
  "pass": true,

  // Pricing
  "gigabytePrices": [...],

  // Plan membership
  "inPlan": true,
  "planIds": [42],

  // Platform
  "os": "Windows",

  // Diagnostics (expandable on row click)
  "diag": {
    "clockDriftSec": 2.3,
    "speedtestMethod": "multi-request",
    "wgAssignedAddrs": ["10.0.0.5"],
    "wgServerPubKey": "...",
    "wgServerEndpoint": "1.2.3.4:51820",
    "googleError": null
  }
}
```

---

## Stop Mechanism — EXACT Pattern

The Node Tester uses `state.stopRequested` flag, NOT CancellationToken:

```
// At start of every phase:
if (state.stopRequested) throw new Error('Stop requested');

// Stop handler:
state.stopRequested = true;
// Force disconnect tunnel
// Uninstall WireGuard service
// Kill V2Ray process
// Remove system proxy
// Set state to idle
// Re-render dashboard
```

The flag is checked at:
1. Entry to handshake (before paying)
2. After catch, before retry
3. Inside V2Ray outbound loop (each transport attempt)
4. Inside port scan discovery loop

**CancellationToken alone is NOT sufficient.** SDK async operations don't respond to cancellation mid-flight. The flag must be checked at explicit points in the flow.

---

## What Handshake dVPN Built vs What It Should Have Built

| Feature | What Was Built | What Should Exist | Gap |
|---------|---------------|-------------------|-----|
| Controls | New Test, Stop, Reset | + Resume, Rescan, Economy, Plan Select, Test Plan | 5 buttons missing |
| Stats | 6 cards (basic) | 6 cards with plan nodes cross-reference | Dead Plan Nodes not calculated |
| History | None | Baseline pills + Node speed pills | Missing entirely |
| Progress | Bar + percentage | + ETA + current action + node count | ETA calculation exists but untested |
| Table | 7 columns | + Baseline column, + transport detail, + click to expand diag | Missing baseline, transport detail |
| Speed test | 3 targets, 30s timeout | + DNS pre-resolve, + IP-first, + rescue 60s, + google-fallback, + connected-no-throughput | Missing 5 fallback modes |
| V2Ray pre-check | 1 target, 3 attempts | 6 targets, 3 attempts with 5s pause | Missing 5 targets |
| Baseline | None | Measure direct speed before testing | Missing entirely |
| Clock drift | None | Detect >120s drift, warn | Missing |
| Plan membership | None | Cross-reference failed nodes with plan nodes | Missing |
| Session reuse | ForceNewSession=true always | Check for existing session, reuse if valid | Wastes tokens |
| Transport detail | "WG" or "V2" | "V2 tcp/tls", "V2 grpc/none" etc | Missing transport detail |
| Diagnostics | None | Expandable row with full diag object | Missing |
| Stop mechanism | CancellationToken only | Volatile flag checked at 4 points + force cleanup | Partially done |
| Live log | Main log + TestLogPanel | Dedicated test log with 200-line limit | Exists but untested |

---

## For the Node Tester Project: What to Provide

### 1. A Working Speed Test Module (Language-Agnostic Spec)

Don't provide JS code and expect C# developers to translate. Provide:
- The ALGORITHM (this document's speed test section)
- The TARGETS (URLs, timeouts, fallback order)
- The THRESHOLDS (3 Mbps probe cutoff, 10/15 Mbps pass thresholds)
- The RESULT SHAPE (JSON example)

### 2. A Complete Dashboard Component Spec

Not HTML. A layout specification:
- Section order (top to bottom)
- Each section's exact fields
- Column widths for the table
- Color rules
- Button states (enabled/disabled/loading)
- Update frequency per element

### 3. A Pre-Connect Checklist

What to check before spending tokens:
1. Node reachable? (GET status, 8s timeout)
2. Correct protocol binary available?
3. Clock drift acceptable? (V2Ray only)
4. Stop requested?
5. Balance sufficient?

### 4. A Complete Test Result JSON Example

From a REAL test. Not a schema. Not a type definition. The actual output from testing a real node on mainnet. Both WireGuard and V2Ray examples.

### 5. Platform-Specific Implementation Notes

For C# WPF:
- Use `HttpClient` not `WebClient` (async support)
- Create `HttpClientHandler` with `WebProxy` for SOCKS5
- Fresh handler per request for V2Ray (connection reuse fails)
- Use `arraybuffer` equivalent (`GetByteArrayAsync`)
- Use `Stopwatch` for timing (not `DateTime.Now`)
- Use `volatile bool` for stop flag (not just CancellationToken)
- Null-check ALL UI references in background loops
- Use `Dispatcher.Invoke` for ALL UI updates from background threads
- WireGuard cleanup: `wireguard.exe /uninstalltunnelservice wgsent0`
- Create SEPARATE VPN client for testing (don't share with main connection)

---

*The Node Tester dashboard has ~50 interactive elements, ~30 data fields, ~15 button states, and ~500 lines of speed test logic. An integration guide that covers 20% of this is not an integration guide — it's a starting point that leaves 80% for the developer to reverse-engineer from source code.*
