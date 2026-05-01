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
  rpcQueryNodes,
  rpcQueryNodesForPlan,
  rpcQueryPlan,
  rpcQuerySubscriptionsForAccount,
  rpcQueryBalance,
  sentprovToSent,
  queryFeeGrant,
  broadcastWithFeeGrant as sdkBroadcastWithFeeGrant,
  disconnectRpc,
} from 'blue-js-sdk';
import { broadcastSerialized, forceReconnect } from './wallet.js';

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
  } catch (e) {
    console.error('[chain] getRpcClient failed (all RPC endpoints exhausted):', e?.message || e);
    return null;
  }
}

/** Disconnect and clear the cached RPC client */
export function cleanupRpc() {
  if (_rpcClient) {
    try { disconnectRpc(); }
    catch (e) { console.error('[chain] disconnectRpc failed:', e?.message || e); }
    _rpcClient = null;
    _rpcUrl = null;
  }
}

/**
 * Run an RPC operation with a timeout. If the first attempt times out or
 * throws, rotate the cached client (`cleanupRpc()`) and retry once on a
 * fresh endpoint via `createRpcQueryClientWithFallback()`.
 *
 * The cached client in `getRpcClient()` is sticky — it picks one endpoint at
 * first connect and never rotates if that endpoint later 502s mid-session.
 * This wrapper unsticks it for any consumer that opts in.
 *
 * @template T
 * @param {(client: any) => Promise<T>} op - operation receiving the RPC client
 * @param {string} label - short label used in timeout/error messages
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function withFreshRpc(op, label, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 12000;
  const withTimeout = (p, lbl) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(
      () => rej(new Error(`${lbl} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )),
  ]);
  const attempt = async (lbl) => {
    const client = await withTimeout(getRpcClient(), `${lbl}:getRpcClient`);
    if (!client) throw new Error(`${lbl}: RPC client unavailable`);
    return withTimeout(Promise.resolve().then(() => op(client)), lbl);
  };
  try {
    return await attempt(label);
  } catch (err) {
    cleanupRpc();
    try {
      return await attempt(`${label}(retry)`);
    } catch (err2) {
      throw new Error(`${label} failed (initial=${err.message}; retry=${err2.message})`);
    }
  }
}

// ─── Node List (RPC primary, LCD fallback) ─────────────────────────────────

/**
 * Wrapper around SDK's rpcQueryNodes with broadcast logging.
 * Returns null if RPC is unavailable (signals LCD fallback).
 */
async function rpcFetchAllNodes(broadcast) {
  const client = await getRpcClient();
  if (!client) return null;
  try {
    const nodes = await rpcQueryNodes(client, { status: 1, limit: 10000 });
    if (broadcast) broadcast('log', { msg: `  RPC: ${nodes.length} nodes fetched` });
    return nodes;
  } catch (err) {
    if (broadcast) broadcast('log', { msg: `  RPC fetch failed: ${err.message}` });
    return null;
  }
}

/**
 * Wrapper around SDK's rpcQueryNodesForPlan with broadcast logging.
 * Returns [] on failure (caller falls back to LCD).
 *
 * @param {{ queryClient }} client
 * @param {number|string|bigint} planId
 * @param {(channel:string, data:any)=>void} [broadcast]
 * @returns {Promise<Array<object>>}
 */
export async function rpcFetchAllNodesForPlanPaginated(client, planId, broadcast) {
  try {
    const nodes = await rpcQueryNodesForPlan(client, BigInt(planId), { status: 1, limit: 10000 });
    if (broadcast) broadcast('log', { msg: `  RPC plan ${planId}: ${nodes.length} nodes` });
    return nodes;
  } catch (err) {
    if (broadcast) broadcast('log', { msg: `  RPC plan ${planId} fetch failed: ${err.message}` });
    return [];
  }
}

// ─── Minimal Protobuf Helpers (for raw ABCI pagination) ────────────────────
// Used by discoverPlans, queryPlanOwnerSent, queryFeeGrantRpcFirst, session.js,
// and the scripts/probe-*.mjs tooling.

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
        hourly_prices: n.hourly_prices || [],
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
      hourly_prices: n.hourly_prices || [],
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
  // RPC first — withFreshRpc rotates a wedged endpoint instead of hanging.
  try {
    const node = await withFreshRpc(
      (client) => rpcQueryNode(client, nodeAddr),
      'queryNodeStatusDirect',
    );
    if (node) {
      const st = node.status === 1 || node.status === '1' ? 1 : 0;
      return { active: st === 1, status: st };
    }
    // null result — could be inactive or not found, try LCD
  } catch (err) {
    console.warn(`[queryNodeStatusDirect] RPC failed (${nodeAddr}): ${err.message}`);
  }

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

// ─── Plan Discovery (RPC-first, LCD fallback) ───────────────────────────────

export async function discoverPlans(broadcast, opts = {}) {
  // Try RPC ABCI first: /sentinel.plan.v3.QueryService/QueryPlans
  // Request proto: field 1 = status (varint enum 1=active), field 2 = pagination
  try {
    const PAGE_SIZE = 1000;
    const pagination = encodeRpcVarintField(3, PAGE_SIZE);
    const request = concatBytes([
      encodeRpcVarintField(1, 1),       // status = active
      encodeRpcEmbedded(2, pagination), // pagination
    ]);
    const result = await withFreshRpc(
      (client) => client.queryClient.queryAbci(
        '/sentinel.plan.v3.QueryService/QueryPlans',
        request,
      ),
      'discoverPlans',
    );
    if (result?.value && result.value.length > 0) {
      const fields = decodeRpcProto(new Uint8Array(result.value));
      if (fields[1] && fields[1].length > 0) {
        const plans = fields[1].map(entry => {
          const pf = decodeRpcProto(entry.value);
          return {
            id: pf[1]?.[0] ? String(pf[1][0].value) : null,
            provAddress: pf[2]?.[0] ? decodeRpcString(pf[2][0].value) : null,
            status: 'active',
          };
        }).filter(p => p.id);
        if (broadcast) broadcast('log', { msg: `Discovered ${plans.length} active plans (RPC)` });
        return plans;
      }
    }
  } catch (rpcErr) {
    // TODO(wave-a-blocker): RPC plan discovery failed — check if /sentinel.plan.v3.QueryService/QueryPlans is the correct ABCI path on this chain version
    console.warn('[discoverPlans] RPC failed, falling back to LCD:', rpcErr.message);
  }

  // LCD fallback
  const lcd = await ensureLcd();
  try {
    const plans = await sdkDiscoverPlans(lcd, opts);
    if (broadcast) broadcast('log', { msg: `Discovered ${plans.length} active plans (LCD)` });
    return plans;
  } catch (err) {
    if (broadcast) broadcast('log', { msg: `Plan discovery failed: ${err.message}` });
    return [];
  }
}

// ─── Subscriptions (delegates to SDK) ───────────────────────────────────────

/**
 * Check if a subscription status value represents "active".
 * Chain v3 returns "STATUS_ACTIVE"; older clients may return "active" or
 * numeric 1. Accept all three forms so the filter never silently drops subs.
 *
 * @param {string|number} status
 * @returns {boolean}
 */
function isActiveStatus(status) {
  if (status === 1 || status === '1') return true;
  const s = String(status).toLowerCase();
  return s === 'active' || s === 'status_active';
}

export async function querySubscriptions(walletAddress) {
  // RPC-first for direct subs (fast). RPC's QuerySubscriptionsForAccount does
  // NOT return shared-plan allocations (e.g. plan 36 where wallet is allocatee
  // not acc_address) — those only appear via LCD. So we always do an LCD pass
  // afterwards and merge any IDs RPC missed.
  const rpcOut = [];
  try {
    // Bug fix: SDK default limit is 100 — wallets with long sub history (older
    // expired subs still iterated by chain) silently drop newer subscriptions.
    const rawEntries = await withFreshRpc(
      (client) => rpcQuerySubscriptionsForAccount(client, walletAddress, { limit: 5000 }),
      'querySubscriptions',
    );
    if (rawEntries && rawEntries.length > 0) {
      for (const entry of rawEntries) {
        try {
          const bytes = entry instanceof Uint8Array ? entry
            : entry.value instanceof Uint8Array ? entry.value
            : null;
          if (!bytes) continue;
          const anyDecoded = _decodeAny(bytes);
          if (!anyDecoded.valueBytes) continue;
          const sub = _decodePlanSubscription(anyDecoded.valueBytes);
          if (!sub.planId) continue;
          rpcOut.push({
            id: sub.subscriptionId,
            plan_id: sub.planId,
            status: 'STATUS_ACTIVE',
            expiry: null,
            ownerAddress: walletAddress, // RPC only returns direct subs
            viaAllocation: false,
            grantedBytes: null,
          });
        } catch { /* skip malformed */ }
      }
    }
  } catch (rpcErr) {
    console.warn('[querySubscriptions] RPC failed, falling back to LCD:', rpcErr.message);
  }

  // LCD pass: direct query with ?status=1 so chain pre-filters at source.
  // Also filter client-side with isActiveStatus() to handle both chain v2
  // ("active") and chain v3 ("STATUS_ACTIVE") response formats.
  const lcd = await ensureLcd();
  try {
    const r = await fetch(
      `${lcd}/sentinel/subscription/v3/accounts/${walletAddress}/subscriptions?status=1&pagination.limit=500`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const raw = Array.isArray(data.subscriptions) ? data.subscriptions : [];
    // /accounts/{addr}/subscriptions returns BOTH direct subs and subs where
    // addr is an allocatee on a shared plan. For non-direct subs, verify a
    // non-zero allocation via v2 /subscriptions/{id}/allocations.
    const active = raw.filter(s => isActiveStatus(s.status));
    const haveIds = new Set(rpcOut.map(s => String(s.id)));
    const out = [...rpcOut];
    for (const s of active) {
      const isOwner = s.acc_address === walletAddress;
      const sid = String(s.id);
      // Enrich expiry on RPC entries
      if (haveIds.has(sid)) {
        const existing = out.find(x => String(x.id) === sid);
        if (existing && !existing.expiry) existing.expiry = s.inactive_at || null;
        if (existing && s.acc_address) existing.ownerAddress = s.acc_address;
        continue;
      }
      let viaAllocation = false;
      let grantedBytes = null;
      if (!isOwner) {
        try {
          const ar = await fetch(
            `${lcd}/sentinel/subscription/v2/subscriptions/${sid}/allocations?pagination.limit=500`,
            { signal: AbortSignal.timeout(10_000) },
          );
          if (ar.ok) {
            const aj = await ar.json();
            const mine = (aj.allocations || []).find(a => a.address === walletAddress);
            if (mine && mine.granted_bytes && mine.granted_bytes !== '0') {
              viaAllocation = true;
              grantedBytes = mine.granted_bytes;
            }
          }
        } catch { /* skip */ }
        if (!viaAllocation) continue;
      }
      out.push({
        id: sid,
        plan_id: s.plan_id,
        status: s.status,
        expiry: s.inactive_at || null,
        ownerAddress: s.acc_address,
        viaAllocation,
        grantedBytes,
      });
    }
    return out;
  } catch {
    return rpcOut;
  }
}

// ─── Balance (RPC primary, LCD fallback) ────────────────────────────────────
export async function queryBalance(address, denom = 'udvpn') {
  // RPC primary — wrapped so a wedged endpoint gets rotated rather than hanging.
  try {
    const coin = await withFreshRpc(
      (client) => rpcQueryBalance(client, address, denom),
      'queryBalance',
    );
    return { denom: coin?.denom || denom, amount: String(coin?.amount || '0') };
  } catch (err) {
    console.warn('[queryBalance] RPC failed, falling back to LCD:', err.message);
  }

  // LCD fallback
  try {
    const lcd = await ensureLcd();
    const r = await fetch(`${lcd}/cosmos/bank/v1beta1/balances/${address}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const coin = (data.balances || []).find(c => c.denom === denom);
    return { denom, amount: coin ? String(coin.amount) : '0' };
  } catch { return { denom, amount: '0' }; }
}

export async function hasActiveSubscription(walletAddress, planId) {
  const subs = await querySubscriptions(walletAddress);
  const match = subs.find(s => String(s.plan_id) === String(planId));
  if (match) return { has: true, subscriptionId: match.id };
  return { has: false };
}

// ─── Sub. Plan mode: enriched subscriber-plan query ─────────────────────────
/**
 * Normalize whatever `rpcQueryPlan` returned to `{ id, provAddress }`.
 *
 * The SDK once returned raw protobuf bytes; current versions return a parsed
 * object `{ id, prov_address, ... }`. Handle both so a future SDK refactor in
 * either direction doesn't silently null out every plan owner.
 */
function decodePlanRaw(maybe) {
  if (!maybe) return null;
  // Already-parsed object from current SDK
  if (typeof maybe === 'object' && !ArrayBuffer.isView(maybe) && !(maybe instanceof ArrayBuffer)) {
    const provAddress = maybe.prov_address || maybe.provAddress || null;
    if (provAddress || maybe.id != null) {
      return { id: maybe.id != null ? String(maybe.id) : null, provAddress };
    }
  }
  // Raw bytes path (legacy SDK)
  try {
    const f = decodeRpcProto(new Uint8Array(maybe));
    return {
      id: f[1]?.[0] ? String(f[1][0].value) : null,
      provAddress: f[2]?.[0] ? decodeRpcString(f[2][0].value) : null,
    };
  } catch (e) {
    console.warn('[decodePlanRaw] could not decode plan payload:', e.message);
    return null;
  }
}

/**
 * Query the plan owner (sent1...) for a given plan ID via RPC, with LCD skip
 * (LCD /plan/v3/plans/{id} returns 501 on this chain).
 * Returns null if plan not found or prov_address missing.
 */
export async function queryPlanOwnerSent(planId) {
  try {
    const result = await withFreshRpc(
      (client) => rpcQueryPlan(client, BigInt(planId)),
      `queryPlanOwnerSent(${planId})`,
    );
    const plan = decodePlanRaw(result);
    if (!plan?.provAddress) return null;
    return sentprovToSent(plan.provAddress);
  } catch (e) {
    console.warn(`[queryPlanOwnerSent] plan ${planId}:`, e.message);
    return null;
  }
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
    let feeGrantCheckFailed = false;
    const selfGranter = !!ownerSentAddr && ownerSentAddr === walletAddress;
    if (ownerSentAddr && !selfGranter) {
      try {
        const allowance = await withFreshRpc(
          (client) => queryFeeGrantRpcFirst(client, lcd, ownerSentAddr, walletAddress),
          `queryFeeGrant(plan=${planId})`,
        );
        feeGrantActive = !!allowance;
      } catch (e) {
        console.warn('[querySubscriberPlansEnriched] feeGrant query', e.message);
        feeGrantCheckFailed = true;
      }
    }

    let nodeCount = nodeCountCache.get(planId);
    if (nodeCount === undefined) {
      nodeCount = 0;
      try {
        const nodes = await withFreshRpc(
          (client) => rpcQueryNodesForPlan(client, BigInt(planId), { status: 1, limit: 500 }),
          `nodesForPlan(${planId})`,
        );
        nodeCount = nodes.length;
      } catch (e) {
        console.warn('[querySubscriberPlansEnriched] rpcQueryNodesForPlan', e.message);
      }
      if (nodeCount === 0) {
        try {
          const r = await fetch(`${lcd}/sentinel/node/v3/plans/${planId}/nodes?pagination.limit=5000`, {
            signal: AbortSignal.timeout(12000),
          });
          const d = await r.json();
          nodeCount = (d.nodes || []).length;
        } catch (e) {
          console.warn('[querySubscriberPlansEnriched] LCD nodeCount', e.message);
        }
      }
      nodeCountCache.set(planId, nodeCount);
    }

    results.push({
      subscriptionId: String(s.id),
      planId: String(planId),
      ownerSentAddr: ownerSentAddr || null,
      expiry: s.expiry || null,
      feeGrantActive,
      feeGrantCheckFailed,
      selfGranter,
      nodeCount,
      viaAllocation: !!s.viaAllocation,
      grantedBytes: s.grantedBytes || null,
      subOwnerAddress: s.ownerAddress || null,
    });
  }
  return results;
}

// ─── Sub. Plan mode: fee-granted broadcast wrapper ──────────────────────────
// Cosmos accounts have a single sequence counter. The SDK's broadcastWithFeeGrant
// calls client.signAndBroadcast directly, bypassing core/wallet.js's broadcast
// mutex. When a sub-plan run fires session TXs back-to-back (or concurrently
// with an SNTR1 self-send / payment TX), both broadcasts grab the same sequence
// and the second one fails with code 32 "expected N+1, got N".
//
// Wrap the SDK call in (a) the SAME serialization mutex used by signAndBroadcast
// (`broadcastSerialized` from core/wallet.js), and (b) a sequence-mismatch retry
// loop. Sharing the mutex is critical — separate mutexes still race.
export async function broadcastWithFeeGrant(client, signerAddress, msgs, granterAddress, memo = '', broadcast) {
  const maxRetries = 3;
  return broadcastSerialized(async () => {
    let activeClient = client;
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await sdkBroadcastWithFeeGrant(activeClient, signerAddress, msgs, granterAddress, memo);
      } catch (err) {
        lastErr = err;
        const isSeq = /sequence mismatch/i.test(err.message || '') || err.code === 32;
        if (attempt < maxRetries && isSeq) {
          if (broadcast) broadcast('log', { msg: `  ⚡ Sequence mismatch on fee-granted TX — reconnecting (${attempt + 1}/${maxRetries})...` });
          // Force a fresh signing client so its cached sequence is re-fetched
          // from chain. This is what the SDK's createSafeBroadcaster does on
          // sequence errors — the bare signAndBroadcast path doesn't, so we do it here.
          try { activeClient = await forceReconnect(); } catch (e) {
            if (broadcast) broadcast('log', { msg: `  ⚠ Reconnect failed: ${e.message}` });
          }
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  });
}

// ─── Fee Grant: RPC-first query ───────────────────────────────────────────────
/**
 * Query a fee-grant allowance via RPC ABCI first, falling back to LCD.
 *
 * ABCI path: /cosmos.feegrant.v1beta1.Query/Allowance
 * Request proto: field 1 = granter (string), field 2 = grantee (string)
 * On RPC failure, delegates to the SDK's LCD queryFeeGrant.
 *
 * Returns the allowance object, or null/undefined if not found.
 *
 * @param {{ queryClient: any }} client  - RPC query client (from getRpcClient())
 * @param {string} lcd                   - Active LCD URL (for fallback)
 * @param {string} granter               - sent1... address of the fee granter
 * @param {string} grantee               - sent1... address of the fee grantee
 * @returns {Promise<object|null>}
 */
export async function queryFeeGrantRpcFirst(client, lcd, granter, grantee) {
  // Try RPC ABCI first
  if (client) {
    try {
      const granterBytes = new TextEncoder().encode(granter);
      const granteeBytes = new TextEncoder().encode(grantee);
      const request = concatBytes([
        encodeRpcBytes(1, granterBytes),
        encodeRpcBytes(2, granteeBytes),
      ]);
      const result = await client.queryClient.queryAbci(
        '/cosmos.feegrant.v1beta1.Query/Allowance',
        request,
      );
      if (result?.value && result.value.length > 0) {
        // QueryAllowanceResponse { Grant allowance = 1 }
        // Grant { string granter = 1; string grantee = 2; Any allowance = 3 }
        // Any { string type_url = 1; bytes value = 2 }
        const top = decodeRpcProto(new Uint8Array(result.value));
        const grantBytes = top[1]?.[0]?.value;
        if (!grantBytes) return null;
        const grant = decodeRpcProto(grantBytes);
        const anyBytes = grant[3]?.[0]?.value;
        if (!anyBytes) return { exists: true, _rpcSource: true };
        const anyFields = decodeRpcProto(anyBytes);
        const typeUrl = anyFields[1]?.[0]?.value ? decodeRpcString(anyFields[1][0].value) : null;
        const innerBytes = anyFields[2]?.[0]?.value;

        // Walk through wrapping allowances (PeriodicAllowance/AllowedMsgAllowance) to
        // reach the BasicAllowance that carries spend_limit.
        let outerType = typeUrl;
        let basicBytes = innerBytes;
        for (let depth = 0; depth < 3 && basicBytes; depth++) {
          if (outerType?.endsWith('BasicAllowance')) break;
          const wrap = decodeRpcProto(basicBytes);
          // PeriodicAllowance.basic = 1 (BasicAllowance) | AllowedMsgAllowance.allowance = 1 (Any)
          const innerAnyBytes = wrap[1]?.[0]?.value;
          if (!innerAnyBytes) break;
          if (outerType?.endsWith('PeriodicAllowance')) {
            outerType = '/cosmos.feegrant.v1beta1.BasicAllowance';
            basicBytes = innerAnyBytes;
            break;
          }
          // AllowedMsgAllowance: inner is Any
          const innerAny = decodeRpcProto(innerAnyBytes);
          outerType = innerAny[1]?.[0]?.value ? decodeRpcString(innerAny[1][0].value) : null;
          basicBytes = innerAny[2]?.[0]?.value;
        }

        // BasicAllowance { repeated Coin spend_limit = 1; Timestamp expiration = 2 }
        // Coin { string denom = 1; string amount = 2 }
        const spend_limit = [];
        if (outerType?.endsWith('BasicAllowance') && basicBytes) {
          const basic = decodeRpcProto(basicBytes);
          for (const coinEntry of (basic[1] || [])) {
            const coin = decodeRpcProto(coinEntry.value);
            spend_limit.push({
              denom: coin[1]?.[0]?.value ? decodeRpcString(coin[1][0].value) : '',
              amount: coin[2]?.[0]?.value ? decodeRpcString(coin[2][0].value) : '0',
            });
          }
        }

        return {
          exists: true,
          _rpcSource: true,
          '@type': typeUrl,
          spend_limit: spend_limit.length ? spend_limit : null,
        };
      }
      // Empty response = no grant found
      return null;
    } catch (e) {
      // Cosmos SDK reports "no grant exists" as a chain error, not an empty
      // response. Treat it as a successful negative answer (null) rather than
      // an RPC failure that should fall back to LCD.
      const msg = String(e?.message || '');
      if (/fee[- ]?grant not found/i.test(msg) || /allowance does not exist/i.test(msg)) {
        return null;
      }
      console.warn('[queryFeeGrantRpcFirst] RPC failed, falling back to LCD:', msg);
    }
  }
  // LCD fallback
  return queryFeeGrant(lcd, granter, grantee);
}
