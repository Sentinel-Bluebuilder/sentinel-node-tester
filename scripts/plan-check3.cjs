// Get all nodes in each plan and cross-reference with test results
const LCD = 'https://sentinel-api.polkachu.com';

async function getNodesInPlan(planId) {
  const nodes = [];
  let nextKey = null;
  do {
    let url = `${LCD}/sentinel/node/v3/nodes?plan_id=${planId}&status=1&pagination.limit=100`;
    if (nextKey) url += `&pagination.key=${encodeURIComponent(nextKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    for (const n of (data.nodes || [])) {
      nodes.push(n.address);
    }
    nextKey = data.pagination?.next_key || null;
  } while (nextKey);
  return nodes;
}

async function run() {
  // Get providers
  const provRes = await fetch(`${LCD}/sentinel/provider/v2/providers?pagination.limit=100`);
  const provData = await provRes.json();
  console.log('=== Providers ===');
  for (const p of (provData.providers || [])) {
    console.log(`  ${p.address} | ${p.name} | ${p.status}`);
  }

  // Get nodes in known plans
  const planIds = [29, 34, 36];
  const planNodes = {};
  const allPlanNodes = new Set();

  for (const pid of planIds) {
    console.log(`\n=== Plan ${pid} nodes ===`);
    const nodes = await getNodesInPlan(pid);
    planNodes[pid] = nodes;
    nodes.forEach(n => allPlanNodes.add(n));
    console.log(`  ${nodes.length} nodes in plan ${pid}`);
    if (nodes.length <= 10) {
      nodes.forEach(n => console.log(`    ${n}`));
    } else {
      nodes.slice(0, 5).forEach(n => console.log(`    ${n}`));
      console.log(`    ... and ${nodes.length - 5} more`);
    }
  }

  console.log(`\nTotal unique nodes in ANY plan: ${allPlanNodes.size}`);

  // Cross-reference with our test results
  const fs = require('fs');
  if (fs.existsSync('results/results.json')) {
    const results = JSON.parse(fs.readFileSync('results/results.json', 'utf8'));
    console.log(`\n=== Cross-reference with test results (${results.length} total) ===`);

    const testedInPlan = results.filter(r => allPlanNodes.has(r.address));
    const failedInPlan = testedInPlan.filter(r => r.actualMbps == null);
    const passedInPlan = testedInPlan.filter(r => r.actualMbps != null);

    console.log(`Nodes in a plan that we tested: ${testedInPlan.length}`);
    console.log(`  Passed: ${passedInPlan.length}`);
    console.log(`  Failed: ${failedInPlan.length}`);

    if (failedInPlan.length > 0) {
      console.log('\n  FAILED plan nodes (THESE NEED INVESTIGATION):');
      failedInPlan.forEach(r => {
        const plans = planIds.filter(pid => planNodes[pid].includes(r.address));
        console.log(`    ${r.address.slice(0, 25)} | ${r.type} | ${r.city}, ${r.country} | plan=${plans.join(',')} | ${r.error}`);
      });
    }

    // Nodes in plan but NOT tested (not in our results)
    const testedAddrs = new Set(results.map(r => r.address));
    const untested = [...allPlanNodes].filter(a => !testedAddrs.has(a));
    console.log(`\nPlan nodes NOT yet tested: ${untested.length}`);
  }
}

run().catch(console.error);
