/**
 * nodes — List all active nodes on the Sentinel chain.
 *
 * Uses Blue JS SDK (getAllNodes) by default.
 * Pass --sdk=tkd to use the official TKD JS SDK instead.
 */

import { getAllNodes } from '../../core/chain.js';
import { tkdQueryNodes } from '../../core/tkd-bridge.js';

// ─── Metadata ────────────────────────────────────────────────────────────────

export const name = 'nodes';
export const description = 'List all active nodes on the Sentinel chain.';
export const usage = 'sentinel-audit nodes [--sdk js|tkd] [--limit N] [--pretty]';
export const flags = [
  { flag: '--sdk',   description: 'SDK to use: js (Blue) or tkd (Official)', default: 'js' },
  { flag: '--limit', description: 'Max nodes to return (default: all)',        default: 'all' },
  { flag: '--pretty', description: 'Human-readable output' },
];

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function run({ positional, flags: f } = {}) {
  const sdk   = (typeof f['--sdk'] === 'string' ? f['--sdk'] : 'js').toLowerCase();
  const limitRaw = f['--limit'];
  const limit = limitRaw && limitRaw !== 'all' ? parseInt(limitRaw, 10) : null;

  // Fetch nodes via the selected SDK
  let raw;
  if (sdk === 'tkd') {
    raw = await tkdQueryNodes();
  } else {
    raw = await getAllNodes(null);
  }

  // Normalise each node into the documented output shape — omit absent fields
  const nodes = (limit ? raw.slice(0, limit) : raw).map(n => {
    const out = {};

    if (n.address)   out.address   = n.address;
    if (n.moniker)   out.moniker   = n.moniker;

    // remoteUrl — present in both SDK paths
    const url = n.remoteUrl || n.remote_url || '';
    if (url) out.remoteUrl = url;

    // location fields — Blue JS SDK does not attach location during bulk fetch;
    // TKD bulk query also skips it. Include if present.
    const country = n.location?.country || n.country || '';
    const city    = n.location?.city    || n.city    || '';
    if (country) out.country = country;
    if (city)    out.city    = city;

    // service type (wireguard / v2ray)
    if (n.type) out.type = n.type;

    // gigabyte price in udvpn — take first entry's quote_value if available
    const prices = n.gigabyte_prices || [];
    if (prices.length > 0) {
      const p = prices[0];
      out.gigabytePrice = p.quote_value || p.base_value || null;
    }

    out.status = n.status ?? 1;
    return out;
  });

  return { count: nodes.length, nodes };
}
