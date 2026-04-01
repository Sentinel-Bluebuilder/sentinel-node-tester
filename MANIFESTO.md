# The Node Tester Manifesto

## To every Claude instance that opens this project:

You are not working on a test tool. You are working on the founder's primary instrument for validating the entire Sentinel dVPN ecosystem. This is the single source of truth for whether Sentinel works.

## Who Can Use This & Why

This tool is built for **anyone** to 1-shot launch and test:

1. **Test Nodes** — Audit every dVPN node on the Sentinel blockchain. Connect, measure bandwidth, verify Google reachability, generate reports. Every result tagged with which SDK and OS tested it.
2. **Test SDKs** — Toggle between JS SDK and C# SDK. Same nodes, same test. Every difference = SDK bug. Results columns show "JS" or "C#" per node so you can compare side by side.
3. **Test Operating Systems** — Every result tagged with Windows/macOS/Linux. Run the same test on different OSes to find platform-specific bugs. WireGuard behaves differently on each OS. V2Ray process management is different. DNS resolution is different. This tool catches all of it.
4. **Test Devices** — Run from a laptop, server, VM, cloud instance. Each device's network characteristics affect tunnel performance differently. The tool records it all.
5. **Cross-Reference Everything** — Filter results by SDK + OS + node + transport. Find patterns: "grpc/none fails on C# but works on JS" or "WireGuard is 2x slower on Linux than Windows." This is how you ship production SDKs.

**Anyone can clone this repo, run `npm install`, launch `SentinelAudit.vbs`, and have a full network audit dashboard in 60 seconds.** No configuration beyond a funded wallet mnemonic in `.env`.

---

## Why This Exists

Sentinel is a decentralized VPN protocol. Anyone can run a node. Anyone can offer bandwidth. That's the vision — but it creates a problem no centralized VPN has: **nobody controls the nodes.** Node operators can run broken software, misconfigured tunnels, drifted clocks, dead endpoints, or outright fraudulent nodes that take payment and deliver nothing.

The founder cannot manually SSH into 900 machines. The founder cannot trust self-reported metrics. The founder cannot assume the protocol works just because the code compiles.

**This tool is the answer.** It does what no human can: connects to every single node on chain, pays real P2P, establishes real tunnels, and measures real bandwidth. It does this automatically, repeatedly, and honestly.

---

## What Makes This Different From Every Other Project

| Project | What it knows |
|---------|--------------|
| Scout Map | Where nodes are geographically |
| Plan Manager | What subscription plans exist on chain |
| Web Proxy | Whether one specific node works right now |
| SDK | How to talk to the chain programmatically |
| **Node Tester** | **Whether the entire network actually works** |

Every other project operates on assumptions. The Node Tester operates on proof.

---

## The Three Pillars

### 1. Network Quality Assurance

Every node gets tested with real traffic. Not a ping. Not a status check. A real VPN tunnel carrying real bytes through Cloudflare's speed test infrastructure. The result is a pass or fail with measured bandwidth in Mbps.

This data answers questions only the founder needs answered:
- How many nodes are actually functional vs dead on chain?
- What's the real-world throughput distribution across the network?
- Which transport protocols (WireGuard, V2Ray/VMess, V2Ray/VLess) actually work?
- Which operators are running quality infrastructure?
- Is the network getting better or worse over time?

No one else in the Sentinel ecosystem has this data. Not node operators, not delegators, not developers building on the SDK. Only the founder.

### 2. SDK Validation

This project imports from the Sentinel JS SDK. Every audit run is a live integration test:
- `listNodes()` — Does the SDK correctly paginate and return all active nodes from LCD?
- Session creation — Does the protobuf encoding match what the chain expects?
- Payment flows — Do batch transactions broadcast and confirm correctly?
- Chain queries — Do LCD failover endpoints work under real load?

When the SDK has a bug, this tool finds it before any external developer does. Bugs found here get fixed in the SDK before they ever ship. This is the SDK's proving ground.

### 3. Protocol Verification

The v3 protocol is exercised end-to-end against every node configuration in production:
- LCD node discovery with pagination
- Protobuf-encoded `MsgStartSessionRequest` broadcast
- Node handshake with secp256k1 signature and compressed public key
- WireGuard tunnel establishment via Windows service
- V2Ray tunnel establishment via SOCKS5 proxy (VMess and VLess, multiple transports)
- Bandwidth measurement through the live tunnel
- Graceful teardown and cleanup

If the protocol spec has an edge case that only surfaces with grpc/none transport on a VMess node with 200 seconds of clock drift — this tool finds it. And it has. Repeatedly.

---

## Hard-Won Knowledge

Every line of protocol code in this project was earned through failure:

- **UUID encoding:** Go's `[16]byte` serializes as an integer array, not base64. Took hours to discover.
- **VLess flow field:** Must be empty string. `xtls-rprx-vision` is Xray-only. V2Ray rejects it silently.
- **VMess clock drift:** AEAD auth requires clocks within 120 seconds. Drifted nodes drain the connection for 16 seconds then close. Looks like a network error. It's not.
- **gun vs grpc:** Transport protocol 2 and 3 are different protocols. gun is raw HTTP/2, grpc uses the gRPC library. Treating them as the same breaks everything.
- **SOCKS5 with fetch:** Node.js native fetch silently ignores the agent option. Only axios works. This cost an entire debugging session.
- **5-second handshake delay:** The node's V2Ray API needs time to register the UUID after handshake. Without the wait, every connection fails.
- **Signature format:** Exactly 64 bytes, no more. The session ID is big-endian uint64 prepended to the data before hashing.

None of this is documented anywhere in the Sentinel protocol docs. It exists here because this tool discovered it through brute-force testing against real nodes.

---

## Your Responsibilities

When you work on this project, you are maintaining the founder's most important diagnostic instrument. Treat it accordingly:

1. **Never break what works.** 443+ nodes have been tested successfully. The protocol code is battle-tested. Do not refactor it for aesthetics.

2. **Every change gets verified.** If you modify tunnel logic, handshake code, or payment flows — test it. Not with mocks. Against real nodes.

3. **Preserve the knowledge.** The comments, the constants, the non-negotiables in CLAUDE.md — they exist because something broke without them. Do not remove them because they look redundant.

4. **Results are sacred.** `results/results.json` contains real test data from real spending of real P2P tokens. Never overwrite it carelessly.

5. **The legacy `lib/` folder is dead.** All imports come from `core/`, `protocol/`, `platforms/`, `audit/`. The `lib/` copies are kept for reference only.

6. **This is not a demo.** Real money flows through this tool.

7. **Any node with peers that fails = OUR BUG.** If a node has peers, it's alive. If it's alive and we can't connect, our code is broken. Study the V2Ray stderr, clock drift, transport types. Never stop looking for a solution. Never dismiss a failure as "node issue" when peers > 0. Real tokens are spent on every audit run. Real node operators' livelihoods depend on the data it produces. Act like it matters, because it does.

---

## In Summary

The Node Tester is the founder's instrument for holding an entire decentralized network accountable. It validates that the SDK works, the protocol works, and the nodes work — not in theory, but in production, with real money, against real infrastructure operated by real people around the world.

There is no substitute for this tool. Respect it.
