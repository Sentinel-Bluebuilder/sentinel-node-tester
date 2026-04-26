# Architecture — Public Live View

**Updated:** 2026-04-25 (single-mode refactor)
**Original decision date:** 2026-04-23 — Option B chosen (same server, `/live` route + `live.html`).

## Overview

There is one server, one database (`audit.db`), and one operating mode. The admin decides whether live audit progress is visible to the public by toggling `broadcastLive`.

```
admin.html  ──POST /api/broadcast──►  state.broadcastLive = true/false
                                              │
                          ┌───────────────────┘
                          ▼
              /api/public/events  (SSE fan-out)
                  │
       broadcastLive=false         broadcastLive=true
       ────────────────────        ──────────────────
       Public SSE is silent.       Live progress events forwarded.
       public.html + /live show    /live upgrades from snapshot
       last-completed snapshot.    view to live progress view.
```

## Constraints (unchanged from original)
1. Zero user-facing action buttons on any public surface.
2. Public can watch live testing progress only when the admin has enabled broadcast.
3. Public can search nodes (moniker, address, country, city).
4. Admin controls start/stop and broadcast. Public never does.
5. Share-friendly URL (`/live`).

## Pages

| Page | Role |
|------|------|
| `admin.html` | Full control panel. Start/stop audit. Toggle Broadcast Live. View all results. |
| `public.html` | Static node directory + search + filters + sort. No action buttons. Shows last-completed run snapshot. |
| `live.html` | Public live view. SSE-driven via `/api/public/events`. Shows live progress when `broadcastLive=true`; falls back to last-completed snapshot when `broadcastLive=false`. No action buttons. |

## Broadcast Live Toggle

- `POST /api/broadcast` (`adminOnly`) — flips `state.broadcastLive`. No request body required. Returns `{ broadcastLive: boolean }`.
- `GET /api/broadcast` — returns current value. Open (no auth).
- When `broadcastLive` is set to `true`:
  1. Admin clicks "Broadcast Live" in `admin.html`.
  2. `state.broadcastLive` flips to `true` on the server.
  3. `/api/public/events` SSE begins forwarding live `batch:*` and `loop:*` events to all connected public clients.
  4. `live.html` receives the events and switches from snapshot view to live progress view (same `cbCard` widget used in admin).
- When `broadcastLive` is set back to `false`:
  1. SSE fan-out goes silent.
  2. `live.html` returns to showing the last-completed run snapshot.

## Database

One database: `audit.db`. All runs — live and dry — write to it.

- Normal audit run: `mode='live'` (or absent/null for legacy rows).
- Test-run (`?testRun=1` on `/api/start`): `mode='test'`. Every node row gets `actualMbps: null, errorCode: 'TEST_RUN_SKIP'`. Visually distinguishable in the admin table but stored in the same file.
- `audit-dry.db` no longer exists.

## TEST RUN (Test Run)

TEST RUN is not a mode — it is an optional parameter on the normal start endpoint.

- `POST /api/start` with `testRun: true` in body, or `POST /api/start?testRun=1`.
- Pipeline skips: plan membership check, online scan, chain operations, payments.
- Every node row: `actualMbps: null, errorCode: 'TEST_RUN_SKIP'`.
- Run row: `mode='test'` in `audit.db`.
- Useful for verifying the pipeline plumbing and UI without spending DVPN.

## SSE Event Contract

`/api/public/events` forwards events only when `state.broadcastLive=true`.

| Event | Payload |
|-------|---------|
| `batch:start` | `{ batchId, snapshotSize, iteration }` |
| `batch:node` | `{ addr, moniker, countryCode, type, actualMbps, errorCode, ... }` |
| `batch:end` | `{ batchId, passed, failed, durationMs }` |
| `batch:gap` | `{ gapMs }` |
| `loop:started` | `{ iteration: 0 }` |
| `loop:stopped` | `{ iterations, reason }` |
| `loop:error` | `{ error, iteration }` |

No wallet, plan ID, or fee-grant internals are forwarded on the public SSE stream.

## Security Surface

- `/live` is publicly accessible (uses `attachAdminFlag` but does NOT gate access).
- All data consumed by `/live` comes from `/api/public/*` endpoints — already sanitized.
- `POST /api/broadcast` requires `adminOnly` middleware (signed cookie or Bearer token).
- No `ALLOW_PUBLIC_TEST` env flag needed — admin triggers broadcast, public only views.

## What Was Removed (2026-04-25)

- Mode cookie (`server_mode`) and `requireMode()` middleware.
- `_currentMode`, `_applyModeUI`, `selectMode`, `switchMode` client-side helpers.
- Mode overlay UI in `admin.html`.
- `POST /api/admin/public-test/start`, `POST /api/admin/public-test/stop`, `GET /api/admin/public-test/status`.
- `POST /api/public/test/start`, `POST /api/public/test/stop`, `GET /api/public/test/status`.
- `audit-dry.db` — superseded by the `mode='test'` column in `audit.db`.
- Economy mode (deprecated earlier in the same session).
