/**
 * Sentinel Node Tester — Session Management
 * Session map, credential cache, batch payment, duplicate guard.
 *
 * Uses SDK's extractAllSessionIds for TX event parsing.
 * Keeps audit-specific: submitBatchPayment (with state mutation + logging),
 * credential cache (local disk), session map (audit TTL), dedup guard.
 */

import { DENOM, GIGS, SESSION_MAP_TTL, V3_MSG_TYPE } from './constants.js';
import { signAndBroadcastRetry, assertIsDeliverTxSuccess } from './wallet.js';
import { getActiveLcd, getRpcClient, withFreshRpc } from './chain.js';
import { sleep } from '../protocol/speedtest.js';
import {
  extractAllSessionIds as sdkExtractAllSessionIds,
  rpcQuerySessionsForAccount,
  rpcQuerySession as sdkRpcQuerySession,
  saveCredentials as sdkSaveCredentials,
  loadCredentials as sdkLoadCredentials,
  clearCredentials as sdkClearCredentials,
  clearAllCredentials as sdkClearAllCredentials,
  buildMsgCancelSession,
} from 'blue-js-sdk';

// ─── Session Credential Cache (SDK encrypted store: ~/.sentinel-sdk/) ──────
// Tester API stays { saveCredential, getCredential, clearCredential, clearAllCredentials }
// — call sites pass a flat object containing `sessionId` + credential fields. We unpack
// sessionId here and delegate to SDK's encrypted, pruned, sessionId-keyed credential store.

export function saveCredential(nodeAddr, data) {
  const { sessionId, ...creds } = data || {};
  sdkSaveCredentials(nodeAddr, String(sessionId || ''), creds);
}

export function getCredential(nodeAddr) {
  const stored = sdkLoadCredentials(nodeAddr);
  if (!stored) return null;
  // Caller-side accesses .sessionId / .type / .uuid / .wgPrivateKey / etc. flat.
  // SDK already returns flat shape with sessionId at top level — pass through.
  return stored;
}

export function clearCredential(nodeAddr) {
  sdkClearCredentials(nodeAddr);
}

export function clearAllCredentials() {
  sdkClearAllCredentials();
}

// ─── Session Reuse Map ──────────────────────────────────────────────────────
let sessionMap = null;
let sessionMapAt = 0;

// Session poisoning: track sessions that failed handshake
const poisonedSessions = new Set();

export function markSessionPoisoned(nodeAddr, sessionId) {
  poisonedSessions.add(`${nodeAddr}:${sessionId}`);
}

export function isSessionPoisoned(nodeAddr, sessionId) {
  return poisonedSessions.has(`${nodeAddr}:${sessionId}`);
}

export function clearPoisonedSessions() {
  poisonedSessions.clear();
}

// ─── Duplicate Payment Guard ────────────────────────────────────────────────
const paidNodesThisRun = new Set();

export function markPaid(nodeAddr) {
  paidNodesThisRun.add(nodeAddr);
}

export function isPaid(nodeAddr) {
  return paidNodesThisRun.has(nodeAddr);
}

export function clearPaidNodes() {
  paidNodesThisRun.clear();
}

/** Invalidate session map after payment creates new sessions */
export function invalidateSessionCache() { sessionMap = null; }

/** Add a newly created session to the map without full refetch */
export function addToSessionMap(nodeAddr, sessionId) {
  if (!sessionMap) sessionMap = new Map();
  sessionMap.set(nodeAddr, { sessionId, maxBytes: GIGS * 1_000_000_000, usedBytes: 0 });
}

// ─── RPC Session Fetch (delegates to SDK) ──────────────────────────────────
// SDK's rpcQuerySessionsForAccount handles ABCI encoding + Any-unwrapping +
// BaseSession decoding. Sentinel v3 truncates at `limit` without emitting
// next_key, so a single large request returns the full set.

async function rpcFetchAllSessions(walletAddress) {
  // RPC-first per global rule. withFreshRpc rotates on a wedged endpoint
  // before giving up and signalling LCD fallback to the caller.
  try {
    return await withFreshRpc(
      (client) => rpcQuerySessionsForAccount(client, walletAddress, { limit: 2000 }),
      'rpcFetchAllSessions',
    );
  } catch {
    return null;
  }
}

/**
 * Fetch ALL active sessions for this wallet.
 * RPC primary (protobuf, faster), LCD fallback (REST/JSON).
 * Builds a Map<nodeAddr, {sessionId, maxBytes, usedBytes}> for instant O(1) lookups.
 */
export async function buildSessionMap(walletAddress, broadcast) {
  if (!walletAddress) return;
  const map = new Map();

  // Helper to populate map from decoded sessions
  function processSession(bs) {
    const sNode = bs.node_address;
    if (!sNode) return;
    if (bs.acc_address && bs.acc_address !== walletAddress) return;
    // status: 1 = active (RPC returns int), 'active' (LCD returns string)
    if (bs.status && bs.status !== 1 && bs.status !== 'active') return;
    const maxBytes = parseInt(bs.max_bytes || '0');
    const used = parseInt(bs.download_bytes || '0') + parseInt(bs.upload_bytes || '0');
    if (maxBytes > 0 && used >= maxBytes) return;
    const sid = BigInt(bs.id);
    if (isSessionPoisoned(sNode, String(sid))) return;
    const existing = map.get(sNode);
    if (!existing || (maxBytes - used) > (existing.maxBytes - existing.usedBytes)) {
      map.set(sNode, { sessionId: sid, maxBytes, usedBytes: used });
    }
  }

  // Try RPC first
  const rpcSessions = await rpcFetchAllSessions(walletAddress);
  if (rpcSessions) {
    for (const bs of rpcSessions) processSession(bs);
    sessionMap = map;
    sessionMapAt = Date.now();
    if (broadcast) broadcast('log', { msg: `  ♻ Session map: ${map.size} reusable sessions (${rpcSessions.length} fetched via RPC)` });
    return;
  }

  // LCD fallback
  const activeLcd = getActiveLcd();
  if (!activeLcd) return;
  let nextKey = null;
  let totalFetched = 0;
  do {
    let url = `${activeLcd}/sentinel/session/v3/sessions?address=${walletAddress}&status=1&pagination.limit=200`;
    if (nextKey) url += `&pagination.key=${encodeURIComponent(nextKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) break;
    const data = await res.json();
    for (const s of (data.sessions || [])) {
      const bs = s.base_session || s;
      processSession({
        id: bs.id,
        node_address: bs.node_address || bs.node,
        acc_address: bs.acc_address || bs.address,
        status: bs.status,
        max_bytes: bs.max_bytes,
        download_bytes: bs.download_bytes,
        upload_bytes: bs.upload_bytes,
      });
    }
    totalFetched += (data.sessions || []).length;
    nextKey = data.pagination?.next_key || null;
  } while (nextKey);
  sessionMap = map;
  sessionMapAt = Date.now();
  if (broadcast) broadcast('log', { msg: `  ♻ Session map: ${map.size} reusable sessions (${totalFetched} fetched via LCD)` });
}

export async function findExistingSession(nodeAddr, walletAddress, broadcast) {
  const activeLcd = getActiveLcd();
  if (!activeLcd || !walletAddress) return null;
  try {
    const now = Date.now();
    if (!sessionMap || now - sessionMapAt > SESSION_MAP_TTL) {
      await buildSessionMap(walletAddress, broadcast);
    }
    const entry = sessionMap?.get(nodeAddr);
    return entry ? entry.sessionId : null;
  } catch (err) {
    if (err?.name !== 'AbortError' && !/timeout|ECONNREFUSED|ENOTFOUND/i.test(err?.message || '')) {
      if (broadcast) broadcast('log', { msg: `⚠ findExistingSession error: ${err?.message}` });
    }
  }
  return null;
}

/** Parse gigabyte_prices array and return price per GB in udvpn (integer) */
export function parseNodePriceUdvpn(gigabytePrices) {
  if (!gigabytePrices) return 0;
  if (Array.isArray(gigabytePrices)) {
    const entry = gigabytePrices.find(p => p.denom === 'udvpn');
    return entry ? Math.round(parseFloat(entry.quote_value) || 0) : 0;
  }
  for (const part of String(gigabytePrices).split(',')) {
    const m = part.trim().match(/^(\d+)udvpn$/i);
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

/**
 * Extract all session IDs from a multi-message tx.
 * Delegates to SDK (handles SessionID variant + base64 decoding).
 */
export function extractAllSessionIds(txResult) {
  return sdkExtractAllSessionIds(txResult);
}

/**
 * Extract session IDs keyed by node_address from a multi-message tx.
 * Returns Map<nodeAddress, BigInt sessionId>.
 * Chain events do NOT include node_address (confirmed 2026-03-23).
 * Returns only orphan IDs — caller MUST query chain to map them to nodes.
 */
export function extractSessionMap(txResult, nodeAddrs) {
  const map = new Map();
  const orphanIds = [];

  for (const event of (txResult.events || [])) {
    if (!/session/i.test(event.type)) continue;
    let sessionId = null;
    let nodeAddr = null;
    for (const attr of event.attributes) {
      const k = typeof attr.key === 'string' ? attr.key : Buffer.from(attr.key, 'base64').toString('utf8');
      const v = typeof attr.value === 'string' ? attr.value : Buffer.from(attr.value, 'base64').toString('utf8');
      const clean = v.replace(/"/g, '');
      if (k === 'session_id' || k === 'id') {
        const id = BigInt(clean);
        if (id > 0n) sessionId = id;
      }
      if (k === 'node_address') nodeAddr = clean;
    }
    if (sessionId && nodeAddr) {
      map.set(nodeAddr, sessionId);
    } else if (sessionId) {
      orphanIds.push(sessionId);
    }
  }

  // Chain events NEVER include node_address. Do NOT guess by index — causes address mismatch.
  // Mark orphan IDs for chain lookup by caller.
  map._orphanIds = orphanIds;
  map._needsChainLookup = orphanIds.length > 0 && map.size < (nodeAddrs?.length || 0);
  return map;
}

/**
 * Submit one tx with up to BATCH_SIZE MsgStartSession messages.
 * Returns Map<nodeAddr, BigInt sessionId> for all NEW sessions.
 */
export async function submitBatchPayment(client, account, denom, gigabytes, batch, state, broadcast) {
  const pricingMode = state?.pricingMode === 'hours' ? 'hours' : 'gigabytes';
  const sessionGigabytes = pricingMode === 'hours' ? 0 : gigabytes;
  const sessionHours = pricingMode === 'hours' ? 1 : 0;
  const result = new Map();
  const reusedAddrs = new Set();
  const toPayBatch = [];
  for (const { node } of batch) {
    if (isPaid(node.address)) {
      if (broadcast) broadcast('log', { msg: `  ⏭ Skip ${node.address.slice(0, 20)}… — already paid this run` });
      continue;
    }
    const priceList = pricingMode === 'hours' ? (node.hourly_prices || []) : (node.gigabyte_prices || []);
    const priceEntry = priceList.find(p => p.denom === denom);
    if (priceEntry) {
      toPayBatch.push({ node, priceEntry });
    } else if (broadcast && pricingMode === 'hours') {
      broadcast('log', { msg: `  ⏭ Skip ${node.address.slice(0, 20)}… — no hourly price` });
    }
  }
  if (toPayBatch.length > 0) {
    const messages = toPayBatch.map(({ node, priceEntry }) => ({
      typeUrl: V3_MSG_TYPE,
      value: {
        from: account.address, node_address: node.address,
        gigabytes: sessionGigabytes, hours: sessionHours,
        max_price: { denom: priceEntry.denom, base_value: priceEntry.base_value, quote_value: priceEntry.quote_value },
      },
    }));
    const n = toPayBatch.length;
    const fee = { amount: [{ denom, amount: String(200000 * n) }], gas: String(800000 * n) };
    let txResult;
    try {
      txResult = await signAndBroadcastRetry(client, account.address, messages, fee, broadcast);
      assertIsDeliverTxSuccess(txResult);
    } catch (batchErr) {
      // "invalid price" (Code 106) — retry WITHOUT max_price.
      // The chain rejects certain price combinations in max_price even though the node
      // registered with that price. Omitting max_price lets the chain use the node's price directly.
      if (/invalid price|code: 106/i.test(batchErr.message)) {
        if (broadcast) broadcast('log', { msg: `  ⚠ Batch failed with "invalid price" — retrying without max_price...` });
        const messagesNoMax = toPayBatch.map(({ node }) => ({
          typeUrl: V3_MSG_TYPE,
          value: {
            from: account.address, node_address: node.address,
            gigabytes: sessionGigabytes, hours: sessionHours,
          },
        }));
        txResult = await signAndBroadcastRetry(client, account.address, messagesNoMax, fee, broadcast);
        assertIsDeliverTxSuccess(txResult);
      } else {
        throw batchErr;
      }
    }
    const batchAddrs = toPayBatch.map(({ node }) => node.address);
    const sessionMap = extractSessionMap(txResult, batchAddrs);
    toPayBatch.forEach(({ node }) => markPaid(node.address));

    if (sessionMap._needsChainLookup) {
      // Chain events don't include node_address — MUST query chain to map sessions to nodes.
      // Do NOT use index-based guessing — it causes address mismatch on handshake.
      if (broadcast) broadcast('log', { msg: `  🔍 Querying chain for ${batchAddrs.length} session→node mappings...` });
      await sleep(3000); // Wait for chain indexing
      invalidateSessionCache();
      await buildSessionMap(account.address, broadcast);
      for (const addr of batchAddrs) {
        const sid = await findExistingSession(addr, account.address, null);
        if (sid) {
          result.set(addr, sid);
          addToSessionMap(addr, sid);
        } else if (broadcast) {
          broadcast('log', { msg: `  ⚠ No session found for ${addr.slice(0, 20)}… — paid but unmapped; deposit will be cancelled via orphan recovery` });
        }
      }
      // Deposit lock-up guard (Task C.2): every node in toPayBatch was markPaid'd
      // above, and the batch TX DID create a session on-chain for each. When the
      // post-pay chain query misses a node, that session is paid-but-unmapped:
      // it never enters `result`, so the pipeline can't cancel it (deposit locks
      // until natural settlement) AND the node hits testNode's duplicate-payment
      // guard (charged, untested). We can't safely map the orphan session id to a
      // specific node (index guessing causes handshake address mismatch), but we
      // CAN still recover the deposit: surface the unmapped orphan session ids so
      // the pipeline folds them into the batch cancel set. The node still fails
      // untested this batch, but its 1 GB deposit is no longer locked.
      //
      // This recovers the deposit. The charged-yet-untested outcome is now also
      // handled upstream: testNode re-queries the chain for the missed node's
      // session (node-test.js, the `isPaid && !sessionId` branch) and reuses it
      // if found (no new payment), or fails it cleanly as SESSION_UNMAPPED — so a
      // session the batch query merely missed gets tested instead of abandoned.
      const mappedIds = new Set([...result.values()].map(String));
      const orphanCancelIds = (sessionMap._orphanIds || [])
        .map(String)
        .filter(id => !mappedIds.has(id));
      if (orphanCancelIds.length > 0) {
        result._orphanSessionIds = orphanCancelIds;
        if (broadcast) broadcast('log', { msg: `  ↩ ${orphanCancelIds.length} paid-but-unmapped session(s) flagged for cancel to recover deposit(s).` });
      }
    } else {
      // Events had node_address (future chain upgrade) — use direct mapping
      for (const addr of batchAddrs) {
        const sid = sessionMap.get(addr);
        if (sid) {
          result.set(addr, sid);
          addToSessionMap(addr, sid);
        }
      }
    }
    if (broadcast) broadcast('log', { msg: `  Batch tx (${n} msgs): ${txResult.transactionHash.slice(0, 16)}…` });
    toPayBatch.forEach(({ node }) => {
      const list = pricingMode === 'hours' ? (node.hourly_prices || []) : (node.gigabyte_prices || []);
      const priceEntry = list.find(p => p.denom === denom);
      const units = pricingMode === 'hours' ? sessionHours : gigabytes;
      if (priceEntry) state.spentUdvpn += Math.round(parseFloat(priceEntry.quote_value) || 0) * units;
    });
    state.spentUdvpn += 200000 * n;
    state.balance = `${(Math.max(0, state.balanceUdvpn - state.spentUdvpn) / 1_000_000).toFixed(4)} P2P (est. remaining)`;
    state.estimatedTotalCost = `${(state.spentUdvpn / 1_000_000).toFixed(4)} P2P`;
    if (broadcast) broadcast('state', { state });
  }
  result._reusedAddrs = reusedAddrs;
  return result;
}

/**
 * Submit one tx with up to N MsgCancelSession messages.
 *
 * Refund mechanics (verified live on mainnet 2026-04-27):
 *   - Cancel TX flips session.status from active(1) → inactive_pending(2).
 *     Only events emitted in the cancel TX itself are `coin_spent/received/transfer`
 *     (the gas fee), `message`, `tx`, and `sentinel.session.v3.EventUpdateStatus`.
 *   - There is NO `NodeEventRefund` in the cancel TX. The refund (unused-bandwidth
 *     deposit minus consumed_bytes) is applied AFTER the inactive_pending settlement
 *     window closes — at which point the chain emits `sentinel.node.v3.EventRefund`
 *     in the settlement block (NOT in the operator's TX).
 *   - There is NO minimum session duration before cancel is accepted (verified by
 *     0-second and 5-second cancel tests both succeeding).
 *   - Up to N cancels CAN be batched in one TX (verified with N=5).
 *
 * @returns {Promise<{ txHash: string, count: number }>} | null on no-op
 */
export async function submitBatchCancel(client, account, sessionIds, broadcast) {
  const ids = sessionIds.filter(Boolean);
  if (ids.length === 0) return null;
  const messages = ids.map(id => buildMsgCancelSession({ from: account.address, id }));
  const fee = {
    amount: [{ denom: DENOM, amount: String(20_000 * ids.length) }],
    gas: String(200_000 * ids.length),
  };
  try {
    const txResult = await signAndBroadcastRetry(client, account.address, messages, fee, broadcast);
    assertIsDeliverTxSuccess(txResult);
    if (broadcast) broadcast('log', { msg: `  ↩ Cancelled ${ids.length} session(s) in tx ${txResult.transactionHash.slice(0, 12)}… (refund settles after the inactive-pending window).` });
    return { txHash: txResult.transactionHash, count: ids.length };
  } catch (err) {
    if (broadcast) broadcast('log', { msg: `  ⚠ Batch cancel failed (${ids.length} sessions): ${err.message}. Sessions will fall through to natural settlement.` });
    return null;
  }
}

/**
 * Poll until all node sessions appear on chain, or timeout.
 * Uses RPC primary, LCD fallback.
 */
export async function waitForBatchSessions(nodeAddrs, walletAddr, maxWaitMs = 20000) {
  if (nodeAddrs.length === 0) return;
  const pending = new Set(nodeAddrs);
  const deadline = Date.now() + maxWaitMs;
  while (pending.size > 0 && Date.now() < deadline) {
    await sleep(2000);
    try {
      // Try RPC first
      const rpcSessions = await rpcFetchAllSessions(walletAddr);
      if (rpcSessions) {
        for (const bs of rpcSessions) {
          if (pending.has(bs.node_address)) pending.delete(bs.node_address);
        }
        continue;
      }
      // LCD fallback
      const activeLcd = getActiveLcd();
      if (!activeLcd) continue;
      const url = `${activeLcd}/sentinel/session/v3/sessions?address=${walletAddr}&status=1&pagination.limit=200`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data = await res.json();
      for (const s of (data.sessions || [])) {
        const bs = s.base_session || s;
        const n = bs.node_address || bs.node;
        if (pending.has(n)) pending.delete(n);
      }
    } catch { /* transient error — retry on next poll */ }
  }
}

/**
 * Query a single session by ID via RPC. Delegates to SDK.
 * Returns decoded session object or null.
 */
async function rpcQuerySession(sessionId) {
  // RPC-first per global rule. withFreshRpc rotates on a wedged endpoint
  // before signalling LCD fallback to the caller.
  try {
    return await withFreshRpc(
      (client) => sdkRpcQuerySession(client, sessionId),
      `rpcQuerySession(${sessionId})`,
    );
  } catch {
    return null;
  }
}

export async function waitForSessionActive(nodeAddr, walletAddr, maxWaitMs = 20000, sessionId = null) {
  // If we have a session ID, query it directly — much faster than scanning all sessions
  if (sessionId) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await sleep(2000);
      try {
        // Try RPC first
        const rpcSession = await rpcQuerySession(sessionId);
        if (rpcSession) {
          if (rpcSession.status === 1) return; // 1 = active
          continue;
        }
        // LCD fallback
        const activeLcd = getActiveLcd();
        if (!activeLcd) continue;
        const url = `${activeLcd}/sentinel/session/v3/sessions/${sessionId}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const data = await res.json();
          const bs = data.session?.base_session || data.session || {};
          if (bs.status === 'active' || bs.status === 1) return;
        }
      } catch { /* transient error — retry on next poll */ }
    }
    return;
  }
  // Fallback: scan by wallet address (slow with 500+ sessions)
  await waitForBatchSessions([nodeAddr], walletAddr, maxWaitMs);
}
