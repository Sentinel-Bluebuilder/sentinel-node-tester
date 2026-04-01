const r = JSON.parse(require('fs').readFileSync('results/results.json', 'utf8'));
const cutoff = new Date('2026-03-05T16:21:00Z');
const oldRun = r.filter(x => new Date(x.timestamp) < cutoff);
const newRun = r.filter(x => new Date(x.timestamp) >= cutoff);

console.log('OLD run results:', oldRun.length);
console.log('  Passed:', oldRun.filter(x => x.actualMbps != null).length);
console.log('  Failed:', oldRun.filter(x => x.actualMbps == null).length);
console.log('  With plan data:', oldRun.filter(x => x.inPlan === true).length);

console.log('\nNEW run results:', newRun.length);
console.log('  Passed:', newRun.filter(x => x.actualMbps != null).length);
console.log('  Failed:', newRun.filter(x => x.actualMbps == null).length);
console.log('  With plan data:', newRun.filter(x => x.inPlan === true).length);

if (newRun.length > 0) {
  console.log('\n  Latest new results:');
  newRun.slice(-5).forEach(x => {
    console.log(`    ${x.actualMbps != null ? x.actualMbps.toFixed(2) : 'FAIL'} Mbps | bl=${(x.baselineAtTest||0).toFixed(2)} | ${x.type} | ${x.city} | plan=${x.inPlan} | ${x.timestamp}`);
  });
}
