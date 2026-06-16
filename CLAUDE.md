# Sentinel Node Tester — Project Instructions

> **New Claude session: read this file first, then `memory/handoff-node-tester.md` (current state), then `ARCH.md` (module map). Stop there.** Everything under `docs/` is reference material — open only when the task needs it. Files in `docs/archive/` are historical and may contradict current code; treat them as read-only context, never as source of truth. The user is the operator; the tester is their primary network audit instrument.

## What this is
Standalone tool for stress-testing every node on the Sentinel chain. Runs sessions, measures speed/latency, persists results in `audit.db` (SQLite). Type 1 deployment (Node.js server + browser dashboard) per global CLAUDE.md categorization. Published to npm as `sentinel-node-tester`. Canonical repo: `Sentinel-Bluebuilder/sentinel-node-tester` (renamed from `Sentinel-Bluebuilder` on 2026-04-30 — old URLs auto-redirect but always use the new name in new code/docs).

**Key purpose: on-chain performance oracle.** The tester is a primary publisher of node performance + concurrent-user data to the Sentinel chain. Every N tested nodes, the tester self-sends 1 udvpn with a compact binary memo (`SNTR1` magic prefix) so any consumer can ingest results via RPC `tx_search` — no off-chain API needed. See `core/onchain-report.js` (encoder/decoder/broadcaster/querier) and the "On-Chain Reporting" section in the admin settings drawer. Opt-in (off by default); batch size 1–6 (default 6) — capped because Sentinel's chain enforces a 256-char TX memo limit and 7 binary records would overflow base64. Region 2-letter ISO + tester baseline Mbps included in every batch header.

## Port
3001 (per global dashboard).

## Source-of-truth hierarchy (when docs disagree)
1. The code itself (especially `server.js`, `audit/pipeline.js`, `audit/node-test.js`).
2. This file (`CLAUDE.md`).
3. `memory/handoff-node-tester.md` — most recent session state.
4. `ARCH.md`, `DECISIONS.md`, `README.md`, `SETUP.md`, `TROUBLESHOOTING.md`.
5. `docs/*.md` — feature/integration references.
6. `docs/archive/*` — historical, often stale.

If `docs/archive/HANDOFF-2026-04-11.md`, `docs/archive/CONTEXT-2026-04-10.md`, or any other archived doc contradicts what's above it in this list, the higher item wins.

## Git Workflow — MASTER IS THE TRUNK

**We own this repo. We push to master directly. There is no upstream review gate.**

This rule exists because we burned ~2 hours on 2026-04-30 untangling a 3-week-old feature branch (`stop-and-error-popup`) that drifted from master while master got squash-merges of subsets of its commits. The branch and master ended up with the same code under different SHAs, every rebase/merge produced false conflicts, and the PR was perpetually `CONFLICTING`. Don't repeat it.

### Rules

1. **Default workflow: commit on master, push on master.** No PR, no branch. The repo is ours.
2. **Branch only for risky multi-day work** (e.g. SDK version bump, schema migration that needs staged rollout). Branch lifetime cap: 24 hours. If it's still alive after 24 hours, merge whatever's done back to master and continue work there.
3. **Never let a branch sit while master moves.** If you must branch and master gets a commit before you merge, your first action is `git pull --rebase origin master` BEFORE doing more work — not at merge time.
4. **No long-running PRs.** PRs are for code review by humans we don't have. Open one only if a collaborator explicitly asks for review. Otherwise: commit, push, done.
5. **If a branch already exists and has drifted, the disk wins.** The currently-checked-out working tree is the truth. Use `git push --force-with-lease origin <branch>:master` to set master to the branch tip if you've verified the tree is what you want shipped. This destroys divergent commits on master that aren't in your branch — only do it after confirming master has nothing the branch lacks (`git log master..HEAD` on the branch should be empty after a manual cherry-pick of any genuine master-only commits).
6. **Squash-merge is forbidden when commit history matters.** Either merge with `--no-ff` (preserves the commit SHAs) or push directly. The squash-merge of PR #1 to master under a different SHA than the branch's `4100ce0` is exactly what created today's confusion.
7. **Branches that ARE created get deleted the moment they merge.** No `backup/*`, no `wip/*`, no abandoned feature branches sitting around. `git branch -D` and `git push origin --delete` immediately on merge.
8. **`master` is always deployable.** No half-finished features behind feature flags counts — if it's on master, it ships. Use a runtime setting (like the `onchainEnabled` toggle) for opt-in features, NOT branch isolation.

### Allowed gh accounts
Repo `Sentinel-Bluebuilder/sentinel-node-tester` requires `gh auth switch --user Sentinel-Bluebuilder` before push (the default non-org gh account gets 403).

### When something gets weird
- "Branch has 11 commits ahead of master, 2 behind, won't merge cleanly" → STOP. Ask before any rebase/merge. The right answer is usually "force-set master to branch tip and delete the branch," not "spend an hour resolving fake conflicts."
- "I rebased and now my working tree is missing changes" → `git rebase --abort` immediately. The rebase has not yet rewritten any pushed commits unless you've force-pushed. Disk + reflog still has everything.
- Always create a `backup/<branch>-pre-<op>-<date>` local branch before any rebase or force-push. Delete it after the operation succeeds.

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

## Single Mode + Broadcast Live (current architecture, since 2026-04-25)

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
- `/api/admin/public-test/*` endpoints were removed in this collapse. If you find any reference to them in older docs, treat as stale.

### TEST RUN

TEST RUN is an optional skip-only demo — it is NOT a separate mode and it does NOT use a separate database.

- Pass `testRun: true` in the request body **or** `?testRun=1` as a query parameter on `POST /api/start`.
- The pipeline skips plan membership check, online scan, chain operations, and payments.
- Every node row gets `actualMbps: null, errorCode: 'TEST_RUN_SKIP'`.
- The run row is written to `audit.db` with `mode='test'` so it is visually distinguishable in the admin table.
- No second database. No `audit-dry.db`. One file on disk.

## Route Isolation — P2P / TEST RUN / SUBSCRIPTION PLAN

The tester has four start routes. Each MUST be reachable independently and MUST NOT bleed state into the others. State leakage caused issue 2026-04-29 (sub-plan picker hijacked into TEST_RUN_SKIP rows).

### Routes

| Route | Endpoint | Runner | Per-node behavior |
|-------|----------|--------|-------------------|
| Test Run (skip-only demo) | `POST /api/start` body `{testRun:true}` | `runAudit` | Short-circuits in `node-test.js` at `if (state.testRun)` → `TEST_RUN_SKIP` |
| P2P per-GB | `POST /api/start` body `{pricingMode:'gigabytes'}` | `runAudit` | Pays each session per GB from this wallet |
| P2P per-Hour | `POST /api/start` body `{pricingMode:'hours'}` | `runAudit` | Pays each session per hour from this wallet |
| Subscription Plan | `POST /api/test-sub-plan` body `{planId, subscriptionId, granter}` | `runSubPlanTest` | Subscription-allocated sessions; plan owner pays gas via fee grant (or self-paid when wallet IS the plan owner) |

### State pinning (server-side, in each runner)

Every runner MUST pin `state.testRun` and `state.runMode` at its top so prior-run state cannot leak in. Current invariants:

- `runAudit` (pipeline.js): `state.testRun = !!opts.testRun`; `state.runMode = testRun ? 'test' : 'p2p'`. Clears `runPlanId / runSubscriptionId / runGranter` when not subscription.
- `runSubPlanTest` (pipeline.js): forces `state.testRun = false`, `state.runMode = 'subscription'`, sets `runPlanId / runSubscriptionId / runGranter` from args.
- `runPlanTest` (pipeline.js, legacy): forces `state.testRun = false`, `state.runMode = 'subscription'`.
- `runRetestSkips` (pipeline.js): inherits the prior run's mode — never starts fresh.

### Client-side picker (admin.html)

`runSubPlanTest()` (the JS function called when the operator picks a plan from the modal) MUST always POST to `/api/test-sub-plan`. It MUST NOT branch on `isTestRunMode()` and fall through to `devStart(true)` — picking a specific plan is an explicit subscription request and overrides any leftover `_testingMode='testrun'` or `state.testRun=true` from a prior run.

### Don't-touch list

- Don't add an `if (isTestRunMode())` shortcut inside the client `runSubPlanTest()` function — it hijacks the route.
- Don't remove the `state.testRun = false` line at the top of `runSubPlanTest` / `runPlanTest` — it's the server-side guard.
- Don't move the `if (state.testRun)` short-circuit out of `node-test.js` — see TEST RUN don't-touch rules below.

## Theme (Dark/Light)
- Toggle exists on BOTH `admin.html` and `public.html` (and `/live`).
- Tokens live in `sentinel.css` under `:root` and `html[data-theme="light"]` at ~line 66.
- **NEVER hardcode `rgba(0,0,0,...)`, `rgba(255,255,255,...)`, `#fff`, `#000` in HTML/inline styles.** Always use tokens: `--bg`, `--bg-card`, `--bg-card-solid`, `--bg-input`, `--border`, `--border-hover`, `--text`, `--text-dim`, `--text-muted`, `--accent`, `--red`, `--green`.
- When fixing light-mode regressions, search for `rgba\(0,0,0|rgba\(255,255,255|#fff|#000|background:var\(--white\)` and swap to tokens.
- `--white` token exists but resolves to `#111` in light mode — do NOT use it for backgrounds expected to be white.

## Key Files
- `server.js` — Express app, all routes, SSE fan-out.
- `audit/continuous.js` — recursive loop runner, emits `loop:*` / `iteration:*` events.
- `audit/pipeline.js` — single-pass audit engine (called by continuous).
- `audit/node-test.js` — per-node test (status → price → payment → handshake → tunnel → speed).
- `core/chain.js` — chain queries (`querySubscriptions`, `queryFeeGrant`, `discoverPlans`). RPC-first per global rule; LCD only as fallback.
- `core/db.js` — SQLite schema + migrations + helpers (`insertErrorLog`, `searchNodes`, etc.).
- `core/onchain-report.js` — on-chain report wire format (`SNTR1` magic, 28-byte records, **≤6/batch**, capped by Sentinel's 256-character TX memo limit — 7+ records overflow base64 and the chain rejects with code 12 "memo too large"), `commitBatch` (memo TX), `queryReports` (RPC `tx_search`).
- `core/settings.js` — runtime-mutable settings: `onchainEnabled` / `onchainBatchSize` (1–6) / `onchainRegion` (2-char) live alongside P2P payment tunables.
- `public.html` — public directory (no action buttons).
- `admin.html` — admin control panel.
- `live.html` — public live-testing view (built; do NOT regenerate without reading first).
- `sentinel.css` — design tokens + theme.
- `bin/cli.js` + `bin/commands/` — `sentinel-audit` CLI.

## Server endpoints (current, post-2026-04-25 collapse)
- `POST /api/start` (adminOnly) — body `{ planId?, subscriptionId?, subscriptionGranter?, testRun?, infiniteLoop?, pricingMode? }`. Accepts `?testRun=1` query.
- `POST /api/stop` (adminOnly) — flips stop flag, wakes pending sleeps via `triggerPipelineStop()`.
- `POST /api/broadcast` (adminOnly) — flips `state.broadcastLive`. No body required.
- `GET  /api/broadcast` — returns `{ broadcastLive: boolean }`. Open.
- `GET  /api/public/events` (SSE — forwards live events only when `broadcastLive=true`)
- `GET  /api/public/nodes`, `/api/public/node/:addr`, `/api/public/countries`, `/api/public/runs/current|last`, `/api/public/stats`, `/api/public/node/:addr/errors`
- `GET  /api/onchain-reports?limit=20&fromHeight=0&address=…` — RPC `tx_search` of past report TXs from this tester (or any address). Open.
- `GET/POST /api/settings` — runtime audit settings (read open, write `adminOnly`); on-chain reporting flags live here.

## Release status
- npm: `sentinel-node-tester@1.4.0` (latest).
- GitHub: `Sentinel-Bluebuilder/sentinel-node-tester` master + open PR #2 on `stop-and-error-popup` (PR #1 merged).
- Pushes to that org require `gh auth switch --user Sentinel-Bluebuilder` first (the default non-org gh account gets 403).

## Boot Path — DO NOT regress (post-2026-04-30)

The server boot path was hardened after a silent-zombie incident: `node server.js` ran at ~93MB RAM, idle CPU, never bound port 3001, and **wrote zero bytes to stdout** because the process deadlocked during module init while stdout was block-buffered. The fixes below are load-bearing — every one of them must stay in place.

### Invariants
1. **Stdout MUST be line-buffered.** `server.js` calls `process.stdout._handle?.setBlocking?.(true)` and `process.stderr._handle?.setBlocking?.(true)` at the top of the file. Without this, redirected output (Start-Process, `node server.js > log.txt`) hides every console.log if the process hangs before `app.listen`. Do not remove.
2. **No blocking I/O at module scope before `app.listen`.** `emergencyCleanupSync()` runs `sc query` / `sc stop` / `sc delete` on Windows, each with 5s timeouts. It MUST be called inside the `app.listen` callback via `setImmediate(...)`, never at module top-level. Same rule applies to any future cleanup, RPC handshake, or chain query that could block: defer it to after the port is bound.
3. **Top-level `await import(...)` of platform modules MUST have a timeout.** The wireguard import is wrapped in `Promise.race([_wgImport, timeout(5000)])` with a fallback that sets `WG_AVAILABLE=false`. If you add another platform-specific dynamic import, copy the same pattern.
4. **`uncaughtException` and `unhandledRejection` handlers MUST `process.exit(1)`** after running cleanup. Without `process.exit`, the event loop keeps going on a half-initialised state and you get the silent zombie back. Both handlers must also print the **full stack** (`err?.stack || err?.message || String(err)`) — `String(reason)` alone drops the stack when reason is an Error.
5. **No empty `catch {}` on the boot path.** Project-wide rule per global CLAUDE.md, but enforced strictly for: `server.js` boot block (state-snapshot restore, setActiveDbRunId), `core/chain.js` getRpcClient/cleanupRpc/disconnectRpc, `core/db.js` PRAGMA + checkpoint catches. These all log via `console.error('[component] thing failed:', e.message)`. Cleanup-only catches in `audit/pipeline.js` tunnel teardown are intentional and stay silent.

### DB lock hygiene
- `core/db.js:_openHandle` sets `PRAGMA busy_timeout = 5000` so writers wait instead of failing immediately with `SQLITE_BUSY` when ad-hoc scripts compete for the WAL lock.
- `core/db.js` registers `process.on('exit', closeDb)` so any importer (the server, CLI commands, ad-hoc `node -e "import('./core/db.js')..."` verifiers) releases the WAL lock cleanly on exit. **A hung verifier without this hook deadlocks every subsequent `getDb()` call.**
- Never run an ad-hoc `node -e` import of `core/db.js` while the server is starting. If you must verify migrations, kill the server first or use a `:memory:` handle.
- Scripts in `scripts/` (cleanup, probe-plan36-scan) hold the WAL lock for their full lifetime — don't run them in parallel with the server. `cleanup.mjs` opens the DB read-only in report mode; only `--fix` writes (after backing up audit.db + index.json).

### When boot still hangs
The server now logs loudly on boot failure. If a future regression brings back the silent-zombie pattern, the diagnosis order is:
1. Check stderr — if empty, `setBlocking` was reverted; restore the call at the top of `server.js`.
2. If stderr shows an unhandledRejection without `process.exit`, the handler was reverted; restore lines 173-186 of `server.js`.
3. If stderr shows `wg-import-timeout`, a platform module is hanging on a sync probe — investigate `platforms/<os>/wireguard.js` module-scope `execSync` calls.
4. If port is held by a stale node PID, kill that PID specifically (NEVER `taskkill /F /IM node.exe`).

## Don't
- Don't add public-facing buttons. Ever.
- Don't regenerate `audit/continuous.js`, `audit/pipeline.js`, `audit/node-test.js`, `live.html`, `admin.html`, or `public.html` without reading them first.
- Don't commit `.env` or `MNEMONIC=...`.
- Don't `taskkill /F /IM node.exe` — kills Claude Code's own runtime. Kill exact PIDs only.
- Don't hide or remove the per-row failure copy button — the failure-log UX is a MUST, not a polish item.
- Don't reach for LCD endpoints as the primary path. RPC-first per global rule.
- Don't treat `docs/archive/*` as authoritative — those files are historical snapshots and may describe UI/routes/code that no longer exists.
- **DON'T FUCK WITH TEST RUN.** Never modify TEST RUN code paths. The canonical implementation lives on GitHub at `Sentinel-Bluebuilder/sentinel-node-tester` — that is the source of truth. This includes:
  - The `if (state.testRun)` short-circuit in `audit/node-test.js` (the block that returns early with `errorCode: 'TEST_RUN_SKIP'` after price discovery).
  - The TEST RUN branching in `audit/pipeline.js` (anything gated on `state.testRun`, including the batch-payment skip and `state.testRun = ...` assignment).
  - The `testRun` flag plumbing through `POST /api/start` (body `testRun: true` and query `?testRun=1`) in `server.js`.
  - The `mode='test'` row write in `core/db.js`.
  - Any helper that exists solely to support TEST RUN (skip flags, `TEST_RUN_SKIP` error code, test-run UI badges, etc.).
  - The vocabulary is `test`/`testRun`/`test-run`/`TEST_RUN` ONLY — never reintroduce `dry`/`dryRun`/`dry-run`/`DRY_RUN` anywhere in the project.
  If a parity refactor, SDK upgrade, or "cleanup" seems to require touching TEST RUN — STOP. Ask the user first. Do not refactor, rename, "consolidate", "simplify", or otherwise modify these paths under any pretext. If you find local divergence from the GitHub canonical version, the local version is wrong; restore from GitHub. Treat TEST RUN as immutable.
