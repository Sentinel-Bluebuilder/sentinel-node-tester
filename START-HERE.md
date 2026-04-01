# Start Here — Sentinel Node Tester

## Answer These Questions First

### Question 1: What are you building?

**A) "I want to run the node tester standalone"**
→ You're deploying Type 1. The CLI/Browser tester runs as a Node.js server with a web dashboard. Tests protocol mechanics, finds edge cases, validates SDKs.
→ **Read:** `SETUP.md` → `CLAUDE.md` → `AI-ONBOARDING.md`
→ **Launch:** `cscript //nologo SentinelAudit.vbs` (Windows, Admin required)
→ **Dashboard:** http://localhost:3001

**B) "I want to add node testing to my existing dVPN app"**
→ **Read ONE file:** `docs/BUILD-ON-ME.md` — working code, every spec, every gotcha
→ 30-second code examples that compile. NodeTester class EXISTS in SDK. Platform comparison table.
→ C# WPF? Use WebView2 (30 min, 100% parity). Electron? Import directly (15 min).

**C) "I want to build a new standalone tester from scratch"**
→ Clone this project's logic into your language/framework.
→ **Read:** `docs/FUNCTION-REFERENCE.md` (every function, in order)
→ **Read:** `docs/NODE-TESTING-COMPLETE.md` (architecture + all 17 bugs)
→ **Read:** `docs/CONSUMER-VS-TESTING.md` (which SDK functions to use)

### Question 2: What language?

| Language | Type 1 (Standalone) | Type 2 (In-App) |
|----------|-------------------|-----------------|
| **JavaScript/Node.js** | This project IS JS. Clone and run. | Wrap your Electron app's VPN backend |
| **C# .NET** | Use the csharp-bridge as reference | Implement INodeTestAdapter in your WPF/WinUI app |
| **Swift** | Port from JS following FUNCTION-REFERENCE.md | Implement NodeTestAdapter protocol |
| **Rust** | Port from JS following FUNCTION-REFERENCE.md | Implement NodeTestAdapter trait |
| **Kotlin** | Port from JS following FUNCTION-REFERENCE.md | Implement in Android VpnService wrapper |

### Question 3: What OS?

| OS | WireGuard | V2Ray | Admin Required? |
|----|-----------|-------|-----------------|
| **Windows** | `wireguard.exe /installtunnelservice` | `v2ray.exe` spawn | YES (UAC) |
| **macOS** | `wg-quick up/down` | `v2ray` binary | YES (sudo) |
| **Linux** | `wg-quick up/down` | `v2ray` binary | YES (sudo/pkexec) |

### Question 4: Do you have a funded wallet?

You need a Sentinel wallet with P2P tokens. Each node test costs ~40 P2P (1 GB session).
- 100 nodes = ~4,000 P2P
- 1000 nodes = ~40,000 P2P
- Set mnemonic in `.env` file (never in source code)

---

## File Map

```
sentinel-node-tester/
│
├── START-HERE.md              ← YOU ARE HERE
├── MANIFESTO.md               ← Why this exists, principles, what we've proven
├── CLAUDE.md                  ← Rules for AI working on this project
├── SETUP.md                   ← Installation + first run
├── AI-ONBOARDING.md           ← Complete AI onboarding (architecture, API, bugs)
├── HANDOFF.md                 ← Current session state + recent changes
│
├── docs/
│   ├── NODE-TESTING-COMPLETE.md  ← Full reference (Type 1 + Type 2 + chain v3)
│   ├── AI-BUILD-NODE-TEST.md     ← AI instructions for Type 2 (any language/platform)
│   ├── IN-APP-NODE-TESTING.md    ← Type 2 design spec + adapter interfaces
│   ├── FUNCTION-REFERENCE.md     ← Every function in execution order
│   └── CONSUMER-VS-TESTING.md    ← Which SDK functions are safe for consumer apps
│
├── core/                      ← Chain queries, wallet, sessions, credentials
├── audit/                     ← Test pipeline, retry logic, node test
├── protocol/                  ← V3 handshake, V2Ray config, speed test
├── platforms/windows/         ← WireGuard service, V2Ray spawn, network detect
├── csharp-bridge/             ← C# SDK bridge CLI
├── bin/                       ← V2Ray binary
├── results/                   ← Test data, logs, archived runs
└── server.js + index.html     ← Express server + dashboard UI
```

---

## Quick Start (Type 1 — Standalone)

```bash
# 1. Clone / enter project
cd sentinel-node-tester

# 2. Install dependencies
npm install

# 3. Create .env
echo "MNEMONIC=your twelve word mnemonic here" > .env

# 4. Launch (Windows, requires Admin)
cscript //nologo SentinelAudit.vbs

# 5. Open dashboard
# http://localhost:3001
# Click "New Test" to start
```

---

## Quick Start (Type 2 — In-App)

```
1. Read docs/AI-BUILD-NODE-TEST.md
2. Scan your app for connect/disconnect functions
3. Implement INodeTestAdapter (3 methods)
4. Create NodeTestService with adapter
5. Add "Node Test" tab to your app
6. Wire Start/Stop → runAll(nodes)
7. Display results in table matching your app's theme
```

Total: ~500-800 lines of new code. No new dependencies.

---

## What This Tool Produces

### Data Files
| File | Content | Persistence |
|------|---------|-------------|
| `results/results.json` | Current test results (all nodes) | Overwritten per test, auto-saved to runs/ before new test |
| `results/failures.jsonl` | Every failure ever (append-only) | Never cleared |
| `results/transport-cache.json` | Learned transport preferences per node | Persists across runs |
| `results/session-credentials.json` | Cached session data for reuse | Cleared at test start |
| `results/audit-{ts}.log` | Per-audit text log | One per test |
| `results/retest-{ts}.log` | Per-retest text log | One per retest |
| `results/runs/test-NNN/` | Archived run snapshots | Permanent |

### Dashboard
| Feature | Description |
|---------|-------------|
| Live SSE log | Real-time scrolling log of every test action |
| Results table | Node, country flag, city, peers, speed, total BW, baseline, FAST/SLOW/FAIL |
| Progress bar | Tested/Total with pass rate |
| Speed history | Last 10 node speeds as color-coded pills |
| SDK toggle | JS / C# (switches actual code path, not just label) |
| DNS selector | OpenDNS / HNS / Cloudflare / Google |
| Run archive | Dropdown to load previous test runs |
| Failure analysis | Categorized failures with error details |
| Auto-retest | Retests failures at end of audit (Iron Rule) |

### API
Full endpoint reference in `docs/FUNCTION-REFERENCE.md` under "API Endpoints".
