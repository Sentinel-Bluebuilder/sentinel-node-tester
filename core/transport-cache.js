/**
 * Sentinel Node Tester — Transport Intelligence Cache
 *
 * Learns which V2Ray transport works for each node and persists it.
 * On next scan, reorders transports so the known-good one is tried first.
 * Also tracks global success rates for never-seen nodes.
 *
 * NO skipping, NO reduced timeouts — just smarter ordering.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { recordTransportResult } from 'blue-js-sdk';
import { RESULTS_DIR } from './constants.js';

// SDK rate-key format mirrors connection/tunnel.js _transportRateKey:
// network=='grpc' or security=='tls' get suffix 'tls' (or special 'grpc/none'),
// otherwise just the network. Tester records protocol-aware key locally and
// dual-writes a normalized key into the SDK rate cache so embedded SDK calls
// benefit from tester's broad-coverage observations.
function sdkTransportKey(network, security) {
  if (!network) return null;
  if (security === 'tls') return `${network}/tls`;
  if (network === 'grpc') return 'grpc/none';
  return network;
}

// ─── Cache File ──────────────────────────────────────────────────────────────
const CACHE_FILE = path.join(RESULTS_DIR, 'transport-cache.json');

let cache = { nodes: {}, globalStats: {} };
let dirty = false;

// ─── Load / Save ─────────────────────────────────────────────────────────────

export function loadTransportCache() {
  if (!existsSync(CACHE_FILE)) return;
  try {
    cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (!cache.nodes) cache.nodes = {};
    if (!cache.globalStats) cache.globalStats = {};
  } catch {
    cache = { nodes: {}, globalStats: {} };
  }
}

export function saveTransportCache() {
  if (!dirty) return;
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  dirty = false;
}

// ─── Record Success ──────────────────────────────────────────────────────────
/**
 * Record a successful transport for a node.
 * Call after V2Ray connectivity + speedtest passes.
 *
 * @param {string} nodeAddr  - sentnode1... address
 * @param {object} transport - { protocol, network, security, port }
 */
export function recordTransportSuccess(nodeAddr, transport) {
  const { protocol, network, security, port } = transport;
  const key = `${protocol}/${network}/${security}`;

  // Per-node cache
  cache.nodes[nodeAddr] = {
    protocol,
    network,
    security,
    port,
    key,
    successCount: (cache.nodes[nodeAddr]?.successCount || 0) + 1,
    lastSuccess: new Date().toISOString(),
  };

  // Global stats
  if (!cache.globalStats[key]) {
    cache.globalStats[key] = { attempts: 0, successes: 0 };
  }
  cache.globalStats[key].successes++;
  cache.globalStats[key].attempts++;
  cache.globalStats[key].rate = cache.globalStats[key].successes / cache.globalStats[key].attempts;

  // Dual-write into SDK's getDynamicRate cache so embedded SDK code paths
  // (setupV2Ray transport ordering) benefit from tester observations.
  const sdkKey = sdkTransportKey(network, security);
  if (sdkKey) try { recordTransportResult(sdkKey, true); } catch { }

  dirty = true;
}

/**
 * Record a failed transport attempt (global stats only).
 * Call after each failed outbound attempt.
 *
 * @param {object} transport - { protocol, network, security }
 */
export function recordTransportFailure(transport) {
  const { protocol, network, security } = transport;
  const key = `${protocol}/${network}/${security}`;

  if (!cache.globalStats[key]) {
    cache.globalStats[key] = { attempts: 0, successes: 0 };
  }
  cache.globalStats[key].attempts++;
  cache.globalStats[key].rate = cache.globalStats[key].successes / cache.globalStats[key].attempts;

  const sdkKey = sdkTransportKey(network, security);
  if (sdkKey) try { recordTransportResult(sdkKey, false); } catch { }

  dirty = true;
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

/**
 * Get the cached successful transport for a node, if any.
 * @param {string} nodeAddr
 * @returns {{ protocol, network, security, port, key, successCount } | null}
 */
export function getCachedTransport(nodeAddr) {
  return cache.nodes[nodeAddr] || null;
}

/**
 * Get global success rate for a transport combo.
 * @param {string} protocol - 'vmess' or 'vless'
 * @param {string} network  - 'tcp', 'grpc', 'websocket', etc.
 * @param {string} security - 'tls' or 'none'
 * @returns {number} success rate 0.0–1.0, or 0.5 if unknown
 */
export function getGlobalRate(protocol, network, security) {
  const key = `${protocol}/${network}/${security}`;
  const stat = cache.globalStats[key];
  if (!stat || stat.attempts < 3) return 0.5; // not enough data — neutral priority
  return stat.rate;
}

// ─── Smart Reorder ───────────────────────────────────────────────────────────

/**
 * Reorder V2Ray outbounds so the most likely to succeed is first.
 *
 * Priority:
 *   1. Cached success for this specific node (exact match on protocol/network/security/port)
 *   2. Global success rate (highest first)
 *   3. Original order (from buildV2RayClientConfig's static priority)
 *
 * @param {string} nodeAddr   - Node address
 * @param {object[]} outbounds - V2Ray config outbounds array
 * @returns {object[]} reordered outbounds (new array, original untouched)
 */
export function reorderOutbounds(nodeAddr, outbounds) {
  if (outbounds.length <= 1) return [...outbounds];

  const cached = getCachedTransport(nodeAddr);
  const sorted = [...outbounds];

  sorted.sort((a, b) => {
    const aProto = a.protocol || '';
    const aNet = a.streamSettings?.network || '';
    const aSec = a.streamSettings?.security || 'none';
    const aPort = a.settings?.vnext?.[0]?.port || 0;

    const bProto = b.protocol || '';
    const bNet = b.streamSettings?.network || '';
    const bSec = b.streamSettings?.security || 'none';
    const bPort = b.settings?.vnext?.[0]?.port || 0;

    // Priority 1: Exact cached match for this node goes first
    if (cached) {
      const aMatch = aProto === cached.protocol && aNet === cached.network && aSec === cached.security && aPort === cached.port;
      const bMatch = bProto === cached.protocol && bNet === cached.network && bSec === cached.security && bPort === cached.port;
      if (aMatch && !bMatch) return -1;
      if (bMatch && !aMatch) return 1;
    }

    // Priority 2: Global success rate
    const aRate = getGlobalRate(aProto, aNet, aSec);
    const bRate = getGlobalRate(bProto, bNet, bSec);
    if (aRate !== bRate) return bRate - aRate; // higher rate first

    // Priority 3: keep original order
    return 0;
  });

  return sorted;
}

/**
 * Get cache stats for logging.
 * @returns {{ nodesCached: number, transportStats: object[] }}
 */
export function getCacheStats() {
  const transportStats = Object.entries(cache.globalStats)
    .map(([key, stat]) => ({
      transport: key,
      attempts: stat.attempts,
      successes: stat.successes,
      rate: stat.attempts > 0 ? (stat.successes / stat.attempts * 100).toFixed(1) + '%' : 'N/A',
    }))
    .sort((a, b) => (b.successes / Math.max(b.attempts, 1)) - (a.successes / Math.max(a.attempts, 1)));

  return {
    nodesCached: Object.keys(cache.nodes).length,
    transportStats,
  };
}
