# Node Tester — Handoff

## 2026-04-25 — Rename dry run → test run across entire project
- **62 occurrences renamed** across 12 files. All `dryRun`/`dry_run`/`dry-run`/`DRY_RUN` identifiers replaced with the `testRun`/`test_run`/`--test-run`/`TEST_RUN` family. Comments/docs updated to "test run" phrasing.
- **DB migration v7 added** (`core/db.js` lines 275–282): `UPDATE runs SET mode='test' WHERE mode='dry'` — idempotent, runs automatically on next startup. Existing `audit.db` rows with `mode='dry'` are migrated to `mode='test'`. Schema version bumped from 6 → 7.
- **Backward-compat alias in `server.js` `/api/start`**: accepts `req.body.testRun` / `?testRun=1` (new, send going forward) AND `req.body.dryRun` / `?dryRun=1` (old, one-release alias). Coalesced to single `testRun` boolean. `bin/commands/agent.js` now sends `testRun` via `--test-run` flag.
- **Do NOT change**: `TEST_RUN_SKIP` error code (already correct), "TEST RUN" UI labels (already correct), `audit-dry.db` historical tombstones in this handoff.

## 2026-04-25 — Admin top-row alignment pass 2
- Bumped TEST RUN, ∞ LOOP, PAY/PER GB/PER HOUR boxes to `height:38px` and `border-radius:6px` to match the surrounding `.btn` controls (38px). Uniform padding `0 14px` on outer wrappers + button segments. ∞ glyph bumped to `font-size:24px` inside a fixed-width `width:20px` inline-block (text-centered) so it can't push baseline. All three boxes share `font-family:var(--font-display)`, `font-size:11px`, `font-weight:700`, `letter-spacing:0.5px`, `line-height:1` so vertical center matches across the row.

## 2026-04-25 — Admin SLA tiles dash out in TEST RUN
- Total Failed, Pass 10 Mbps SLA, Dead Plan Nodes, and Pass Rate now render `—` with sub `not measured in test run` when admin detects a TEST RUN (`state.testRun || any row with errorCode==='TEST_RUN_SKIP'`). Matches /live's behavior so the operator can't mis-read skip-only demo numbers as real measurements. Tested tile + Not Online still show real progress.

## 2026-04-25 — /live Not Online parity with admin
- TEST RUN was reporting "0 nodes offline" on /live while admin reported the real count. /live's `trulyOffline` filter excluded TEST_RUN_SKIP rows; admin's does not. Aligned /live to admin's filter (`actualMbps == null && (peers === 0 || peers == null)`) so both surfaces report identical counts in every mode.

## 2026-04-25 — /live counter parity, transport in TEST RUN, banner gap, admin top-row alignment
- **Public 227 vs admin 150 Tested mismatch.** The earlier "prefer `state.testedNodes`" fix on /live caused public to *outpace* admin: pipeline counter increments (retries, race with recompute) made `state.testedNodes` greater than the deduped row count admin uses. Reverted both `cbRender()` and `renderLiveStats()` in `live.html` to use `resultsArr.length` (deduped by address via `upsert`) — same single source of truth as `admin.html` line 1296. Pass/Fail derived from `resultsArr` filter (matches admin's recompute). Mid-run joiners get the full backlog via the `init` SSE event + REST fallback, so the new approach can't regress the original "0 / 1048" symptom.
- **Transport missing in TEST RUN.** `live.html` was reading `r.serviceType` from the `result` SSE event, but the pipeline emits `r.type` (set in `audit/node-test.js:219` for the TEST_RUN_SKIP early return) — sanitizer maps `r.type → serviceType` for `batch:node:result` but the `result` event passes the raw object through. Patched `live.html` `case 'result'` + the `init` replay to use `normalizeServiceType(r.serviceType ?? r.type)`. Transport badge now renders for every TEST RUN row.
- **TEST RUN banner gap too small.** `.test-run-banner` had no bottom margin so the page title was glued to the alert. Added `margin-bottom: 22px` and bumped padding to `12px 16px`.
- **Admin top-row alignment + ∞ icon size.** TEST RUN, ∞ LOOP, and PAY/PER GB/PER HOUR controls now share `font-family: var(--font-display)`, `font-size:11px`, `font-weight:700`, `letter-spacing:0.5px`, and `height:34px`. ∞ glyph bumped from `font-size:14px` → `20px` (with `font-weight:400`) so it visually balances the "LOOP" label. Pricing wrapper switched to `align-items:stretch` and child segments use `display:inline-flex; align-items:center` so all three controls end at the same right edge.

## 2026-04-25 — Strip ETA + "Started …s ago" from public /live
- Removed `#cbMeta` ("Batch #N · Started …s ago" / "waiting for admin to start testing…") and `#cbEta` ("ETA ~Xm Ys") from the public Current Batch panel in `live.html`. Both DOM elements deleted; `cbRender()` no longer computes elapsed/meta/eta. CSS rules `.cb-meta` / `.cb-eta` left in place (no longer referenced; harmless). Public-only — admin Current Batch panel untouched.

## 2026-04-25 — Agent CLI + /live Tested tile fix
- **Built end-to-end agentic CLI driver.** `bin/commands/agent.js` + `bin/lib/http.js`. One subcommand router with 54 endpoints registered, each self-describing via `agent map`. Auth: `--token`, `$SENTINEL_AUDIT_TOKEN`, or `$ADMIN_TOKEN` (Bearer). CSRF-friendly: every non-GET sets `X-Admin-Request: 1`. Target: `--base-url`, `$SENTINEL_AUDIT_URL`, or `--port` (default `http://localhost:3001`).
  - Discovery: `sentinel-audit agent map --pretty`, `sentinel-audit agent --help`.
  - Audit lifecycle: `start [--test-run] [--pricing-mode hours|gigabytes] [--plan-id] [--sub-id] [--sub-granter]`, `stop`, `resume`, `rescan`, `clear`.
  - Retest: `retest-skips`, `retest-fails`, `auto-retest`.
  - Reads: `state`, `stats`, `results`, `plans`, `subscriptions`, `sub-plans`, `failure-analysis`, `transport-cache`, `chain-nodes`, `chain-status`.
  - Public reads: `pub-nodes`, `pub-node <addr>`, `pub-node-errors <addr>`, `pub-bandwidth <addr>`, `pub-errors`, `pub-countries`, `pub-stats`, `pub-runs`, `pub-run-current`, `pub-run-last`, `pub-batches`, `pub-batch <id>`, `pub-logs`, `pub-live-state`, `pub-test-status`.
  - Run history: `runs`, `run-get <n>`, `run-save`, `run-load <n>`.
  - Toggles: `broadcast` / `broadcast-toggle`, `economy`, `sdk-get` / `sdk-set --sdk js|tkd`, `dns-get` / `dns-set --dns ... --enabled true|false`.
  - Streaming: `events --watch 30` and `pub-events --watch 30` — taps SSE to stderr, returns aggregate JSON on stdout.
  - Wired into `bin/cli.js` `COMMAND_GROUPS.Agent`. `node bin/cli.js agent map` returns 54 endpoints.
- **Fixed /live "0 / 1048 nodes tested" stuck counter.** When `/live` joined mid-run via `init` and missed earlier `result`/`batch:node:result` SSE events, both the Tested tile and Current Batch panel showed `0 / N` while admin had progress. Root: tile relied on `arr.length` and panel on `_cb.tested`, both incremented purely from streamed events.
  - Fix in `live.html`: `renderLiveStats()` now uses `_liveState.testedNodes` as the authoritative `processed` source when available (falls back to `arr.length`); `cbRender()` uses `_liveState.testedNodes` for `tested`, `_liveState.passed10` for passed, `_liveState.failedNodes` for failed (each fall back to local `_cb.*`); `state` SSE handler now also calls `cbRender()` so the panel refreshes on every server state push. `state.testedNodes/failedNodes/passed10` were already in `PUBLIC_STATE_KEYS` — they were arriving but unused.

## 2026-04-25 — Single-mode refactor + Economy deprecation
- **Dual-mode system dropped.** The dev/bundled/public mode cookie, `requireMode()` middleware, mode overlay UI, `_currentMode`, `_applyModeUI`, `selectMode`, and `switchMode` are all gone. There is now one mode and no mode-switching anywhere in the stack.
- **One database.** `audit-dry.db` is gone. All runs — live and test — write to `audit.db`. Test runs get `mode='test'` on the run row so they remain visually distinguishable in the admin table.
- **`state.broadcastLive` added.** Server-side boolean that controls whether public surfaces (`public.html`, `/live`, `/api/public/events`, `/api/public/runs/current`) show the live in-flight audit or the last-completed snapshot.
  - `POST /api/broadcast` (adminOnly) — flips the toggle. No body required.
  - `GET /api/broadcast` — returns `{ broadcastLive: boolean }`. Open.
  - When `false`: public SSE is silent, public sees last-completed snapshot.
  - When `true`: public SSE fan-out becomes active, `/live` upgrades from snapshot view to live progress view.
- **TEST RUN now `?testRun=1`.** Pass `testRun: true` in body or `?testRun=1` on `POST /api/start`. Pipeline skips plan membership, online scan, chain ops, payments. Every node row: `actualMbps: null, errorCode: 'TEST_RUN_SKIP'`. Run row: `mode='test'` in `audit.db`. Not a separate mode — just a parameter.
- **Removed endpoints:** `POST /api/admin/public-test/start`, `POST /api/admin/public-test/stop`, `GET /api/admin/public-test/status`, `POST /api/public/test/start`, `POST /api/public/test/stop`, `GET /api/public/test/status`.
- **Economy mode fully deprecated** (removed earlier this same session — no economy-mode code paths remain).
- **Failure-log UX still intact (hard rule).** Per-row copy button (`.row-copy-btn`, glyph `⎘`, `copyRowFailure`), admin drawer "Copy Failure Logs" (`#copyFailureLogsBtn`) + "Download .txt" button — all wired and untouched by this refactor.
- **Docs updated:** `CLAUDE.md` Server Modes section replaced with Single Mode + Broadcast Live; Existing Server Infrastructure updated; Build Order updated. `docs/ARCHITECTURE-PUBLIC-LIVE.md` rewritten to reflect new architecture.

## 2026-04-24 — Perpetual-utility upgrades (58→100 plan, P0 fixes landed)
- **Mission alignment**: make the tester a perpetual, refresh-resilient service — "find a server, host this, run forever, users copy error logs". Audit scored the codebase 58/100 before these edits. This pass landed the P0 fixes.
- **Fix 1 — refresh-blank on /live**:
  - `core/db.js` migration v6: `ALTER TABLE batch_results ADD COLUMN country_code TEXT`. `insertBatchResult` now persists `country_code` (`r.countryCode || r.country_code`) and `type` now falls back to `r.serviceType`. New `getActiveBatch()` returns `{ batch, nodes }` where batch is the row with `finished_at IS NULL` and nodes is the full, camelCase-normalized `batch_results` set for it.
  - `server.js` — imports `getActiveBatch`; `/api/public/runs/current` now returns `{ id, started_at, finished_at, snapshot_size, passed, failed, mode, nodes }`. No more wrong-schema leak from the legacy `runs` table.
  - `live.html` `loadCurrentBatch` now consumes the new shape (camelCase first, snake_case fallback) and calls `showPaused(false)` when a batch is returned, so refresh mid-batch hydrates the table and hides the paused overlay.
- **Fix 2 — batchId in SSE init**: `server.js` /api/public/events `init` payload now also sends `{ batchId, snapshotSize }` derived from `getActiveBatch()`. `live.html` init handler treats a non-null `batchId` as "mid-flight" → never flashes the paused overlay between SSE connection and first `batch:start`.
- **Fix 3 — auto-resume on restart**: `audit/continuous.js` now persists `results/.loop-config.json` (`running | mode | planId | subscriptionId | subscriptionGranter | minDelayMs | updatedAt`) on `_runLoop` start and on the finally-block stop. Exports `readPersistedLoopConfig()` + `resumeFromPersisted()`. `server.js` calls `continuous.resumeFromPersisted()` in the listen callback (only if MNEMONIC is configured) so a restart of a crashed/rebooted host picks the loop back up automatically.
- **Fix 4 — systemd hardening**: `deploy/sentinel-node-tester.service` → `Restart=always` (was on-failure) and `ReadWritePaths=... /data /results /logs` so the service can actually write `.loop-config.json` under ProtectSystem=strict.
- `/health` already existed (server.js:1856) — kept as-is.
- Server restarted on PID that replaced 33308. Migration v6 ran cleanly. `curl /api/public/runs/current` returns the new shape: `{"id":1,"started_at":...,"snapshot_size":1048,...,"nodes":[]}`.

## 2026-04-24 — /live paused-during-dry-run + admin ptCard alignment
- **Bug 1**: /live showed the "Testing Has Been Paused" overlay even while the admin was running a dry-run. Root cause: dry-run is client-side in admin.html and never hits `/api/admin/public-test/start`, so the continuous loop never fires `public-test:loop:started` — meaning /live's SSE stream never received a "we're live" signal. The `init` handler's `running` flag reflects only the server loop.
- **Fix** (4 edits):
  1. `admin.html _dryRun.startPt()` now fans out `public-test:loop:started` (with `dryRun:true`) at loop entry, and `stopPt()` fans out `public-test:loop:stopped`. Each iterate cycle also fans out `batch:start` at the top and `batch:end` + `batch:gap` at the bottom so /live's cbCard populates identically to a real run.
  2. `server.js DRY_RUN_EVENT_TYPES` whitelist extended to include `batch:gap`, `public-test:loop:started`, `public-test:loop:stopped`.
  3. `live.html` dispatcher: `dry-run:log` case now calls `showPaused(false)` so any dry-run chatter (even before the first `batch:start`) clears the overlay immediately.
  4. Dry-run fanout uses `gapMs` not `next_in_ms` to match `sanitizeForPublic`'s allow-list.
- **Bug 2 (admin.html ptCard alignment)**: "Public Testing / Recursive non-stop... / Running (DRY) / Mode" was visually misaligned. Restructured ptCard (admin.html:1111):
  - Status strip → rounded status pill with dot + label, anchored to header's right side.
  - Controls row: all inputs now share `height:34px` with `box-sizing:border-box`; DRY RUN chip uses matching padding; button has explicit `margin:0`.
  - Status detail strip → 4-column `grid-template-columns:repeat(auto-fit,minmax(140px,1fr))` with label-on-top / value-below for each metric. Cleaner at all widths.
  - `ptPlanWrap` + `ptLastErrWrap` style.display now set to `'flex'` explicitly (default `''` fell back to block and killed flex-direction).
- Server restarted (PID 33308).

## 2026-04-24 — Frozen snapshot: batch model goes 88→100
- **Problem**: `continuous.js` called `getAllNodes()` to record `snapshot_size`, then `pipeline.js runAudit()` called `getAllNodes()` independently at line 458. Two separate chain queries meant `snapshot_size` could disagree with the node set actually tested in the same batch. Also: on LCD failure the size silently fell back to `0` so cbCard rendered `0 / ? nodes tested` until first result arrived. Also: no persistence of the actual address set for later audit.
- **Fix** (4 files):
  1. `core/db.js` — migration v5 adds `batches.snapshot_addresses TEXT`. `insertBatch()` now accepts `snapshot_addresses: string[]` and JSON-encodes it.
  2. `audit/continuous.js` — replaced `_resolveSnapshotSize()` with `_resolveSnapshot()` returning `{ nodes, addresses }`. In p2p mode only (`_ctrl.mode !== 'subscription'`), resolve snapshot ONCE per iteration, pass `frozenNodes` into `_runOnePass()` → `pipeline.runAudit()`. On snapshot failure: emit `loop:error`, skip the iteration cleanly (with interruptible sleep), continue the loop — never test an empty/partial set. Subplan mode scopes its own node universe via `rpcFetchAllNodesForPlanPaginated`, so it's unchanged.
  3. `audit/pipeline.js` — `runAudit(resume, state, broadcast, preloadedNodes = null)`. When `preloadedNodes` is a non-empty array, use it directly and log `🔒 Using frozen snapshot (N nodes)`; otherwise fall back to the original `getAllNodes` + 60s timeout path (preserves standalone `/api/start` behavior).
  4. `server.js` — `/api/public/batch/:id` now strips `snapshot_addresses` from the batch object before responding (already-public data but bloats responses; keep the admin-only surface narrow).
- **Result**: `batches.snapshot_size` is now provably equal to the number of nodes fed into the pipeline. Audit trail: exactly which addresses were in the snapshot is persisted for forensic queries. No silent 0-size iterations.
- Server restarted at PID 31200. Migration v5 ran cleanly.

## 2026-04-24 — Fix MODE_NOT_SET on Start Public Testing (no dry-run)
- **Root cause**: `/api/admin/public-test/start` is gated by `requireMode('public')` which requires `server_mode === 'bundled'`. If the admin's signed cookie is missing → 403 `MODE_NOT_SET`; if it's `dev` → 403 `WRONG_MODE`. The client was showing the raw error string, so users saw "MODE_NOT_SET" with no guidance. Dry-run short-circuited into `_dryRun.startPt()` and never hit the endpoint, which is why dry-run "worked".
- **Fix** (admin.html `ptToggle`):
  1. Pre-flight check: when `_currentMode !== 'bundled'`, prompt `"Public Testing requires Dev + Public (bundled) mode. Switch now and start?"` and call `selectMode('bundled')` before the fetch. This also refreshes the signed cookie.
  2. Humanized the 403 messages: `MODE_NOT_SET` → "Server mode not set. Pick Dev + Public in the mode overlay and try again." / `WRONG_MODE` → "Public Testing requires Dev + Public mode. Switch modes and try again."
- Client-only change, no server restart needed. Reload admin.html and the toggle now offers to switch modes in one click instead of leaking the raw error code.

## 2026-04-24 — /live: Current Batch card + Paused overlay + country/transport fixes
- **Current Batch card ported into /live**: full cbCard widget from admin (progress bar, ETA, iteration #, elapsed, snapshot size, passed/failed counts, gap countdown) replaces the slim `status-row`. CSS `.cb-*` rules ported from admin.html:808-897. Markup + `_cb` state + `cbApplyBatchStart/NodeResult/BatchEnd/Gap` + `cbRender` live in live.html. `handleEvent` calls them on `batch:*` events; seeded from `/api/public/runs/current`.
- **Removed Total BW column** from /live per user. `colspan` changed 11→10; `totalBw`/`totalHtml` locals dropped from `appendRowHtml`.
- **Testing Has Been Paused overlay** added to /live. Fullscreen overlay (`#pausedOverlay`) with `/logo.jpg`, title "Testing Has Been Paused", body copy. Shows on `public-test:loop:stopped` / `loop:error` / initial `init` when not running / `loadCurrentBatch` 404. Hides on `public-test:loop:started` / `batch:start`. Fixes user report: "stop public testing button is not working" — backend stop always worked, but /live never visually reflected it.
- **Transport/Country/City missing — root causes fixed (3 edits)**:
  1. `audit/continuous.js:118` `_sanitizeBatchNodeResult` now includes `countryCode: result.countryCode || null`. Previously only `country` string was forwarded — flag never appeared.
  2. `server.js:951` `sanitizeForPublic` now forwards `evt.countryCode`. Without this, step 1's field was dropped on the way to the public SSE stream.
  3. `audit/pipeline.js:322` `buildFailResult` type fallback `'UNKNOWN'` → `null`. The string `'UNKNOWN'` was treated as V2 by client's `includes('wire')` check. /live client now renders `—` for unknown transport (in both SSE handler `type` mapping and `appendRowHtml`'s WG/V2 badge + Transport column).
- Remaining gap (not a bug): nodes that fail before GeoIP have genuinely no location — those will keep showing `—`. That's upstream-correct behavior.
- Server restarted (PID 20768).

## 2026-04-24 — Rename matrix + bundled-visible + M-01 header
- Renamed "Node Performance Matrix" → "dVPN Node Connections" (admin.html:1211).
- Removed `bundled-hide` class from the table container — table is now visible in both Dev Only and Dev + Public modes with identical DOM/renderer wiring.
- Dropped the now-unused `body.mode-bundled .bundled-hide` CSS rule (admin.html:788-789) as dead code.
- M-01 applied: added `X-Frame-Options: DENY` to the global security-headers middleware (server.js:387). Defence-in-depth for admin routes where the public `frame-ancestors 'none'` CSP doesn't apply.
- Server restarted (PID 15280); verified `X-Frame-Options: DENY` lands on `/` responses.

## 2026-04-24 — Dry Run stop-button fix + Min Delay removed
- Bug: "its not stopping its just spamming non stop im unable to stop it" — clicking Stop on dry run did nothing because:
  1. `ptApplyStatus` polls server every 3s and overwrites the Stop button label back to "Start Public Testing" whenever the real endpoint says idle (dry run never hits the real endpoint, so server always reports idle)
  2. ptToggle's stop branch was guarded by `dryEl.checked`; if user toggled the checkbox while running, ptToggle fell through to the real /api/admin/public-test/stop path, leaving `_dryRun.ptRunning=true`
  3. Single `this.timer` slot was overwritten by each `_sleep` + each `setTimeout(step)`; `clearTimeout(this.timer)` only killed the newest, older pending timers kept firing
- Fix (admin.html):
  - Replaced `this.timer` with `this.timers = new Set()` + `_cancelAll()` that iterates and clears every pending timer.
  - `_sleep` and all `setTimeout(step)/setTimeout(iterate)` now push their id into `this.timers` and remove on fire.
  - `stopDev()` / `stopPt()` call `_cancelAll()` + log `⏹ Dry run stopped by user.`
  - `startCreateMode()` and `ptToggle()` now honor stop on a running dry run regardless of checkbox state — stop is unconditional.
  - `ptApplyStatus()` early-return when `_dryRun.ptRunning` is true, so poll no longer resets button to "Start".
- Also removed the `Min Delay (ms)` input per user: "why delay it should be instant right lets say people are watching it live". Batch flow is now snapshot → test all → fresh snapshot → repeat with zero artificial gap.
  - admin.html: dropped the `ptMinDelay` input div and removed `minDelayMs` from ptToggle body.
  - continuous.js: `MIN_DELAY_MS = 30_000` → `MIN_DELAY_MS = 0` (clamp still exists, just floors at 0).
- Server restarted (PID 22504) to pick up continuous.js change.

## 2026-04-24 — Dry Run mirrors real pipeline exactly (skip only at connect)
- User asked: "identical process as normal, just skip at connecting to node" — same data shape, same log sequence, real baseline, skip only the actual handshake.
- New helper `_clientBaseline()` — measures real client-side download throughput via same-origin fetch of `/api/chain/nodes` (CSP-safe; admin route has no CSP but `/` does enforce `connect-src 'self'`). Returns `{ mbps, chunks, adaptive: 'same-origin' }`.
- New helper `_simulateNode(n, detail, idx, total, prefix)` — emits the same log sequence as node-test.js: `[i/total] <moniker> (<addr>…)` → `↳ <transport> · country/city · peers x/y` → `Probing <transport> endpoint…` → `⏭ DRY RUN — skipping connect/handshake, no payment sent`. Total ~400-700ms per node with randomized sleeps.
- `_sleep(ms)` shared timer helper.
- `startDev()` now emits the full run prelude: `🔑 Setting up wallet…` → wallet line → `V2Ray: ✓ available` → `WireGuard: ✓ available` → `📡 Running baseline speed test…` → `Baseline speed: X Mbps …` (pushes `state.baselineMbps` so header card updates) → `🔍 Fetching node list…` → `Fetched N nodes total.` → `🔍 Phase 2: Scanning N nodes (dry run — serial)…` → `💳 Phase 3: payment batches — skipped (DRY RUN).` → loops through nodes with `_simulateNode` → `✓ Dry run complete — N processed, 0 connected, N skipped.`
- Each skipped row gets `row.baselineAtTest = state.baselineMbps` so the row's baseline column matches.
- `applyState()` called after baseline + each row so header stats animate in like a real run.
- `startPt()` mirrors same shape per batch (prefix `[B<n>]`), continuous loop with 1.5s gap, uptime counter.
- Swapped `renderStats()` (did not exist) to `applyState()` (the real state-reflector).

## 2026-04-24 — Dry Run pulls from CHAIN (not DB)
- Bug: dry run said "no nodes returned" on fresh DB because `/api/public/nodes` is DB-backed and DB was empty
- Real intent: dry run identifies **live on-chain nodes** and skips them. Not tied to DB at all.
- Added `GET /api/chain/nodes` (adminOnly) in server.js — wraps `getAllNodes()` from core/chain.js (RPC first, LCD fallback). Returns `{ total, results: [{ address, remoteUrl, remoteAddrs, gigabyte_prices, status, planIds }] }`.
- `_loadNodes` in admin.html now chain-first (`/api/chain/nodes`) with DB fallback.
- `_toSkippedRow` now derives a display moniker from `remoteUrl` hostname when chain node has no DB-side moniker/country/city.
- Per-node query (`/api/public/node/:addr`) still runs and merges when a match exists (previously audited nodes get richer display), otherwise falls back to chain fields.
- ⚠ Requires server restart to expose `/api/chain/nodes` — endpoint is 404 until restart.

## 2026-04-23 — Dry Run actually queries per-node properties
- User feedback: "dry run means we do all operations as normal, query each node, understand its properties and then skip"
- Found three bugs in the earlier dry-run module:
  1. `_loadNodes` read `data.nodes` — real envelope from `/api/public/nodes` is `{ total, offset, limit, window, results }`. Fixed to read `data.results` with fallback chain.
  2. `_toSkippedRow` used wrong field names (`n.address`/`n.type`) — real DB fields are `n.node_addr` / `n.service_type`. Rewrote to read real fields + merge per-node detail.
  3. No per-node query was happening — just walking the list.
- Added `_queryNode(addr)` → hits `/api/public/node/:addr` (which returns `{ node, history, errors }`).
- Added `_addrOf(n)` helper (tries `node_addr || address || sentnode`).
- `startDev()` now: fetches directory, per node logs `[i/total] Querying <moniker>…`, fetches detail, renders row from merged list+detail fields, logs `↳ <transport> · <country>/<city> · peers N → SKIPPED`, advances progress bar.
- `startPt()` now mirrors that pattern per iteration: loads nodes once, each batch logs `Dry batch #N started`, per node queries detail, bumps `_cb.tested`, `cbRender()`, logs same `↳ … → SKIPPED`, then 1.5s gap and loops.
- Still no POSTs / no SSE / no DB writes — only GETs to public read endpoints.

## 2026-04-23 — Dry Run simulator (admin.html)
- Two `DRY RUN` checkboxes: one beside Start Test (dev controls row), one in the Public Testing card near ptToggleBtn
- When checked, the panel's Start button short-circuits into `_dryRun.startDev()` / `_dryRun.startPt()` instead of hitting /api/start or /api/admin/public-test/start
- Pulls real nodes from `/api/public/nodes` (capped at 60), walks them one at a time (~350ms interval), each rendered as a row with `badge-skip` "SKIPPED"
- Dev sim updates: resultsArr, progress bar, progress label ("N% (dry run)"), log lines ("Connecting → moniker … skipped")
- PT sim updates: cbCard (tested/snapshotSize/iteration via real `_cb` fields), iteration counter, uptime, ptDot, then loops
- Sticky yellow banner "⚠ DRY RUN — <label> (simulated data, nothing saved)" at top of mainContent while active
- Extended row-render badge branch (admin.html ~1831): `r.skipped` → SKIPPED badge (uses existing `.badge-skip` class from admin.html:580)
- Nothing saved: no POSTs, no SSE, no DB, no audit.db touch

## 2026-04-23 — hide Node Performance Matrix in bundled mode
- admin.html:1207 matrix panel got `bundled-hide` class
- Added `body.mode-bundled .bundled-hide { display: none !important }` rule (admin.html ~line 789)
- New class because `dev-only` wouldn't work — the existing model doesn't hide dev widgets in bundled mode (bundled is a superset per CLAUDE.md)
- Live Log panel NOT touched — user only asked about the matrix

## 2026-04-23 — public summary bar + admin header rename
- Removed `.summary-bar` markup (4 cells: Active Nodes / Reliable Nodes / Typical Speed / Updated) from public.html
- Guarded `loadStats()` with element null-checks so the removed IDs (sumTotal/sumPass/sumMedian/sumUpdated) don't throw
- `.summary-bar` / `.summary-cell` CSS kept in place (inert without markup, harmless)
- admin.html:936 `<h1>SENTINEL AUDIT</h1>` → `<h1>SENTINEL NODE TEST</h1>`
- public.html h1 left as "Sentinel" (first rename was mistaken — user meant the admin title)
- Other "Sentinel Audit" strings remain in: index.html:516, server.js:718+735, node.html:6, docs/INTEGRATION.md:194, elevate.ps1, SentinelAudit.vbs, Setup.bat — NOT touched pending user confirmation

## COMPLETED (2026-04-23)
Wave A backend changes — ALL 6 TASKS DONE

## Wave A Commits
- c9ef3aa — Task 1+2+3: STATUS_ACTIVE fix, feegrant re-verify, RPC-first queries
- 42823ce — Task 4: Batch-model continuous testing (batches + batch_results DB tables, batch:* SSE events)
- 453a197 — Task 5: Server-side public/dev mode gating (requireMode middleware, /admin/mode endpoints)
- bcf79a4 — Task 6: Security audit report (SECURITY-AUDIT-2026-04-23.md)

## Security Audit Findings (bcf79a4)
HIGH:
- H-01: planId exposed in public SSE init (server.js:925) — strip planId/minDelayMs from init payload
- H-02: ADMIN_TOKEN stored verbatim in cookie — use session ID instead

MEDIUM:
- M-01: No X-Frame-Options on admin routes
- M-02: unsafe-inline in script-src weakens CSP
- M-03: Bespoke rate-limit map for /api/public/test/start (should use core/rate-limit.js)
- M-04: Invalid sort values silently fall back to default
- M-05: COOKIE_SECRET falls back to hardcoded literal when ADMIN_TOKEN not set

LOW: L-01..L-06 documented in SECURITY-AUDIT-2026-04-23.md

## Project State
- Port: 3001
- DB: data/audit.db (SQLite, migration v4 — batches + batch_results tables)
- Key files: server.js, core/chain.js, core/constants.js, audit/continuous.js, audit/pipeline.js, core/db.js
- Wave B: admin.html, public.html, live.html — NOT touched (per spec)

## Pending (Wave B)
- Fix H-01, M-01, M-02, M-03, M-05 from audit (Wave C?)
- Build live.html (Task from CLAUDE.md build order #4)
- Wire admin "Public Testing" toggle (CLAUDE.md #5)
- Add theme toggle to public.html (CLAUDE.md #6)
