# Decision Log

## 2026-03-22: Iron Rule Established
**Decision:** Any node with peers > 0 that fails = our bug. No exceptions.
**Reason:** AI dismissed 8 failures as "node-side" — all 8 were real code bugs.

## 2026-03-22: C# Bridge Wired Into Pipeline
**Decision:** When SDK toggle = C#, audit pipeline calls SentinelBridge.exe for status + handshake.
**Reason:** Previous "C# tests" were actually JS with a label. Bridge enables real C# SDK testing.
**Impact:** Found transport_security offset bug (C# 0-indexed vs JS 1-indexed), UUID wait bug.

## 2026-03-22: Batch Session Mapping via Chain Query
**Decision:** Don't guess session→node mapping by event index. Query chain after broadcast.
**Reason:** Cosmos events don't include node_address. Index-based mapping caused address mismatch.

## 2026-03-23: V2Ray Upgraded 5.2.1 → 5.44.1
**Decision:** Use V2Ray 5.44.1 (2025, Go 1.25) instead of 5.2.1 (2022, Go 1.19).
**Reason:** Testing compatibility with newer sentinel-go-sdk node versions (8.2+).
**Impact:** Same pass rate — V2Ray version wasn't the bottleneck.

## 2026-03-23: alterId 64 for Clock Drift
**Decision:** VMess nodes with |clockDrift| > 120s get alterId=64 (legacy, no AEAD clock check).
**Reason:** AEAD requires ±120s clock sync. Legacy mode doesn't. Nodes with drift have peers.

## 2026-03-23: gun + grpc Dual Outbounds
**Decision:** For transport_protocol:3, generate BOTH gun and grpc V2Ray outbounds.
**Reason:** 87% of grpc nodes work, 13% need gun framing. sentinel-go-sdk uses gun internally.

## 2026-03-23: Per-Node 5-Min Timeout
**Decision:** Hard timeout of 300s per node via Promise.race.
**Reason:** V2Ray transport iteration hangs indefinitely on dead nodes.

## 2026-03-23: Stop Response < 500ms
**Decision:** Poll stopRequested every 500ms in retry.js Promise.race.
**Reason:** Stop was waiting 5 min for current node to finish.

## 2026-03-23: Clear All Credentials at Audit Start
**Decision:** Wipe session-credentials.json before every new audit.
**Reason:** Expired sessions from previous runs were reused → handshake succeeded but tunnel failed.

## 2026-03-23: Auto-Save Results Before New Test
**Decision:** /api/start auto-saves current results to runs/ before clearing.
**Reason:** 130 C# test results were permanently lost when new test wiped results.json.

## 2026-03-23: Auto-Retest at End of Audit
**Decision:** After main audit pass, automatically retest failures with peers > 0.
**Reason:** Iron Rule — failures need investigation without manual intervention.

## 2026-03-24: V2Ray Port Pre-Check Before Payment
**Decision:** Probe common V2Ray ports before paying for a session. Dead ports → no payment.
**Reason:** kfmg nodes have dead V2Ray (port 8686 REFUSED) but sentinel daemon responds. Payment was wasted.

## 2026-03-24: NodeTester Class Added to C# SDK
**Decision:** Built INodeTestAdapter + NodeTester in Sentinel.SDK.Core.
**Reason:** Apps need a real, compilable class to integrate — not just documentation.

## 2026-03-24: Two Deployment Types
**Decision:** Type 1 = standalone CLI/browser. Type 2 = embedded in app via adapter.
**Reason:** Different audiences: SDK developers (Type 1) vs app developers (Type 2).

## 2026-03-24: Never Retest Without a Fix
**Decision:** Before any retest, name the specific code change. No blind retesting.
**Reason:** Retested same 24 nodes 5+ times without new solutions. Wasted 8+ hours and tokens.

## 2026-03-24: Docs Must Describe Real Code
**Decision:** Every doc must state if it's WORKING CODE or DESIGN SPEC.
**Reason:** AI spent 10+ hours trying to use NodeTester class and IVpnTestAdapter that didn't exist.
