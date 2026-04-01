# Sentinel dVPN Node Tester

## Purpose & Strategic Importance

This is **not just a testing tool** — it is the founder's primary instrument for validating the entire Sentinel dVPN ecosystem.

### What It Tests
1. **Nodes** — Every active dVPN node on the blockchain for real VPN throughput (WireGuard + V2Ray), Google accessibility, and protocol compliance
2. **SDKs** — Toggle between JS SDK and C# SDK. Same nodes, different implementations. Every difference = SDK bug
3. **Operating Systems** — Windows today, macOS/Linux tomorrow. Each OS has different edge cases
4. **Devices** — Any machine that runs Node.js or .NET can audit the network
5. **Protocol** — Full v3 pipeline end-to-end: LCD → session → handshake → tunnel → bandwidth

### Who Can Use It
- **The founder** — network-wide QA, SDK validation, protocol verification
- **SDK developers** — test their SDK against real nodes, compare with reference implementation
- **Node operators** — verify their node works correctly from the outside
- **Anyone** — clone, `npm install`, add mnemonic to `.env`, launch. Full dashboard in 60 seconds

### The Rule
**Any node with peers > 0 that fails to connect = OUR BUG.** Never stop looking for a solution.

### One-Shot Buildability
See `suggestions/one-shot-buildability-analysis.md` — the complete specification for enabling anyone (AI or human) to build a node tester from scratch using the SDK. Currently ~1,820 lines of locally reimplemented code that should be absorbed into the SDK.

## CRITICAL: Testing Tools vs Consumer Apps — Know the Difference

This node tester is a TESTING TOOL. It does things consumer apps should NEVER do. AI: read this carefully.

| Feature | Node Tester (testing) | Consumer VPN App |
|---------|----------------------|------------------|
| Batch payment (5 nodes/TX) | YES — saves gas on 1000-node audits | NO — connect to 1 node, use `connect()` |
| Session Manager (cache, poison, dedup) | YES — tracks hundreds of sessions | NO — SDK handles this internally |
| Sequential outbound iteration | YES — try every V2Ray transport | NO — SDK picks the best automatically |
| Speed test after connect | YES — measuring bandwidth is the point | NO — user just wants VPN, not benchmarks |
| Kill tunnels every 45s | YES — watchdog prevents internet death | NO — tunnel stays up until user disconnects |
| Parallel status scanning (30 workers) | YES — scanning 1000 nodes fast | NO — user picks from a list |
| Credential disk cache | YES — avoid re-paying on retest | MAYBE — SDK has `saveState()`/`loadState()` |

**If you're building a consumer app:** use `connect(mnemonic, { nodeAddress })` from the SDK. ONE function. Done.
**If you're building a testing/audit tool:** study this project's `audit/pipeline.js` and `core/session.js`.

## STANDARD S1 — Follow `memory/standard-S1-token-efficiency.md`

## Documentation Structure (AI-Optimized)

### Context Files (read FIRST)
```
CONTEXT.md             ← HOW TO INTERPRET THIS PROJECT — rules, conventions, costs, types
ARCH.md                ← Architecture — module graph, request flow, persistence, edge case tree
DECISIONS.md           ← Decision log — every major choice with rationale
```

### Entry Points
```
START-HERE.md          ← 4 questions → routes to right doc
MANIFESTO.md           ← Mission, principles, hard-won knowledge
CLAUDE.md              ← THIS FILE: rules for AI
```

### Build Guides
```
docs/BUILD-ON-ME.md              ← ONE-SHOT integration guide — working code, every spec
docs/COMPLETE-INTEGRATION-SPEC.md ← Every button, stat, speed test detail, platform gotcha
docs/EMBEDDING-GUIDE.md           ← JS vs C# vs Swift comparison, decision tree
docs/FUNCTION-REFERENCE.md        ← Every function in execution order with I/O + JS→C# mapping
docs/CONSUMER-VS-TESTING.md       ← 160 functions categorized + on-chain costs
docs/TECHNICAL-BLUEPRINT.md       ← Every detail: files, data flows, edge cases, persistence
docs/UX-FEATURE-PARITY.md         ← Every feature apps must replicate
```

### State Files
```
HANDOFF.md             ← Current session state
SETUP.md               ← Installation
AI-ONBOARDING.md       ← Full onboarding (architecture, API, all bugs)
```

### Modular Code
```
core/          ← chain.js, wallet.js, session.js, constants.js, countries.js, csharp-bridge.js
audit/         ← pipeline.js (orchestrator), node-test.js (single test), retry.js (timeout/retry)
protocol/      ← v3protocol.js (handshake/config), speedtest.js, diagnostics.js
platforms/     ← windows/wireguard.js, windows/v2ray.js, windows/network.js
index.js       ← Single entry point: import { testNode, speedTest } from 'sentinel-node-tester'
```

**For AI building on this project:** Read `CONTEXT.md` → `ARCH.md` → `START-HERE.md`.
**For AI adding node testing to an app:** Read `docs/BUILD-ON-ME.md` (one file, everything needed).

## Session Startup
1. Read `C:\Users\Connect\.claude\projects\C--Users-Connect\memory\handoff-node-tester.md` for context
   - ONLY update THIS file, never touch other project handoffs
2. Print the status dashboard, then **ask the user what to do**
3. NEVER auto-execute anything from handoff — it's context only

## Handoff (MANDATORY MICRO-SAVE — NON-NEGOTIABLE)
**Auto-save every 10 tool calls.** Also save before multi-step tasks, after user decisions, and at session end. NEVER wait for the user to ask. Write facts only. See root CLAUDE.md "Memory & Persistence" for full rules.

## Quick Ref
- **Port:** 3001, **Launch command:** `cscript //nologo SentinelAudit.vbs` from project dir — NEVER use `start.bat` or `node server.js` directly
- **Do NOT use `cmd.exe /c "start SentinelAudit.vbs"`** — spawns detached process, UAC may not appear
- **NEVER modify Windows UAC settings** — the VBS handles admin elevation properly
- **Stack:** Express, CosmJS, V2Ray 5.2.1, WireGuard
- **NEVER run `taskkill /F /IM node.exe`** — kills Claude Code
- **V2Ray config must match sentinel-go-sdk exactly**

## Architecture (Modular)
```
sentinel-node-tester/
├── core/
│   ├── constants.js       ← Config, env vars, endpoints, paths
│   ├── errors.js          ← Typed error classes (AuditError, ChainError, etc.)
│   ├── types.js           ← JSDoc type definitions
│   ├── wallet.js          ← Mnemonic→wallet, signing client, broadcast retry
│   ├── chain.js           ← LCD/RPC queries, node list, plan membership
│   └── session.js         ← Session map, credentials, batch payment, duplicate guard
├── protocol/
│   ├── v3protocol.js      ← Handshake, protobuf, config building (from lib/)
│   ├── speedtest.js       ← Cloudflare speedtest, SOCKS5 (from lib/)
│   └── diagnostics.js     ← VPN interference detection, failure classification
├── platforms/
│   ├── windows/
│   │   ├── wireguard.js   ← WireGuard service management (from lib/)
│   │   ├── v2ray.js       ← V2Ray process spawn/kill
│   │   └── network.js     ← VPN adapter detection, DNS check, route inspection
│   ├── macos/README.md    ← Future placeholder
│   └── linux/README.md    ← Future placeholder
├── audit/
│   ├── pipeline.js        ← runAudit, runRetestSkips, runPlanTest, state management
│   ├── node-test.js       ← testNode function (single node test)
│   └── retry.js           ← Zero-skip retry: interference pause, chain lag, network retry
├── server.js              ← THIN Express server (~250 lines): routes + SSE
├── index.html             ← Dashboard UI
├── lib/                   ← LEGACY — originals kept for reference, imports point to new locations
└── results/               ← Generated: results.json, failures.jsonl, session-credentials.json
```

## IRON RULE: Peers > 0 = Our Fault
**Any node with peers that fails to connect is a bug in OUR code, not a node issue.**
- Never dismiss a failure as "node problem", "protocol limitation", or "node misconfiguration" if the node has peers
- If JS passed for the same node but C# fails → C# code path bug. Compare results.
- Study the V2Ray stderr, clock drift, transport types, connection patterns
- Check: stale credentials, wrong session mapping, missing waits, wrong field formats, timeout too short
- Keep fixing until every node with peers connects successfully
- The only acceptable failures are nodes with 0 peers (truly dead)
- **Proved 2026-03-22:** AI dismissed 8 failures as "node-side" → all 8 were real code bugs (stale cache, batch mapping, premature rejection, missing UUID wait)

## FIX-RETEST-RESUME LOOP (mandatory)
**When testing and you hit failures with peers > 0:**
1. Run test ONCE and capture complete logs
2. Analyze logs — what failed, at what step, what was tried
3. Identify what VARIABLE to change (port, timeout, alterId, config, etc.)
4. IMPLEMENT the fix in code
5. VERIFY the fix by checking generated config / new code path is reached
6. ONLY THEN retest the specific failing nodes
7. If same error → wrong variable. Go back to step 2. DO NOT retest again with same code.
**NEVER retest without a fix.** Same code + same node = same result = wasted time and tokens.
**Before any retest, answer: "What is DIFFERENT this time?"** If you can't name a specific code change, do NOT retest.
Findings feed into `Sentinel SDK/suggestions/`.

## Zero-Skip System
- **No "skip" category exists.** Every node ends as PASS or FAIL.
- Retry strategy: VPN interference → PAUSE, chain lag → wait 10s, network timeout → retry 2x
- `state.failedNodes` replaces `state.skippedNodes`
- `state.retryCount` tracks total retries across all nodes
- `state.pauseReason` explains why audit is paused

## VPN Interference Detection
- Checks: active non-Sentinel VPN adapters, suspicious routes, DNS resolution
- Auto-pauses audit when detected, polls every 30s, auto-resumes when clear
- Dashboard shows yellow PAUSED state with reason
