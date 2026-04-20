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
  rpcQueryPlan,
  rpcQuerySubscriptionsForAccount,
  sentprovToSent,
  queryFeeGrant,
  broadcastWithFeeGrant as sdkBroadcastWithFeeGrant,
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
export async function getRpcClient() {
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
  // Sentinel v3 chain truncates at `limit` without emitting `next_key`.
  // A single large request returns the full set (chain has its own hard ceiling).
  const PAGE_SIZE = 10000;
  try {
    const pagination = encodeRpcVarintField(3, PAGE_SIZE); // limit at field 3
    const request = concatBytes([
      encodeRpcVarintField(1, 1),                // status = active
      encodeRpcEmbedded(2, pagination),           // pagination
    ]);
    const result = await client.queryClient.queryAbci(
      '/sentinel.node.v3.QueryService/QueryNodes',
      request,
    );
    const fields = decodeRpcProto(new Uint8Array(result.value));
    const nodes = (fields[1] || []).map(entry => decodeRpcNode(decodeRpcProto(entry.value)));
    if (broadcast) broadcast('log', { msg: `  RPC: ${nodes.length} nodes fetched (limit=${PAGE_SIZE})` });
    return nodes;
  } catch (err) {
    if (broadcast) broadcast('log', { msg: `  RPC fetch failed: ${err.message}` });
    return null;
  }
}

/**
 * Fetch ALL nodes linked to a plan via RPC with raw ABCI pagination.
 * Chain caps ABCI queries at 100 per page; we loop with next_key until done.
 *
 * QueryNodesForPlanRequest proto:
 *   1 = id (uint64 plan id), 2 = status (enum), 3 = pagination (PageRequest)
 * PageRequest fields: 1=key, 2=offset, 3=limit, 4=count_total, 5=reverse
 *
 * @param {{ queryClient }} client
 * @param {number|string|bigint} planId
 * @param {(channel:string, data:any)=>void} [broadcast]
 * @returns {Promise<Array<object>>} — empty array on failure
 */
export async function rpcFetchAllNodesForPlanPaginated(client, planId, broadcast) {
  // Sentinel v3 chain truncates at `limit` without emitting `next_key`.
  // A single large request returns the full set (observed: plan 36 → 803 nodes
  // with limit=1000 but only 100 with limit=100, and no next_key either time).
  const PAGE_SIZE = 10000;
  try {
    const pagination = encodeRpcVarintField(3, PAGE_SIZE); // limit at field 3
    const request = concatBytes([
      encodeRpcVarintField(1, BigInt(planId)), // plan id
      encodeRpcVarintField(2, 1),              // status = active
      encodeRpcEmbedded(3, pagination),        // pagination
    ]);
    const result = await client.queryClient.queryAbci(
      '/sentinel.node.v3.QueryService/QueryNodesForPlan',
      request,
    );
    const fields = decodeRpcProto(new Uint8Array(result.value));
    const nodes = (fields[1] || []).map(entry => decodeRpcNode(decodeRpcProto(entry.value)));
    if (broadcast) broadcast('log', { msg: `  RPC plan ${planId}: ${nodes.length} nodes (limit=${PAGE_SIZE})` });
    return nodes;
  } catch (err) {
    if (broadcast) broadcast('log', { msg: `  RPC plan ${planId} fetch failed: ${err.message}` });
    return [];
  }
}

// ─── Minimal Protobuf Helpers (for raw ABCI pagination) ────────────────────
// Exported so session.js can reuse for RPC session queries.

export function encodeRpcVarint(value) {
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

export function encodeRpcVarintField(fieldNum, value) {
  if (!value && value !== 0) return new Uint8Array(0);
  const tag = encodeRpcVarint((BigInt(fieldNum) << 3n) | 0n);
  const val = encodeRpcVarint(value);
  return concatBytes([tag, val]);
}

export function encodeRpcBytes(fieldNum, data) {
  const tag = encodeRpcVarint((BigInt(fieldNum) << 3n) | 2n);
  const len = encodeRpcVarint(data.length);
  return concatBytes([tag, len, data]);
}

export function encodeRpcEmbedded(fieldNum, bytes) {
  if (!bytes || bytes.length === 0) return new Uint8Array(0);
  return encodeRpcBytes(fieldNum, bytes);
}

export function concatBytes(arrays) {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export function decodeRpcProto(buf) {
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

export function decodeRpcString(data) {
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
    const result = rpcNodes.map(n => {
      const addrs = (n.remote_addrs || []).map(a => a.startsWith('http') ? a : `https://${a}`);
      return {
        address: n.address,
        remoteUrl: addrs[0] || '',
        remoteAddrs: addrs,
        gigabyte_prices: n.gigabyte_prices || [],
        status: 1,
        planIds: [],
      };
    });
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
 * Minimal protobuf decoder for google.protobuf.Any bytes returned by
 * rpcQuerySubscriptionsForAccount. Returns { typeUrl, valueBytes }.
 * Only handles wire types 0 (varint) and 2 (length-delimited).
 */
function _decodeAny(buf) {
  let i = 0;
  let typeUrl = '';
  let valueBytes = null;
  while (i < buf.length) {
    let tag = 0n;
    let shift = 0n;
    while (i < buf.length) {
      const b = buf[i++];
      tag |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if (!(b & 0x80)) break;
    }
    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 0x7n);
    if (wireType === 0) {
      // varint — skip
      while (i < buf.length) { if (!(buf[i++] & 0x80)) break; }
    } else if (wireType === 2) {
      let len = 0n;
      let s = 0n;
      while (i < buf.length) {
        const b = buf[i++];
        len |= BigInt(b & 0x7f) << s;
        s += 7n;
        if (!(b & 0x80)) break;
      }
      const slice = buf.slice(i, i + Number(len));
      i += Number(len);
      if (fieldNum === 1) typeUrl = new TextDecoder().decode(slice);
      else if (fieldNum === 2) valueBytes = slice;
    } else {
      break; // unsupported wire type — stop parsing
    }
  }
  return { typeUrl, valueBytes };
}

/**
 * Decode a PlanSubscription proto bytes.
 * field 1 = base_subscription (embedded), field 2 = plan_id (varint uint64).
 * base_subscription field 1 = id (uint64).
 */
function _decodePlanSubscription(buf) {
  let i = 0;
  let planId = null;
  let baseBytes = null;
  while (i < buf.length) {
    let tag = 0n;
    let shift = 0n;
    while (i < buf.length) {
      const b = buf[i++];
      tag |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if (!(b & 0x80)) break;
    }
    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 0x7n);
    if (wireType === 0) {
      let val = 0n;
      let s = 0n;
      while (i < buf.length) {
        const b = buf[i++];
        val |= BigInt(b & 0x7f) << s;
        s += 7n;
        if (!(b & 0x80)) break;
      }
      if (fieldNum === 2) planId = val;
    } else if (wireType === 2) {
      let len = 0n;
      let s = 0n;
      while (i < buf.length) {
        const b = buf[i++];
        len |= BigInt(b & 0x7f) << s;
        s += 7n;
        if (!(b & 0x80)) break;
      }
      const slice = buf.slice(i, i + Number(len));
      i += Number(len);
      if (fieldNum === 1) baseBytes = slice;
    } else {
      break;
    }
  }
  // Decode id from base_subscription (field 1 = id varint)
  let subscriptionId = null;
  if (baseBytes) {
    let j = 0;
    while (j < baseBytes.length) {
      let tag2 = 0n;
      let shift2 = 0n;
      while (j < baseBytes.length) {
        const b = baseBytes[j++];
        tag2 |= BigInt(b & 0x7f) << shift2;
        shift2 += 7n;
        if (!(b & 0x80)) break;
      }
      const fn2 = Number(tag2 >> 3n);
      const wt2 = Number(tag2 & 0x7n);
      if (wt2 === 0) {
        let val2 = 0n;
        let s2 = 0n;
        while (j < baseBytes.length) {
          const b = baseBytes[j++];
          val2 |= BigInt(b & 0x7f) << s2;
          s2 += 7n;
          if (!(b & 0x80)) break;
        }
        if (fn2 === 1) subscriptionId = val2;
      } else if (wt2 === 2) {
        let len2 = 0n;
        let s2 = 0n;
        while (j < baseBytes.length) {
          const b = baseBytes[j++];
          len2 |= BigInt(b & 0x7f) << s2;
          s2 += 7n;
          if (!(b & 0x80)) break;
        }
        j += Number(len2);
      } else {
        break;
      }
    }
  }
  return { subscriptionId: subscriptionId ? String(subscriptionId) : null, planId: planId ? String(planId) : null };
}

/**
 * Fetch subscription plans and mark which nodes belong to each plan.
 * Step 1: Discover plan IDs — RPC first (rpcQuerySubscriptionsForAccount),
 *   LCD fallback if RPC unavailable.
 * Step 2: For each plan, get its nodes — RPC first, LCD fallback.
 */
export async function fetchPlanMembership(nodes, broadcast) {
  const planNodeSets = {};

  try {
    const planIds = new Set();
    const rpcClient = await getRpcClient();

    if (rpcClient) {
      // RPC path: query subscriptions for a sentinel sentinel network-wide scan
      // rpcQuerySubscriptionsForAccount returns Any bytes; decode each to find PlanSubscriptions
      // NOTE: This queries ALL subscriptions on chain (no address filter in global query).
      // The global plan-ID discovery requires iterating all subscriptions via LCD pagination,
      // but we use RPC to decode each returned entry efficiently when an address IS known.
      // For global plan discovery (no specific address), fall through to LCD.
      // Mark RPC available for Step 2 node queries.
    }

    // Step 1: Discover plan IDs from subscriptions (LCD — global scan, no address filter in RPC)
    const lcd = getActiveLcd();
    if (!lcd) return;
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

    // Step 2: For each plan, get its nodes (RPC first, LCD fallback)
    for (const pid of planIds) {
      const planNodes = new Set();

      if (rpcClient) {
        try {
          const planNodeList = await rpcQueryNodesForPlan(rpcClient, BigInt(pid), { status: 1, limit: 500 });
          for (const n of planNodeList) planNodes.add(n.address);
        } catch {
          // fall through to LCD for this plan
        }
      }

      if (planNodes.size === 0) {
        const lcd2 = getActiveLcd();
        if (lcd2) {
          let nextKey = null;
          do {
            let url = `${lcd2}/sentinel/node/v3/nodes?plan_id=${pid}&status=1&pagination.limit=200`;
            if (nextKey) url += `&pagination.key=${encodeURIComponent(nextKey)}`;
            const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
            const d = await r.json();
            for (const n of (d.nodes || [])) planNodes.add(n.address);
            nextKey = d.pagination?.next_key || null;
          } while (nextKey);
        }
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
      expiry: s.expiry || s.inactive_at || s.base_subscription?.inactive_at || null,
    }));
  } catch { return []; }
}

export async function hasActiveSubscription(walletAddress, planId) {
  const subs = await querySubscriptions(walletAddress);
  const match = subs.find(s => String(s.plan_id) === String(planId));
  if (match) return { has: true, subscriptionId: match.id };
  return { has: false };
}

// ─── Sub. Plan mode: enriched subscriber-plan query ─────────────────────────
/**
 * Decode a Plan protobuf message (raw ABCI bytes) → { id, provAddress }.
 * Plan proto: field 1 = id (uint64), field 2 = prov_address (string).
 */
function decodePlanRaw(bytes) {
  if (!bytes) return null;
  const f = decodeRpcProto(new Uint8Array(bytes));
  return {
    id: f[1]?.[0] ? String(f[1][0].value) : null,
    provAddress: f[2]?.[0] ? decodeRpcString(f[2][0].value) : null,
  };
}

/**
 * Query the plan owner (sent1...) for a given plan ID via RPC, with LCD skip
 * (LCD /plan/v3/plans/{id} returns 501 on this chain).
 * Returns null if plan not found or prov_address missing.
 */
export async function queryPlanOwnerSent(planId) {
  try {
    const client = await getRpcClient();
    if (!client) return null;
    const bytes = await rpcQueryPlan(client, BigInt(planId));
    const plan = decodePlanRaw(bytes);
    if (!plan?.provAddress) return null;
    return sentprovToSent(plan.provAddress);
  } catch { return null; }
}

/**
 * Sub. Plan mode query.
 * Returns the wallet's active subscriptions enriched with:
 *   - planId                - the plan this sub belongs to
 *   - ownerSentAddr         - the plan owner's sent1... (fee granter)
 *   - expiry                - inactive_at
 *   - feeGrantActive        - true if granter has an active feegrant for this wallet
 *   - nodeCount             - number of active nodes in this plan
 *
 * One row per subscription. Caller picks one → runSubPlanTest tests that plan's
 * nodes with session TXs fee-granted by the plan owner.
 */
export async function querySubscriberPlansEnriched(walletAddress) {
  if (!walletAddress) return [];
  const lcd = await ensureLcd();
  const subs = await querySubscriptions(walletAddress);
  if (subs.length === 0) return [];

  const ownerCache = new Map();
  const nodeCountCache = new Map();
  const rpcClient = await getRpcClient();

  const results = [];
  for (const s of subs) {
    const planId = s.plan_id;
    if (!planId) continue;

    let ownerSentAddr = ownerCache.get(planId);
    if (ownerSentAddr === undefined) {
      ownerSentAddr = await queryPlanOwnerSent(planId);
      ownerCache.set(planId, ownerSentAddr);
    }

    let feeGrantActive = false;
    if (ownerSentAddr) {
      try {
        const allowance = await queryFeeGrant(lcd, ownerSentAddr, walletAddress);
        feeGrantActive = !!allowance;
      } catch { }
    }

    let nodeCount = nodeCountCache.get(planId);
    if (nodeCount === undefined) {
      nodeCount = 0;
      if (rpcClient) {
        try {
          const nodes = await rpcQueryNodesForPlan(rpcClient, BigInt(planId), { status: 1, limit: 500 });
          nodeCount = nodes.length;
        } catch { }
      }
      if (nodeCount === 0) {
        try {
          const r = await fetch(`${lcd}/sentinel/node/v3/plans/${planId}/nodes?pagination.limit=5000`, {
            signal: AbortSignal.timeout(12000),
          });
          const d = await r.json();
          nodeCount = (d.nodes || []).length;
        } catch { }
      }
      nodeCountCache.set(planId, nodeCount);
    }

    results.push({
      subscriptionId: String(s.id),
      planId: String(planId),
      ownerSentAddr: ownerSentAddr || null,
      expiry: s.expiry || null,
      feeGrantActive,
      nodeCount,
    });
  }
  return results;
}

// ─── Sub. Plan mode: fee-granted broadcast wrapper ──────────────────────────
/**
 * Broadcast a message list where `granterAddress` pays gas instead of `signerAddress`.
 * Thin pass-through to the SDK — kept here so pipeline imports stay consistent.
 */
export async function broadcastWithFeeGrant(client, signerAddress, msgs, granterAddress, memo = '') {
  return sdkBroadcastWithFeeGrant(client, signerAddress, msgs, granterAddress, memo);
}
