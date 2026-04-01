# Feature Specs — Every Dashboard Feature in 10-20 Lines

> For each feature: Input → Logic → State → Output. No ambiguity. No reverse-engineering needed.

---

## Resume

**Input:** User clicks Resume
**Logic:**
1. Load `results.json` from disk → `resultsArr`
2. Count tested: `resultsArr.length`
3. Fetch current node list from chain: `getAllNodes()`
4. `testedAddresses = resultsArr.map(r => r.address)`
5. Skip nodes already in `testedAddresses`
6. Continue scan from first untested node
7. If node list changed since last scan: new nodes get tested, removed nodes skipped
**State:** `results.json` loaded, counters recomputed from results array, `.state-snapshot.json` restores baseline/speed history
**Output:** Progress bar resumes from X/Y, existing results visible in table, new results append

---

## Baseline Measurement

**Input:** Automatic — runs before first node test, then every ~50 nodes
**Logic:**
1. Ensure no VPN tunnel is active
2. `speedtestDirect()` → downloads from Cloudflare, measures Mbps
3. Store in `baselineHistory[]` (last 10 readings)
4. Current baseline = most recent reading
5. Refresh: call `speedtestDirect()` periodically during audit
**State:** `baselineHistory[]` in state, persisted in `.state-snapshot.json`
**Output:** Baseline pills row (green ≥30, yellow ≥15, red <15). Each result row shows `baselineAtTest`.
**Used for:** `passBaseline = actualMbps >= (baselineMbps * 0.5)`. `ispBottleneck = actualMbps >= (baselineMbps * 0.85)`

---

## Economy Mode

**Input:** User clicks Economy toggle
**Logic:**
1. `state.economyMode = !state.economyMode`
2. When `economyMode = true`: skip nodes that need individual payment (no batch session available)
3. Only test nodes with pre-existing sessions or batch-paid sessions
4. Saves tokens by not paying for expensive/slow nodes
**State:** `state.economyMode` (in-memory, not persisted)
**Output:** Economy button highlighted when active. Fewer nodes tested. Log shows "Economy mode — no batch session available" for skipped nodes.

---

## Plan Test

**Input:** User selects a plan from dropdown, clicks "Test Plan"
**Logic:**
1. Query `GET /sentinel/node/v3/plans/{planId}/nodes` → get plan node addresses
2. Filter to only nodes in the selected plan
3. Check subscription: does wallet have active subscription to this plan?
4. If yes: create sessions via plan subscription (no per-GB cost)
5. If no: create individual sessions (costs per-GB)
6. Test each plan node: handshake → tunnel → speed → google
**State:** `planId` saved in state, results tagged with `inPlan: true, planIds: [planId]`
**Output:** Only plan nodes shown in results. "Dead Plan Nodes" stat populated.

---

## Retest Failed

**Input:** User clicks "Retest Failed" button
**Logic:**
1. `clearPoisonedSessions()`, `clearPaidNodes()`, `invalidateSessionCache()`
2. Find all results where `actualMbps == null && error != null`
3. For each: look up node in current chain list
4. If node still active: test it (fresh session, fresh handshake)
5. `force: true` parameter retests ALL failures including "permanent" ones
6. Results update in-place (upsert by address, not append)
**State:** Retest mode: `state.retestMode = true`, separate counters: `retestTested`, `retestPassed`, `retestFailed`
**Output:** Log shows per-node PASS/FAIL. Results table updates in real-time. Progress shows retest-specific counts.

---

## Run Archive

**Input:** Automatic — triggers before every new test start
**Logic:**
1. Check `results.json` — if has results, save before clearing
2. Create directory: `runs/test-{NNN}/`
3. Copy `results.json` → `runs/test-{NNN}/results.json`
4. Copy `failures.jsonl` → `runs/test-{NNN}/failures.jsonl`
5. Update `runs/index.json` with: `{ number, label, date, total, passed, failed, pass10, sdk }`
6. Increment run number
**State:** `runs/index.json` persists, each run dir is permanent
**Output:** Run selector dropdown populated with all past runs. Click to load any run's results into the table.
**Trigger:** `/api/start` auto-saves. `/api/runs/save` manual save.

---

## Session Spend Tracking

**Input:** Automatic during testing
**Logic:**
1. Before scan: record `startBalance = getBalance()`
2. After each payment TX: `state.spentUdvpn += (nodePriceUdvpn * gigabytes) + 200000` (gas)
3. Running total: `state.balance = (startBalance - spentUdvpn) / 1_000_000`
4. Display: "Balance: X P2P" and "Est. Cost: Y P2P"
**State:** `state.balanceUdvpn`, `state.spentUdvpn` in memory. `state.balance` as display string.
**Output:** Balance stat card. Updated after every payment. Shows running spend.

---

## Stop

**Input:** User clicks Stop
**Logic:**
1. Set `state.stopRequested = true` (volatile flag)
2. Flag checked at:
   - Before handshake attempt
   - Before each V2Ray outbound
   - Before port scan
   - In retry.js: polled every 500ms via `Promise.race`
3. When caught: throw `"Stop requested"`
4. Cleanup: `uninstallWgTunnel()`, `killAllV2Ray()`, `clearSystemProxy()`
5. Save results to disk
**State:** `state.stopRequested` (volatile boolean). Reset to `false` on next start/resume.
**Output:** Status → "done" within 500ms. Results saved. No data loss. Can Resume later.
**CRITICAL:** Use volatile flag, NOT just CancellationToken. SDK async operations don't respond to cancellation mid-flight.

---

## DNS Toggle

**Input:** User selects DNS preset from dropdown
**Logic:**
1. `POST /api/dns { preset: "hns" | "google" | "cloudflare" | "default" }`
2. `setActiveDns(DNS_PRESETS[preset])`
3. Next node test uses new DNS in:
   - V2Ray config: `dns.servers` array
   - WireGuard config: `DNS = ...` line
**State:** `ACTIVE_DNS` in memory. Not persisted across restarts (reverts to default).
**Output:** Dropdown shows current selection. Log: "DNS set to hns: 103.196.38.38, 103.196.38.39"
**Presets:** `default: [208.67.222.222]`, `hns: [103.196.38.38]`, `cloudflare: [1.1.1.1]`, `google: [8.8.8.8]`

---

## Rescan

**Input:** User clicks Rescan
**Logic:**
1. `invalidateNodeCache()` — clear cached node list
2. `getAllNodes()` — fresh fetch from LCD with pagination
3. Update `state.totalNodes` with new count
4. Do NOT start testing — just refresh the node list
**State:** Node list cache refreshed. `state.totalNodes` updated.
**Output:** Log shows "X nodes fetched". Stats update total. No results cleared.

---

## Results Persistence (App Restart)

**Input:** Server/app starts
**Logic:**
1. Read `results.json` → populate `resultsArr[]`
2. Read `.state-snapshot.json` → restore: `baselineHistory`, `nodeSpeedHistory`, `totalNodes`, `activeRunNumber`
3. Read `.sdk-pref` → set `state.activeSDK`
4. Recompute from results: `testedNodes`, `failedNodes`, `passed10`, `passedBaseline`
5. Dashboard renders immediately with loaded data
**State:** All files in `results/` directory
**Output:** Dashboard shows previous results within 1 second of startup. Not blank.
**CRITICAL:** NEVER show "No results yet" when `results.json` has data.

---

## Table Interactivity

**Sort:** Click column header → toggle ascending/descending. Active sort column highlighted.
**Filter:** Buttons: All | WG | V2 | Pass | Fail. Active filter highlighted.
**Click row:** Expand to show full diagnostics: session ID, connect time, transport attempts, V2Ray stderr, clock drift.
**Click address:** Copy full `sentnode1...` address to clipboard.
**Max rows:** 200. Newest first. Older rows scroll off bottom.
**Upsert:** Re-testing a node replaces its row. No duplicates.

---

## User Journeys

### Journey 1: First Test
Open app → Click "New Test" → Confirm → Scan starts → See real-time results → Audit completes → See summary

### Journey 2: Return Visit
Open app → See previous results immediately → Click "Resume" to continue OR "New Test" for fresh

### Journey 3: Share Results
Open app → See results → Click "Export" → Choose CSV or JSON → Save file → Send to team

### Journey 4: Investigate Failure
Open app → See results → Click failed node → See full diagnostics → Click "Retest" for just that node

### Journey 5: Compare Over Time
Open app → Open run selector → Load yesterday's run → Compare with today's → See trends

### Journey 6: Test Specific Plan
Open app → Select plan from dropdown → Click "Test Plan" → Only plan nodes tested → See dead plan nodes stat
