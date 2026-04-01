const r = JSON.parse(require('fs').readFileSync('results/results.json', 'utf8'));
const tested = r.filter(x => x.actualMbps != null && x.baselineAtTest != null);

console.log('--- Cases where actual > baseline ---');
const violations = tested.filter(x => x.actualMbps > x.baselineAtTest);
console.log(`${violations.length} out of ${tested.length} tested nodes have actual > baseline\n`);

violations.forEach(x => {
  console.log(`  ${x.type.padEnd(10)} | actual: ${x.actualMbps.toFixed(2).padStart(7)} | baseline: ${x.baselineAtTest.toFixed(2).padStart(7)} | diff: +${(x.actualMbps - x.baselineAtTest).toFixed(2)} | ${x.city}, ${x.country}`);
});

console.log('\n--- Baseline distribution ---');
const baselines = tested.map(x => x.baselineAtTest).sort((a,b) => a-b);
console.log(`  Min:    ${baselines[0]}`);
console.log(`  P25:    ${baselines[Math.floor(baselines.length*0.25)]}`);
console.log(`  Median: ${baselines[Math.floor(baselines.length*0.5)]}`);
console.log(`  P75:    ${baselines[Math.floor(baselines.length*0.75)]}`);
console.log(`  Max:    ${baselines[baselines.length-1]}`);

console.log('\n--- Actual speed distribution ---');
const actuals = tested.map(x => x.actualMbps).sort((a,b) => a-b);
console.log(`  Min:    ${actuals[0]}`);
console.log(`  P25:    ${actuals[Math.floor(actuals.length*0.25)]}`);
console.log(`  Median: ${actuals[Math.floor(actuals.length*0.5)]}`);
console.log(`  P75:    ${actuals[Math.floor(actuals.length*0.75)]}`);
console.log(`  Max:    ${actuals[actuals.length-1]}`);

console.log('\n--- Baseline readings over time (sample) ---');
tested.slice(0, 20).forEach(x => {
  const flag = x.actualMbps > x.baselineAtTest ? ' *** ACTUAL > BASELINE' : '';
  console.log(`  baseline=${x.baselineAtTest.toFixed(2).padStart(7)} actual=${x.actualMbps.toFixed(2).padStart(7)} ${x.type.padEnd(10)} ${x.city}${flag}`);
});
console.log('  ...');
tested.slice(-20).forEach(x => {
  const flag = x.actualMbps > x.baselineAtTest ? ' *** ACTUAL > BASELINE' : '';
  console.log(`  baseline=${x.baselineAtTest.toFixed(2).padStart(7)} actual=${x.actualMbps.toFixed(2).padStart(7)} ${x.type.padEnd(10)} ${x.city}${flag}`);
});
