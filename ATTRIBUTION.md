# Attribution

This project is built on the **Blue JS SDK** — the JavaScript SDK for Sentinel dVPN.

| | |
|---|---|
| **SDK Repository** | [Sentinel-Bluebuilder/blue-js-sdk](https://github.com/Sentinel-Bluebuilder/blue-js-sdk) |
| **npm Package** | [`sentinel-dvpn-sdk`](https://www.npmjs.com/package/sentinel-dvpn-sdk) |
| **License** | MIT |
| **Installed Version** | ^1.5.1 |

---

## SDK Code Usage

The node tester consumes the Blue JS SDK as a runtime dependency. The table below maps every file in this project to its SDK relationship.

### Direct SDK Imports

These files import functions directly from `sentinel-dvpn-sdk`:

| File | What's Imported | Role |
|------|-----------------|------|
| `protocol/v3protocol.js` | `nodeStatusV3`, `generateWgKeyPair`, `initHandshakeV3`, `initHandshakeV3V2Ray`, `buildV2RayClientConfig`, `writeWgConfig`, `extractSessionId`, `waitForPort`, `generateV2RayUUID`, `encodeMsgStartSession`, `encodeMsgEndSession`, `encodeMsgStartSubscription`, `encodeMsgSubStartSession`, `validateCIDR`, `buildMsgStartSession`, `buildMsgEndSession`, `buildMsgStartSubscription`, `buildMsgSubStartSession` | Pure re-export — 100% SDK passthrough for all v3 protocol operations |
| `protocol/speedtest.js` | `sleep`, `speedtestDirect`, `speedtestViaSocks5`, `resolveSpeedtestIPs`, `flushSpeedTestDnsCache`, `compareSpeedTests`, `SPEEDTEST_DEFAULTS` | SDK speedtest engine + local Google accessibility check |
| `core/wallet.js` | `createWallet`, `privKeyFromMnemonic`, `createClient`, `buildRegistry`, `broadcast`, `createSafeBroadcaster`, `RPC_ENDPOINTS`, `SDK_VERSION` | SDK wallet/crypto primitives wrapped with RPC rotation and retry |
| `core/chain.js` | `fetchActiveNodes`, `flushNodeCache`, `discoverPlans`, `querySubscriptions`, `LCD_ENDPOINTS`, `createRpcQueryClientWithFallback`, `rpcQueryNode`, `rpcQueryNodesForPlan`, `disconnectRpc` | SDK chain queries wrapped with LCD failover and pagination |
| `core/session.js` | `extractAllSessionIds`, `markSessionPoisoned`, `isSessionPoisoned`, `querySessions`, `querySessionAllocation` | SDK session functions extended with credential caching and batch payment |
| `core/errors.js` | `SentinelError`, `ValidationError`, `NodeError`, `ChainError`, `TunnelError`, `SecurityError`, `ErrorCodes`, `ERROR_SEVERITY`, `isRetryable`, `userMessage` | SDK error hierarchy extended with audit-specific subclasses |
| `core/constants.js` | `MSG_TYPES` | SDK message type strings used as source of truth for protocol constants |
| `audit/pipeline.js` | `rpcQueryNode`, `rpcQueryNodesForPlan` | SDK RPC query functions for audit orchestration |

### Derived From SDK

| File | Source |
|------|--------|
| `core/countries.js` | Static data copied from `blue-js-sdk/app-helpers.js` — 80+ country-to-ISO-code mappings |

### Original to This Project

These files contain code written specifically for the node tester with no SDK origin:

| File | Purpose |
|------|---------|
| `server.js` | Express server, SSE dashboard, REST API |
| `index.html` | Dashboard UI |
| `audit/pipeline.js` | Audit orchestration (state machine, batch scheduling) |
| `audit/node-test.js` | Single-node test logic |
| `audit/retry.js` | Failure classification and retry strategy |
| `protocol/diagnostics.js` | VPN interference detection, failure forensics |
| `core/transport-cache.js` | V2Ray transport intelligence (learns per-node) |
| `core/types.js` | JSDoc type definitions |
| `platforms/windows/wireguard.js` | Windows WireGuard service management |
| `platforms/windows/v2ray.js` | Windows V2Ray process management |
| `platforms/windows/network.js` | Windows VPN adapter detection |
| `easy.js` | Simplified 3-function API |

---

## License

Both this project and the Blue JS SDK are licensed under the [MIT License](LICENSE).
