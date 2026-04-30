# Contributing

Thanks for considering a contribution. This project is small enough that the
fastest way to get a change merged is to open an issue describing what you want
to change and why, *before* writing code.

## Ground rules

- **Read `CLAUDE.md`** — it documents non-negotiable invariants (zero public
  action buttons, failure-log copy UX, TEST RUN immutability, theme-token
  discipline). Changes that violate these will be rejected.
- **Keep the public dashboard read-only.** No new buttons on `public.html` or
  `live.html` that visitors can click to spend money or change state.
- **Don't touch TEST RUN code paths.** The canonical implementation lives on
  GitHub at `Sentinel-Autonomybuilder/sentinel-node-tester`. If a refactor
  seems to require touching them, stop and open an issue first.
- **RPC-first for chain calls.** New code must not call LCD as the primary
  path. LCD is fallback only.
- **No secrets in commits.** `.env`, mnemonics, and private keys are blocked
  by `.gitignore`. Don't override.

## Local development

```bash
git clone https://github.com/Sentinel-Autonomybuilder/sentinel-node-tester
cd sentinel-node-tester
npm install
cp .env.example .env   # set MNEMONIC
npm test               # smoke + db + continuous + security suites
npm start              # boots dashboard at http://localhost:3001
```

Cross-platform notes:

- **Windows**: WireGuard ops require Administrator. Launch via
  `cscript //nologo SentinelAudit.vbs` for auto-elevation.
- **Linux/macOS**: WireGuard ops require root. Use `sudo -E node server.js` or
  `./start.sh`. V2Ray-only runs (~70% of nodes) work unprivileged.

## Code style

- ES modules, single quotes, semicolons, 2-space indent, LF line endings.
- `camelCase` variables, `UPPER_SNAKE` constants, `kebab-case` filenames.
- Section headers as `// ─── Name ───`.
- `catch {}` is banned — log or rethrow with context.

## Tests

- Unit / smoke tests live in `test/`.
- `npm test` runs everything that's wired into CI. Keep it green.
- New features that touch the chain pipeline should add at least a smoke
  test that exercises the new code path with mocked broadcasts.

## Commit messages

Imperative, short subject line. Reference issues/PRs in the body. Example:

```
fix: stop emitting SSE events when broadcastLive is off

Public surfaces were leaking iteration:* events when an admin disabled the
broadcast toggle mid-run because the fan-out check was inverted.

Closes #42
```

## PRs

- One topic per PR. Smaller is better.
- CI must pass before review.
- If the change affects the public dashboard, post a screenshot.
- If the change touches `audit/pipeline.js`, `audit/continuous.js`,
  `audit/node-test.js`, or `core/db.js`, expect extra scrutiny — these are the
  hot path.
