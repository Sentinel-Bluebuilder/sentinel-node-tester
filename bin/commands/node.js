/**
 * node — Get single node details by sentnode1... address.
 *
 * RPC-first via rpcQueryNode (ABCI /sentinel.node.v3.QueryService/QueryNode),
 * falls back to LCD REST if RPC is unreachable.
 */

import {
  getRpcClient,
  ensureLcd,
} from '../../core/chain.js';
import { rpcQueryNode } from 'sentinel-dvpn-sdk';

// ─── Metadata ────────────────────────────────────────────────────────────────

export const name = 'node';
export const description = 'Get details for a single node (RPC first, LCD fallback).';
export const usage = 'sentinel-audit node <sentnode1...> [--pretty]';
export const flags = [
  { flag: '--pretty', description: 'Human-readable output' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shape(n) {
  if (!n) return null;
  const out = {};
  if (n.address)   out.address   = n.address;
  if (n.moniker)   out.moniker   = n.moniker;
  const url = n.remoteUrl || n.remote_url || (Array.isArray(n.remote_addrs) ? n.remote_addrs[0] : '') || '';
  if (url) out.remoteUrl = url;
  const country = n.location?.country || n.country || '';
  const city    = n.location?.city    || n.city    || '';
  if (country) out.country = country;
  if (city)    out.city    = city;
  if (n.type || n.service_type) out.type = n.type || n.service_type;
  const prices = n.gigabyte_prices || [];
  if (prices.length > 0) {
    const p = prices[0];
    out.gigabytePrice = p.quote_value || p.base_value || null;
  }
  out.status = n.status ?? null;
  out.active = (n.status === 1 || n.status === '1');
  return out;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function run({ positional = [], flags: _f } = {}) {
  const addr = positional[0];
  if (!addr) throw new Error('node <address> required');

  // RPC primary
  try {
    const client = await getRpcClient();
    if (client) {
      const node = await rpcQueryNode(client, addr);
      if (node) return shape(node);
    }
  } catch { }

  // LCD fallback
  try {
    const lcd = await ensureLcd();
    const res = await fetch(`${lcd}/sentinel/node/v3/nodes/${addr}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.node) return shape(data.node);
    }
  } catch { }

  return { address: addr, active: false, status: null, error: 'node not found' };
}
