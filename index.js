/**
 * Sentinel Node Tester — Single Entry Point
 *
 * Import anything you need from one place:
 *   import { testNode, speedTest, getAllNodes } from 'sentinel-node-tester';
 */

// ─── Core Testing ────────────────────────────────────────────────────────────
export { testNode } from './audit/node-test.js';
export { testWithRetry } from './audit/retry.js';
export { runAudit, runRetestSkips } from './audit/pipeline.js';

// ─── Chain & Wallet ──────────────────────────────────────────────────────────
export { getAllNodes, findWorkingLcd, getActiveLcd, queryNodeStatusDirect, invalidateNodeCache, discoverPlans, querySubscriptions, hasActiveSubscription, cleanupRpc } from './core/chain.js';
export { signAndBroadcastRetry, assertIsDeliverTxSuccess } from './core/wallet.js';
export {
  getCredential, saveCredential, clearCredential, clearAllCredentials,
  markSessionPoisoned, isPaid, markPaid, clearPaidNodes,
  findExistingSession, buildSessionMap, submitBatchPayment,
  waitForSessionActive, extractAllSessionIds, extractSessionMap,
  invalidateSessionCache, parseNodePriceUdvpn,
} from './core/session.js';

// ─── Protocol ────────────────────────────────────────────────────────────────
export {
  nodeStatusV3, generateWgKeyPair, initHandshakeV3, initHandshakeV3V2Ray,
  buildV2RayClientConfig, writeWgConfig, extractSessionId, waitForPort,
} from './protocol/v3protocol.js';
export {
  speedtestDirect, speedtestViaSocks5, checkGoogleDirect, checkGoogleViaSocks5,
  resolveSpeedtestIPs, sleep,
} from './protocol/speedtest.js';
export { classifyFailure } from './protocol/diagnostics.js';

// ─── Platform (Windows) ──────────────────────────────────────────────────────
export { installWgTunnel, uninstallWgTunnel, WG_AVAILABLE, IS_ADMIN, emergencyCleanupSync } from './platforms/windows/wireguard.js';
export { spawnV2Ray, cleanupV2Ray, killAllV2Ray, killV2RayByPid, nextSocksPort } from './platforms/windows/v2ray.js';

// ─── C# Bridge ───────────────────────────────────────────────────────────────
export { BRIDGE_AVAILABLE, bridgeNodeStatus, bridgeHandshakeWG, bridgeHandshakeV2Ray } from './core/csharp-bridge.js';

// ─── Transport Intelligence ──────────────────────────────────────────────────
export { reorderOutbounds, recordTransportSuccess, recordTransportFailure, getCachedTransport, saveTransportCache } from './core/transport-cache.js';

// ─── Country/Flag Helpers ─────────────────────────────────────────────────
export { COUNTRY_MAP, countryNameToCode, getFlagUrl, getFlagEmoji, groupNodesByCountry } from './core/countries.js';

// ─── Constants ───────────────────────────────────────────────────────────────
export {
  MNEMONIC, RPC, DENOM, GAS_PRICE, GIGS, TEST_MB, MAX_NODES, NODE_DELAY, PORT,
  DNS_PRESETS, ACTIVE_DNS, setActiveDns,
  V3_MSG_TYPE, LCD_ENDPOINTS, PROJECT_ROOT,
} from './core/constants.js';
