# Changelog

All notable changes to `sentinel-node-tester`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  successfully and are visible at `https://p2pscan.com/transactions/<hash>`.
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
    `📡 On-chain report posted: N nodes, MB @hH → https://p2pscan.com/transactions/<hash>`
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
