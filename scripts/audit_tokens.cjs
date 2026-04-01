var fs = require('fs');
var d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));

console.log('=== TOTAL TOKEN SPEND AUDIT ===\n');

// Every tested node = 1 session (~400k udvpn) + gas (~200k per batch of 5)
var total = d.length;
var ok = d.filter(function(r) { return r.actualMbps > 0; });
var fails = d.filter(function(r) { return r.error; });
var retested = fails.filter(function(r) { return (r.error || '').indexOf('retest:') === 0; });
var seqFails = fails.filter(function(r) { return (r.error || '').indexOf('sequence mismatch') !== -1; });
var socksRetested = retested.filter(function(r) { return (r.error || '').indexOf('SOCKS5') !== -1; });

console.log('Total tested:', total);
console.log('Successful:', ok.length);
console.log('Failed:', fails.length);
console.log('  - Retested (burned extra tokens):', retested.length);
console.log('  - Sequence mismatch (our bug):', seqFails.length);
console.log('  - SOCKS5 retested (potentially wasted):', socksRetested.length);

// Estimate costs
// Each session: priceEntry.quote_value varies per node (~100k-500k udvpn)
// Gas per tx: 200k udvpn per node in batch
// Retest: full session + gas again

var retestCost = retested.length * 600000; // ~0.6 DVPN each
var seqCost = seqFails.length * 200000; // only gas wasted (session not created)
console.log('\nEstimated waste:');
console.log('  Retest sessions:', retested.length, 'x ~600k udvpn =', (retestCost/1000000).toFixed(2), 'DVPN');
console.log('  Sequence mismatch gas:', seqFails.length, 'x ~200k udvpn =', (seqCost/1000000).toFixed(2), 'DVPN');
console.log('  Total estimated waste:', ((retestCost + seqCost)/1000000).toFixed(2), 'DVPN');

console.log('\n=== RETESTED NODES (each burned a fresh session) ===');
retested.forEach(function(r) {
  console.log('  ' + r.address.slice(0, 40) + ' | inPlan=' + r.inPlan);
  console.log('    err: ' + (r.error || '').slice(0, 100));
});
