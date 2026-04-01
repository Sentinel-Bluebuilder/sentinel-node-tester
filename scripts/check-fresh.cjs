const r = JSON.parse(require('fs').readFileSync('results/results.json','utf8'));
const withSpeed = r.filter(x => x.actualMbps != null);
const failed = r.filter(x => x.actualMbps == null);
const planFailed = failed.filter(x => x.inPlan);

console.log(`Total: ${r.length} | With speed: ${withSpeed.length} | Failed: ${failed.length} | Plan failed: ${planFailed.length}\n`);

// Show all results
withSpeed.forEach((x, i) => {
  const pct = x.baselineAtTest > 0 ? ((x.actualMbps / x.baselineAtTest) * 100).toFixed(1) : '?';
  const gap = x.baselineAtTest > 0 ? (x.baselineAtTest - x.actualMbps).toFixed(2) : '?';
  const plan = x.inPlan ? 'PLAN' : '';
  console.log(`#${String(i+1).padStart(2)} ${x.type.slice(0,2)} actual=${String(x.actualMbps).padStart(5)} baseline=${String(x.baselineAtTest).padStart(5)} ratio=${pct.padStart(5)}% gap=${gap.padStart(5)} ${plan} ${x.adaptive || ''}`);
});

if (failed.length > 0) {
  console.log('\n--- FAILURES ---');
  failed.forEach((x, i) => {
    console.log(`  ${x.address.slice(0,25)}… ${x.type || '?'} ${x.inPlan?'PLAN':''} err=${x.error || 'null result'}`);
  });
}

// Stats
if (withSpeed.length > 0) {
  const ratios = withSpeed.filter(x => x.baselineAtTest > 0).map(x => x.actualMbps / x.baselineAtTest * 100);
  const avgRatio = ratios.reduce((s,v) => s+v, 0) / ratios.length;
  const minRatio = Math.min(...ratios);
  const maxRatio = Math.max(...ratios);
  const capped = withSpeed.filter(x => x.baselineAtTest > 0 && x.actualMbps >= x.baselineAtTest * 0.97).length;
  console.log(`\n--- STATS ---`);
  console.log(`Avg ratio: ${avgRatio.toFixed(1)}% | Min: ${minRatio.toFixed(1)}% | Max: ${maxRatio.toFixed(1)}%`);
  console.log(`Near-cap (>=97%): ${capped}/${withSpeed.length}`);
  console.log(`Baselines: ${withSpeed.map(x=>x.baselineAtTest).join(', ')}`);
}
