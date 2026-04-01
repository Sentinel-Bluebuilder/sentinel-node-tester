const r = JSON.parse(require('fs').readFileSync('results/results.json', 'utf8'));
const tested = r.filter(x => x.actualMbps != null && x.baselineAtTest != null);

console.log('=== SPEED DATA PATTERN ANALYSIS ===\n');

// Baseline clustering
const baselines = tested.map(x => x.baselineAtTest);
const baselineUnique = [...new Set(baselines.map(x => x.toFixed(2)))];
console.log(`Baseline readings: ${baselines.length} total, ${baselineUnique.length} unique values`);

// Count how often each baseline appears
const blCounts = {};
baselines.forEach(b => {
  const k = b.toFixed(2);
  blCounts[k] = (blCounts[k] || 0) + 1;
});
console.log('\nBaseline value frequency (top 20):');
Object.entries(blCounts).sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, v]) => {
  const bar = '█'.repeat(Math.min(v, 50));
  console.log(`  ${k.padStart(8)} Mbps: ${String(v).padStart(3)}x ${bar}`);
});

// Actual speed clustering
const actuals = tested.map(x => x.actualMbps);
const actualUnique = [...new Set(actuals.map(x => x.toFixed(2)))];
console.log(`\nActual speeds: ${actuals.length} total, ${actualUnique.length} unique values`);

const actCounts = {};
actuals.forEach(a => {
  const k = a.toFixed(2);
  actCounts[k] = (actCounts[k] || 0) + 1;
});
console.log('\nActual speed frequency (top 20):');
Object.entries(actCounts).sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, v]) => {
  const bar = '█'.repeat(Math.min(v, 50));
  console.log(`  ${k.padStart(8)} Mbps: ${String(v).padStart(3)}x ${bar}`);
});

// Check for suspiciously close baseline-to-actual ratios
console.log('\n=== RATIO ANALYSIS (actual / baseline) ===');
const ratios = tested.map(x => x.actualMbps / x.baselineAtTest);
const ratioBuckets = {};
ratios.forEach(r => {
  const bucket = (Math.round(r * 10) / 10).toFixed(1);
  ratioBuckets[bucket] = (ratioBuckets[bucket] || 0) + 1;
});
console.log('Ratio distribution:');
Object.entries(ratioBuckets).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).forEach(([k, v]) => {
  const bar = '█'.repeat(Math.min(v, 50));
  console.log(`  ${k.padStart(5)}x: ${String(v).padStart(3)}x ${bar}`);
});

// Check if baselines are suspiciously consistent
console.log('\n=== BASELINE OVER TIME ===');
console.log('First 30 tests:');
tested.slice(0, 30).forEach((x, i) => {
  const ratio = (x.actualMbps / x.baselineAtTest * 100).toFixed(0);
  console.log(`  #${String(i+1).padStart(3)} bl=${x.baselineAtTest.toFixed(2).padStart(7)} act=${x.actualMbps.toFixed(2).padStart(7)} ratio=${ratio.padStart(3)}% ${x.type.padEnd(10)} ${x.city}`);
});
console.log('\nLast 30 tests:');
tested.slice(-30).forEach((x, i) => {
  const ratio = (x.actualMbps / x.baselineAtTest * 100).toFixed(0);
  const idx = tested.length - 30 + i + 1;
  console.log(`  #${String(idx).padStart(3)} bl=${x.baselineAtTest.toFixed(2).padStart(7)} act=${x.actualMbps.toFixed(2).padStart(7)} ratio=${ratio.padStart(3)}% ${x.type.padEnd(10)} ${x.city}`);
});

// Check if baseline is capped at some value
console.log('\n=== BASELINE RANGE CHECK ===');
console.log(`Min baseline: ${Math.min(...baselines).toFixed(2)}`);
console.log(`Max baseline: ${Math.max(...baselines).toFixed(2)}`);
console.log(`Std dev:      ${(Math.sqrt(baselines.reduce((s, b) => s + (b - baselines.reduce((a, c) => a + c, 0) / baselines.length) ** 2, 0) / baselines.length)).toFixed(2)}`);
console.log(`Min actual:   ${Math.min(...actuals).toFixed(2)}`);
console.log(`Max actual:   ${Math.max(...actuals).toFixed(2)}`);

// How many actuals are within 5% of baseline?
const within5pct = tested.filter(x => Math.abs(x.actualMbps - x.baselineAtTest) / x.baselineAtTest < 0.05).length;
const within10pct = tested.filter(x => Math.abs(x.actualMbps - x.baselineAtTest) / x.baselineAtTest < 0.10).length;
console.log(`\nActuals within 5% of baseline:  ${within5pct}/${tested.length} (${(within5pct/tested.length*100).toFixed(1)}%)`);
console.log(`Actuals within 10% of baseline: ${within10pct}/${tested.length} (${(within10pct/tested.length*100).toFixed(1)}%)`);

// Check the adaptive field pattern
console.log('\n=== SPEEDTEST MODE USED ===');
// These aren't in results — let me check what data we have
console.log('Sample result keys:', Object.keys(tested[0]).join(', '));
