const r = JSON.parse(require('fs').readFileSync('results/results.json', 'utf8'));
// Only results from current run (after 16:21 UTC)
const cutoff = new Date('2026-03-05T16:21:00Z');
const current = r.filter(x => new Date(x.timestamp) >= cutoff && x.actualMbps != null);
const uncapped = current.filter(x => x.baselineAtTest != null && x.actualMbps > x.baselineAtTest);
console.log('Current run results:', current.length);
console.log('Uncapped in current run:', uncapped.length);
if (uncapped.length > 0) {
  uncapped.forEach(x => console.log(
    '  ', x.actualMbps.toFixed(2), '/', x.baselineAtTest.toFixed(2), x.city
  ));
}

// Plan data in current run
const withPlan = current.filter(x => x.inPlan === true);
const noPlan = current.filter(x => x.inPlan == null || x.inPlan === undefined);
console.log('\nWith plan data:', withPlan.length);
console.log('Missing plan data:', noPlan.length);

// Check ALL results for plan data
const allWithPlan = r.filter(x => x.inPlan === true);
const allNoPlan = r.filter(x => x.inPlan == null || x.inPlan === undefined);
console.log('\nAll results - with plan:', allWithPlan.length, '  without plan:', allNoPlan.length);
