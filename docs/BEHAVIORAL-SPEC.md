# Every Single Thing Integrators Must Handle — Complete Behavioral Spec

**Date:** 2026-03-24
**Source:** C# WPF integration (Handshake dVPN) — 135 mainnet nodes, 12+ hours of discovery
**Rule:** Every behavior listed here must be documented in BUILD-ON-ME.md with working code in BOTH JS and C#

---

## Why This File Exists

The Node Tester browser dashboard does 50+ things automatically via SSE (Server-Sent Events) that push results, stats, progress, and logs to the browser in real-time. A native app (C# WPF, Swift, Kotlin) has NO SSE. The integrator must manually replicate every single behavior. None of these are documented. This file lists every one.

---

## CATEGORY 1: Live Result Updates (11 behaviors)

### 1.1 New result appears instantly in table
**Node Tester:** `broadcast('result', { result, state })` → SSE → `addSingleRow(r)` prepends row to `<tbody>` (index.html:1018)
**C# had to:** Call `RenderTestTable()` after each `TestNodeAsync()` return. Without this, the table stays empty until scan completes.
**Doc must say:** "After each node test, push the new NodeTestResult to your results list and re-render/insert a row. Do NOT batch — users need to see each result as it arrives."

### 1.2 Dedup by address (upsert, not append)
**Node Tester:** `upsertLocal(result)` — finds existing by address, replaces if exists, appends if new (index.html:735-739). DOM also deduped in `addSingleRow()` (removes old `<tr>` with matching `data-addr`).
**C# had to:** `_testResults.Any(r => r.Address == node.Address)` check before testing + `RemoveAll` on retest.
**Doc must say:** "Results must be deduplicated by node address. If you test the same node twice, replace the old result. Never show duplicate rows."

### 1.3 Table row shows correct badge: FAST / SLOW / FAIL
**Node Tester:** `actualMbps >= 10 → FAST (green)`, `actualMbps > 0 && < 10 → SLOW (amber)`, `null → FAIL (red)` (index.html:1062-1069)
**C# had to:** Change from binary PASS/FAIL to three-tier FAST/SLOW/FAIL. Was not documented anywhere.
**Doc must say:** "Result badges: FAST (green, ≥10 Mbps), SLOW (amber, <10 Mbps), FAIL (red, no speed data). NEVER use binary PASS/FAIL."

### 1.4 Speed colored by threshold
**Node Tester:** Green ≥10, amber <10, red = fail. Same thresholds in table cell styling.
**C# had to:** Reimplement: `speedColor = r.SpeedMbps >= 10 ? "Green" : r.SpeedMbps > 0 ? "Amber" : "Red"`
**Doc must say:** "Speed thresholds: ≥10 = green, >0 && <10 = amber, 0/null = red. These MUST match FAST/SLOW/FAIL badges."

### 1.5 Total BW calculation
**Node Tester:** `totalBw = actualMbps * Math.max(peers, 1)` (index.html:1055-1057)
**C# had to:** Add BW column, replicate formula.
**Doc must say:** "Total BW = speed × max(peers, 1). Peers 0 means we're the only user. This estimates the node's total bandwidth capacity."

### 1.6 Transport detail in table
**Node Tester:** Shows `vless/tcp TLS :443` from `r.diag.v2rayProto/v2rayTransport/v2raySecurity/v2rayPort` (index.html:1072-1085)
**C# had to:** Only show "WG" or "V2" because SDK doesn't expose transport metadata entries.
**Doc must say:** "V2Ray transport detail requires the diagnostic object from the test. Fields: v2rayProto, v2rayTransport, v2raySecurity, v2rayPort. If your SDK doesn't expose these, show 'V2' as fallback."

### 1.7 Click to copy node address
**Node Tester:** `onclick="copyToClipboard('${addrFull}', this)"` on address cell (index.html:1036)
**C# had to:** `nodeCell.MouseLeftButtonUp += (_, _) => { Clipboard.SetText(r.Address); }`
**Doc must say:** "Node address cells must be clickable to copy the full address to clipboard. Show truncated in cell, full in tooltip."

### 1.8 Country flag + code
**Node Tester:** Emoji flag via `String.fromCodePoint()` + country code (index.html:1038-1041)
**C# had to:** WPF cannot render emoji flags. Built PNG cache from flagcdn.com with 120+ country map and three-layer cache (memory → disk → download).
**Doc must say:** "Platform flag rendering: Web = emoji, WPF/WinForms = PNG images from flagcdn.com/w40/{code}.png, macOS/iOS = NSImage with emoji. WPF CANNOT render emoji flags — this is not a bug, it's a Windows limitation."

### 1.9 Peers with max display
**Node Tester:** Shows `peers/maxPeers` if max available, just `peers` otherwise (index.html:1049-1052)
**C# had to:** Show peers count. MaxPeers not available from SDK status endpoint.
**Doc must say:** "Peers column: show {current}/{max} if maxPeers available, otherwise just {current}. MaxPeers comes from node status."

### 1.10 Max Users calculation
**Node Tester:** `maxUsers = Math.floor(totalBw / 10)` — how many 10Mbps SLA users this node can serve (index.html:1059)
**C# missing:** Not implemented. Not documented.
**Doc must say:** "Max Users = floor(totalBw / 10). This tells operators how many users can get 10Mbps SLA from this node."

### 1.11 ISP Bottleneck indicator
**Node Tester:** Shows ⚡ icon when `r.ispBottleneck` is true (index.html:1043)
**C# missing:** Not implemented. Not documented.
**Doc must say:** "ISP Bottleneck: if baseline speed is close to node speed, the user's own internet is the bottleneck, not the node."

---

## CATEGORY 2: Stats Grid Updates (12 behaviors)

### 2.1 Stats recalculate on every result
**Node Tester:** `applyState()` called on every SSE message (index.html:779). Recalculates all 6 stat cards.
**C# had to:** Call `RenderTestStats()` after each result manually. If not called, stats show stale data.
**Doc must say:** "After EVERY result, recalculate ALL stat values. Do not defer to end of scan."

### 2.2 Tested: shows done/total with remaining
**Node Tester:** `{processed} of {total} total | {remaining} remaining` (index.html:893-894)
**C# had to:** `$"{_testDone}/{_testTotal}"` during scan, `$"{tested}"` after.
**Doc must say:** "Tested stat: during scan show {done}/{total}, after scan show just {total tested}. Sub-text: 'of {online} total | {remaining} remaining'."

### 2.3 Total Failed with failure rate %
**Node Tester:** `fail` count + `failPct%` failure rate (index.html:902-904)
**C# matches.**

### 2.4 Pass 10 Mbps with connected %
**Node Tester:** `p10` count + `passRate% of connected` (index.html:907-909). Note: "of connected" means out of nodes that successfully connected, not all tested.
**C# matches.**

### 2.5 Dead Plan Nodes
**Node Tester:** `resultsArr.filter(r => r.inPlan && r.actualMbps == null).length` (index.html:938)
**C# had to:** Track `InPlan` field on NodeTestResult.
**Doc must say:** "Dead Plan Nodes = nodes that are in a subscription plan but failed to connect or had 0 speed. Requires `inPlan` boolean on each result."

### 2.6 Not Online count
**Node Tester:** `resultsArr.filter(r => r.actualMbps == null && (r.peers === 0 || r.peers == null)).length` (index.html:916)
**C# had different calculation:** Used `totalChain - totalOnline` from node list.
**Doc must say:** "Not Online = tested nodes with null speed AND (peers === 0 OR peers === null). These are nodes that claim to be active on chain but are actually dead."

### 2.7 Pass Rate = connection success rate
**Node Tester:** `done / processed * 100` (index.html:912). Note: `done` = successful connections, `processed` = done + fail.
**C# had to:** Calculate separately.
**Doc must say:** "Pass Rate = successful connections / total tested. This is CONNECTION success rate, not speed-pass rate."

### 2.8 Retest Failed button count badge
**Node Tester:** `retestBtn.textContent = 'Retest Failed (' + fail + ')'` (index.html:922)
**C# matches:** `$"Retest Failed ({failCount})"`

### 2.9 Estimated cost in header
**Node Tester:** `state.estimatedTotalCost` displayed in header (index.html:872)
**C# missing:** Not tracking token spend during scan.
**Doc must say:** "Track balance before scan starts. After each node test, estimate running cost. Display: 'Spent: X.X P2P (balance: Y → Z)'"

### 2.10 Baseline speed in header
**Node Tester:** `state.baselineMbps` displayed in header (index.html:875-883). Colored red if <30 Mbps.
**C# missing:** No baseline measurement.
**Doc must say:** "Measure direct internet speed (no tunnel) before scanning. Display in header. Color red if <30 Mbps (your internet is slow, results will be limited by it)."

### 2.11 Speed history pills (baseline)
**Node Tester:** `renderHistory()` — last N baseline readings as colored pills. Green ≥30, amber ≥10, red <10 (index.html:991-999)
**C# missing.** Not implemented.

### 2.12 Speed history pills (node speeds)
**Node Tester:** Last N node speeds as colored pills. Green ≥15, amber ≥5, red <5 (index.html:1001-1008)
**C# missing.** Not implemented.

---

## CATEGORY 3: Progress Bar Updates (8 behaviors)

### 3.1 Progress percentage updates live
**Node Tester:** `fill.style.width = pct + '%'` on every state update (index.html:961-962)
**C# had to:** Call `RenderTestProgress()` after each result.
**Doc must say:** "Update progress bar after EVERY result. Formula: pct = (done + failed) / totalNodes * 100."

### 3.2 ETA updates every second
**Node Tester:** `setInterval(updateETA, 1000)` — independent 1-second timer (index.html:747)
**C# had to:** Calculate in `EstimateEta()` called during progress render.
**Doc must say:** "ETA should update every 1 second on its own timer, not just when a new result arrives. Formula: remaining = (totalNodes - processed) * (elapsed / processed)."

### 3.3 Progress bar changes color on done/paused
**Node Tester:** Class `done` (green), `paused` (amber), default (accent) (index.html:963)
**C# partially:** Uses accent color only.
**Doc must say:** "Progress bar: running = accent, paused = amber, done = green."

### 3.4 Current action text
**Node Tester:** `'[WG] sentnode1abc...'` or `'[V2] sentnode1xyz...'` with protocol type (index.html:984)
**C# had to:** `_testStatusTb.Text = $"Testing {node.Moniker}..."`
**Doc must say:** "Show current node being tested with protocol type prefix: [WG] or [V2]."

### 3.5 Retest mode shows different progress
**Node Tester:** `RETESTING #3/17` with retest-specific counts (index.html:949-959)
**C# partially:** Shows progress but doesn't distinguish retest from new scan.
**Doc must say:** "When retesting failed nodes, show 'RETESTING #{n}/{total}' instead of normal progress."

### 3.6 Remaining count
**Node Tester:** `{processed} / {total} Nodes — {remaining} remaining` (index.html:971)
**C# matches.**

### 3.7 Retry count display
**Node Tester:** `(${retryCount} retries)` appended to progress (index.html:956, 971)
**C# missing.** Not tracking retries.

### 3.8 Pause state with reason
**Node Tester:** `PAUSED — VPN interference detected` (index.html:964, 982)
**C# missing.** No VPN interference detection.

---

## CATEGORY 4: Log Panel Behaviors (6 behaviors)

### 4.1 Log auto-scrolls
**Node Tester:** `body.scrollTop = body.scrollHeight` after each append (index.html:1122)
**C# had to:** `TestLogScroll.ScrollToEnd()` manually.

### 4.2 Log color coding
**Node Tester:** warn/pause → amber, error/fail → red, success/✓ → green, default → white (index.html:1115-1117)
**C# had to:** Check `err` parameter and `msg.Contains("[TEST]")`.

### 4.3 Log max entries
**Node Tester:** 500 lines max (index.html:1123)
**C# uses:** 100 lines in test panel, 20 in main log.
**Doc must say:** "Keep at most 500 log entries. Remove oldest when limit reached."

### 4.4 Log timestamps
**Node Tester:** `new Date().toLocaleTimeString('en-US', { hour12: false })` (index.html:1119)
**C# matches:** `DateTime.Now.ToString("HH:mm:ss")`

### 4.5 Log restored on reconnect
**Node Tester:** SSE `init` message includes `msg.logs` buffer, replayed on connect (index.html:759-761)
**C# equivalent:** Load app.log from disk on startup. Not automatic.
**Doc must say:** "On app restart, restore the last 100 log lines from the log file."

### 4.6 Log HTML escaping
**Node Tester:** `.replace(/&/g,'&amp;').replace(/</g,'&lt;')` (index.html:1120)
**C# doesn't need:** WPF TextBlock auto-escapes.
**Doc must say:** "Web integrations: always HTML-escape log messages. Native: not needed."

---

## CATEGORY 5: Test Run Management (6 behaviors)

### 5.1 Test run numbering
**Node Tester:** `state.activeRunNumber` increments per scan, shown in dropdown as `Test #N — LIVE` (index.html:925-935)
**C# missing entirely.** No run numbering. No dropdown. No way to see "this is test #3."
**Doc must say:** "Every scan gets an incrementing run number. Display: 'Test #N — LIVE' during scan, 'Test #N — MM/DD HH:MM' after completion."

### 5.2 Previous run loading
**Node Tester:** Run select dropdown with `loadRun(runNumber)` to load past results.
**C# missing entirely.** Previous results load from single DiskCache but no run history.
**Doc must say:** "Auto-save each completed scan to runs/{N}/. Dropdown lists all runs. Click to load that run's results into the table."

### 5.3 Run comparison
**Node Tester:** Has run history in dropdown. No explicit comparison view, but runs can be viewed separately.
**C# missing.**
**Doc must say:** "Users expect to compare Run #5 vs Run #4. Show: +X new passes, -Y new fails, average speed delta."

### 5.4 Results persist across restarts
**Node Tester:** `results.json` loaded by server, sent via SSE `init` message. Table populated on page load (index.html:757).
**C# had to:** Add `DiskCache.Load<List<NodeTestResult>>("test-results")` in `EnterApp()`. Was initially missing — app showed "No results yet" even with 135 results on disk.
**Doc must say:** "On app startup, load cached results from disk BEFORE rendering the test tab. If results exist, show them immediately. NEVER show 'No results yet' when results exist on disk."

### 5.5 Results saved incrementally
**Node Tester:** Server writes to `results.json` after each node test.
**C# had to:** `DiskCache.Save("test-results", _testResults)` every 5 nodes + on completion.
**Doc must say:** "Save results to disk every N nodes (we use 5) AND on scan completion AND on stop. Users will kill-process your app — don't lose 50 results because you only save at the end."

### 5.6 Failure log (JSONL)
**Node Tester:** `appendFileSync(FAILURE_LOG, JSON.stringify(entry) + '\n')` (node-test.js:33-35)
**C# matches:** Appends to `test-failures.jsonl` with matching fields.
**Doc must say:** "Log every failure to a JSONL file. One JSON object per line. Fields: ts, node, moniker, peers, type, error, country, city, connectSeconds, speedMbps."

---

## CATEGORY 6: Button States & Controls (8 behaviors)

### 6.1 Button enable/disable during scan
**Node Tester:** Start/Resume/Retest disabled during scan, Stop enabled. Reversed when idle. (index.html:823-838)
**C# had to:** Completely swap button set (show Stop when running, show Start/Resume/Retest/Export/Reset when idle).
**Doc must say:** "During scan: only Stop visible. Idle: New Test, Resume, Retest Failed (N), Export, Reset, and filter buttons."

### 6.2 Status dot animation
**Node Tester:** CSS `pulse-dot.running` with green glow animation (index.html:56-78)
**C# missing.** No status indicator in header.
**Doc must say:** "Header status indicator: gray dot (idle), green pulsing dot (running), amber pulsing dot (paused)."

### 6.3 Economy toggle
**Node Tester:** `toggleEconomy()` — reduces speed test to 1 chunk, shorter timeouts.
**C# missing.**

### 6.4 DNS toggle
**Node Tester:** HNS/Google/Cloudflare selection.
**C# has in Settings:** AppSettings.DnsPreset, but not exposed on test dashboard.

### 6.5 Plan Select dropdown
**Node Tester:** Dropdown of active plans, "Test Plan" button tests only plan nodes.
**C# missing.** Plan tab exists but no plan-specific testing.

### 6.6 Rescan button
**Node Tester:** `rescanNodes()` — refetch node list from chain.
**C# missing.** Must restart app to refresh node list.

### 6.7 Help popup
**Node Tester:** `showInfoPopup()` with test methodology explanation.
**C# missing.** Low priority.

### 6.8 SDK toggle (JS/C#)
**Node Tester:** Toggle between JS and C# SDK for testing.
**C# N/A:** Single SDK (C# only). Correctly removed.

---

## CATEGORY 7: Data Model Mismatches (5 behaviors)

### 7.1 Field name differences
**Node Tester uses:** `actualMbps`, `baselineAtTest`, `type`, `inPlan`, `diag`, `address`
**C# uses:** `SpeedMbps`, none, `Protocol`, `InPlan`, none, `Address`
**Doc must say:** "Provide a field mapping table: JS name → C# name → meaning. Example: actualMbps = SpeedMbps = measured throughput in Mbps."

### 7.2 results.json format
**Node Tester:** Raw JSON array `[{...}, {...}]`
**C# DiskCache:** Wraps in `{"Data":[...], "SavedAt":"..."}` — incompatible.
**Doc must say:** "results.json must be a raw JSON array. If your cache wrapper adds metadata, strip it on export. Provide both raw export and cached formats."

### 7.3 Diagnostic object
**Node Tester:** `r.diag` contains V2Ray transport details, attempt log, port scans.
**C# missing.** SDK doesn't expose this.
**Doc must say:** "The diag object is critical for debugging failures. Fields: v2rayProto, v2rayTransport, v2raySecurity, v2rayPort, attempts[], portScan[]. If your SDK doesn't provide diag, log transport attempts separately."

### 7.4 Baseline at test time
**Node Tester:** `r.baselineAtTest` — the user's baseline speed when this node was tested.
**C# missing.** No baseline measurement.
**Doc must say:** "Before each scan, measure direct internet speed. Store as baselineAtTest on each result so you can detect ISP bottlenecks."

### 7.5 SDK label per result
**Node Tester:** `r.sdk` = 'js' or 'csharp' per result.
**C# N/A:** Always 'csharp'.

---

## CATEGORY 8: Speed Test Details (7 behaviors)

### 8.1 Connectivity pre-check for V2Ray
**Node Tester:** Tests 6 connectivity targets through SOCKS5 before speed test.
**C# matches:** Same 6 targets, any 200 = OK.
**Doc must say:** "Before speed testing through V2Ray SOCKS5, verify connectivity by fetching ANY of these 6 URLs: google.com, cloudflare.com, 1.1.1.1/cdn-cgi/trace, httpbin.org/ip, ifconfig.me, ip-api.com/json. If none return 200, the SOCKS5 tunnel is broken."

### 8.2 Fresh HttpClient per V2Ray request
**Node Tester:** Uses `axios` with `httpAgent: new SocksProxyAgent(...)` per request.
**C# had to discover:** HttpClient connection reuse SILENTLY FAILS through SOCKS5. Must create fresh `HttpClient(new HttpClientHandler { Proxy = new WebProxy("socks5://127.0.0.1:{port}") })` per request.
**Doc must say:** "CRITICAL C# GOTCHA: Never reuse HttpClient for V2Ray SOCKS5 requests. Create a fresh HttpClient per request. Connection pooling silently returns stale/empty responses."

### 8.3 Seven fallback speed methods
**Node Tester:** probe → multi-request → OVH → Tele2 → rescue → google-fallback → connected-no-throughput
**C# matches:** Same chain.
**Doc must say:** Document ALL 7 methods with exact URLs and decision logic.

### 8.4 Probe cutoff at 3 Mbps
**Node Tester:** If 1MB probe measures ≥3 Mbps, proceed to multi-request. If <3 Mbps, use probe result as final.
**C# matches.**

### 8.5 Multi-request: 5 × 1MB
**Node Tester:** 5 parallel downloads of 1MB each, average.
**C# matches.**

### 8.6 Rescue mode: 60-second download
**Node Tester:** If all speed targets fail but tunnel is connected, do a 60-second streaming download to measure any throughput.
**C# matches.**

### 8.7 Google fallback: estimate from latency
**Node Tester:** If all speed methods fail, time a Google HEAD request. Estimate speed from latency.
**C# matches.**

---

## THE COMPLETE LIST: What the Node Tester Must Do

1. **Write BUILD-ON-ME.md for BOTH JS and C#** — currently JS-only
2. **Include the complete function execution map** (Phase 0-5 with every sub-step)
3. **Document every SSE event type** and what the integrator must replicate manually
4. **Provide field mapping table** (JS → C# → meaning)
5. **Export country map as a module** (currently only in index.html)
6. **Document WPF flag workaround** (flagcdn.com PNG cache)
7. **Document V2Ray SOCKS5 fresh-HttpClient requirement**
8. **Document all 7 speed test fallback methods** with URLs and decision logic
9. **Add test run numbering and history** — save runs, load runs, compare runs
10. **Document CancellationToken architecture** for C# (what to cancel, what NOT to cancel)
11. **Document dedicated test VPN instance pattern** (never share with main app)
12. **Document WireGuard cleanup pattern** (before AND after each test)
13. **Document progress counter rule** (EVERY code path must increment, including errors)
14. **Document baseline measurement** (direct speed before tunnel testing)
15. **Include working NodeTestResult C# class** with ALL 20 fields
16. **Include working DiskCache C# class** (the one from Handshake dVPN works)
17. **Include working speed test C# method** (RunSpeedTestAsync from Handshake dVPN)
18. **Include working Google check C# method** (CheckGoogleAsync from Handshake dVPN)

**Every one of these was discovered the hard way over 12+ hours. The documentation must prevent the next integrator from repeating this.**

---

## The Standard

If a developer reads BUILD-ON-ME.md and can't build a working test dashboard in 2 hours, the documentation has failed. Currently it takes 12+ hours because 60% of behaviors are undocumented. This file documents all of them. Now put them in BUILD-ON-ME.md.
