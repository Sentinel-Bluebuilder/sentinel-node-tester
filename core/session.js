/**
 * Sentinel Node Tester — Session Management
 * Session map, credential cache, batch payment, duplicate guard.
 *
 * Uses SDK's extractAllSessionIds for TX event parsing.
 * Keeps audit-specific: submitBatchPayment (with state mutation + logging),
 * credential cache (local disk), session map (audit TTL), dedup guard.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { DENOM, GIGS, CREDS_FILE, SESSION_MAP_TTL, V3_MSG_TYPE } from './constants.js';
import { signAndBroadcastRetry, assertIsDeliverTxSuccess } from './wallet.js';
import {
  getActiveLcd, getRpcClient,
  encodeRpcVarint, encodeRpcVarintField, encodeRpcBytes, encodeRpcEmbedded,
  concatBytes, decodeRpcProto, decodeRpcString,
} from './chain.js';
import { sleep } from '../protocol/speedtest.js';
import {
  extractAllSessionIds as sdkExtractAllSessionIds,
  markSessionPoisoned as sdkMarkPoisoned,
  isSessionPoisoned as sdkIsPoisoned,
  querySessions as sdkQuerySessions,
  querySessionAllocation as sdkQueryAllocation,
} from 'sentinel-dvpn-sdk';

// ─── Session Credential Cache (disk-persistent) ─────────────────────────────
let credentialCache = {};
if (existsSync(CREDS_FILE)) {
  try { credentialCache = JSON.parse(readFileSync(CREDS_FILE, 'utf8')); } catch { credentialCache = {}; }
}

export function saveCredential(nodeAddr, data) {
  credentialCache[nodeAddr] = { ...data, savedAt: new Date().toISOString() };
  writeFileSync(CREDS_FILE, JSON.stringify(credentialCache, null, 2), 'utf8');
}

export function getCredential(nodeAddr) {
  return credentialCache[nodeAddr] || null;
}

export function clearCredential(nodeAddr) {
  delete credentialCache[nodeAddr];
  writeFileSync(CREDS_FILE, JSON.stringify(credentialCache, null, 2), 'utf8');
}

export function clearAllCredentials() {
  credentialCache = {};
  writeFileSync(CREDS_FILE, '{}', 'utf8');
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

// ─── RPC Session Decoder ────────────────────────────────────────────────────
// BaseSession proto fields (sentinel.session.v3.BaseSession):
//   1=id(uint64), 2=acc_address(string), 3=node_address(string),
//   4=download_bytes(string), 5=upload_bytes(string), 6=max_bytes(string),
//   7=duration, 8=max_duration, 9=status(enum), 10=inactive_at, 11=start_at, 12=status_at
// Session wrappers: field 1 = base_session (embedded)

function decodeRpcBaseSession(buf) {
  const f = decodeRpcProto(buf);
  return {
    id: f[1]?.[0] ? f[1][0].value : 0n,
    acc_address: f[2]?.[0] ? decodeRpcString(f[2][0].value) : '',
    node_address: f[3]?.[0] ? decodeRpcString(f[3][0].value) : '',
    download_bytes: f[4]?.[0] ? decodeRpcString(f[4][0].value) : '0',
    upload_bytes: f[5]?.[0] ? decodeRpcString(f[5][0].value) : '0',
    max_bytes: f[6]?.[0] ? decodeRpcString(f[6][0].value) : '0',
    status: f[9]?.[0] ? Number(f[9][0].value) : 0,
  };
}

function decodeRpcSession(anyBuf) {
  // Unwrap google.protobuf.Any: field 1 = type_url, field 2 = value
  const anyFields = decodeRpcProto(anyBuf);
  const innerBuf = anyFields[2]?.[0]?.value;
  if (!innerBuf) return null;
  // Session wrapper: field 1 = base_session (embedded)
  const sessionFields = decodeRpcProto(innerBuf);
  if (!sessionFields[1]?.[0]) return null;
  return decodeRpcBaseSession(sessionFields[1][0].value);
}

/**
 * Fetch sessions for account via RPC (ABCI query) with pagination.
 * Returns array of decoded session objects, or null if RPC unavailable.
 */
async function rpcFetchAllSessions(walletAddress) {
  const client = await getRpcClient();
  if (!client) return null;

  const allSessions = [];
  let nextKeyBytes = null;
  let page = 0;
  const PAGE_SIZE = 100;
  const MAX_PAGES = 20;

  try {
    do {
      const paginationParts = [];
      if (nextKeyBytes) {
        paginationParts.push(encodeRpcBytes(1, nextKeyBytes));
      }
      paginationParts.push(encodeRpcVarintField(3, PAGE_SIZE));

      const request = concatBytes([
        encodeRpcBytes(1, new TextEncoder().encode(walletAddress)), // address (string = field 1)
        encodeRpcEmbedded(2, concatBytes(paginationParts)),         // pagination
      ]);

      const result = await client.queryClient.queryAbci(
        '/sentinel.session.v3.QueryService/QuerySessionsForAccount',
        request,
      );
      const resp = new Uint8Array(result.value);
      if (resp.length <= 2) break; // empty pagination-only response

      const fields = decodeRpcProto(resp);

      // Field 1 = repeated google.protobuf.Any (sessions)
      const sessions = (fields[1] || []).map(entry => decodeRpcSession(entry.value)).filter(Boolean);
      allSessions.push(...sessions);
      page++;

      // Extract pagination response (field 2) for next_key
      nextKeyBytes = null;
      if (fields[2]?.[0]) {
        const pagResp = decodeRpcProto(fields[2][0].value);
        if (pagResp[1]?.[0]?.value?.length > 0) {
          nextKeyBytes = pagResp[1][0].value;
        }
      }

      if (sessions.length < PAGE_SIZE) break;
    } while (nextKeyBytes && page < MAX_PAGES);

    return allSessions;
  } catch {
    return null; // signal LCD fallback
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
  const result = new Map();
  const reusedAddrs = new Set();
  const toPayBatch = [];
  for (const { node } of batch) {
    if (isPaid(node.address)) {
      if (broadcast) broadcast('log', { msg: `  ⏭ Skip ${node.address.slice(0, 20)}… — already paid this run` });
      continue;
    }
    const priceEntry = (node.gigabyte_prices || []).find(p => p.denom === denom);
    if (priceEntry) toPayBatch.push({ node, priceEntry });
  }
  if (toPayBatch.length > 0) {
    const messages = toPayBatch.map(({ node, priceEntry }) => ({
      typeUrl: V3_MSG_TYPE,
      value: {
        from: account.address, node_address: node.address,
        gigabytes, hours: 0,
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
            gigabytes, hours: 0,
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
          broadcast('log', { msg: `  ⚠ No session found for ${addr.slice(0, 20)}… — will pay individually` });
        }
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
      const priceEntry = (node.gigabyte_prices || []).find(p => p.denom === denom);
      if (priceEntry) state.spentUdvpn += Math.round(parseFloat(priceEntry.quote_value) || 0) * gigabytes;
    });
    state.spentUdvpn += 200000 * n;
    state.balance = `${(Math.max(0, state.balanceUdvpn - state.spentUdvpn) / 1_000_000).toFixed(4)} DVPN (est. remaining)`;
    state.estimatedTotalCost = `${(state.spentUdvpn / 1_000_000).toFixed(4)} DVPN`;
    if (broadcast) broadcast('state', { state });
  }
  result._reusedAddrs = reusedAddrs;
  return result;
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
 * Query a single session by ID via RPC.
 * Returns decoded base session or null.
 */
async function rpcQuerySession(sessionId) {
  const client = await getRpcClient();
  if (!client) return null;
  try {
    const request = encodeRpcVarintField(1, Number(sessionId));
    const result = await client.queryClient.queryAbci(
      '/sentinel.session.v3.QueryService/QuerySession',
      request,
    );
    const resp = new Uint8Array(result.value);
    if (resp.length <= 2) return null;
    const fields = decodeRpcProto(resp);
    // Field 1 = google.protobuf.Any (session)
    if (!fields[1]?.[0]) return null;
    return decodeRpcSession(fields[1][0].value);
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
