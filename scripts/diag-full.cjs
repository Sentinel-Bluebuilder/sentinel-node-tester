const fs = require('fs');
const r = JSON.parse(fs.readFileSync(__dirname + '/results/results.json', 'utf8'));

console.log('═══════════════════════════════════════════════════════════');
console.log('  SENTINEL NODE TESTER — FULL DIAGNOSTIC REPORT');
console.log('  Generated:', new Date().toISOString());
console.log('═══════════════════════════════════════════════════════════\n');

// ── OVERVIEW ──
console.log('── OVERVIEW ──────────────────────────────────────────────');
console.log(`Total results: ${r.length}`);
const types = {};
r.forEach(n => { types[n.type] = (types[n.type] || 0) + 1; });
Object.entries(types).forEach(([t, c]) => console.log(`  ${t}: ${c}`));

const withSpeed = r.filter(n => n.actualMbps != null && n.actualMbps > 0);
const zeroSpeed = r.filter(n => n.actualMbps === 0);
const nullSpeed = r.filter(n => n.actualMbps == null);
const withError = r.filter(n => n.error);
console.log(`\nWorking (speed > 0): ${withSpeed.length} (${(withSpeed.length/r.length*100).toFixed(1)}%)`);
console.log(`Zero speed: ${zeroSpeed.length}`);
console.log(`Null speed (failed): ${nullSpeed.length}`);
console.log(`With error field: ${withError.length}`);

// ── PASS RATES ──
console.log('\n── PASS RATES ────────────────────────────────────────────');
const p15 = r.filter(n => n.pass15mbps).length;
const p10 = r.filter(n => n.pass10mbps).length;
const pBase = r.filter(n => n.passBaseline).length;
console.log(`Pass 15 Mbps:    ${p15}/${r.length} (${(p15/r.length*100).toFixed(1)}%)`);
console.log(`Pass 10 Mbps:    ${p10}/${r.length} (${(p10/r.length*100).toFixed(1)}%)`);
console.log(`Pass Baseline:   ${pBase}/${r.length} (${(pBase/r.length*100).toFixed(1)}%)`);

// By type
['WireGuard', 'V2Ray'].forEach(t => {
  const sub = r.filter(n => n.type === t);
  const sp15 = sub.filter(n => n.pass15mbps).length;
  const sp10 = sub.filter(n => n.pass10mbps).length;
  const spB = sub.filter(n => n.passBaseline).length;
  const working = sub.filter(n => n.actualMbps > 0).length;
  console.log(`\n  ${t} (${sub.length} nodes):`);
  console.log(`    Working:       ${working} (${(working/sub.length*100).toFixed(1)}%)`);
  console.log(`    Pass 15 Mbps:  ${sp15} (${(sp15/sub.length*100).toFixed(1)}%)`);
  console.log(`    Pass 10 Mbps:  ${sp10} (${(sp10/sub.length*100).toFixed(1)}%)`);
  console.log(`    Pass Baseline: ${spB} (${(spB/sub.length*100).toFixed(1)}%)`);
});

// ── SPEED DISTRIBUTION ──
console.log('\n── SPEED DISTRIBUTION ────────────────────────────────────');
const speeds = withSpeed.map(n => n.actualMbps).sort((a, b) => a - b);
if (speeds.length > 0) {
  const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const median = speeds[Math.floor(speeds.length / 2)];
  const p90 = speeds[Math.floor(speeds.length * 0.9)];
  const p95 = speeds[Math.floor(speeds.length * 0.95)];
  console.log(`Min:    ${speeds[0].toFixed(2)} Mbps`);
  console.log(`Median: ${median.toFixed(2)} Mbps`);
  console.log(`Mean:   ${avg.toFixed(2)} Mbps`);
  console.log(`P90:    ${p90.toFixed(2)} Mbps`);
  console.log(`P95:    ${p95.toFixed(2)} Mbps`);
  console.log(`Max:    ${speeds[speeds.length - 1].toFixed(2)} Mbps`);

  const buckets = [
    [0, 1, '< 1 Mbps'],
    [1, 5, '1-5 Mbps'],
    [5, 10, '5-10 Mbps'],
    [10, 15, '10-15 Mbps'],
    [15, 25, '15-25 Mbps'],
    [25, 50, '25-50 Mbps'],
    [50, 100, '50-100 Mbps'],
    [100, 999999, '100+ Mbps'],
  ];
  console.log('\nHistogram:');
  buckets.forEach(([lo, hi, label]) => {
    const count = speeds.filter(s => s >= lo && s < hi).length;
    const bar = '█'.repeat(Math.round(count / 3));
    console.log(`  ${label.padEnd(12)} ${String(count).padStart(4)} ${bar}`);
  });

  // By type
  ['WireGuard', 'V2Ray'].forEach(t => {
    const ts = withSpeed.filter(n => n.type === t).map(n => n.actualMbps).sort((a, b) => a - b);
    if (ts.length === 0) return;
    const tavg = ts.reduce((a, b) => a + b, 0) / ts.length;
    const tmed = ts[Math.floor(ts.length / 2)];
    console.log(`\n  ${t}: min=${ts[0].toFixed(2)}, median=${tmed.toFixed(2)}, mean=${tavg.toFixed(2)}, max=${ts[ts.length-1].toFixed(2)} Mbps`);
  });
}

// ── ISP BOTTLENECK ANALYSIS ──
console.log('\n── ISP BOTTLENECK ANALYSIS ───────────────────────────────');
const bottlenecked = r.filter(n => n.ispBottleneck);
const viable = r.filter(n => n.baselineViable);
const sla = r.filter(n => n.slaApplicable);
console.log(`ISP bottleneck flagged: ${bottlenecked.length}/${r.length} (${(bottlenecked.length/r.length*100).toFixed(1)}%)`);
console.log(`Baseline viable (>=30): ${viable.length}/${r.length}`);
console.log(`SLA applicable:         ${sla.length}/${r.length}`);

const baselines = r.filter(n => n.baselineAtTest != null).map(n => n.baselineAtTest);
if (baselines.length > 0) {
  baselines.sort((a, b) => a - b);
  console.log(`\nBaseline speeds during tests:`);
  console.log(`  Min: ${baselines[0].toFixed(2)} Mbps`);
  console.log(`  Median: ${baselines[Math.floor(baselines.length/2)].toFixed(2)} Mbps`);
  console.log(`  Max: ${baselines[baselines.length-1].toFixed(2)} Mbps`);
}

// ── GEOGRAPHIC DISTRIBUTION ──
console.log('\n── GEOGRAPHIC DISTRIBUTION ───────────────────────────────');
const countries = {};
r.forEach(n => {
  const c = n.country || 'Unknown';
  if (!countries[c]) countries[c] = { total: 0, working: 0, speeds: [], pass10: 0 };
  countries[c].total++;
  if (n.actualMbps > 0) { countries[c].working++; countries[c].speeds.push(n.actualMbps); }
  if (n.pass10mbps) countries[c].pass10++;
});
const sorted = Object.entries(countries).sort((a, b) => b[1].total - a[1].total);
console.log(`${sorted.length} countries\n`);
console.log('Country'.padEnd(25) + 'Nodes'.padStart(6) + 'Work'.padStart(6) + 'Avg Mbps'.padStart(10) + 'Pass10'.padStart(8));
console.log('-'.repeat(55));
sorted.forEach(([c, d]) => {
  const avg = d.speeds.length > 0 ? (d.speeds.reduce((a,b)=>a+b,0)/d.speeds.length).toFixed(2) : '-';
  console.log(c.slice(0,24).padEnd(25) + String(d.total).padStart(6) + String(d.working).padStart(6) + String(avg).padStart(10) + String(d.pass10).padStart(8));
});

// ── PLAN ANALYSIS ──
console.log('\n── PLAN ANALYSIS ─────────────────────────────────────────');
const inPlan = r.filter(n => n.inPlan);
const notInPlan = r.filter(n => !n.inPlan);
console.log(`In plan: ${inPlan.length} | Not in plan: ${notInPlan.length}`);

const planIds = {};
r.forEach(n => {
  (n.planIds || []).forEach(pid => {
    if (!planIds[pid]) planIds[pid] = { total: 0, working: 0, speeds: [] };
    planIds[pid].total++;
    if (n.actualMbps > 0) { planIds[pid].working++; planIds[pid].speeds.push(n.actualMbps); }
  });
});
if (Object.keys(planIds).length > 0) {
  console.log('\nPlan ID'.padEnd(10) + 'Nodes'.padStart(6) + 'Work'.padStart(6) + 'Avg Mbps'.padStart(10));
  console.log('-'.repeat(32));
  Object.entries(planIds).sort((a,b) => b[1].total - a[1].total).forEach(([pid, d]) => {
    const avg = d.speeds.length > 0 ? (d.speeds.reduce((a,b)=>a+b,0)/d.speeds.length).toFixed(2) : '-';
    console.log(String(pid).padEnd(10) + String(d.total).padStart(6) + String(d.working).padStart(6) + String(avg).padStart(10));
  });
}

// In-plan vs not-in-plan speed comparison
const inPlanSpeeds = inPlan.filter(n => n.actualMbps > 0).map(n => n.actualMbps);
const notInPlanSpeeds = notInPlan.filter(n => n.actualMbps > 0).map(n => n.actualMbps);
if (inPlanSpeeds.length > 0 && notInPlanSpeeds.length > 0) {
  const ipAvg = inPlanSpeeds.reduce((a,b)=>a+b,0)/inPlanSpeeds.length;
  const nipAvg = notInPlanSpeeds.reduce((a,b)=>a+b,0)/notInPlanSpeeds.length;
  console.log(`\nIn-plan avg:     ${ipAvg.toFixed(2)} Mbps (${inPlanSpeeds.length} nodes)`);
  console.log(`Not-in-plan avg: ${nipAvg.toFixed(2)} Mbps (${notInPlanSpeeds.length} nodes)`);
}

// ── PRICING ANALYSIS ──
console.log('\n── PRICING ANALYSIS ──────────────────────────────────────');
const priced = r.filter(n => n.gigabytePrices && n.gigabytePrices.length > 0);
const udvpnPrices = [];
priced.forEach(n => {
  const p = n.gigabytePrices.find(g => g.denom === 'udvpn');
  if (p) {
    const val = parseFloat(p.base_value);
    if (val > 0) udvpnPrices.push({ addr: n.address, price: val, mbps: n.actualMbps });
  }
});
if (udvpnPrices.length > 0) {
  const prices = udvpnPrices.map(p => p.price).sort((a,b) => a-b);
  const dvpnPrices = prices.map(p => p * 1e6); // base_value is in DVPN scaled form
  console.log(`Nodes with udvpn pricing: ${udvpnPrices.length}`);
  console.log(`Price range: ${prices[0]} - ${prices[prices.length-1]} (base_value)`);

  // Convert to DVPN per GB
  const dvpnPerGb = udvpnPrices.map(p => {
    // base_value is sdk.Dec (multiply by 10^6 to get udvpn, then /10^6 for DVPN)
    // Actually base_value like "0.001500000000000000" means 0.0015 udvpn/byte?
    // No — it's the raw price. Let me just show the raw values.
    return p.price;
  }).sort((a,b) => a-b);
  console.log(`Min price:    ${dvpnPerGb[0]}`);
  console.log(`Median price: ${dvpnPerGb[Math.floor(dvpnPerGb.length/2)]}`);
  console.log(`Max price:    ${dvpnPerGb[dvpnPerGb.length-1]}`);
}

// ── PEER UTILIZATION ──
console.log('\n── PEER UTILIZATION ──────────────────────────────────────');
const withPeers = r.filter(n => n.peers != null && n.maxPeers != null);
if (withPeers.length > 0) {
  const peerRatios = withPeers.map(n => ({ addr: n.address, peers: n.peers, max: n.maxPeers, ratio: n.peers / n.maxPeers, mbps: n.actualMbps }));
  const avgRatio = peerRatios.reduce((a, p) => a + p.ratio, 0) / peerRatios.length;
  const full = peerRatios.filter(p => p.ratio >= 0.9).length;
  const empty = peerRatios.filter(p => p.peers === 0).length;
  console.log(`Nodes with peer data: ${withPeers.length}`);
  console.log(`Avg utilization: ${(avgRatio * 100).toFixed(1)}%`);
  console.log(`>90% full: ${full}`);
  console.log(`Empty (0 peers): ${empty}`);

  // Correlation: peers vs speed
  const highPeer = peerRatios.filter(p => p.ratio > 0.5 && p.mbps > 0);
  const lowPeer = peerRatios.filter(p => p.ratio <= 0.5 && p.mbps > 0);
  if (highPeer.length > 0 && lowPeer.length > 0) {
    const hpAvg = highPeer.reduce((a, p) => a + p.mbps, 0) / highPeer.length;
    const lpAvg = lowPeer.reduce((a, p) => a + p.mbps, 0) / lowPeer.length;
    console.log(`\nSpeed vs peers:`);
    console.log(`  >50% utilized: ${hpAvg.toFixed(2)} Mbps avg (${highPeer.length} nodes)`);
    console.log(`  <=50% utilized: ${lpAvg.toFixed(2)} Mbps avg (${lowPeer.length} nodes)`);
  }
}

// ── REPORTED vs ACTUAL SPEED ──
console.log('\n── REPORTED vs ACTUAL SPEED ──────────────────────────────');
const withBoth = r.filter(n => n.reportedDownloadMbps > 0 && n.actualMbps > 0);
if (withBoth.length > 0) {
  const ratios = withBoth.map(n => n.actualMbps / n.reportedDownloadMbps);
  const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const medianRatio = ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)];
  console.log(`Nodes with both reported & actual: ${withBoth.length}`);
  console.log(`Avg actual/reported ratio: ${(avgRatio * 100).toFixed(1)}%`);
  console.log(`Median actual/reported ratio: ${(medianRatio * 100).toFixed(1)}%`);

  const overReported = withBoth.filter(n => n.actualMbps < n.reportedDownloadMbps * 0.1).length;
  const closeMatch = withBoth.filter(n => n.actualMbps >= n.reportedDownloadMbps * 0.5).length;
  console.log(`Massively over-reported (actual < 10% of reported): ${overReported} (${(overReported/withBoth.length*100).toFixed(1)}%)`);
  console.log(`Reasonably accurate (actual >= 50% of reported): ${closeMatch} (${(closeMatch/withBoth.length*100).toFixed(1)}%)`);
}

// ── FAILURES DETAIL ──
console.log('\n── FAILURES DETAIL ───────────────────────────────────────');
const failures = r.filter(n => n.error || n.actualMbps == null);
console.log(`Total failed: ${failures.length}\n`);
const errGroups = {};
failures.forEach(n => {
  const err = (n.error || 'null-speed-no-error').replace(/expected \d+, got \d+/, 'expected N, got M');
  errGroups[err] = errGroups[err] || [];
  errGroups[err].push(n.address);
});
Object.entries(errGroups).sort((a, b) => b[1].length - a[1].length).forEach(([err, addrs]) => {
  console.log(`${addrs.length}x ${err}`);
  addrs.forEach(a => console.log(`     ${a}`));
});

// ── TOP 20 FASTEST NODES ──
console.log('\n── TOP 20 FASTEST NODES ──────────────────────────────────');
const fastest = [...withSpeed].sort((a, b) => b.actualMbps - a.actualMbps).slice(0, 20);
fastest.forEach((n, i) => {
  console.log(`${String(i+1).padStart(2)}. ${n.actualMbps.toFixed(2).padStart(8)} Mbps  ${n.type.padEnd(10)} ${(n.country || '').padEnd(20)} ${n.moniker || ''}`);
});

// ── TOP 20 SLOWEST WORKING NODES ──
console.log('\n── TOP 20 SLOWEST WORKING NODES ──────────────────────────');
const slowest = [...withSpeed].sort((a, b) => a.actualMbps - b.actualMbps).slice(0, 20);
slowest.forEach((n, i) => {
  console.log(`${String(i+1).padStart(2)}. ${n.actualMbps.toFixed(2).padStart(8)} Mbps  ${n.type.padEnd(10)} ${(n.country || '').padEnd(20)} ${n.moniker || ''}`);
});

// ── TIMESTAMP ANALYSIS ──
console.log('\n── TEST TIMELINE ─────────────────────────────────────────');
const timestamps = r.map(n => new Date(n.timestamp)).sort((a, b) => a - b);
console.log(`First test: ${timestamps[0].toISOString()}`);
console.log(`Last test:  ${timestamps[timestamps.length - 1].toISOString()}`);
const durationMs = timestamps[timestamps.length - 1] - timestamps[0];
const durationHrs = durationMs / 3600000;
console.log(`Duration:   ${durationHrs.toFixed(1)} hours`);
console.log(`Rate:       ${(r.length / durationHrs).toFixed(1)} nodes/hour`);

// Tests per day
const byDay = {};
r.forEach(n => {
  const day = n.timestamp.slice(0, 10);
  byDay[day] = (byDay[day] || 0) + 1;
});
console.log('\nTests per day:');
Object.entries(byDay).sort().forEach(([d, c]) => console.log(`  ${d}: ${c}`));

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  END OF DIAGNOSTIC REPORT');
console.log('═══════════════════════════════════════════════════════════');
