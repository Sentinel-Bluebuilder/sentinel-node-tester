# Start Here

Three readers, three paths. Pick yours.

## I'm a Claude session
1. `CLAUDE.md` — project rules + current architecture.
2. `memory/handoff-node-tester.md` — last session state.
3. `ARCH.md` — module dependency graph.

Stop there. Open anything in `docs/` only when the task needs it. **`docs/archive/` is historical — may contradict current code.**

## I'm an operator running the tester locally
1. `SETUP.md` — install Node, WireGuard, V2Ray, .NET (for C# bridge).
2. `.env.example` → `.env` — set `MNEMONIC`.
3. `npm install && npm start` — opens dashboard at http://localhost:3001.
4. Stuck? `TROUBLESHOOTING.md`.

WireGuard requires elevated privileges:
- **Windows** — launch via `cscript //nologo SentinelAudit.vbs` (auto-elevates).
- **macOS / Linux** — `sudo -E node server.js` (or `sudo -E npm start`).

## I'm building my own dVPN app and want node testing
- `docs/BUILD-ON-ME.md` — embed the audit engine in your app.
- `docs/CONSUMER-VS-TESTING.md` — which SDK functions to use.
- `docs/EMBEDDING-GUIDE.md` — Electron / WebView2 / native.

## CLI / scripting / agents
`docs/CLI.md` — every `sentinel-audit` command, JSON output schema.

## All reference docs
`docs/INDEX.md` lists everything in `docs/` with one-line descriptions.
