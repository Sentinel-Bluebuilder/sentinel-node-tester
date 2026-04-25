# Sentinel Node Tester — Project Instructions

## Role
Standalone tool for stress-testing every node on the Sentinel chain. Runs sessions, measures speed/latency, persists results. Type 1 deployment (CLI/browser) per the global CLAUDE.md categorization.

## Hard Rules — Public Dashboard

**The public dashboard MUST have ZERO user-facing action buttons.**

- No "Start Test", no "Resume", no "Rescan", no "Retest Failed", no "Public Test Start/Stop" buttons visible to public.
- Public only sees: **node list + search + filters + sort + detail drawer**.
- Only the admin can start/stop testing.
- Public visitors are spectators. Ever.

## Failure-Log UX (MUST)

Every failure in a batch must produce a durable, user-copyable log. This is non-negotiable — transparency is the product.

- `audit/pipeline.js` calls `insertErrorLog()` for every failed result. Do not remove that call or gate it behind a flag.
- `core/db.js` owns the `error_logs` table (migration v2) and the `insertErrorLog` / query helpers. The admin drawer and public drawer both read from `/api/public/node/:addr/errors?limit=N`.
- Every failed row in the results table — on `admin.html`, `public.html`, AND `live.html` — MUST render a per-row copy button (`.row-copy-btn`, glyph `⎘`) that calls `copyRowFailure(ev)`, fetches the latest stored failure log, and copies a multi-line formatted block (header `Sentinel Node Tester — Failure Log`, then Node / Address / Stage / Error code / Captured / Message / Log snippet).
- The copy helper MUST have both `navigator.clipboard.writeText` AND a `<textarea> + execCommand('copy')` fallback for insecure contexts.
- The node-detail drawer on admin.html ALSO has a "Copy Failure Logs" button (`#copyFailureLogsBtn`) + "Download .txt" button — keep both wired.
- When a public visitor opens a node's detail drawer via search, the last batch's failure log MUST be visible if the node failed that batch.

Remove or downgrade any of these and the product regresses to opaque — do not do it.

## Single Mode + Broadcast Live (2026-04-25)

The dual-mode (dev/bundled/public) system has been collapsed. There is now **one mode**. There is **one database** (`audit.db`).

### Broadcast Live toggle

`state.broadcastLive: boolean` controls whether public surfaces (`public.html`, `/live`, `/api/public/events`, `/api/public/runs/current`) reflect the live in-flight audit or the last-completed snapshot.

| `broadcastLive` | What the public sees |
|-----------------|----------------------|
| `false` (default) | Last-completed run snapshot only. Public SSE is silent during an active audit. |
| `true` | Public SSE fan-out becomes active — live progress events are forwarded in real time. `/live` upgrades from snapshot view to live progress view. |

- Toggled by the admin via `POST /api/broadcast` (`adminOnly`). Body ignored; it flips the current value.
- Read via `GET /api/broadcast` — returns `{ broadcastLive: boolean }`.
- No mode cookie, no `requireMode` middleware, no `_currentMode` client state. Those are gone.

### TEST RUN (dry run)

TEST RUN is an optional skip-only demo — it is NOT a separate mode and it does NOT use a separate database.

- Pass `dryRun: true` in the request body **or** `?dryRun=1` as a query parameter on `POST /api/start`.
- The pipeline skips plan membership check, online scan, chain operations, and payments.
- Every node row gets `actualMbps: null, errorCode: 'TEST_RUN_SKIP'`.
- The run row is written to `audit.db` with `mode='dry'` so it is visually distinguishable in the admin table.
- No second database. No `audit-dry.db`. One file on disk.

## Theme (Dark/Light)
- Toggle exists on BOTH `admin.html` and `public.html` (and `/live` when built).
- Tokens live in `sentinel.css` under `:root` and `html[data-theme="light"]` at ~line 66.
- **NEVER hardcode `rgba(0,0,0,...)`, `rgba(255,255,255,...)`, `#fff`, `#000` in HTML/inline styles.** Always use tokens: `--bg`, `--bg-card`, `--bg-card-solid`, `--bg-input`, `--border`, `--border-hover`, `--text`, `--text-dim`, `--text-muted`, `--accent`, `--red`, `--green`.
- When fixing light-mode regressions, search for `rgba\(0,0,0|rgba\(255,255,255|#fff|#000|background:var\(--white\)` and swap to tokens.
- `--white` token exists but resolves to `#111` in light mode — do NOT use it for backgrounds expected to be white.

## Port
- 3001 (per global dashboard).

## Key Files
- `server.js` — Express app, all routes, SSE fan-out.
- `audit/continuous.js` — recursive loop runner, emits `loop:*` / `iteration:*` events.
- `audit/pipeline.js` — single-pass audit engine (called by continuous).
- `core/chain.js` — LCD v3 queries, `querySubscriptions`, `queryFeeGrant`, `discoverPlans`.
- `public.html` — public directory (no action buttons).
- `admin.html` — admin control panel.
- `live.html` — NOT YET BUILT. Public live-testing view. See architecture doc.
- `sentinel.css` — design tokens + theme.

## Existing Server Infrastructure (2026-04-25 audit)
- `POST /api/start` (adminOnly) — body `{ planId?, subscriptionId?, subscriptionGranter? }`. Accepts optional `dryRun: true` in body or `?dryRun=1` query param to run a skip-only demo audit.
- `POST /api/broadcast` (adminOnly) — flips `state.broadcastLive`. No body required.
- `GET  /api/broadcast` — returns `{ broadcastLive: boolean }`. Open.
- `GET  /api/public/events` (SSE — forwards live events only when `broadcastLive=true`)
- `GET  /api/public/nodes`, `/api/public/node/:addr`, `/api/public/countries`, `/api/public/runs/current|last`, `/api/public/stats`

## Build Order (current pending work)
- DONE 2026-04-23: Fix remaining light-mode regressions (MUST-FIX items).
- DONE 2026-04-23: Build admin search (#18) — prototype in `admin.html`.
- DONE 2026-04-23: Port search to `public.html` (#20).
- DONE 2026-04-23: Build `/live` page + route (Option B).
- DONE 2026-04-25: Collapsed dual-mode (dev/bundled/public) → single mode + `broadcastLive` toggle. Removed mode cookie, `requireMode` middleware, `_currentMode`, `_applyModeUI`, `selectMode`, `switchMode`, mode overlay, public-test endpoints. Added `POST /GET /api/broadcast`.
- DONE 2026-04-25: Consolidated `audit-dry.db` into `audit.db`. TEST RUN is now `?dryRun=1` on `/api/start`, writes `mode='dry'` rows to the single DB.
- PENDING: Add theme toggle to `public.html` (#22).

## Don't
- Don't add public-facing buttons. Ever.
- Don't regenerate `audit/continuous.js` or `audit/pipeline.js` without reading first.
- Don't commit `.env` or `MNEMONIC=...`.
- Don't `taskkill /F /IM node.exe` — kills Claude Code's own runtime.
- Don't hide or remove the per-row failure copy button — the failure-log UX is a MUST, not a polish item.
