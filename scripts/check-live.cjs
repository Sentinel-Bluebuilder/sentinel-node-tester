const r = JSON.parse(require('fs').readFileSync('results/results.json', 'utf8'));
const t = r.filter(x => x.actualMbps != null);
console.log('Total results:', r.length, 'Passed:', t.length);

if (t.length > 0) {
  console.log('\nAll tested results:');
  t.forEach((x, i) => {
    const ratio = x.baselineAtTest > 0 ? (x.actualMbps / x.baselineAtTest * 100).toFixed(0) : '?';
    const flag = x.actualMbps > x.baselineAtTest ? ' *** OVER BASELINE' : '';
    console.log(`  #${i+1} actual=${x.actualMbps.toFixed(2)} baseline=${(x.baselineAtTest||0).toFixed(2)} ratio=${ratio}% ${x.type} ${x.city}${flag}`);
  });

  // Stats
  const ratios = t.filter(x => x.baselineAtTest > 0).map(x => x.actualMbps / x.baselineAtTest);
  const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const within90 = ratios.filter(r => r > 0.9).length;
  console.log('\nAvg ratio (actual/baseline):', (avgRatio * 100).toFixed(1) + '%');
  console.log('Within 90% of baseline:', within90, '/', ratios.length);
  console.log('Over baseline:', ratios.filter(r => r > 1).length);

  // Check baseline values
  const baselines = t.map(x => x.baselineAtTest).filter(Boolean);
  const uniqueBl = [...new Set(baselines.map(x => x.toFixed(2)))];
  console.log('\nUnique baseline values:', uniqueBl.length);
  uniqueBl.forEach(b => {
    const count = baselines.filter(x => x.toFixed(2) === b).length;
    console.log(`  ${b} Mbps: ${count}x`);
  });
}
