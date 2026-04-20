#!/usr/bin/env node
/**
 * Direct test of rpcFetchAllNodesForPlanPaginated for plan 36.
 * Logs every page + final count. Read-only.
 */
import 'dotenv/config';
import { getRpcClient, rpcFetchAllNodesForPlanPaginated, ensureLcd } from '../core/chain.js';

const PLAN_ID = Number(process.argv[2] || 36);

const broadcast = (ch, data) => {
  if (ch === 'log') console.log(data.msg);
};

console.log(`\n── Testing plan ${PLAN_ID} pagination ──────────────────────────\n`);

const t0 = Date.now();
const rpc = await getRpcClient();
if (!rpc) {
  console.error('RPC client unavailable — aborting');
  process.exit(1);
}
console.log(`RPC client OK (${Date.now() - t0}ms)\n`);

const t1 = Date.now();
const rpcNodes = await rpcFetchAllNodesForPlanPaginated(rpc, PLAN_ID, broadcast);
const rpcElapsed = ((Date.now() - t1) / 1000).toFixed(1);
console.log(`\nRPC total: ${rpcNodes.length} nodes in ${rpcElapsed}s\n`);

// Cross-check via LCD with matching high limit (chain truncates at `limit`, no next_key).
console.log(`── Cross-check via LCD (limit=10000) ──────────────────────────\n`);
const lcd = await ensureLcd();
const t2 = Date.now();
const lcdUrl = `${lcd}/sentinel/node/v3/plans/${PLAN_ID}/nodes?status=1&pagination.limit=10000`;
const lcdR = await fetch(lcdUrl, { signal: AbortSignal.timeout(30000) });
const lcdD = await lcdR.json();
const lcdAll = lcdD.nodes || [];
const lcdElapsed = ((Date.now() - t2) / 1000).toFixed(1);
console.log(`  LCD: ${lcdAll.length} nodes, next_key ${lcdD.pagination?.next_key ? 'yes' : 'no'}`);
console.log(`\nLCD total: ${lcdAll.length} nodes (${lcdElapsed}s)\n`);

console.log(`── Verdict ───────────────────────────────────────────────────\n`);
if (rpcNodes.length === lcdAll.length) {
  console.log(`  ✓ MATCH: RPC and LCD agree at ${rpcNodes.length} nodes`);
} else {
  console.log(`  ✗ MISMATCH: RPC=${rpcNodes.length}  LCD=${lcdAll.length}`);
  // Show which addresses are missing
  const rpcAddrs = new Set(rpcNodes.map(n => n.address));
  const lcdAddrs = new Set(lcdAll.map(n => n.address));
  const missingFromRpc = [...lcdAddrs].filter(a => !rpcAddrs.has(a));
  const missingFromLcd = [...rpcAddrs].filter(a => !lcdAddrs.has(a));
  console.log(`  Missing from RPC: ${missingFromRpc.length}`);
  console.log(`  Missing from LCD: ${missingFromLcd.length}`);
  if (missingFromRpc.length > 0 && missingFromRpc.length < 10) {
    console.log(`  Addrs missing from RPC: ${missingFromRpc.join(', ')}`);
  }
}
console.log('');
process.exit(0);
