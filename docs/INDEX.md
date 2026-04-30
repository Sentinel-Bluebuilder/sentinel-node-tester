# Docs Index

Reference material. Read on demand — none of these are required for a fresh Claude session (start with `/CLAUDE.md` instead).

## Architecture & specs
- `ARCHITECTURE-PUBLIC-LIVE.md` — public/live surfaces, SSE event allow-list, redaction.
- `BEHAVIORAL-SPEC.md` — pipeline behavior contract: what each stage MUST do per node.
- `TECHNICAL-BLUEPRINT.md` — deeper protocol/transport detail.
- `FRONTEND-SPEC.md` — admin/public/live UI contract.
- `FEATURE-SPECS.md` — per-feature requirement specs.
- `UX-FEATURE-PARITY.md` — feature matrix across admin / public / live pages.

## Integration & embedding
- `BUILD-ON-ME.md` — embed the audit engine in another dVPN app (Electron, WebView2, native).
- `INTEGRATION.md` — high-level integration overview.
- `COMPLETE-INTEGRATION-SPEC.md` — full integration contract.
- `EMBEDDING-GUIDE.md` — host-side wiring patterns.
- `CONSUMER-VS-TESTING.md` — SDK functions a consumer app uses vs functions only the tester uses.
- `IN-APP-NODE-TESTING.md` — running the tester loop inside a consumer app.
- `NODE-TESTING-COMPLETE.md` — end-to-end node-test architecture + historical bug list.

## Operator / runtime
- `OPERATOR-RUNBOOK.md` — production deployment checklist (reverse proxy, secrets, admin token rotation).
- `CLI.md` — every `sentinel-audit` subcommand, args, JSON output shape.
- `FUNCTION-REFERENCE.md` — exported function reference (every function in invocation order).

## Archived (historical, may be stale)
- `archive/HANDOFF-2026-04-11.md` — old handoff doc; replaced by `memory/handoff-node-tester.md`.
- `archive/CONTEXT-2026-04-10.md` — old "AI context" doc; replaced by `CLAUDE.md`.
- `archive/SCORE-2026-04-23.md` — point-in-time SDK parity score.
- `archive/SECURITY-AUDIT-2026-04-23.md` — point-in-time security audit.

Files in `archive/` describe surfaces that may no longer exist (PUBLIC_MODE, dual-mode dev/bundled/public, `/api/admin/public-test/*` endpoints, `lib/` directory layout). When in doubt, the code wins. See `/CLAUDE.md` for the source-of-truth hierarchy.
