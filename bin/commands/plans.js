/**
 * plans — List all on-chain subscription plans.
 *
 * Uses discoverPlans() which queries the chain via LCD.
 * Optionally filter to plans that have at least one node with --with-nodes.
 */

import { discoverPlans } from '../../core/chain.js';

// ─── Metadata ────────────────────────────────────────────────────────────────

export const name = 'plans';
export const description = 'List all active on-chain subscription plans.';
export const usage = 'sentinel-audit plans [--with-nodes] [--pretty]';
export const flags = [
  { flag: '--with-nodes', description: 'Only show plans that have at least one node' },
  { flag: '--pretty',     description: 'Human-readable output' },
];

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function run({ positional: _p, flags: f } = {}) {
  // discoverPlans(broadcast) — pass null for no broadcast callbacks
  let plans = await discoverPlans(null);

  // Filter to plans with nodes if --with-nodes flag is set
  if (f['--with-nodes']) {
    plans = plans.filter(p => (p.nodeCount ?? 0) > 0);
  }

  return {
    count: plans.length,
    plans,
  };
}
