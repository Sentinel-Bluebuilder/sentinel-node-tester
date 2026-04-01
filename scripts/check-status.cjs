const r = JSON.parse(require('fs').readFileSync('results/results.json', 'utf8'));
const t = r.filter(x => x.actualMbps != null);
const f = r.filter(x => x.actualMbps == null && x.error);
const s = r.filter(x => x.skipped);

console.log('Total:', r.length, 'Passed:', t.length, 'Failed:', f.length, 'Skipped:', s.length);
console.log('In plan:', r.filter(x => x.inPlan).length);
console.log('Dead plan:', r.filter(x => x.inPlan && x.actualMbps == null).length);

const bl = t.map(x => x.baselineAtTest).filter(Boolean);
const act = t.map(x => x.actualMbps);
console.log('Baseline range:', Math.min(...bl).toFixed(2), '-', Math.max(...bl).toFixed(2));
console.log('Actual range:', Math.min(...act).toFixed(2), '-', Math.max(...act).toFixed(2));

const capped = t.filter(x => x.actualMbps === x.baselineAtTest).length;
console.log('Capped at baseline:', capped, '/', t.length);

// Speed distribution buckets
const buckets = {};
t.forEach(x => {
  const b = Math.floor(x.actualMbps);
  buckets[b] = (buckets[b] || 0) + 1;
});
console.log('\nSpeed distribution (Mbps floor):');
Object.entries(buckets).sort((a, b) => parseInt(a[0]) - parseInt(b[0])).forEach(([k, v]) => {
  console.log(`  ${k} Mbps: ${v} nodes`);
});

// Error breakdown
const errTypes = {};
f.forEach(x => {
  const key = (x.error || 'unknown').slice(0, 60);
  errTypes[key] = (errTypes[key] || 0) + 1;
});
console.log('\nError breakdown:');
Object.entries(errTypes).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
  console.log(`  ${v}x ${k}`);
});

// Last 10
console.log('\nLast 10 tested:');
t.slice(-10).forEach(x => {
  console.log(`  ${x.actualMbps.toFixed(2)} / ${(x.baselineAtTest || 0).toFixed(2)} Mbps  ${x.type}  ${x.city}, ${x.country}  plan=${x.inPlan}`);
});
