const r = JSON.parse(require('fs').readFileSync('results/results.json', 'utf8'));
const n = r.find(x => x.address && x.address.includes('vfdgskvj7f0lqk6'));
if (!n) { console.log('NOT FOUND'); process.exit(); }
console.log('Result:', n.actualMbps ? 'PASS ' + n.actualMbps + ' Mbps' : 'FAIL');
console.log('Error:', n.error);
console.log('');
if (n.diag) {
  console.log('UUID:', n.diag.v2rayUUID);
  console.log('HS config:', n.diag.hsConfig);
  console.log('HS endpoints:', JSON.stringify(n.diag.hsEndpoints));
  console.log('');
  (n.diag.v2rayAttempts || []).forEach(a => {
    console.log('=== ' + a.label + ' === ' + a.result);
    if (a.error) console.log('Error:', a.error);
    console.log('STDOUT:', (a.stdout || '').substring(0, 3000));
    console.log('');
  });
}
