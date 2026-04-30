# Changelog

All notable changes to `sentinel-node-tester`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Refund-reconciled spend totals (per-GB / per-Hour P2P).** After every
  batch's `submitBatchCancel`, `audit/pipeline.js` now reads the wallet
  balance and compares to the expected balance (`balanceUdvpn − spentUdvpn`).
  Any positive delta is treated as a refund credit: `state.refundedUdvpn`
  accumulates the cumulative refund, `state.spentUdvpn` is reduced by the
  same amount so the live spend tile shows net spend, and a
  `↩ Refund credited: X.XXXX P2P (cumulative refunded: …; net spend: …)`
  log line is broadcast. Both `refundedUdvpn` and `estimatedTotalCost` are
  now in `PUBLIC_STATE_KEYS`, and `admin.html` renders a new green
  `Refunded` header tile next to `Spend` (hidden as `--` until the first
  refund lands). Avoids relying on Sentinel's settlement-block
  `EventRefund` (which is emitted by the chain itself, not by the user TX,
  and therefore not visible to `tx_search`).
- **Per-GB / per-Hour suffix in the P2P mode badge.** Both `admin.html` and
  `/live` now render the active pricing mode at the end of the P2P badge
  detail line — e.g. *"All online nodes — direct peer-to-peer payments per
  session : Testing All Nodes - Paying Per GB"* (and *Per Hour* in the hourly
  variant). Reads `state.pricingMode` (already in the public sanitize
  whitelist), defaults to per-GB if absent. Subscription-plan and Test-Run
  badges are unchanged.
- **`/live` ETA readout** next to the progress bar — same linear projection
  admin uses (`remaining * elapsed / tested`), formatted `HH:MM:SS`. Shows
  `ETA —` until snapshot size and at least one tested row are known. Ticks
  every second between SSE events for a smooth countdown.
- **Human-readable error labels in the public failure popup.** `public.html`
  now maps DB `error_code` strings (`HANDSHAKE_TIMEOUT`, `TCP_PORT_DEAD`,
  `SOCKS5_NO_CONNECTIVITY`, etc.) to plain-English labels via a new
  `errLabel()` / `ERR_LABELS` helper. The raw code stays alongside the label
  in monospace so the operator can still grep logs by canonical code.
  Unknown codes fall back to a Title-Cased version of the raw string instead
  of bare `UNKNOWN`.
- **On-chain reporting status dot.** `admin.html` toggle button now shows a
  red/green dot at the front: red when `onchainEnabled=false`, green (with
  soft glow) when on. Button background stays transparent — only the dot
  lights up. Bug found at the same time: page-load state read
  `d.onchainEnabled` from `/api/settings`, but the response is
  `{settings:{...}}`, so the indicator was always rendering OFF; fixed to
  read `d.settings.onchainEnabled`.

### Fixed
- **Boot-time silent zombies eliminated.** `server.js` could deadlock during
  module init (top-level `await import('./platforms/windows/wireguard.js')`
  runs sync `execSync` probes; `emergencyCleanupSync()` called at module
  scope blocks the event loop on slow Service Control Manager) while
  stdout was block-buffered when redirected — symptom: process alive at
  ~93MB RAM, idle CPU, no port bound, zero log output. Fixes:
  - `server.js` forces `process.stdout._handle.setBlocking(true)` at the
    top of the file so console.log flushes immediately even when redirected.
  - The platform-wireguard `import()` is now wrapped in a 5s
    `Promise.race` timeout; on timeout the server falls back to
    `WG_AVAILABLE=false` and logs `[boot] WireGuard import failed`.
  - `emergencyCleanupSync()` no longer runs at module scope — it's
    deferred via `setImmediate` inside the `app.listen` callback so a
    slow SCM can't gate startup.
  - `process.on('uncaughtException'|'unhandledRejection')` now print
    full stack traces (`reason?.stack || reason?.message || String(reason)`)
    and `process.exit(1)` after cleanup. Previously they ran cleanup and
    let the event loop continue on a half-initialised state — the silent
    zombie pattern.
  - State-snapshot restore `catch {}` at boot now logs the error.
- **DB lock leaks from ad-hoc scripts.** `core/db.js` adds
  `PRAGMA busy_timeout = 5000` so writers wait instead of failing
  immediately with `SQLITE_BUSY`, and registers `process.on('exit',
  closeDb)` so any process that imports `core/db.js` (including
  `node -e "import('./core/db.js')..."` verifiers) releases the WAL lock
  cleanly on exit. Previously a hung verifier could lock `audit.db-wal`
  and block server boot indefinitely.
- **Silent error handlers logged with context.** Several previously empty
  catch blocks now surface their cause: `core/chain.js` `getRpcClient` /
  `cleanupRpc` / `disconnectRpc`, `core/db.js` `useDb` PRAGMA failures
  and `wal_checkpoint` close failures, `audit/continuous.js`
  `_getDb().catch`, `audit/pipeline.js` `_flushOnchainBatch().catch`.
  Cleanup-only catches in pipeline tunnel teardown intentionally remain
  silent.
- **`/live` sticky column-header band was translucent during scroll.** The th
  box-shadow only painted the 6px gap *above* each cell, so when body rows
  scrolled past, the 4px `border-spacing` stripe *below* the header row let
  rows of data flash through the band. Added a downward `0 6px 0 0 --bg-card-solid`
  shield (plus a 1px `--border` underline at +7px) so the header reads as a
  fully opaque band on every scroll position in both themes.
- **History pills (`Last 10 Baseline Readings` / `Last 10 Node Speeds`) rendered
  as run-on digits with no separation/colors, e.g. `4.620.920.5…`.** Two
  independent bugs:
  1. `.h-pill-good` / `.h-pill-bad` referenced `var(--accent-green)` /
     `var(--accent-red)` tokens that don't exist in `sentinel.css` — the actual
     tokens are `--green` / `--green-bright` / `--green-dim` (and `--red`
     equivalents). The pill `color` resolved to the inherited body color and
     the rgba backgrounds were too faint to register as pills. Switched to the
     real tokens (and dropped hardcoded `rgba()` fills in favor of `--*-dim`).
     Same fix applied in `index.html`.
  2. `runSubPlanTest` and `runPlanTest` in `audit/pipeline.js` did not reset
     `state.baselineHistory` / `state.nodeSpeedHistory` (and several counters)
     on a fresh run, so subscription-plan reruns kept appending to the prior
     run's pills instead of starting clean. Both runners now zero
     `passed10/passed15/passedBaseline` and clear the two history arrays in
     the same `if (!resume)` block where `testedNodes`/`failedNodes` reset.
  `renderHistory()` is now also defensive against legacy number-only entries
  (coerces to `Number(e)` when `e.mbps` is missing) so a stale snapshot from
  before the `{mbps,ts}` schema can't crash the render.
- **`/live` baseline column was always `--`.** Root cause:
  `audit/continuous.js` `_sanitizeBatchNodeResult` stripped `baselineAtTest`
  from the public payload, so `batch:node:result` arrived without baseline.
  Now forwards it as `baselineMbps`. Server's public sanitizer
  (`server.js:1180`) was already passing it through, and `live.html` already
  reads `d.baselineMbps` on the SSE upsert — column populates immediately.
- **`/live` baseline column reverted to `--` on page refresh and on every
  historical row.** The previous fix only patched the live SSE forward path.
  The DB schema itself had no `baseline_mbps` column, so refresh / historical
  hydration (`/api/public/runs/current` and `/api/public/runs/last`) returned
  `null` for every row. Added migration v9 to `core/db.js`:
  `ALTER TABLE results ADD COLUMN baseline_mbps REAL` and the same on
  `batch_results`. `mapResultToRow` + `_insertResultSql` now persist
  `r.baselineAtTest`; `insertBatchResult` accepts
  `baselineMbps | baseline_mbps | baselineAtTest`; the second batch_results
  writer in `server.js` (the inline `withBatchTracking` middleware) writes
  `baseline_mbps: r.baselineAtTest ?? r.baselineMbps ?? null`; and
  `getActiveBatch` / `getBatchWithNodes` / `getLastBatch` / `getBatchResults`
  all project `baseline_mbps AS baselineMbps`. Migration is idempotent
  (PRAGMA-checks the column before ALTER) so re-runs on a v9 DB are no-ops.
- **`/live` progress bar jumped to 100% on the first row.** `cbRender()` used
  `total = snap || tested` as the denominator, so before the snapshot-size
  arrived from `batch:start`, every new row made `tested === total` and the
  bar pinned to 100%. Fixed by gating pct on `snap > 0`; bar holds at 0%
  until the snapshot is known, then tracks `tested / snap` exactly. Counter
  card and bar now read from the same single source.
- **`/live` pager stuck at "Page 1 of 3 — 1–50 of 142" on a fresh test.**
  Rehydrated rows from `localStorage` survived into a new run because the
  `batch:start` reset only fired when a prior `_cb.batchId` was already
  set. Reset now also fires when `_cb.batchId == null` AND `resultsArr` is
  non-empty — i.e., we just refreshed mid-old-run and a new batch is
  starting.
- **Admin Mbps column drift on rows with the ⚡ ISP-bottleneck glyph.** The
  glyph was appended after the Mbps string with no width reservation, so
  rows with `ispBottleneck=true` rendered wider than rows without and
  broke right-alignment. Fixed by wrapping the value in a flex inline
  container with a fixed-width 14px slot for the glyph (empty string when
  absent), so all rows allocate the same horizontal space.
- **Admin Live Log was capped at 400px.** `.logs` had a hard
  `max-height: 400px` and the parent `.log-container` didn't flex to fill
  the page. Now `min-height: 320px`, `max-height: calc(100vh - 240px)`,
  with `flex: 1 1 auto` on both the container and the log body so it
  stretches to the viewport instead of stopping at a fixed pixel cap.

### Removed
- **Duplicate on-chain reporting controls inside the P2P Payment Settings
  drawer.** The per-GB / per-Hour `⚙ SETTINGS` button opened a drawer that
  duplicated the Enable / Nodes-per-report / Region / Recent-reports block
  already owned by the standalone "On-Chain Reporting" header popup
  (`openOnchainPopup`). Two surfaces for the same settings was a footgun
  (last-write-wins drift between drawers). Removed the on-chain section,
  its reset/save hydration, and the Recent-reports refresh handler from
  `openP2pSettingsDrawer`. Header `On-Chain Reporting` button is now the
  sole entry point.
- **Inline `error_code` chip from the live admin log and the per-row
  failure-error column.** `live.html` no longer renders the small
  `[ERR_CODE]` chip in inline log entries, and the admin/live node-detail
  drawers no longer include the `Error Code` row. Per-row clipboard copy
  blocks still include the canonical code (failure-log MUST is preserved);
  only the visible UI chip/row was dropped pending the redesigned logs
  panel.

### Changed
- **On-chain memo format switched from binary base64 to legible CSV (v2).**
  Old format was opaque on p2pscan (a base64 blob). New format is plain ASCII
  the operator and any consumer can read without a binary decoder:
  ```
  SNTR1|v2|<region>|b=<baselineMbps>|t=<unixSeconds>
  <addr>|<ok>|<mbps>|<peers>|<lat>
  …
  ```
  Header carries the tester's baseline once (not per record). Per-record
  fields: full bech32 address, ok=1/0, measured Mbps (one decimal, empty for
  failed), concurrent peers at test time, handshake latency in ms.
  Pipeline now uses a greedy packer (`packBatch` in `core/onchain-report.js`)
  that fits as many records as the 256-char memo allows — typically **4–5
  per TX** depending on value lengths, vs. the old hard-coded 6. Records that
  don't fit roll into the next TX. The decoder still understands v1 binary
  base64 memos so historical TXs render correctly in the history popup.

## [1.4.1] — 2026-04-30

### Fixed
- **On-chain reporting was completely broken in 1.4.0.** Every batch broadcast
  failed silently with chain code 12 (`memo too large: maximum number of
  characters is 256 but received 956 characters`). Root cause: `MAX_RECORDS`
  was set to 50 but Sentinel's chain enforces a 256-character TX memo limit.
  Base64 encodes 3 raw bytes into 4 chars, so a 256-char memo holds at most
  `floor(256/4)*3 = 192` raw bytes. With our 15-byte header + 28-byte records,
  the true ceiling is `floor((192-15)/28) = 6` records per batch. Reduced
  `MAX_RECORDS` to **6** in `core/onchain-report.js` and added a defensive
  `MEMO_CHAR_LIMIT = 256` guard in `commitBatch` that throws before broadcast
  if the encoded memo would exceed the chain cap. On-chain reports now post
  successfully and are visible at `https://p2pscan.com/transaction/<hash>`.
- `core/settings.js` `onchainBatchSize` default lowered from 25 to 6 and
  `sanitize()` now clamps the value to `1..6` (was `1..50`). Existing settings
  with higher values are auto-clamped on read; a `POST /api/settings` with a
  legacy value of 25 persists as 6 silently.
- `audit/pipeline.js` `_flushOnchainBatch` slice cap reduced from 50 to 6 so
  the in-memory buffer can never present an oversized batch to the encoder.
- `admin.html` failure-log copy buttons across `admin.html`, `public.html`,
  and `live.html` now check `res.ok` before parsing JSON, so a 404/500 from
  `/api/public/node/:addr/errors` produces a clean error toast instead of a
  silent JSON parse exception.

### Added
- **p2pscan.com TX links wired through three surfaces** so the operator can
  click a hash and view the on-chain report:
  - `audit/pipeline.js` `_flushOnchainBatch` now appends a clickable URL to
    the broadcast log line:
    `📡 On-chain report posted: N nodes, MB @hH → https://p2pscan.com/transaction/<hash>`
  - `admin.html` Recent Reports list (both `data.reports.map` blocks)
    renders the TX hash as an `<a target="_blank">` styled with `--accent`.
  - `admin.html` and `live.html` `appendLog` now auto-linkify every
    `https?://...` URL inside any broadcast log message — escapes HTML first,
    then wraps URL spans with `<a target="_blank" rel="noopener">`.
- `(?)` info popup in admin.html on-chain reporting section corrected: now
  states "up to **6 records** (244 base64 chars) and costs ~200,000 udvpn
  gas" instead of the prior "up to 50 records" claim, and the wire-format
  spec line `count 1B uint8 (≤50)` is now `count 1B uint8 (1–6, chain memo
  cap)` to match the encoder.
- `CLAUDE.md` documents the chain memo cap explicitly: batch size 1–6 (default
  6) "capped because Sentinel's chain enforces a 256-char TX memo limit and
  7 binary records would overflow base64", with a parallel note on
  `core/onchain-report.js`'s key-files entry calling out chain rejection code
  12 by name.

### Documentation
- `core/onchain-report.js` header comment rewritten to walk through the
  256-char chain memo limit, the base64 ratio, and the math that produces
  the 6-record ceiling — so future Claude sessions don't reintroduce the
  bug by raising `MAX_RECORDS`.
- `admin.html` settings hint under `#setOnchainBatchSize` (and the matching
  `#ocBatchSize` input) explains the 256-char chain memo cap to operators.
  Inputs `min="1" max="6"` enforce it at the form level.

## [1.4.0] — 2026-04-25

### Added
- Cross-platform `SETUP.md` covering Windows, macOS, and Linux.
- `.gitattributes` enforcing LF line endings on source files and CRLF on
  Windows-only scripts.
- `start.sh` launcher for Linux/macOS (re-execs under sudo for WireGuard).
- `CONTRIBUTING.md` and this `CHANGELOG.md`.
- Real `platforms/linux/README.md` and `platforms/macos/README.md` (replacing
  placeholders).
- `.env.example` now documents every variable read by the code, including
  `LISTEN_HOST`, `LCD_ENDPOINTS`, `DNS_SERVERS`, `INSECURE_COOKIE`,
  `ENABLE_HSTS`, `ALLOW_PUBLIC_TEST`, and the public-test plan/sub fields.
- `package.json` `files` whitelist now ships `sentinel.css`, `about.html`,
  `index.html`, the `fonts/` directory, and `scripts/cleanup-runaway-runs.mjs`.
- `core/onchain-report.js` — **on-chain performance oracle**. Every N tested
  nodes, the tester self-sends 1 udvpn with a compact binary memo (`SNTR1`
  magic + version + region + baselineMbps + startedAt + count + records).
  Includes encoder, decoder, RPC `commitBatch` broadcaster, and RPC
  `tx_search` `queryReports` consumer. Opt-in via `onchainEnabled` setting.
- `core/settings.js` — runtime-mutable settings (`gigabytes`, `batchSize`,
  `autoCancelAfterTest`, `maxPriceUdvpn`, `onchainEnabled`,
  `onchainBatchSize`, `onchainRegion`) with `clampInt` sanitization on read
  and write.
- `bin/commands/universal-test.js` — single CLI entrypoint that probes node
  reachability across SDK paths.
- `core/db.js` `error_logs.raw_json` column (migration v3) — captures the
  full diagnostic blob alongside the truncated message so the failure-log
  popup can render structured diag fields (status, transports, last attempt
  stage) without losing the raw payload.
- Failure-popup enrichment across `admin.html`, `public.html`, and `live.html`:
  the per-row copy button now produces a multi-line block with sections for
  Node / Address / Stage / Error code / Captured / Message / Log snippet /
  Diag (parsed from `raw_json`).
- `live.html` log-filter NODE/FAIL/SYS regex now matches the actual broadcast
  prefixes (was over-restrictive, hid lines that started with emoji glyphs
  or `[scope]` tags).
- TEST RUN flag (`testRun: true` body or `?testRun=1` query) on
  `POST /api/start`. Writes `mode='test'` rows to the single `audit.db`.

### Changed
- Single-mode collapse: removed dual-mode (dev/bundled/public) system in
  favor of a single mode plus a `broadcastLive` toggle. One database
  (`audit.db`), one set of routes.
- `/api/admin/public-test/*` endpoints removed.
- `state.broadcastLive` boolean controls whether public SSE / `/live` reflect
  the in-flight audit or the last-completed snapshot. Toggled via
  `POST /api/broadcast`.

### Removed
- 70+ ad-hoc dev scripts under `scripts/` (analyzers, probes, retests, plan
  checkers, dump utilities). The published package now ships only
  `postinstall.js`, `backfill-runs.mjs`, and `cleanup-runaway-runs.mjs`.
- Stale `csharp-bridge/` project and its launcher (`SentinelAuditLauncher.cs`)
  — the C# SDK path was decommissioned.
- Legacy `tools/smoke-public-mode.mjs` (referenced removed `PUBLIC_MODE`
  helpers from before the mode collapse).
- Local-only artifacts: `fresh-clone-test/`, `agent-map.json`, `suggestions/`,
  duplicate V2Ray binaries in `bin/`, root-level `*.log` files.

## [1.3.x] and earlier

See git history.
