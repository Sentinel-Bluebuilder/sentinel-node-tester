const r = JSON.parse(require('fs').readFileSync('results/results.json','utf8'));

const planNodes = r.filter(x => x.inPlan);
const planFails = planNodes.filter(x => x.actualMbps == null);
const planSuccess = planNodes.filter(x => x.actualMbps != null);

console.log(`Plan nodes total: ${planNodes.length}`);
console.log(`  Success: ${planSuccess.length}`);
console.log(`  Failed:  ${planFails.length}`);

if (planFails.length > 0) {
  console.log('\n--- Plan Node Failures ---');
  planFails.forEach((x, i) => {
    console.log(`\n#${i+1} ${x.address}`);
    console.log(`  Type: ${x.type}`);
    console.log(`  Location: ${x.city}, ${x.country}`);
    console.log(`  Error: ${x.error || 'none'}`);
    console.log(`  Timed out: ${x.timedOut || false}`);
    console.log(`  Plans: ${JSON.stringify(x.planIds)}`);
  });
}

if (planSuccess.length > 0) {
  console.log('\n--- Plan Node Successes ---');
  planSuccess.forEach((x, i) => {
    console.log(`#${i+1} ${x.address.slice(0,25)}… ${x.actualMbps} Mbps (baseline ${x.baselineAtTest}) ${x.type}`);
  });
}

// Also check non-plan for comparison
const nonPlan = r.filter(x => !x.inPlan);
const nonPlanFails = nonPlan.filter(x => x.actualMbps == null);
console.log(`\nNon-plan: ${nonPlan.length} total, ${nonPlanFails.length} failed`);
