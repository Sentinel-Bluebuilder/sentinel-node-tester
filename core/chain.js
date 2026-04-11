/**
 * Sentinel Node Tester — Chain Queries
 * Adapter: uses SDK for RPC queries (primary) with LCD fallback.
 * RPC is ~10x faster per-request via protobuf/ABCI. LCD used as fallback
 * when RPC endpoints are unreachable.
 *
 * Keeps audit-specific: sticky LCD, plan membership annotation, local cache wrapper.
 */

import {
  fetchActiveNodes as sdkFetchActiveNodes,
  flushNodeCache as sdkFlushNodeCache,
  discoverPlans as sdkDiscoverPlans,
  querySubscriptions as sdkQuerySubscriptions,
  LCD_ENDPOINTS as SDK_LCD_ENDPOINTS,
  createRpcQueryClientWithFallback,
  rpcQueryNode,
  rpcQueryNodesForPlan,
  disconnectRpc,
} from 'sentinel-dvpn-sdk';

// ─── LCD Endpoint Management ────────────────────────────────────────────────
const LCD_LIST = SDK_LCD_ENDPOINTS.map(e => e.url);
let _activeLcd = null;

export function getActiveLcd() { return _activeLcd || LCD_LIST[0]; }
export function setActiveLcd(lcd) { _activeLcd = lcd; }

/** Probe LCD endpoints and return the first working one */
export async function findWorkingLcd() {
  for (const ep of LCD_LIST) {
    try {
      const r = await fetch(`${ep}/sentinel/node/v3/nodes?status=1&pagination.limit=1`, {
        signal: AbortSignal.timeout(6000),
      });
      if (r.ok) { _activeLcd = ep; return ep; }
    } catch { }
  }
  return null;
}

/** Ensure activeLcd is set, probing if needed */
export async function ensureLcd() {
  if (_activeLcd) return _activeLcd;
  const lcd = await findWorkingLcd();
  if (!lcd) throw new Error('No working LCD endpoint found');
  return lcd;
}

// ─── RPC Client Management ─────────────────────────────────────────────────
let _rpcClient = null;
let _rpcUrl = null;

/**
 * Get or create a cached RPC query client with automatic fallback.
 * Returns null if all RPC endpoints fail (caller should use LCD fallback).
 */
async function getRpcClient() {
  if (_rpcClient) return _rpcClient;
  try {
    const result = await createRpcQueryClientWithFallback();
    _rpcClient = result;
    _rpcUrl = result.url;
    return result;
  } catch {
    return null;
  }
}

/** Disconnect and clear the cached RPC client */
export function cleanupRpc() {
  if (_rpcClient) {
    try { disconnectRpc(); } catch { }
    _rpcClient = null;
    _rpcUrl = null;
  }
}

// ─── Node List (RPC primary, LCD fallback) ─────────────────────────────────

/**
 * Fetch all active nodes via RPC with raw ABCI pagination.
 * The chain caps ABCI queries at 100 per page, so we loop with next_key.
 * Returns null if RPC is unavailable (signals LCD fallback).
 */
async function rpcFetchAllNodes(broadcast) {
  const client = await getRpcClient();
  if (!client) return null; // signal LCD fallback
  return rpcFetchAllNodesPaginated(client, broadcast);
}

/**
 * Raw ABCI paginated fetch for all active nodes.
 * Loops with next_key until all pages are fetched.
 *
 * Cosmos PageRequest proto fields:
 *   1 = key (bytes), 2 = offset (uint64), 3 = limit (uint64),
 *   4 = count_total (bool), 5 = reverse (bool)
 * NOTE: The SDK's encodePagination has a bug — it puts limit at field 2 (offset).
 * We use correct field numbers here.
 */
async function rpcFetchAllNodesPaginated(client, broadcast) {
  const allNodes = [];
  let nextKeyBytes = null;
  let page = 0;
  const PAGE_SIZE = 100;
  const MAX_PAGES = 20; // safety: max 2000 nodes

  try {
    do {
      const paginationParts = [];
      if (nextKeyBytes) {
        // key = field 1 (length-delimited bytes)
        paginationParts.push(encodeRpcBytes(1, nextKeyBytes));
      }
      // limit = field 3 (NOT field 2 which is offset)
      paginationParts.push(encodeRpcVarintField(3, PAGE_SIZE));

      const pagination = concatBytes(paginationParts);
      const request = concatBytes([
        encodeRpcVarintField(1, 1),                // status = active
        encodeRpcEmbedded(2, pagination),           // pagination
      ]);

      const result = await client.queryClient.queryAbci(
        '/sentinel.node.v3.QueryService/QueryNodes',
        request,
      );
      const resp = new Uint8Array(result.value);
      const fields = decodeRpcProto(resp);

      // Decode nodes (field 1)
      const nodes = (fields[1] || []).map(entry => decodeRpcNode(decodeRpcProto(entry.value)));
      allNodes.push(...nodes);
      page++;

      // Extract pagination response (field 2) for next_key
      nextKeyBytes = null;
      if (fields[2] && fields[2][0]) {
        const pagResp = decodeRpcProto(fields[2][0].value);
        if (pagResp[1] && pagResp[1][0] && pagResp[1][0].value.length > 0) {
          nextKeyBytes = pagResp[1][0].value;
        }
      }

      if (nodes.length < PAGE_SIZE) break; // last page
    } while (nextKeyBytes && page < MAX_PAGES);

    if (broadcast) broadcast('log', { msg: `  RPC: ${allNodes.length} nodes fetched in ${page} pages` });
    return allNodes;
  } catch (err) {
    if (broadcast) broadcast('log', { msg: `  RPC paginated fetch failed at page ${page}: ${err.message}` });
    // Return what we have if partial, otherwise null for LCD fallback
    return allNodes.length > 0 ? allNodes : null;
  }
}

// ─── Minimal Protobuf Helpers (for raw ABCI pagination) ────────────────────

function encodeRpcVarint(value) {
  let n = BigInt(value);
  const bytes = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    bytes.push(b);
  } while (n > 0n);
  return new Uint8Array(bytes);
}

function encodeRpcVarintField(fieldNum, value) {
  if (!value && value !== 0) return new Uint8Array(0);
  const tag = encodeRpcVarint((BigInt(fieldNum) << 3n) | 0n);
  const val = encodeRpcVarint(value);
  return concatBytes([tag, val]);
}

function encodeRpcBytes(fieldNum, data) {
  const tag = encodeRpcVarint((BigInt(fieldNum) << 3n) | 2n);
  const len = encodeRpcVarint(data.length);
  return concatBytes([tag, len, data]);
}

function encodeRpcEmbedded(fieldNum, bytes) {
  if (!bytes || bytes.length === 0) return new Uint8Array(0);
  return encodeRpcBytes(fieldNum, bytes);
}

function concatBytes(arrays) {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function decodeRpcProto(buf) {
  const fields = {};
  let i = 0;
  while (i < buf.length) {
    let tag = 0n, shift = 0n;
    while (i < buf.length) {
      const b = buf[i++];
      tag |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if (!(b & 0x80)) break;
    }
    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 0x7n);

    if (wireType === 0) {
      let val = 0n, s = 0n;
      while (i < buf.length) {
        const b = buf[i++];
        val |= BigInt(b & 0x7f) << s;
        s += 7n;
        if (!(b & 0x80)) break;
      }
      if (!fields[fieldNum]) fields[fieldNum] = [];
      fields[fieldNum].push({ wireType, value: val });
    } else if (wireType === 2) {
      let len = 0n, s = 0n;
      while (i < buf.length) {
        const b = buf[i++];
        len |= BigInt(b & 0x7f) << s;
        s += 7n;
        if (!(b & 0x80)) break;
      }
      const data = buf.slice(i, i + Number(len));
      i += Number(len);
      if (!fields[fieldNum]) fields[fieldNum] = [];
      fields[fieldNum].push({ wireType, value: data });
    } else if (wireType === 5) { i += 4; }
      else if (wireType === 1) { i += 8; }
  }
  return fields;
}

function decodeRpcString(data) {
  return new TextDecoder().decode(data);
}

function decodeRpcPrice(fields) {
  return {
    denom: fields[1]?.[0] ? decodeRpcString(fields[1][0].value) : '',
    base_value: fields[2]?.[0] ? decodeRpcString(fields[2][0].value) : '0',
    quote_value: fields[3]?.[0] ? decodeRpcString(fields[3][0].value) : '0',
  };
}

function decodeRpcNode(fields) {
  return {
    address: fields[1]?.[0] ? decodeRpcString(fields[1][0].value) : '',
    gigabyte_prices: (fields[2] || []).map(f => decodeRpcPrice(decodeRpcProto(f.value))),
    hourly_prices: (fields[3] || []).map(f => decodeRpcPrice(decodeRpcProto(f.value))),
    remote_addrs: (fields[4] || []).map(f => decodeRpcString(f.value)),
    status: fields[6]?.[0] ? Number(fields[6][0].value) : 0,
  };
}

// ─── Node List (RPC primary → LCD fallback) ────────────────────────────────

/**
 * Fetch all active nodes from chain.
 * Tries RPC first (faster, protobuf), falls back to LCD (REST/JSON).
 */
export async function getAllNodes(broadcast) {
  // Try RPC first
  const rpcNodes = await rpcFetchAllNodes(broadcast);
  if (rpcNodes && rpcNodes.length > 0) {
    const result = rpcNodes.map(n => ({
      address: n.address,
      remoteUrl: '',
      remoteAddrs: (n.remote_addrs || []).map(a => a.startsWith('http') ? a : `https://${a}`),
      gigabyte_prices: n.gigabyte_prices || [],
      status: 1,
      planIds: [],
    }));
    if (broadcast) broadcast('log', { msg: `  ${result.length} nodes fetched via RPC (${_rpcUrl || 'cached'})` });
    return result;
  }

  // LCD fallback
  const lcd = await ensureLcd();
  try {
    const nodes = await sdkFetchActiveNodes(lcd);
    const result = nodes.map(n => ({
      address: n.address,
      remoteUrl: n.remote_url || '',
      remoteAddrs: n.remoteAddrs || (n.remote_addrs || []).map(a => a.startsWith('http') ? a : `https://${a}`),
      gigabyte_prices: n.gigabyte_prices || [],
      status: 1,
      planIds: [],
    }));
    if (broadcast) broadcast('log', { msg: `  ${result.length} nodes fetched via LCD fallback` });
    return result;
  } catch (err) {
    if (broadcast) broadcast('log', { msg: `  Node fetch failed: ${err.message}` });
    throw err;
  }
}

/** Invalidate node list cache — delegates to SDK */
export function invalidateNodeCache() {
  sdkFlushNodeCache();
}

/**
 * Direct query: is this node active on chain RIGHT NOW?
 * Tries RPC first (fast single-node lookup), falls back to LCD.
 */
export async function queryNodeStatusDirect(nodeAddr) {
  // Try RPC first
  try {
    const client = await getRpcClient();
    if (client) {
      const node = await rpcQueryNode(client, nodeAddr);
      if (node) {
        const st = node.status === 1 || node.status === '1' ? 1 : 0;
        return { active: st === 1, status: st };
      }
      // rpcQueryNode returned null — could be inactive or not found, try LCD
    }
  } catch { /* fall through to LCD */ }

  // LCD fallback
  for (const lcd of LCD_LIST) {
    try {
      const res = await fetch(`${lcd}/sentinel/node/v3/nodes/${nodeAddr}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const node = data.node;
      if (!node) continue;
      const st = node.status === 'active' || node.status === 1 || node.status === '1' ? 1 : 0;
      return { active: st === 1, status: st };
    } catch { }
  }
  return { active: false, status: null };
}

// ─── Plan Membership (RPC for node lists, LCD for plan discovery) ──────────

/**
 * Fetch subscription plans and mark which nodes belong to each plan.
 * Uses LCD for plan/subscription discovery (no RPC decoder for plans yet),
 * but uses RPC for querying nodes per plan (decoded protobuf).
 */
export async function fetchPlanMembership(nodes, broadcast) {
  const lcd = getActiveLcd();
  if (!lcd) return;
  const planNodeSets = {};

  try {
    // Step 1: Discover plan IDs from subscriptions (LCD — no RPC decoder for subscriptions)
    const planIds = new Set();
    let subNextKey = null;
    do {
      let subUrl = `${lcd}/sentinel/subscription/v3/subscriptions?pagination.limit=200`;
      if (subNextKey) subUrl += `&pagination.key=${encodeURIComponent(subNextKey)}`;
      const res = await fetch(subUrl, { signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      for (const s of (data.subscriptions || [])) {
        if (s.plan_id && s.status === 'active') planIds.add(s.plan_id);
      }
      subNextKey = data.pagination?.next_key || null;
    } while (subNextKey);

    // Step 2: For each plan, get its nodes (try RPC first, LCD fallback)
    const rpcClient = await getRpcClient();

    for (const pid of planIds) {
      const planNodes = new Set();

      if (rpcClient) {
        // RPC: single request, up to 500 nodes per plan
        try {
          const nodes = await rpcQueryNodesForPlan(rpcClient, BigInt(pid), { status: 1, limit: 500 });
          for (const n of nodes) planNodes.add(n.address);
        } catch {
          // Fall through to LCD for this plan
        }
      }

      if (planNodes.size === 0) {
        // LCD fallback: paginated fetch
        let nextKey = null;
        do {
          let url = `${lcd}/sentinel/node/v3/nodes?plan_id=${pid}&status=1&pagination.limit=200`;
          if (nextKey) url += `&pagination.key=${encodeURIComponent(nextKey)}`;
          const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
          const d = await r.json();
          for (const n of (d.nodes || [])) planNodes.add(n.address);
          nextKey = d.pagination?.next_key || null;
        } while (nextKey);
      }

      planNodeSets[pid] = planNodes;
    }

    const nodeMap = new Map(nodes.map(n => [n.address, n]));
    for (const [pid, addrs] of Object.entries(planNodeSets)) {
      for (const addr of addrs) {
        const node = nodeMap.get(addr);
        if (node) node.planIds.push(pid);
      }
    }

    const inPlan = nodes.filter(n => n.planIds.length > 0).length;
    const rpcNote = rpcClient ? ' (RPC+LCD)' : ' (LCD)';
    if (broadcast) broadcast('log', { msg: `Plans: ${Object.keys(planNodeSets).length} active plans, ${inPlan} nodes in at least one plan${rpcNote}` });
  } catch (err) {
    if (broadcast) broadcast('log', { msg: `Plan lookup failed (non-critical): ${err.message}` });
  }
}

// ─── Plan Discovery (delegates to SDK) ──────────────────────────────────────

export async function discoverPlans(broadcast, opts = {}) {
  const lcd = await ensureLcd();
  try {
    const plans = await sdkDiscoverPlans(lcd, opts);
    if (broadcast) broadcast('log', { msg: `Discovered ${plans.length} active plans` });
    return plans;
  } catch (err) {
    if (broadcast) broadcast('log', { msg: `Plan discovery failed: ${err.message}` });
    return [];
  }
}

// ─── Subscriptions (delegates to SDK) ───────────────────────────────────────

export async function querySubscriptions(walletAddress) {
  const lcd = await ensureLcd();
  try {
    const result = await sdkQuerySubscriptions(lcd, walletAddress, { status: 1 });
    return (result.items || result || []).map(s => ({
      id: s.id || s.base_subscription?.id,
      plan_id: s.plan_id || s.base_subscription?.plan_id,
      status: s.status || s.base_subscription?.status,
      expiry: s.expiry || s.base_subscription?.inactive_at,
    }));
  } catch { return []; }
}

export async function hasActiveSubscription(walletAddress, planId) {
  const subs = await querySubscriptions(walletAddress);
  const match = subs.find(s => String(s.plan_id) === String(planId));
  if (match) return { has: true, subscriptionId: match.id };
  return { has: false };
}
