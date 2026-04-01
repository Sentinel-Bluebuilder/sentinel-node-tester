/**
 * Sentinel Node Tester — Chain Queries
 * Adapter: uses SDK for LCD queries, pagination, and node discovery.
 * Keeps audit-specific: sticky LCD, plan membership annotation, local cache wrapper.
 */

import {
  fetchActiveNodes as sdkFetchActiveNodes,
  invalidateNodeCache as sdkInvalidateNodeCache,
  lcdQuery,
  lcdPaginatedSafe,
  queryNode,
  discoverPlans as sdkDiscoverPlans,
  querySubscriptions as sdkQuerySubscriptions,
  hasActiveSubscription as sdkHasActiveSub,
} from 'sentinel-dvpn-sdk/cosmjs-setup';
import { LCD_ENDPOINTS as SDK_LCD_ENDPOINTS, tryWithFallback } from 'sentinel-dvpn-sdk/defaults';
import { LCD_ENDPOINTS as LOCAL_LCD_ENDPOINTS } from './constants.js';

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

// ─── Node List (delegates to SDK with caching + remoteAddrs) ────────────────

/**
 * Fetch all active nodes from chain. SDK handles pagination, caching (5-min TTL),
 * and populates remoteAddrs[] for fallback.
 */
export async function getAllNodes(broadcast) {
  const lcd = await ensureLcd();
  try {
    const nodes = await sdkFetchActiveNodes(lcd);
    // Normalize to the format the Node Tester expects
    const result = nodes.map(n => ({
      address: n.address,
      remoteUrl: n.remote_url || '',
      remoteAddrs: n.remoteAddrs || (n.remote_addrs || []).map(a => a.startsWith('http') ? a : `https://${a}`),
      gigabyte_prices: n.gigabyte_prices || [],
      status: 1,
      planIds: [],
    }));
    if (broadcast) broadcast('log', { msg: `  ${result.length} nodes fetched from chain` });
    return result;
  } catch (err) {
    if (broadcast) broadcast('log', { msg: `  ⚠ Node fetch failed: ${err.message}` });
    throw err;
  }
}

/** Invalidate node list cache — delegates to SDK */
export function invalidateNodeCache() {
  sdkInvalidateNodeCache();
}

/**
 * Direct query: is this node active on chain RIGHT NOW?
 * Uses SDK's queryNode with multi-endpoint fallback.
 */
export async function queryNodeStatusDirect(nodeAddr) {
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

// ─── Plan Membership (audit-specific) ───────────────────────────────────────

/**
 * Fetch subscription plans and mark which nodes belong to each plan.
 */
export async function fetchPlanMembership(nodes, broadcast) {
  const lcd = getActiveLcd();
  if (!lcd) return;
  const planNodeSets = {};

  try {
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

    for (const pid of planIds) {
      const planNodes = new Set();
      let nextKey = null;
      do {
        let url = `${lcd}/sentinel/node/v3/nodes?plan_id=${pid}&status=1&pagination.limit=200`;
        if (nextKey) url += `&pagination.key=${encodeURIComponent(nextKey)}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        const d = await r.json();
        for (const n of (d.nodes || [])) planNodes.add(n.address);
        nextKey = d.pagination?.next_key || null;
      } while (nextKey);
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
    if (broadcast) broadcast('log', { msg: `Plans: ${Object.keys(planNodeSets).length} active plans, ${inPlan} nodes in at least one plan` });
  } catch (err) {
    if (broadcast) broadcast('log', { msg: `Plan lookup failed (non-critical): ${err.message}` });
  }
}

// ─── Plan Discovery (delegates to SDK) ──────────────────────────────────────

export async function discoverPlans(broadcast, opts = {}) {
  const lcd = await ensureLcd();
  try {
    const plans = await sdkDiscoverPlans(lcd, opts);
    if (broadcast) broadcast('log', { msg: `📋 Discovered ${plans.length} active plans` });
    return plans;
  } catch (err) {
    // Fallback to local implementation if SDK fails
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
