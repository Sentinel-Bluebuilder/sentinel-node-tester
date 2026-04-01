const fs = require('fs');
const r = JSON.parse(fs.readFileSync(__dirname + '/results/results.json', 'utf8'));

console.log('Total results:', r.length);

// Check what fields exist
const sample = r[0];
console.log('\nSample keys:', Object.keys(sample).join(', '));

// Types
const types = {};
r.forEach(n => { types[n.type] = (types[n.type] || 0) + 1; });
console.log('\nBy type:', JSON.stringify(types));

// Pass/fail analysis
const pass15 = r.filter(n => n.pass15mbps).length;
const pass10 = r.filter(n => n.pass10mbps).length;
const passBase = r.filter(n => n.passBaseline).length;
const zeroSpeed = r.filter(n => n.actualMbps === 0).length;
const nullSpeed = r.filter(n => n.actualMbps === null || n.actualMbps === undefined).length;
const hasSpeed = r.filter(n => n.actualMbps > 0).length;

console.log('\nPass 15mbps:', pass15);
console.log('Pass 10mbps:', pass10);
console.log('Pass baseline:', passBase);
console.log('Got speed > 0:', hasSpeed);
console.log('Zero speed:', zeroSpeed);
console.log('Null/undefined speed:', nullSpeed);

// Error field
const withError = r.filter(n => n.error);
console.log('\nWith error field:', withError.length);

// Look for failure indicators
const failNodes = r.filter(n => n.actualMbps === 0 || n.actualMbps === null || n.actualMbps === undefined);
console.log('\nFailed nodes (0/null speed):', failNodes.length);

// Error reasons from failed nodes
const reasons = {};
failNodes.forEach(n => {
  const reason = n.error || n.failReason || n.reason || 'no-error-field';
  const key = reason.toString().slice(0, 120);
  reasons[key] = (reasons[key] || 0) + 1;
});
console.log('\nFailure reasons:');
Object.entries(reasons).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${v}x ${k}`));

// ISP bottleneck
const ispBottleneck = r.filter(n => n.ispBottleneck).length;
console.log('\nISP bottleneck flagged:', ispBottleneck);

// Show some failed node addresses
console.log('\nFirst 10 failed addresses:');
failNodes.slice(0, 10).forEach(n => console.log(`  ${n.address} (${n.type}) speed=${n.actualMbps} err=${(n.error||'').slice(0,80)}`));

// Check for 'result' or 'status' fields
const hasResult = r.filter(n => n.result !== undefined).length;
const hasStatus = r.filter(n => n.status !== undefined).length;
console.log('\nHas result field:', hasResult, '| Has status field:', hasStatus);
