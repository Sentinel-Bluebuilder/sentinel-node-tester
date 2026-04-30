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

// ─── Platform (auto-dispatch by OS) ──────────────────────────────────────────
// Windows / Linux / macOS each have their own implementation. Other platforms
// fall through to no-op stubs so `import 'sentinel-node-tester'` never crashes.
const _platform = process.platform;
let _wg, _v2ray;
if (_platform === 'win32') {
  _wg = await import('./platforms/windows/wireguard.js');
  _v2ray = await import('./platforms/windows/v2ray.js');
} else if (_platform === 'linux') {
  _wg = await import('./platforms/linux/wireguard.js');
  _v2ray = await import('./platforms/linux/v2ray.js');
} else if (_platform === 'darwin') {
  _wg = await import('./platforms/macos/wireguard.js');
  _v2ray = await import('./platforms/macos/v2ray.js');
} else {
  _wg = {
    installWgTunnel: async () => { throw new Error(`WireGuard not supported on ${_platform}`); },
    uninstallWgTunnel: async () => {},
    WG_AVAILABLE: false,
    IS_ADMIN: false,
    emergencyCleanupSync: () => {},
  };
  _v2ray = {
    spawnV2Ray: async () => { throw new Error(`V2Ray not supported on ${_platform}`); },
    cleanupV2Ray: () => {},
    killAllV2Ray: () => {},
    killV2RayByPid: () => {},
    nextSocksPort: async () => 10800,
  };
}
export const installWgTunnel = _wg.installWgTunnel;
export const uninstallWgTunnel = _wg.uninstallWgTunnel;
export const WG_AVAILABLE = _wg.WG_AVAILABLE;
export const IS_ADMIN = _wg.IS_ADMIN;
export const emergencyCleanupSync = _wg.emergencyCleanupSync;
export const spawnV2Ray = _v2ray.spawnV2Ray;
export const cleanupV2Ray = _v2ray.cleanupV2Ray;
export const killAllV2Ray = _v2ray.killAllV2Ray;
export const killV2RayByPid = _v2ray.killV2RayByPid;
export const nextSocksPort = _v2ray.nextSocksPort;

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
