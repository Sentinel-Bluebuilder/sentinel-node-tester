# Sentinel Node Tester — Operator Runbook

How to run the node tester in production: starting and stopping public testing,
interpreting results, and dealing with common failures.

---

## Purpose

The node tester runs continuous VPN session audits against every active node on
the Sentinel chain and publishes results to a public dashboard. The operator
controls when tests run; public visitors only read results. This runbook covers
day-to-day operations, monitoring, incident response, and the security checklist
required before exposing the dashboard to the public internet.

---

## Daily operations

### Starting Public Testing Mode

1. Navigate to your admin panel (default path: `/admin`; changed by `ADMIN_PATH`).
2. Log in with your `ADMIN_TOKEN`.
3. Click **Start Public Testing**.
4. Select the test mode:
   - **P2P** — tester wallet pays gas and session fees directly. Requires P2P
     balance in the tester wallet.
   - **Subscription / Fee-granted** — tests only nodes in a specific plan.
     Sessions are broadcast via `broadcastWithFeeGrant`; the plan operator
     covers all gas. Requires `subscriptionGranter` (the plan owner's `sent1...`
     address) and the tester wallet to be an active plan subscriber.
5. Confirm the minimum inter-pass delay (default 30 seconds; higher values
   reduce chain load between full iterations).
6. Click **Confirm**. The loop starts immediately.

Within 30 seconds, public pages (`/` and `/live`) will show an active-testing
banner. The `/live` page streams real-time iteration progress via SSE.

### Stopping Public Testing Mode

1. From the admin panel, click **Stop Public Testing**.
2. The loop finishes its current node test and then halts.
3. The public banner clears within 30 seconds as the SSE `loop:stopped` event
   propagates.

Stopping is graceful: the current node test completes, results are written, and
then the loop exits. A hard stop (process restart) also works — `audit.db` is
never left in a corrupt state.

### Running a one-shot regular audit

Click **New Test** on the admin panel. This runs a single full pass over all
online nodes using `audit/pipeline.js` and then stops. Mutually exclusive with
Public Testing Mode: if the continuous loop is running, **New Test** returns
`409 Conflict` — stop Public Testing first.

### Retesting failures only

Click **Retest Failed** on the admin panel. This re-runs only the nodes that
failed or were skipped in the most recent audit pass. Useful after fixing a
WireGuard or V2Ray configuration issue without paying for a full re-scan.
Also mutually exclusive with an active continuous loop.

### Running a plan-specific test

Click **Test Sub. Plan** on the admin panel, then select a plan from the
dropdown (populated from your wallet's active subscriptions). Only that plan's
nodes are tested, and gas is covered by the plan operator's fee grant.

---

## Monitoring

### Admin dashboard

The admin panel shows:
- Current status (`idle`, `running`, `paused_internet`, `stopping`)
- Active run: nodes tested, passed, failed, elapsed time
- Public Testing status: `running` / `stopped`, current iteration count, mode
- Live SSE log panel: real-time per-node events

### What "iteration" means

In Public Testing Mode, one **iteration** is a complete pass over all online
nodes. The iteration counter increments each time the loop completes a full
scan and restarts. A single iteration can take minutes to hours depending on
network size and `NODE_DELAY_MS`.

SSE events:
- `loop:started` — loop began, emits `{ mode, minDelayMs, iteration: 0 }`
- `iteration:start` — a new pass is beginning, emits `{ iteration, mode }`
- `iteration:end` — pass complete, emits `{ iteration, mode, durationMs, passed, failed }`
- `loop:stopped` — loop halted, emits `{ iterations, reason }`

### Where results are stored

- `data/audit.db` — SQLite database. Primary store for all node results,
  error logs, run metadata, and bandwidth history.
- `runs/` — one JSON file per completed audit pass. Useful for archiving and
  offline analysis.

### Health endpoint

```
GET /health
# Returns: {"ok":true}
```

Use this as the liveness probe for your reverse proxy or container orchestrator.

---

## Common problems and fixes

### "Wallet balance low" warning in logs

The tester wallet's P2P balance has fallen below 0.5 P2P. Top up by sending
P2P tokens to the wallet's `sent1...` address (displayed on the admin panel
under "Wallet"). Sub. Plan mode is unaffected — it uses fee grants, not the
tester's own balance.

### "LCD unavailable" or chain queries timing out

The active LCD endpoint is unreachable. The server cycles through its built-in
failover list automatically:

1. `https://sentinel-api.polkachu.com`
2. `https://api.sentinel.quokkastake.io`
3. `https://sentinel-rest.publicnode.com`

If all are unreachable, check general internet connectivity from the host. You
can override the endpoint list by setting `LCD_ENDPOINTS` in `.env` as a
comma-separated list and restarting the server.

### "WireGuard tunnel failed — admin privileges required"

On Windows, WireGuard tunnel creation requires an elevated process. Without it,
WireGuard-protocol nodes are skipped (only V2Ray nodes are tested, which is
approximately 70% of the network).

Fix: use `SentinelAudit.vbs` in the project root to relaunch with UAC
elevation, or run `npm start` from an elevated terminal.

On Linux/macOS: restart the server with `sudo npm start`.

### "Public Testing won't start — 409 Conflict"

A regular audit (single-pass) is already running. Wait for it to finish or
click **Stop** on the admin panel, then start Public Testing.

### "Regular audit won't start — 409 Conflict"

The continuous Public Testing loop is live. Click **Stop Public Testing** on
the admin panel and wait for the `loop:stopped` SSE event before starting a
one-shot audit.

### "No subscriptions found" in Sub. Plan mode

The tester wallet has no active plan subscriptions on-chain. Either switch to
**Test ALL (P2P)** mode, or subscribe to a plan through a Sentinel app first.

### "Fee grant not found" in subscription mode

The plan operator has not granted a fee allowance to the tester wallet, or the
grant has expired. Verify by running:

```bash
sentinel-audit balance  # also prints active fee grants
```

Contact the plan operator to issue or renew the `MsgGrantAllowance` on-chain.

### audit.db growing very large

The database accumulates result rows, error logs, and run metadata over time.
`scripts/cleanup.mjs` is a consolidated verify/fix tool. By default it runs
read-only and prints a report of orphaned or runaway rows from incomplete runs;
pass `--fix` to repair them:

```bash
npm run cleanup              # read-only report (no changes)
node scripts/cleanup.mjs --fix   # repair dangling/partial records
```

For a full database analysis (tables, row counts, size breakdown):

```bash
node scripts/analyze.cjs
```

Neither script deletes completed run data — they only remove dangling or
partial records. Back up `audit.db` before running either script.

### Server unresponsive after many iterations

The Node.js process may have accumulated large in-memory log buffers. Restart
the server — `audit.db` is durable and no data is lost. For systemd deployments:

```bash
sudo systemctl restart sentinel-node-tester
```

For Docker:

```bash
docker compose restart
```

---

## Security checklist before going public

Complete every item before pointing a public domain at this server.

- [ ] `PUBLIC_MODE=true` set in `.env`.
- [ ] `ADMIN_TOKEN` set to a 32-byte (64-character) random hex value.
  Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- [ ] `ADMIN_PATH` changed from `/admin` to an unguessable path (e.g.
  `/ops-7f3a9`) for defense in depth. Not a substitute for a strong token,
  but reduces automated scanning exposure.
- [ ] `ALLOW_PUBLIC_TEST=false` (the default) unless you deliberately want
  public visitors to trigger test runs. Leaving it `false` means only the
  admin can start tests.
- [ ] `MNEMONIC` is not checked into git. Confirm with:
  `git log --all --oneline -- .env`
  If it appears, rotate the mnemonic immediately and revoke the exposed wallet.
- [ ] HTTPS termination at the reverse proxy level. The application speaks plain
  HTTP; TLS must be provided externally.

  Minimal nginx example:

  ```nginx
  server {
      listen 443 ssl;
      server_name tester.example.com;
      ssl_certificate     /etc/letsencrypt/live/tester.example.com/fullchain.pem;
      ssl_certificate_key /etc/letsencrypt/live/tester.example.com/privkey.pem;

      location / {
          proxy_pass http://127.0.0.1:3001;
          proxy_set_header Host $host;
          proxy_set_header X-Real-IP $remote_addr;
          # SSE: disable buffering
          proxy_buffering off;
          proxy_cache off;
      }
  }
  ```

  Minimal Caddy example:

  ```
  tester.example.com {
      reverse_proxy 127.0.0.1:3001 {
          flush_interval -1
      }
  }
  ```

  The `flush_interval -1` / `proxy_buffering off` directive is required for SSE
  (`/api/public/events` and the admin log stream) to deliver events in real time.

- [ ] Admin path not indexed by search engines. Add to your `robots.txt`:
  ```
  User-agent: *
  Disallow: /admin
  ```
  (replace `/admin` with your actual `ADMIN_PATH`).

---

## Backup

Two items must be included in any backup:

1. `data/audit.db` — the SQLite database. All persistent results live here.
2. `runs/` — per-run JSON archives. Used for replay and offline analysis.

The `.env` file must also be backed up securely (separately from the codebase).

For Docker deployments, both paths are bind-mounted from the host — back up
the host directories directly.

---

## Further reading

- [deploy/README.md](../deploy/README.md) — Docker and systemd deployment steps.
- [docs/CLI.md](CLI.md) — full CLI subcommand reference.
- [docs/ARCHITECTURE-PUBLIC-LIVE.md](ARCHITECTURE-PUBLIC-LIVE.md) — public live-view page design.
- [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) — extended troubleshooting guide.
