# UX Feature Parity — What Every App Must Replicate

> Any application that builds on the node tester MUST implement ALL of these features with the same behavior. The UX, data persistence, and user flows must be identical regardless of platform.

---

## What Changes When Embedded in an App

Some features only apply to the standalone CLI/Browser tester. When embedded in a consumer app:

| Feature | Standalone | Embedded in App | Why |
|---------|-----------|-----------------|-----|
| SDK toggle (JS/C#) | ✓ Required | ✗ Not needed | App already uses one SDK |
| SDK badge on results | ✓ Shows JS/C# | ✗ Remove or hardcode | Only one SDK in the app |
| Wallet setup | ✓ From .env | ✗ App already has wallet | Use app's wallet |
| Mnemonic in .env | ✓ Required | ✗ App manages auth | App handles credentials |
| SentinelAudit.vbs | ✓ Required | ✗ App has own launcher | App handles elevation |
| Port 3001 | ✓ Default | Configurable or embedded | May conflict with app |
| Dictator Mode link | ✓ Optional | ✗ Remove | App-specific feature |
| Economy mode | ✓ Optional | ✓ Keep | Users want to limit spending |
| Plan Test | ✓ Optional | Only if app uses plans | Depends on app type |

**Everything else is IDENTICAL.** Results table, log, progress, DNS, run archive, data persistence, badges, flags, alignment — all the same.

---

## Mandatory Features Checklist

### 1. Test Controls
- [ ] **New Test** — Start fresh audit. Auto-saves previous results before clearing.
- [ ] **Resume** — Continue from where last test stopped. Picks up from the last tested node.
- [ ] **Stop** — Halts within 500ms. Current node completes or aborts. No data loss.
- [ ] **Retest Failed** — Retests ALL failed nodes. `force` option retests even "permanent" failures.
- [ ] **Rescan** — Re-fetches node list from chain without starting a test.

### 2. Results Table
- [ ] **Columns:** SDK badge, Transport, Node address (copyable), Country (flag + code), City, Peers (center), Speed (right-aligned), Total BW (right-aligned), Baseline (right-aligned), Result badge (center)
- [ ] **Result badges:** FAST (green ≥10Mbps), SLOW (yellow <10Mbps), FAIL (red)
- [ ] **Country flags:** ISO code → emoji flag. `🇺🇸 US` not `United States`
- [ ] **Node address:** Truncated with copy-on-click. `sentnode1abc...xyz`
- [ ] **Total BW:** `actualMbps × max(peers, 1)`. If peers=0 but connected, use 1.
- [ ] **Sort:** Most recent test first (newest at top)
- [ ] **Max rows:** 200 visible. Older rows scroll off.
- [ ] **Upsert:** Re-testing a node replaces its old row, doesn't duplicate.

### 3. Live Log
- [ ] **Real-time:** Messages appear instantly via SSE
- [ ] **Timestamped:** `HH:MM:SS` prefix on every line
- [ ] **Color coded:** Yellow for warnings, green for success, red for errors
- [ ] **Scrolling:** Auto-scrolls to bottom. Max 500 entries.
- [ ] **Content:** Every action logged — handshake, payment, speed, connectivity, errors

### 4. Progress Tracking
- [ ] **Progress bar:** Tested / Total with percentage
- [ ] **Counters:** Total, Tested, Remaining, Failed, >10Mbps, Pass Rate
- [ ] **Speed history:** Last 10 node speeds as visual pills (color-coded)
- [ ] **Balance:** Current wallet balance, updated after each payment
- [ ] **Current node:** Shows which node is being tested right now

### 5. SDK Toggle
- [ ] **JS / C# switch** — Visible in header
- [ ] **Active SDK badge** on each result row (which SDK tested this node)
- [ ] **Actually switches code path** — not just a label
- [ ] **Persists across restarts** — saved to disk

### 6. DNS Configuration
- [ ] **Dropdown selector:** OpenDNS, HNS, Cloudflare, Google
- [ ] **Applied to both** V2Ray config AND WireGuard config
- [ ] **Visible in header** — user always knows which DNS is active
- [ ] **Takes effect immediately** — next node test uses new DNS

### 7. Run Archive (Previous Tests)
- [ ] **Auto-save:** Every test is saved before a new one starts
- [ ] **Run list:** Shows all previous runs with number, date, passed/failed, SDK
- [ ] **Load previous:** Click to view any past test's results
- [ ] **Export:** CSV and/or JSON download of any run's results
- [ ] **Run index:** `runs/index.json` tracks all runs

### 8. Failure Analysis
- [ ] **Categorized:** Group failures by error type (timeout, address mismatch, etc.)
- [ ] **Per-node detail:** Node name, peers, error message, JS comparison
- [ ] **Retestable flag:** Which failures are worth retrying
- [ ] **Dead flag:** Which nodes are genuinely offline

### 9. Data Persistence (MUST survive restart)
- [ ] **Results** — `results.json` loaded on startup, displayed immediately
- [ ] **Counters** — tested/failed/remaining restored from results count
- [ ] **Baseline history** — saved in `.state-snapshot.json`, restored on startup
- [ ] **Speed history** — last 10 speeds restored on startup
- [ ] **Total nodes** — persisted, not reset to 0 on restart
- [ ] **Transport cache** — learned preferences persist across all runs
- [ ] **SDK preference** — `js` or `csharp` persists
- [ ] **Log files** — one per audit run, never overwritten
- [ ] **Failure log** — append-only, never cleared

### 10. Auto-Retest at End of Audit
- [ ] **Automatic:** After main audit completes, retests failures with peers > 0
- [ ] **Fast path:** In retest mode, 409 nodes skip 35s waits → immediate fresh session
- [ ] **Results update:** Retested nodes update their row in the table
- [ ] **Completes before "done":** Status stays "running" until auto-retest finishes

---

## Data Files That Must Exist

| File | What | Persistence | Behavior |
|------|------|-------------|----------|
| `results.json` | Current test results | Overwritten per node, auto-saved to runs/ before new test | MUST load on startup |
| `failures.jsonl` | Every failure ever | Append-only, never cleared | Searchable by address |
| `session-credentials.json` | Cached sessions | Cleared at test start | Prevents stale reuse |
| `transport-cache.json` | Learned transports | Persists across ALL runs | Speeds up repeat tests |
| `.state-snapshot.json` | Volatile state backup | Written periodically | Restores history on startup |
| `.sdk-pref` | Active SDK choice | Single line | Loaded on startup |
| `audit-{ts}.log` | Per-audit text log | One per audit | Human-readable |
| `retest-{ts}.log` | Per-retest text log | One per retest | Human-readable |
| `runs/index.json` | Run archive index | Updated when runs saved | Lists all past runs |
| `runs/test-NNN/results.json` | Archived run snapshot | Permanent | Loadable via UI |

---

## API That Must Be Available

Any embedded deployment (Electron webview, C# HTTP client) calls these:

| Endpoint | Purpose | MUST have |
|----------|---------|-----------|
| POST /api/start | Start new test | ✓ |
| POST /api/resume | Resume from last | ✓ |
| POST /api/stop | Stop <500ms | ✓ |
| POST /api/auto-retest | Retest failures | ✓ |
| GET /api/state | Current state | ✓ |
| GET /api/failure-analysis | Failure categories | ✓ |
| GET /events | SSE stream | ✓ |
| POST /api/sdk | Toggle JS/C# | ✓ |
| POST /api/dns | Set DNS preset | ✓ |
| GET /api/runs | List past runs | ✓ |
| POST /api/runs/save | Save current run | ✓ |
| GET /api/runs/:num | Load past run | ✓ |
| GET /api/results | Raw results | ✓ |

---

## Visual Spec

### Header
```
[Logo] PROJECT NAME    [Windows Badge]  [JS|C#]  [DNS▼]  [Special Mode]
```

### Stats Row
```
Total: 1002 | Tested: 975/1002 (97.3%) | >10Mbps: 200 | Balance: 57,142 P2P
```

### Buttons (all same height: 38px)
```
[New Test] [Resume] [Rescan] [Retest Failed] [Stop] [Economy]  [Plan Test] [Reset]
   green    white    blue       red            red     outline    purple     gray
```

### Results Table
```
SDK  | Transport      | Node          | Country | City       | Peers | Speed     | Total BW  | Baseline  | Result
C# WG| WireGuard      | sentno1a...xy | 🇺🇸 US  | New York   |   12  | 34.21 Mbps| 410.5 Mbps| 35.00 Mbps| FAST
JS V2| vmess/grpc/none| sentno1b...zw | 🇩🇪 DE  | Frankfurt  |    8  | 21.05 Mbps| 168.4 Mbps| 35.00 Mbps| FAST
C# V2| vless/tcp/tls  | sentno1c...ab | 🇫🇷 FR  | Paris      |    3  |  2.10 Mbps|   6.3 Mbps| 35.00 Mbps| SLOW
JS V2|                | sentno1d...cd | 🇬🇧 GB  | London     |    0  |     --    |     --    | 35.00 Mbps| FAIL
```

### Speed History Pills
```
[34.2] [21.1] [8.9] [42.1] [15.3] [2.1] [28.7] [19.4] [11.2] [5.8]
green  green  yellow green  green  red   green  green  green  yellow
```
- ≥15 = green
- ≥5 = yellow
- <5 = red

### Log Panel
```
03:21:16 [C# SDK]
03:21:16 → V2Ray | New York, United States | 34.2 Mbps | Cost: pre-paid
03:21:17   V2Ray UUID: abc123-... (SOCKS:10808)
03:21:27   Waiting 10s for node to register UUID...
03:21:37   🧠 Transport cache: vmess/grpc/none port=8686 (2× success)
03:21:37   V2Ray [1/3]: 1.2.3.4 vmess/grpc/none port=8686
03:21:45   Speed: 34.21 Mbps
03:21:46   Google: ✓ reachable (120ms)
03:21:46   💾 Cached: vmess/grpc/none:8686
03:21:46 ✓ [142/1002] 34.21 Mbps | baseline 35.00 Mbps
```

---

## Behavior That Must Be Identical

### On New Test
1. Save current results to `runs/test-NNN/`
2. Register in `runs/index.json`
3. Clear `results.json` to `[]`
4. Clear credentials, poisoned sessions, paid nodes, session cache
5. Start fresh scan → payment → test cycle

### On Resume
1. Load `results.json` from disk
2. Count tested nodes
3. Find first untested node
4. Continue from there (no re-scan, no re-payment for already-tested nodes)

### On Stop
1. Set flag
2. Within 500ms: current operation aborts
3. Results saved (no data loss)
4. Can Resume later

### On Retest
1. Clear poisoned sessions + paid nodes + session cache
2. For each failed node: run testNode with fresh session
3. Results update in place (upsert, not duplicate)
4. Log shows PASS/FAIL per retested node

### On Results Display After Restart
1. Load `results.json` from disk
2. Compute testedNodes, failedNodes, passed10 from results array
3. Display all results in table immediately
4. Load `.state-snapshot.json` for baseline history + speed history
5. Dashboard shows data within 1 second of server start
