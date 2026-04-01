# Strict Frontend Review: Complete Function Map of index.html

**Date:** 2026-03-25
**Source:** Line-by-line reading of `index.html` (1511 lines), `server.js` (761 lines), and all 12 docs
**Purpose:** Definitive reference for anyone building a C# (or any) integration of the Node Tester dashboard

---

## 1. Complete JavaScript Function Map

Every function in index.html, in source order.

### `_countryToCode(name)` -- line 712
```
Purpose:    Convert country name string to ISO 2-letter code
Called by:   appendRowHtml() for each result row
Data needed: _CC lookup table (80+ country mappings, lines 688-711)
DOM elements: None (pure function)
For integrators: Replicate the full _CC map. Handle variants:
  "The Netherlands" -> NL, "Turkiye"/"Turk...ye" -> TR, "Czechia" -> CZ,
  "Russian Federation" -> RU, "Viet Nam" -> VN, "Republic of Korea" -> KR.
  Includes fuzzy case-insensitive fallback if exact match fails.
```

### `copyToClipboard(fullText, el)` -- line 727
```
Purpose:    Copy text to clipboard, show "Copied!" tooltip on element
Called by:   onclick on wallet address, onclick on node address in table
Data needed: fullText string, DOM element reference
DOM elements: Adds/removes 'copied' CSS class on el
For integrators: Use platform clipboard API. Show visual feedback for 1200ms.
```

### `upsertLocal(result)` -- line 735
```
Purpose:    Dedup helper -- replace existing entry for same address, or append
Called by:   SSE 'result' handler
Data needed: result.address, resultsArr array
DOM elements: None (modifies in-memory array only)
For integrators: Must maintain results collection with upsert-by-address semantics.
  Re-testing a node replaces old result, never duplicates.
```

### `DOMContentLoaded handler` (anonymous) -- line 741
```
Purpose:    Page load initialization
Called by:   Browser DOMContentLoaded event
Data needed: None
Actions:
  1. fetch('/api/stats') -> apply state (fast, no results payload)
  2. connectSSE() -> establish Server-Sent Events stream
  3. setInterval(updateETA, 1000) -> tick ETA every second
For integrators: On app startup, call GET /api/stats for initial state,
  then establish SSE connection (or poll /api/state periodically).
  Start 1-second ETA timer.
```

### `connectSSE()` -- line 750
```
Purpose:    Establish SSE connection to /api/events, handle all event types
Called by:   DOMContentLoaded, auto-reconnect on error (3s delay)
Data needed: None initially; processes incoming messages
DOM elements: Updates everything via applyState(), renderTable(), appendLog()
SSE message routing:
  'init' or 'state' -> merge state, optionally render results, restore logs
  'progress'        -> merge state, applyState()
  'result'          -> merge state, upsert result, add table row, applyState()
  'log'             -> appendLog(msg)
Error handling: Auto-reconnect after 3000ms. Uses _reconnecting flag to prevent storm.
For integrators: NO SSE in native apps. Instead:
  - Poll GET /api/state every 1-2 seconds for state changes
  - Poll GET /api/results for new results
  - Use callback/event system for real-time updates if running audit in-process
```

### `updateETA()` -- line 791
```
Purpose:    Calculate and display estimated time remaining
Called by:   setInterval every 1000ms
Data needed: state.status, state.startedAt, state.retestMode,
  state.retestTested, state.retestTotal, state.testedNodes,
  state.failedNodes, state.totalNodes
DOM elements: #etaTime text content
Algorithm:
  done = retestMode ? retestTested : (testedNodes + failedNodes)
  total = retestMode ? retestTotal : totalNodes
  remaining = total - done
  elapsed = Date.now() - Date.parse(startedAt)
  estimatedMs = remaining * (elapsed / done)
  Format as HH:MM:SS
  If done=0 or remaining<=0: "Calculating..."
  If status=done: "00:00:00"
  If status != running: no update
For integrators: Replicate this exact algorithm. ETA = (remaining * elapsed / done).
```

### `applyState()` -- line 813
```
Purpose:    THE MAIN UI UPDATE FUNCTION. Applies ALL state to ALL UI elements.
Called by:   Every SSE event (init, state, progress, result), button handlers
Data needed: Entire state object + resultsArr for derived calculations
DOM elements updated (exhaustive list):
  #headerDot        -> class: pulse-dot / pulse-dot running / pulse-dot paused
  #btnStart         -> disabled, textContent, loading class
  #btnResume        -> disabled, textContent, loading class
  #btnRetestFails   -> disabled, textContent (includes fail count)
  #btnStop          -> disabled, textContent, loading class
  #btnEconomy       -> via updateEconomyBtn()
  #sdkJs, #sdkCs    -> background/color styles for active SDK
  #walletAddr       -> truncated address, copyable, title, onclick
  #walletBal        -> cleaned balance string
  #estCost          -> estimatedTotalCost
  #headerBaseline   -> baselineMbps with color (red if < 30)
  #statTested       -> testedNodes + failedNodes (processed count)
  #statTestedSub    -> "of X total | Y remaining" or "complete"
  #statTotalFailed  -> failedNodes count
  #statTotalFailedPct -> "X% failure rate"
  #statPassed       -> passed10 count
  #statPassedPct    -> "X% of connected"
  #statPassRate     -> connection success percentage
  #statNotOnline    -> count of results with actualMbps=null AND (peers=0 or peers=null)
  #statNotOnlineSub -> "X nodes offline"
  #runSelect        -> prepends LIVE test option if activeRunNumber set
  #statDeadPlan     -> count of results where inPlan=true AND actualMbps=null
  #statDeadPlanPct  -> "X/Y plan nodes failed"
  #progressFill     -> width %, class (done/paused)
  #progressPctLabel -> percentage or "RETESTING #X/Y" or "PAUSED -- reason" or "Ready"
  #progressCount    -> "X / Y Nodes -- Z remaining (N retries)" or retest variant
  #currentAction    -> current node being tested, or completion message, or pause reason
  Also calls: renderHistory()

Button state logic:
  running or paused -> btnStart disabled, btnResume disabled, btnRetest disabled, btnStop enabled
  idle or done -> btnStart enabled, btnResume enabled, btnRetest enabled, btnStop disabled

For integrators: This is the MOST COMPLEX function. Every stat card, progress bar,
  button state, and header value is computed here. You must replicate ALL of this
  logic. The "processed" count = testedNodes + failedNodes (NOT just testedNodes).
```

### `renderHistory()` -- line 991
```
Purpose:    Render baseline and node speed history pill rows
Called by:   applyState() at the end of every state update
Data needed: state.baselineHistory (array of {mbps, ts}),
  state.nodeSpeedHistory (array of {mbps, addr, ts})
DOM elements:
  #baselineHistoryPills -> pills with color classes
  #nodeSpeedHistoryPills -> pills with color classes
Color thresholds:
  BASELINE: >= 30 Mbps = h-pill-good (green), >= 10 = h-pill-mid (gray), < 10 = h-pill-bad (red)
  NODE SPEEDS: >= 15 Mbps = h-pill-good (green), >= 5 = h-pill-mid (gray), < 5 = h-pill-bad (red)
Empty state: "<span class='h-pill h-pill-empty'>No readings yet</span>"
For integrators: CRITICAL DIFFERENCE from docs. BUILD-ON-ME.md says baseline
  thresholds are 30/15, COMPLETE-INTEGRATION-SPEC says 15/5 for node speeds.
  The ACTUAL CODE uses:
    Baseline: 30 / 10 (NOT 30/15 as some docs say)
    Node speeds: 15 / 5 (correct in docs)
```

### `renderTable()` -- line 1011
```
Purpose:    Full re-render of results table (clears and rebuilds)
Called by:   SSE 'init' with results, startAudit(), clearResults()
Data needed: resultsArr array
DOM elements: #resultsBody (tbody), #resultsCountLabel
Behavior: Shows last maxRows (200) results, reversed (newest first).
For integrators: Full table rebuild. Cap at 200 visible rows.
```

### `addSingleRow(r)` -- line 1018
```
Purpose:    Add or update a single row in the results table (incremental)
Called by:   SSE 'result' event handler
Data needed: result object, resultsArr for count
DOM elements: #resultsBody, #resultsCountLabel
Behavior:
  1. Find existing row by data-addr attribute, remove it
  2. Prepend new row (newest at top)
  3. If > maxRows, remove last child
For integrators: Upsert by node address. Remove old row, insert new at top.
  This avoids full re-render on every result.
```

### `appendRowHtml(r, tbody, prepend = false)` -- line 1029
```
Purpose:    Build and insert a single table row from a result object
Called by:   renderTable(), addSingleRow()
Data needed: result object with ALL fields (see below)
DOM elements: Creates <tr> with 10 <td> columns

Result fields used:
  r.address        -> truncated, copyable, data-addr attribute
  r.type           -> "WireGuard" or "V2Ray" detection (case-insensitive "wire")
  r.inPlan         -> PLAN badge
  r.moniker        -> NOT USED in current code (addr is shown instead)
  r.countryCode    -> flag emoji via String.fromCodePoint
  r.country        -> fallback to _countryToCode()
  r.city           -> city column
  r.peers          -> center-aligned, with optional maxPeers
  r.maxPeers       -> shown as "peers/max" if present
  r.actualMbps     -> right-aligned, 2 decimal places + " Mbps"
  r.ispBottleneck  -> lightning bolt icon if true
  r.baselineAtTest -> right-aligned, 2 decimal places + " Mbps"
  r.sdk            -> "js" or "csharp" badge
  r.os             -> Windows/macOS/Linux icon
  r.diag.v2rayProto     -> protocol name
  r.diag.v2rayTransport -> transport name
  r.diag.v2raySecurity  -> "tls" shows green TLS badge
  r.diag.v2rayPort      -> port number

Computed columns:
  totalBw = actualMbps * max(peers, 1)
  maxUsers = floor(totalBw / 10) -- COMPUTED BUT NOT DISPLAYED IN HTML
  SDK badge: JS = green (#00c853), C# = blue (#448aff)
  Result badge: >= 10 Mbps = FAST (badge-pass), < 10 = SLOW (badge-slow), null = FAIL (badge-fail)
  Transport: WireGuard = blue text (#4fc3f7), V2Ray = purple text (#ce93d8)

TABLE COLUMNS (10 total):
  1. SDK + Protocol (badge + WG/V2 + optional PLAN badge)
  2. Transport detail (WireGuard / proto/transport + optional TLS + port)
  3. Node address (monospace, truncated, copyable)
  4. Country (flag emoji + code)
  5. City
  6. Peers (center-aligned)
  7. Speed (right-aligned, white, bold)
  8. Total BW (right-aligned, blue #4fc3f7)
  9. Baseline (right-aligned, gray)
  10. Result badge (center-aligned)

For integrators: This is the most detail-dense function. Every column format,
  every color, every badge, every computed value is defined here.
```

### `appendLog(msg)` -- line 1111
```
Purpose:    Add a log entry to the live log panel
Called by:   SSE 'log' event, SSE 'init' log restore, inline calls from button handlers
Data needed: msg string
DOM elements: #logBody
Behavior:
  1. Classify message by regex:
     /warn|pause|insufficient/i -> log-warn (yellow border #888, text #bbb)
     /complete|success/i + emoji check -> log-ok (green border, text #66cc99)
     /error|fail|ERR/i -> log-err (red border, text #ff6680)
     default -> normal (dim border #444, text #999)
  2. Prepend timestamp (HH:MM:SS, 24h format)
  3. HTML-escape the message (&, <, >)
  4. Append to log body, auto-scroll to bottom
  5. Cap at 500 entries, remove oldest
Animation: slideIn (0.2s ease, translateX 6px -> 0)
For integrators: Regex-based log classification. 4 log levels.
  500-line cap. Auto-scroll. HTML escaping mandatory.
```

### `toggleEconomy()` -- line 1126
```
Purpose:    Toggle economy mode via API
Called by:   onclick on #btnEconomy
Data needed: None (server manages toggle)
API call:    POST /api/economy
DOM elements: Updates via updateEconomyBtn()
```

### `updateEconomyBtn(on)` -- line 1134
```
Purpose:    Update economy button visual state
Called by:   toggleEconomy(), applyState(), startup fetch
Data needed: boolean on/off
DOM elements: #btnEconomy
Visual states:
  ON:  green border, green text, green bg (rgba), text "recycling symbol Economy ON"
  OFF: transparent bg, gray border, gray text, text "recycling symbol Economy"
```

### `loadRunsList()` -- line 1155
```
Purpose:    Populate the test run dropdown
Called by:   Page load (line 1200), after startAudit(), after saveRun()
API call:    GET /api/runs
DOM elements: #runSelect
Behavior: Sorts runs by number descending. Format: "Test #N -- X/Y passed (date)"
  Marks active run as selected.
```

### `loadRun(num)` -- line 1175
```
Purpose:    Load a previous test run's results into the dashboard
Called by:   onchange on #runSelect
API call:    POST /api/runs/load/:num
DOM elements: Triggers full page reload (location.reload())
For integrators: Loading a run replaces current results server-side and reloads.
```

### `saveRun()` -- line 1183
```
Purpose:    Save current results as a named test run
Called by:   onclick on SAVE button in header
API call:    POST /api/runs/save { label }
Behavior:
  1. prompt() for label (default: "Audit YYYY-MM-DD")
  2. POST to server
  3. alert() on success with run number
  4. Refresh runs list
```

### `setSDK(sdk)` -- line 1204
```
Purpose:    Switch active SDK between JS and C#
Called by:   onclick on #sdkJs or #sdkCs elements
API call:    POST /api/sdk { sdk: 'js' | 'csharp' }
DOM elements: #sdkJs, #sdkCs
Visual states:
  JS active:  sdkJs = green bg rgba(0,200,83,0.15), color #00c853
              sdkCs = transparent bg, color #555
  C# active:  sdkCs = blue bg rgba(68,138,255,0.15), color #448aff
              sdkJs = transparent bg, color #555
For integrators: In embedded mode, SDK toggle is REMOVED. App uses its own SDK.
```

### `setDNS(preset)` -- line 1222
```
Purpose:    Change DNS preset
Called by:   onchange on #dnsSelect
API call:    POST /api/dns { preset }
DOM elements: Appends log message on success
Presets:     default (OpenDNS), hns (Handshake), cloudflare, google
```

### `DNS startup loader` (anonymous) -- line 1231
```
Purpose:    Sync DNS dropdown with server's current DNS on page load
Called by:   Immediately on script load (not in DOMContentLoaded)
API call:    GET /api/dns
DOM elements: #dnsSelect
Behavior: Matches first server IP against preset prefixes:
  '208.67' -> default, '103.196' -> hns, '1.1.1' -> cloudflare, '8.8' -> google
```

### `startAudit()` -- line 1242
```
Purpose:    Start a NEW test (saves previous, clears, starts fresh)
Called by:   onclick on #btnStart
API call:    POST /api/start
Behavior:
  1. confirm() dialog: "Start a NEW test? Current results will be saved..."
  2. Clear ALL local state: resultsArr, testedNodes, failedNodes, retryCount,
     totalNodes, passed15, passed10, passedBaseline, nodeSpeedHistory,
     baselineHistory, estimatedTotalCost, startedAt, completedAt,
     errorMessage, pauseReason
  3. renderTable() (empty), applyState(), clear log panel
  4. Set btnStart to loading, enable btnStop
  5. POST /api/start
  6. Refresh runs list
  Error: Restore button to normal state
For integrators: Must clear ALL state before starting. Confirmation dialog required.
```

### `resumeAudit()` -- line 1279
```
Purpose:    Resume interrupted scan from last tested node
Called by:   onclick on #btnResume
API call:    POST /api/resume
Behavior:
  1. Set btnResume to loading, enable btnStop
  2. POST /api/resume
  3. On error response: show in log, restore button
For integrators: Does NOT clear results. Skips already-tested nodes.
```

### `retestFails()` -- line 1301
```
Purpose:    Retest all failed nodes
Called by:   onclick on #btnRetestFails
API call:    POST /api/retest-fails { addresses: [...] }
Behavior:
  1. Set btnRetestFails to loading, disable btnStart, enable btnStop
  2. Filter resultsArr for actualMbps == null -> get addresses
  3. If no failures: log "No failures to retest", re-enable button
  4. POST with specific addresses
  Error: Restore buttons
For integrators: Client-side filters failures and sends specific addresses to server.
  NOT the same as POST /api/auto-retest (which does server-side filtering).
```

### `rescanNodes()` -- line 1332
```
Purpose:    Re-fetch node list from chain without starting test
Called by:   onclick on #btnRescan
API call:    POST /api/rescan
Behavior:
  1. Set button text to "Scanning...", disable
  2. POST /api/rescan
  3. On success: log "Rescan: X nodes on chain, Y tested, Z remaining"
  4. On error: log error
  5. Always restore button to "Rescan Nodes", enable
For integrators: Updates totalNodes in state. Use to verify remaining count.
```

### `showInfoPopup()` -- line 1352
```
Purpose:    Show/hide the dashboard guide overlay popup
Called by:   onclick on ? help button
DOM elements: Creates/removes #infoOverlay (full-screen overlay + popup)
Behavior:
  Toggle: if overlay exists, remove it; otherwise create
  Close: click outside, click X, press Escape
  Content: Description of every button and stat card
For integrators: Optional. Help text for users.
```

### `stopAudit()` -- line 1442
```
Purpose:    Stop current audit
Called by:   onclick on #btnStop
API call:    POST /api/stop
Behavior: Set btnStop to loading/"Stopping..."
For integrators: Server sets stopRequested flag. Audit stops within 500ms.
```

### `clearResults()` -- line 1451
```
Purpose:    Clear all results from dashboard
Called by:   onclick on Reset button
API call:    POST /api/clear
Behavior:
  1. confirm() dialog: "Clear all results?"
  2. POST /api/clear
  3. Clear local state (same fields as startAudit)
  4. renderTable(), applyState(), clear log
For integrators: Clears server-side AND client-side. Does NOT delete saved runs.
```

### `loadPlans()` -- line 1471
```
Purpose:    Populate plan dropdown with available plans
Called by:   Page load (line 1507)
API call:    GET /api/plans
DOM elements: #planSelect
Format: "Plan {id} -- {nodes} nodes, {subs} subs ({price})"
Error: Shows "Failed to load plans" in dropdown
```

### `testPlan()` -- line 1487
```
Purpose:    Test only nodes in selected plan
Called by:   onclick on #btnPlanTest
API call:    POST /api/test-plan { planId }
Behavior:
  1. Get planId from #planSelect value
  2. If empty: log "Select a plan first", return
  3. Disable btnPlanTest, enable btnStop
  4. POST with planId
  5. On error response: log error
  6. Restore button
```

### Startup code (not in named functions) -- lines 1149-1200, 1231-1240, 1507
```
1. fetch('/api/state') -> sync economy mode (line 1150)
2. loadRunsList() (line 1200)
3. fetch('/api/dns') -> sync DNS dropdown (line 1231)
4. loadPlans() (line 1507)
```

---

## 2. Complete SSE Event Map

### Connection: `GET /api/events`

Server sends initial payload immediately:
```json
{
  "type": "init",
  "state": { ...full state object... },
  "results": [ ...all current results... ],
  "logs": [ ...last 100 log messages... ]
}
```

### Event: `init`
```
Fields: state (object), results (array), logs (array of strings)
Frontend action:
  1. Merge state into local state
  2. Replace resultsArr, renderTable()
  3. Replay all log messages via appendLog()
  4. Check if done/idle -> reset retest button with fail count
  5. applyState()
Integrator equivalent:
  On startup, call GET /api/state for state+results.
  Restore log from most recent results/.log file or ignore.
```

### Event: `state`
```
Fields: state (object), optionally results (array)
Frontend action:
  1. Merge state
  2. If results present: replace resultsArr, renderTable()
  3. Check done/idle -> reset retest button
  4. applyState()
Integrator equivalent:
  Poll GET /api/stats every 1-2s. Apply state diff.
```

### Event: `progress`
```
Fields: state (object)
Frontend action:
  1. Merge state
  2. applyState()
Sent when: A new node test starts (updates currentNode, currentType)
Integrator equivalent:
  Included in state polling. Watch for currentNode changes.
```

### Event: `result`
```
Fields: result (object), state (object)
Frontend action:
  1. Merge state
  2. upsertLocal(result) -> update resultsArr
  3. addSingleRow(result) -> update table DOM
  4. applyState()
Integrator equivalent:
  Compare results count on each poll. Fetch new results via GET /api/results.
  Or maintain WebSocket/callback if running in-process.
```

### Event: `log`
```
Fields: msg (string)
Frontend action:
  appendLog(msg) -> classify, timestamp, escape, append, scroll, cap at 500
Integrator equivalent:
  If polling, logs are NOT available via simple API (only buffered in SSE init).
  For native integration, implement logging callback in audit pipeline.
```

---

## 3. Complete CSS/Design Requirements

### CSS Variables (root)
| Variable | Value | Usage |
|----------|-------|-------|
| `--bg-base` | `#080808` | Body background |
| `--glass-bg` | `rgba(16, 16, 16, 0.85)` | Panel backgrounds |
| `--glass-border` | `rgba(255, 255, 255, 0.07)` | Panel borders |
| `--text-primary` | `#f0f0f0` | Main text |
| `--text-secondary` | `#666` | Labels, subtitles |
| `--text-dim` | `#444` | Timestamps, inactive |
| `--accent-green` | `#00c853` | Pass, running, active |
| `--accent-red` | `#ff1744` | Fail, stop, errors |
| `--white` | `#fff` | Headers, stat values |

### Fonts
| Family | Weight | Usage |
|--------|--------|-------|
| `Outfit` | 300, 400, 600, 700 | Headings, stat values, buttons, progress |
| `Inter` | 400, 500, 600 | Body text, labels |
| `SF Mono / Fira Code / Consolas` | 400, 600 | Log panel, node addresses, speed pills |

### Color Thresholds

**Result badges:**
| Condition | Badge | CSS class | Colors |
|-----------|-------|-----------|--------|
| actualMbps >= 10 | FAST | badge-pass | bg: rgba(0,200,83,0.12), text: #00c853, border: rgba(0,200,83,0.25) |
| actualMbps > 0 but < 10 | SLOW | badge-slow | bg: rgba(255,193,7,0.12), text: #ffc107, border: rgba(255,193,7,0.25) |
| actualMbps == null | FAIL | badge-fail | bg: rgba(255,23,68,0.08), text: #ff1744, border: rgba(255,23,68,0.2) |

**Baseline history pills (ACTUAL CODE, not docs):**
| Condition | Class | Colors |
|-----------|-------|--------|
| mbps >= 30 | h-pill-good | bg: rgba(0,200,83,0.1), text: #00c853, border: rgba(0,200,83,0.2) |
| mbps >= 10 | h-pill-mid | bg: rgba(255,255,255,0.05), text: #aaa, border: rgba(255,255,255,0.1) |
| mbps < 10 | h-pill-bad | bg: rgba(255,23,68,0.08), text: #ff1744, border: rgba(255,23,68,0.2) |

**Node speed history pills:**
| Condition | Class | Colors |
|-----------|-------|--------|
| mbps >= 15 | h-pill-good | (same as above) |
| mbps >= 5 | h-pill-mid | (same as above) |
| mbps < 5 | h-pill-bad | (same as above) |

**Header baseline color:**
| Condition | Color |
|-----------|-------|
| baselineMbps >= 30 | default (white) |
| baselineMbps < 30 | var(--accent-red) = #ff1744 |

**SDK badge colors:**
| SDK | Background | Text |
|-----|------------|------|
| JS | rgba(0,200,83,0.1) | #00c853 |
| C# | rgba(68,138,255,0.15) | #448aff |

**Transport text colors:**
| Type | Color |
|------|-------|
| WireGuard | #4fc3f7 (light blue) |
| V2Ray protocol | #ce93d8 (purple) |
| TLS badge | #66bb6a (green) |
| Port number | #666 (dim) |

**Total BW column:** #4fc3f7 (light blue, same as WireGuard)

**Button colors:**
| Button | Background | Text | Border |
|--------|------------|------|--------|
| New Test / Resume | var(--accent-green) = #00c853 | #000 | none |
| Resume override | var(--white) | #000 | none |
| Retest Failed | var(--accent-red) | #fff | none |
| Stop | transparent | #ff1744 | rgba(255,23,68,0.4) |
| Economy | transparent | #888 | rgba(255,255,255,0.15) |
| Economy ON | rgba(0,200,83,0.15) | #00c853 | var(--accent-green) |
| Rescan | transparent | #448aff | rgba(68,138,255,0.4) |
| Test Plan | gradient(135deg, #7c3aed, #a855f7) | #fff | none |
| Reset | transparent | #666 | rgba(255,255,255,0.07) |
| Help (?) | transparent | #666 | rgba(255,255,255,0.15) |

**Log entry border-left colors:**
| Type | Border | Text |
|------|--------|------|
| Default | #444 (--text-dim) | #999 |
| Warning | #888 | #bbb |
| Error | #ff1744 | #ff6680 |
| Success | #00c853 | #66cc99 |

### Animations
| Name | Duration | Effect |
|------|----------|--------|
| `pulse` | 2s infinite | Scale 0.95->1, green glow 0->8px->0 |
| `pulse-warn` | 2s infinite | Same but orange (#ffa726) |
| `slideIn` | 0.2s ease | Log entry: opacity 0->1, translateX 6->0 |
| Progress fill | 0.4s ease | Width transition |

### Layout Structure
```
<header> -- sticky, z-index 100, glass bg
  brand (logo + pulse dot + title + controls row)
  header-right (wallet + balance + baseline + spend)

<main> -- max-width 1920px, 24px padding, flex column, 16px gap
  controls bar -- glass panel, flex row, 12px gap
  stats grid -- 6 columns (grid-template-columns: repeat(6, 1fr)), 14px gap
  history panel -- flex row, 2 sections with vertical divider
  progress container -- glass panel, flex column
  data grid -- 2 columns: flex table (1fr) + log panel (380px fixed)
    table container -- panel header + scrollable table
    log container -- panel header + scrollable log (max-height 400px)
```

### Sizing
| Element | Value |
|---------|-------|
| Button height | 38px |
| Stat value font | 32px |
| Header title | 18px |
| Table cell padding | 6px |
| Table font | 12px |
| Log font | 11px |
| Badge font | 10px |
| Max table rows | 200 |
| Max log entries | 500 |
| Table border-spacing | 0 4px |
| Panel border-radius | 12px |
| Badge border-radius | 4px |
| Pill border-radius | 20px |
| Scrollbar width | 6px |

---

## 4. Complete State Object

### Server-side state (`createState()` in pipeline.js + additions in server.js)

| Field | Type | Default | Set by | Used by frontend |
|-------|------|---------|--------|-----------------|
| `status` | `'idle'\|'running'\|'paused'\|'done'\|'error'` | `'idle'` | pipeline | Button states, pulse dot, progress |
| `totalNodes` | `number` | `0` | pipeline/rescan | Stats, progress denominator |
| `testedNodes` | `number` | `0` | pipeline | Stats (passed count) |
| `failedNodes` | `number` | `0` | pipeline | Stats (failed count) |
| `retryCount` | `number` | `0` | pipeline | Progress meta text |
| `passed15` | `number` | `0` | pipeline | NOT displayed (computed but not shown) |
| `passed10` | `number` | `0` | pipeline | Stats card "Pass 10 Mbps" |
| `passedBaseline` | `number` | `0` | pipeline | NOT displayed |
| `baselineMbps` | `number\|null` | `null` | pipeline | Header "Avg Baseline" |
| `baselineHistory` | `Array<{mbps,ts}>` | `[]` | pipeline | History pills |
| `nodeSpeedHistory` | `Array<{mbps,addr,ts}>` | `[]` | pipeline | History pills |
| `currentNode` | `string\|null` | `null` | pipeline | Progress "current action" |
| `currentType` | `string\|null` | `null` | pipeline | Progress "current action" prefix |
| `currentLocation` | `string\|null` | `null` | pipeline | NOT displayed in frontend |
| `walletAddress` | `string\|null` | `null` | server startup | Header wallet display |
| `balance` | `string\|null` | `null` | server/pipeline | Header balance display |
| `balanceUdvpn` | `number` | `0` | server/pipeline | NOT displayed directly |
| `estimatedTotalCost` | `string\|null` | `null` | pipeline | Header "Session Spend" |
| `spentUdvpn` | `number` | `0` | pipeline | NOT displayed directly |
| `startedAt` | `string\|null` | `null` | pipeline | ETA calculation |
| `completedAt` | `string\|null` | `null` | pipeline | NOT displayed |
| `errorMessage` | `string\|null` | `null` | pipeline/server | NOT displayed in current frontend |
| `stopRequested` | `boolean` | `false` | stop handler | NOT displayed |
| `lowBalanceWarning` | `boolean` | `false` | pipeline | NOT displayed |
| `economyMode` | `boolean` | `false` | economy toggle | Economy button state |
| `pauseReason` | `string\|null` | `null` | pipeline | Progress bar text when paused |
| `activeSDK` | `'js'\|'csharp'` | from disk | sdk toggle | SDK toggle, result badges |
| `activeRunNumber` | `number` | from disk | start/resume | Run dropdown |
| `retestMode` | `boolean` | — | pipeline | Progress bar mode |
| `retestTotal` | `number` | — | pipeline | Progress denominator in retest |
| `retestTested` | `number` | — | pipeline | Progress numerator in retest |
| `retestPassed` | `number\|null` | — | pipeline | Completion message |
| `retestFailed` | `number\|null` | — | pipeline | Completion message |

### Client-side state (index.html)

| Field | Initial | Purpose |
|-------|---------|---------|
| `state` | (partial copy of server state) | Merged on every SSE event |
| `resultsArr` | `[]` | Full results array for table + derived stats |
| `eventSource` | `null` | SSE connection reference |
| `maxRows` | `200` | Table row cap |
| `activeSDK` | `'js'` | Local SDK state for toggle |
| `_CC` | (80+ entries) | Country name -> code map |

---

## 5. Complete API Endpoint Map (server.js)

| Method | Path | Purpose | Frontend function | Response |
|--------|------|---------|-------------------|----------|
| GET | `/` | Serve index.html | Browser navigation | HTML |
| GET | `/api/stats` | State only (fast) | DOMContentLoaded | `{ state }` |
| GET | `/api/state` | State + results | Economy startup check | `{ state, results }` |
| GET | `/api/results` | Paginated results | Not used by frontend | `{ total, page, results }` |
| GET | `/api/events` | SSE stream | connectSSE() | SSE events |
| POST | `/api/start` | New test | startAudit() | `{ ok, testNumber }` |
| POST | `/api/resume` | Resume test | resumeAudit() | `{ ok, testNumber, resumeFrom }` |
| POST | `/api/stop` | Stop audit | stopAudit() | `{ ok }` |
| POST | `/api/economy` | Toggle economy | toggleEconomy() | `{ ok, economyMode }` |
| POST | `/api/retest-skips` | Retest unreachable | Not used by frontend | `{ ok, retesting }` |
| POST | `/api/retest-fails` | Retest specific failures | retestFails() | `{ ok, retesting, addresses }` |
| POST | `/api/test-plan` | Test plan nodes | testPlan() | `{ ok, planId }` |
| GET | `/api/plans` | List plans | loadPlans() | `{ plans: [{id,subs,nodes,price}] }` |
| POST | `/api/clear` | Clear results | clearResults() | `{ ok }` |
| GET | `/api/failure-analysis` | Categorize failures | Not used by frontend | `{ total, passed, failed, ... }` |
| POST | `/api/rescan` | Re-fetch nodes | rescanNodes() | `{ total, tested, remaining }` |
| GET | `/api/transport-cache` | Cache stats | Not used by frontend | Cache stats object |
| POST | `/api/auto-retest` | Auto-retest all | Not used by frontend | `{ ok, retesting, addresses }` |
| GET | `/api/runs` | List runs | loadRunsList() | `{ runs, activeRun }` |
| POST | `/api/runs/save` | Save current run | saveRun() | `{ ok, number }` |
| GET | `/api/runs/:num` | Get run details | Not used by frontend | `{ number, total, passed, ... }` |
| POST | `/api/runs/load/:num` | Load run into current | loadRun() | `{ ok, number, total }` |
| POST | `/api/sdk` | Set SDK | setSDK() | `{ ok, sdk }` |
| GET | `/api/sdk` | Get SDK | Not used by frontend | `{ sdk }` |
| GET | `/api/dns` | Get DNS config | DNS startup loader | `{ servers, presets }` |
| POST | `/api/dns` | Set DNS | setDNS() | `{ ok, servers, preset }` |
| GET | `/dictator` | Dictator page | Link in header | HTML |
| GET | `/api/dictator` | Dictator data | Not used by main frontend | `{ sdk, countries, ... }` |
| GET | `/health` | Health check | Not used by frontend | `{ status, uptime }` |

---

## 6. What Docs Describe But Does Not Exist in Frontend

### BUILD-ON-ME.md
| Described | Actually exists? | Notes |
|-----------|-----------------|-------|
| `NodeTester` class in SDK | NOT in index.html | Doc describes C# `NodeTester` class with events. This is SDK-level, not frontend. Frontend knows nothing about this. |
| `INodeTestAdapter` interface | NOT in index.html | Same -- SDK-level concept. |
| 6 stats cards | YES -- all 6 exist | |
| SDK toggle removed for embedded | EXISTS in standalone | Doc says removed; standalone still has it. Correct for embedded. |

### COMPLETE-INTEGRATION-SPEC.md
| Described | Actually exists? | Notes |
|-----------|-----------------|-------|
| `connected` field in result schema | NO | Frontend never reads `r.connected`. It infers connection from `r.actualMbps != null`. |
| `connectSeconds` field | NO | Frontend never displays connect time. |
| `transport` field (flat) | NO | Frontend reads `r.diag.v2rayTransport`, not `r.transport`. |
| `pass` field (boolean) | NO | Frontend computes pass from `r.actualMbps >= 10`, never reads `r.pass`. |
| `dynamicThreshold` field | NO | Frontend never displays this. Server uses it for `passedBaseline` counter. |
| `baselineViable` field | NO | Frontend never reads this. |
| `gigabytePrices` field | NO | Frontend never displays pricing. |
| `speedMethod` field | NO | Frontend never displays speed test method. |
| Result badge "PASS"/"FAIL" | PARTIAL | Frontend uses FAST/SLOW/FAIL, NOT PASS/FAIL. Docs say PASS/FAIL, code says FAST/SLOW/FAIL. |
| Max 200 lines in log | NO | Code is 500 lines (line 1123: `body.children.length > 500`). Doc says 200. |
| Expandable diag row | NO | Frontend has no row expansion. Diag data is used inline for transport display. |
| V2Ray result schema field `diag.speedtestMethod` | NO | Frontend never reads this. |
| V2Ray result schema field `diag.wgAssignedAddrs` | NO | Frontend never reads this. |

### UX-FEATURE-PARITY.md
| Described | Actually exists? | Notes |
|-----------|-----------------|-------|
| Failure Analysis (Section 8) | NOT in frontend | Server has GET /api/failure-analysis, but NO frontend UI for it. |
| Max 200 log entries | NO | Code uses 500. |
| Separate "failure categories" view | NO | Not implemented in frontend. |
| "Export CSV/JSON" for runs | NO | Frontend has SAVE button but no export/download feature. |
| "Retestable flag" per failure | SERVER ONLY | Computed in /api/failure-analysis but not displayed. |
| Color-coded log: "Yellow for warnings" | PARTIAL | Actually gray-ish: border #888, text #bbb. Not truly yellow. |

### TECHNICAL-BLUEPRINT.md
| Described | Actually exists? | Notes |
|-----------|-----------------|-------|
| `baseline` SSE event type | NOT FOUND | Code has no handler for `msg.type === 'baseline'`. Server may broadcast it, but frontend ignores it. Baseline comes via state.baselineHistory in state events. |
| 1492 lines in index.html | CLOSE | Actual: 1511 lines (slightly grown since doc was written). |
| Server state field `passed15` | EXISTS | But NOT displayed in frontend. No stat card for 15 Mbps. |
| Server state field `lowBalanceWarning` | EXISTS | But NOT displayed in frontend. |

### FUNCTION-REFERENCE.md
| Described | Actually exists? | Notes |
|-----------|-----------------|-------|
| All backend functions | YES | Accurate for backend. But ZERO frontend functions documented. |
| Frontend functions | NOT DOCUMENTED | FUNCTION-REFERENCE.md has zero mention of any index.html function. |

---

## 7. What Exists in Frontend But Docs Do Not Describe

### Functions with ZERO documentation in any doc file

| Function | Lines | What it does | Mentioned in docs? |
|----------|-------|--------------|-------------------|
| `_countryToCode()` | 712-722 | Country name -> ISO code with fuzzy match | NO |
| `copyToClipboard()` | 727-732 | Clipboard + visual feedback | NO |
| `upsertLocal()` | 735-739 | Dedup results by address | NO |
| `connectSSE()` | 750-789 | SSE connection + reconnect + message routing | NO (mentioned generically, not the function) |
| `updateETA()` | 791-811 | ETA calculation algorithm | NO (result shown, algorithm not documented) |
| `applyState()` | 813-989 | THE core UI update function (177 lines) | NO |
| `renderHistory()` | 991-1009 | History pill rendering with thresholds | NO |
| `renderTable()` | 1011-1016 | Full table rebuild | NO |
| `addSingleRow()` | 1018-1027 | Incremental row upsert | NO |
| `appendRowHtml()` | 1029-1109 | Row HTML construction (81 lines, most complex) | NO |
| `appendLog()` | 1111-1124 | Log message classification + rendering | NO |
| `toggleEconomy()` | 1126-1132 | Economy toggle API call | Mentioned as button, not as function |
| `updateEconomyBtn()` | 1134-1147 | Economy button visual states | NO |
| `loadRunsList()` | 1155-1173 | Run dropdown population | NO |
| `loadRun()` | 1175-1181 | Load previous run | NO |
| `saveRun()` | 1183-1198 | Save current run | NO |
| `setSDK()` | 1204-1220 | SDK toggle with visual + API | Mentioned as feature, not as function |
| `setDNS()` | 1222-1228 | DNS preset change | Mentioned as feature, not as function |
| `startAudit()` | 1242-1277 | New test with state clearing | Mentioned as button action, state clearing not documented |
| `resumeAudit()` | 1279-1299 | Resume with error handling | Mentioned as button action |
| `retestFails()` | 1301-1330 | Client-side failure filtering + API call | NO -- different from /api/auto-retest |
| `rescanNodes()` | 1332-1350 | Chain rescan | Mentioned as button action |
| `showInfoPopup()` | 1352-1440 | Help overlay (89 lines of HTML content) | NO |
| `stopAudit()` | 1442-1449 | Stop API call | Mentioned as button action |
| `clearResults()` | 1451-1468 | Clear with state reset | Mentioned as button action |
| `loadPlans()` | 1471-1485 | Plan dropdown population | NO |
| `testPlan()` | 1487-1504 | Plan test API call | Mentioned as button action |

### API endpoints used by frontend but not documented in docs

| Endpoint | Used by | In any doc? |
|----------|---------|-------------|
| `GET /api/stats` | DOMContentLoaded fast load | NO -- only `/api/state` is documented |
| `POST /api/retest-fails` (with addresses body) | retestFails() | NO -- docs mention `/api/auto-retest` |
| `POST /api/runs/load/:num` | loadRun() | YES in UX-FEATURE-PARITY.md |

### DOM elements with no documentation

| Element ID | Purpose | In any doc? |
|------------|---------|-------------|
| `headerDot` | Pulse dot (running/paused/idle) | NO |
| `walletAddr` | Truncated wallet address, copyable | Brief mention |
| `walletBal` | Balance display | Brief mention |
| `headerBaseline` | Average baseline speed | NO |
| `estCost` | Session spend | NO |
| `statTested` through `statPassRate` | 6 stat cards | Values documented, IDs not |
| `runSelect` | Test run dropdown | NO |
| `sdkToggle`, `sdkJs`, `sdkCs` | SDK toggle elements | NO |
| `dnsSelect` | DNS preset dropdown | NO |
| `planSelect` | Plan dropdown | NO |
| `baselineHistoryPills` | Baseline pill container | NO |
| `nodeSpeedHistoryPills` | Node speed pill container | NO |
| `progressPctLabel` | Progress percentage text | NO |
| `etaTime` | ETA countdown | NO |
| `progressFill` | Progress bar fill | NO |
| `progressCount` | Progress count text | NO |
| `currentAction` | Current test action text | NO |
| `resultsBody` | Table tbody | NO |
| `resultsCountLabel` | Entry count label | NO |
| `logBody` | Log container | NO |
| `infoOverlay` | Help popup overlay | NO |

---

## 8. Documentation Discrepancies (Code vs Docs Conflicts)

### CRITICAL: Baseline pill thresholds
- **BUILD-ON-ME.md line 150:** "green >= 30, yellow >= 15, red < 15"
- **UX-FEATURE-PARITY.md line 56:** "green >= 30 Mbps, yellow >= 15, red < 15"
- **ACTUAL CODE line 997:** `e.mbps >= 30 ? 'h-pill-good' : e.mbps >= 10 ? 'h-pill-mid' : 'h-pill-bad'`
- **Verdict:** Code uses 30/10, docs say 30/15. CODE IS CORRECT (docs are wrong).

### CRITICAL: Node speed pill thresholds
- **BUILD-ON-ME.md line 151:** "green >= 10, yellow >= 5, red < 5"
- **UX-FEATURE-PARITY.md line 57:** "green >= 10 Mbps, yellow >= 5, red < 5"
- **UX-FEATURE-PARITY.md line 176:** ">=15 = green, >=5 = yellow, <5 = red" (contradicts own line 57)
- **ACTUAL CODE line 1006:** `e.mbps >= 15 ? 'h-pill-good' : e.mbps >= 5 ? 'h-pill-mid' : 'h-pill-bad'`
- **Verdict:** Code uses 15/5. Some docs say 10/5, other docs say 15/5. CODE IS CORRECT at 15/5.

### Result badge: FAST/SLOW vs PASS/FAIL
- **COMPLETE-INTEGRATION-SPEC.md line 83:** says "PASS" or "FAIL"
- **ACTUAL CODE line 1064-1069:** FAST (>=10), SLOW (<10), FAIL (null)
- **Verdict:** Three states in code, two in that doc. BUILD-ON-ME.md correctly says FAST/SLOW/FAIL.

### Log max entries
- **UX-FEATURE-PARITY.md line 50:** "Max 500 entries"
- **COMPLETE-INTEGRATION-SPEC.md line 93:** "Max 200 lines"
- **ACTUAL CODE line 1123:** `body.children.length > 500`
- **Verdict:** Code uses 500. COMPLETE-INTEGRATION-SPEC.md is wrong.

### `processed` count calculation
- **Not documented anywhere.** Frontend computes `processed = testedNodes + failedNodes` for all stats. This is NOT obvious. Some docs imply testedNodes is the total processed count, but in the code testedNodes counts only PASSED nodes and failedNodes counts FAILED nodes. The sum is the total processed.

### Not Online stat card
- **BUILD-ON-ME.md line 141:** "Not Online = totalChain - totalOnline"
- **ACTUAL CODE line 916:** `resultsArr.filter(r => r.actualMbps == null && (r.peers === 0 || r.peers == null)).length`
- **Verdict:** COMPLETELY DIFFERENT. Docs say it comes from chain data. Code computes it from test results (failed nodes with 0/null peers). These produce very different numbers.

### Stats grid columns
- **CSS on line 263:** `grid-template-columns: repeat(5, 1fr)` (default)
- **HTML on line 581:** inline `style="grid-template-columns: repeat(6, 1fr);"` (override)
- **Verdict:** 6 columns is correct. The CSS default is wrong but overridden by inline style.

### `moniker` display
- **COMPLETE-INTEGRATION-SPEC.md line 78:** "Moniker (click to copy full address)"
- **ACTUAL CODE line 1036:** Shows truncated address, NOT moniker. Moniker is available in `r.moniker` but NOT displayed in the Node column.
- **Verdict:** Docs say moniker is shown. Code shows address. This is a mismatch.

---

## 9. Missing Features (Frontend has no implementation)

1. **Failure Analysis UI** -- Server has `/api/failure-analysis` with categorized failures, retestable flags, and dead node lists. Frontend has ZERO UI for this. No page, no tab, no panel.

2. **Export/Download** -- UX-FEATURE-PARITY says "Export: CSV and/or JSON download of any run's results." Frontend has no download button.

3. **Expandable row diagnostics** -- COMPLETE-INTEGRATION-SPEC describes expandable rows with full diag object. Frontend has no row expansion.

4. **Error message display** -- `state.errorMessage` is set by server on audit errors but never displayed in frontend.

5. **Low balance warning** -- `state.lowBalanceWarning` is set by server but never shown in frontend.

6. **Dictator Mode link** -- EXISTS in header but leads to separate `dictator.html` (not part of main dashboard code review).

7. **Moniker display** -- Result rows show truncated address, not moniker. The moniker field exists in results but is unused in the table.

---

## 10. Server API Endpoints NOT Called by Frontend

These exist in server.js but have no corresponding frontend function:

| Endpoint | Purpose | Why unused |
|----------|---------|------------|
| `GET /api/results` (paginated) | Fetch results with pagination | Frontend uses SSE init instead |
| `POST /api/retest-skips` | Retest unreachable-only | Frontend uses retest-fails instead |
| `GET /api/failure-analysis` | Categorized failure report | No UI built |
| `GET /api/transport-cache` | Cache statistics | No UI built |
| `POST /api/auto-retest` | Server-side filtered retest | Frontend uses client-side filtered retest-fails |
| `GET /api/runs/:num` | Get run details without loading | Frontend loads runs directly |
| `GET /api/sdk` | Get current SDK | Frontend syncs via SSE state |
| `GET /api/dictator` | Dictator data | Used by dictator.html, not main dashboard |
| `GET /health` | Health check | For monitoring, not UI |

---

## 11. Integrator Checklist: What You MUST Replicate

### Data Processing (from applyState, lines 813-989)
- [ ] `processed = testedNodes + failedNodes` (NOT just testedNodes)
- [ ] `failPct = fail / processed * 100`
- [ ] `passRate = p10 / done * 100` where done = testedNodes only
- [ ] `connRate = done / processed * 100` (Pass Rate card)
- [ ] `notOnline = results.filter(r => actualMbps == null && (peers == 0 || peers == null)).length`
- [ ] `deadPlan = results.filter(r => inPlan && actualMbps == null).length`
- [ ] `totalBw = actualMbps * max(peers, 1)` per row
- [ ] Retest mode: switch progress to retestTested/retestTotal

### Button State Machine
- [ ] Running/Paused: Start=disabled, Resume=disabled, Retest=disabled, Stop=enabled
- [ ] Idle/Done: Start=enabled, Resume=enabled, Retest=enabled (with fail count), Stop=disabled
- [ ] Loading states on click (disabled + text change + class)
- [ ] Error: restore to pre-click state

### Persistence (survives restart)
- [ ] Results: `results.json` -> restore table
- [ ] Counters: recompute from results
- [ ] History: `.state-snapshot.json` -> restore baseline + speed pills
- [ ] Total nodes: from snapshot (NOT from results.length)
- [ ] SDK: `.sdk-pref` file
- [ ] Log buffer: from most recent .log file
- [ ] Transport cache: `transport-cache.json`
- [ ] Runs index: `runs/index.json`

### ETA Algorithm
```
if retestMode:
  done = retestTested, total = retestTotal
else:
  done = testedNodes + failedNodes, total = totalNodes
remaining = total - done
if done == 0 or remaining <= 0: "Calculating..."
elapsed = now - startedAt
eta_ms = remaining * (elapsed / done)
format as HH:MM:SS
```

### Flag Emoji (for non-WPF)
```javascript
// ISO code -> flag emoji
const flag = cc.length === 2
  ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65))
  : '';
```
For WPF: Use `getFlagUrl(cc, 40)` from SDK's countries.js -> Image control.

---

## Summary

**Total frontend functions:** 24 named functions + 4 anonymous startup blocks = 28 code units
**Total documented in any doc file:** 0 (zero frontend functions are documented by name)
**Total API endpoints in server.js:** 24
**Total API endpoints used by frontend:** 15
**Total API endpoints documented:** ~13 (across various docs, with inconsistencies)
**Total CSS variables:** 9
**Total color thresholds:** 3 sets (baseline pills, node pills, result badges)
**Total documentation discrepancies found:** 7 (code != docs)
**Total features described but not implemented:** 5

The fundamental gap: **no doc file maps what index.html actually does.** FUNCTION-REFERENCE.md covers only backend functions. BUILD-ON-ME.md covers the API and specs. But the 1511-line frontend with 28 code units, 177-line applyState(), and complex state machine is completely undocumented. Any integrator must reverse-engineer every function, every threshold, every DOM update, and every button state from source code alone.
