#!/usr/bin/env node

/**
 * Audit Sentinel RPC endpoints against the tester's configured list.
 *
 * For each candidate this script verifies:
 *   1. Tendermint connect succeeds within 8s
 *   2. /status reports `catching_up: false`
 *   3. ABCI bank balance query for a known funded address returns the
 *      expected amount (this is stronger than /status alone — a node can
 *      report in-sync while serving stale ABCI state, which is exactly the
 *      failure mode that bricked rpc.sentinel.co for several weeks)
 *
 * Output is sorted by latency, ready to paste into core/constants.js.
 *
 * Usage:
 *   node scripts/audit-rpc-endpoints.mjs
 *   node scripts/audit-rpc-endpoints.mjs <funded-address> <expected-udvpn>
 */

import { Tendermint37Client } from '@cosmjs/tendermint-rpc';
import { QueryClient, setupBankExtension } from '@cosmjs/stargate';
import { RPC_ENDPOINTS } from '../core/constants.js';

const FUNDED_ADDR = process.argv[2];
const EXPECTED_UDVPN = process.argv[3] || '10000000000';
if (!FUNDED_ADDR) {
  console.error('Usage: node scripts/audit-rpc-endpoints.mjs <sent1-funded-address> [expected-udvpn]');
  process.exit(1);
}

async function audit(url) {
  const t0 = Date.now();
  let tm = null;
  try {
    tm = await Promise.race([
      Tendermint37Client.connect(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout 8s')), 8000)),
    ]);
    const status = await Promise.race([
      tm.status(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('status timeout 8s')), 8000)),
    ]);
    const height = Number(status.syncInfo.latestBlockHeight);
    const catchingUp = !!status.syncInfo.catchingUp;
    const q = QueryClient.withExtensions(tm, setupBankExtension);
    const bal = await Promise.race([
      q.bank.balance(FUNDED_ADDR, 'udvpn'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('balance timeout 10s')), 10000)),
    ]);
    const ms = Date.now() - t0;
    const balanceOk = bal.amount === EXPECTED_UDVPN;
    return { url, ok: !catchingUp && balanceOk, height, catchingUp, balance: bal.amount, balanceOk, ms };
  } catch (e) {
    const ms = Date.now() - t0;
    return { url, ok: false, error: e.message, ms };
  } finally {
    try { tm && tm.disconnect(); } catch (e) { /* ignore */ }
  }
}

console.log(`Auditing ${RPC_ENDPOINTS.length} RPC endpoints against ${FUNDED_ADDR} (expected ${EXPECTED_UDVPN} udvpn)\n`);

const results = [];
for (const url of RPC_ENDPOINTS) {
  process.stdout.write(`  ${url.padEnd(50)} `);
  const r = await audit(url);
  results.push(r);
  if (r.ok) console.log(`OK   h=${r.height} bal=${r.balance} ${r.ms}ms`);
  else if (r.error) console.log(`FAIL ${r.error} (${r.ms}ms)`);
  else console.log(`STALE catching=${r.catchingUp} balOk=${r.balanceOk} h=${r.height} bal=${r.balance}`);
}

const tier1 = results.filter(r => r.ok).sort((a, b) => a.ms - b.ms);
const tier2 = results.filter(r => !r.ok);

console.log('\n=== TIER 1 — sorted by latency ===');
for (const r of tier1) console.log(`  ${String(r.ms).padStart(5)}ms  ${r.url}`);

console.log('\n=== TIER 2 — failed/stale ===');
for (const r of tier2) {
  const reason = r.error || (r.catchingUp ? 'catching_up=true' : !r.balanceOk ? `wrong balance ${r.balance}` : 'unknown');
  console.log(`  ${r.url.padEnd(50)} ${reason}`);
}

console.log(`\n${tier1.length}/${results.length} healthy`);
process.exit(tier1.length === 0 ? 1 : 0);
