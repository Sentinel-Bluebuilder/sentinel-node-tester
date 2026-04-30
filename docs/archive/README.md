# Archived Docs

These files are historical snapshots. They describe code, UI, routes, or processes that no longer exist or have been superseded. **Do not treat any file in this directory as a source of truth.**

Current sources of truth:
1. The code itself (`server.js`, `audit/pipeline.js`, `audit/node-test.js`, `core/db.js`).
2. `/CLAUDE.md` — project instructions for AI sessions.
3. `memory/handoff-node-tester.md` — most recent session state.
4. `/ARCH.md`, `/DECISIONS.md`, `/README.md`.

## What's stale here

- **`HANDOFF-2026-04-11.md`** — describes a "Two Test Modes" dashboard UI (`Test ALL (P2P)` + `Test Sub. Plan` buttons), references `lib/v3protocol.js` (now `protocol/v3protocol.js`), `probe.js` and `test-v2ray.js` (don't exist), and a single `index.html` (now split into `admin.html` / `public.html` / `live.html`). The dual-mode UI was collapsed into single-mode + Broadcast Live toggle on 2026-04-25.

- **`CONTEXT-2026-04-10.md`** — recommends LCD-first chain queries. Per global rule, the project is RPC-first; LCD is fallback only.

- **`SCORE-2026-04-23.md`** — point-in-time SDK parity score (pre-2.6.0 upgrade). Current parity numbers are in `memory/handoff-node-tester.md` (avg 84/100 against `blue-js-sdk@2.6.0`).

- **`SECURITY-AUDIT-2026-04-23.md`** — point-in-time audit. Some findings reference `PUBLIC_MODE`, which was removed in the single-mode collapse.

Kept for history, blame trails, and recovering decisions. Not for navigation.
