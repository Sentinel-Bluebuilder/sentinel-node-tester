// Quick diagnostic: fetch plan-36 nodes via RPC, dump first 10 entries
// to see exactly what `remote_addrs` looks like.
import { withFreshRpc, rpcFetchAllNodesForPlanPaginated } from '../core/chain.js';

const nodes = await withFreshRpc(
  (rpc) => rpcFetchAllNodesForPlanPaginated(rpc, 36, () => {}),
  'rpcFetchAllNodesForPlan(36)',
);

console.log(`Total nodes: ${nodes.length}`);
console.log('First 5 raw entries:');
for (const n of nodes.slice(0, 5)) {
  console.log(JSON.stringify(n, null, 2));
}

// Count how many have empty/missing remote_addrs
let missing = 0;
let valid = 0;
const sampleBad = [];
for (const n of nodes) {
  const ra = n.remote_addrs;
  if (!Array.isArray(ra) || ra.length === 0 || !ra[0]) {
    missing++;
    if (sampleBad.length < 3) sampleBad.push(n);
  } else {
    valid++;
  }
}
console.log(`\nremote_addrs missing/empty: ${missing}/${nodes.length}`);
console.log(`remote_addrs valid: ${valid}`);
if (sampleBad.length) {
  console.log('\nSample nodes with missing remote_addrs:');
  for (const n of sampleBad) console.log(JSON.stringify(n));
}

// Also check what URL the dashboard's mapping produces for first 5
console.log('\nDashboard mapping (pipeline.js:1352) for first 5:');
for (const n of nodes.slice(0, 5)) {
  const rawAddr = (n.remote_addrs || [])[0] || '';
  const remoteUrl = rawAddr.startsWith('http') ? rawAddr : `https://${rawAddr}`;
  console.log(`  ${n.address} → "${remoteUrl}"`);
}

process.exit(0);
