#!/usr/bin/env node
import 'dotenv/config';
import {
  ensureLcd, getRpcClient,
  encodeRpcVarintField, encodeRpcBytes, encodeRpcEmbedded,
  concatBytes, decodeRpcProto,
} from '../core/chain.js';

const PLAN = Number(process.argv[2] || 36);

const lcd = await ensureLcd();
for (const [label, qs] of [
  ['no-status', 'pagination.limit=500'],
  ['status=1',  'status=1&pagination.limit=500'],
  ['status=2',  'status=2&pagination.limit=500'],
]) {
  const u = `${lcd}/sentinel/node/v3/plans/${PLAN}/nodes?${qs}`;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
    const d = await r.json();
    console.log(`LCD ${label}: ${(d.nodes||[]).length} nodes, next_key=${d.pagination?.next_key ? 'YES' : 'no'}`);
  } catch (e) {
    console.log(`LCD ${label}: ERROR ${e.message}`);
  }
}

const rpc = await getRpcClient();
async function probe(planId, statusVal, pageSize) {
  const parts = [encodeRpcVarintField(1, BigInt(planId))];
  if (statusVal !== null) parts.push(encodeRpcVarintField(2, statusVal));
  parts.push(encodeRpcEmbedded(3, encodeRpcVarintField(3, pageSize)));
  const req = concatBytes(parts);
  const res = await rpc.queryClient.queryAbci('/sentinel.node.v3.QueryService/QueryNodesForPlan', req);
  const fields = decodeRpcProto(new Uint8Array(res.value));
  const count = (fields[1]||[]).length;
  let nk = null;
  if (fields[2]?.[0]) {
    const p = decodeRpcProto(fields[2][0].value);
    if (p[1]?.[0]?.value?.length > 0) nk = Buffer.from(p[1][0].value).toString('base64');
  }
  return { count, nextKey: nk };
}

for (const [label, status, size] of [
  ['status=1 lim=100', 1, 100],
  ['status=1 lim=500', 1, 500],
  ['status=1 lim=1000', 1, 1000],
  ['no-status lim=500', null, 500],
  ['status=2 lim=500', 2, 500],
  ['status=0 lim=500', 0, 500],
]) {
  try {
    const r = await probe(PLAN, status, size);
    console.log(`RPC ${label}: ${r.count} nodes, next_key=${r.nextKey ? 'YES' : 'no'}`);
  } catch (e) {
    console.log(`RPC ${label}: ERROR ${e.message}`);
  }
}
process.exit(0);
