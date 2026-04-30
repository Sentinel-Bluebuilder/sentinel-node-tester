// Run scanNodesParallel against plan 36 the EXACT same way the dashboard does
// (same mapping, same concurrency=20). Surface all error buckets.
import { withFreshRpc, rpcFetchAllNodesForPlanPaginated } from '../core/chain.js';
import { scanNodesParallel } from '../audit/pipeline.js';
import { nodeStatusV3 } from '../protocol/v3protocol.js';

const rawNodes = await withFreshRpc(
  (rpc) => rpcFetchAllNodesForPlanPaginated(rpc, 36, () => {}),
  'rpcFetchAllNodesForPlan(36)',
);

// Mimic dashboard mapping at audit/pipeline.js:1352
const planNodes = rawNodes.map(n => {
  const rawAddr = (n.remote_addrs || [])[0] || '';
  return {
    address: n.address,
    remoteUrl: rawAddr.startsWith('http') ? rawAddr : `https://${rawAddr}`,
    gigabyte_prices: n.gigabyte_prices || [],
    planIds: [36],
  };
});

console.log(`Total: ${planNodes.length}`);
console.log(`Sample remoteUrls:`);
for (const n of planNodes.slice(0, 5)) console.log(`  ${n.remoteUrl}`);

// Try a single direct probe FIRST so we can see the actual error
console.log('\nSingle direct probe of node 0:');
try {
  const t0 = Date.now();
  const status = await nodeStatusV3(planNodes[0].remoteUrl);
  console.log(`  OK (${Date.now() - t0}ms): ${status.moniker || '<no moniker>'} type=${status.type}`);
} catch (e) {
  console.log(`  FAIL: ${e.code || ''} ${e.message}`);
  console.log(`  stack: ${e.stack?.split('\n').slice(0, 4).join(' | ')}`);
}

const fakeState = {};
const t0 = Date.now();
const online = await scanNodesParallel(planNodes, 20, (type, data) => {
  if (type === 'log' && data?.msg) console.log(data.msg);
}, fakeState);
console.log(`\nElapsed: ${Date.now() - t0}ms`);
console.log(`Online: ${online.length}/${planNodes.length}`);
console.log(`Error buckets:`, fakeState.lastScanErrorBuckets || online.errorBuckets || {});
process.exit(0);
