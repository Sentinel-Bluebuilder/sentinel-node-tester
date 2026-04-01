import fs from 'fs';
const results = JSON.parse(fs.readFileSync('results/results.json','utf8'));
const failed = results.filter(r => r.error && r.actualMbps == null);
const balanceRe = /balance|insufficient|spendable/i;
const balanceFails = failed.filter(r => balanceRe.test(r.error));
const otherFails = failed.filter(r => !balanceRe.test(r.error));
const groups = {};
for (const r of otherFails) {
  const key = r.error.slice(0, 80);
  if (!groups[key]) groups[key] = [];
  groups[key].push(r.address);
}
console.log('Total failed:', failed.length);
console.log('Balance errors (skip):', balanceFails.length);
console.log('Other failures (retest):', otherFails.length);
console.log('');
for (const [err, addrs] of Object.entries(groups)) {
  console.log(addrs.length + 'x:', err);
}
console.log('');
console.log('ADDRESSES:' + JSON.stringify(otherFails.map(r => r.address)));
