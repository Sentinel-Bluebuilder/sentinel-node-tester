var fs = require('fs');
var d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));

// Compare raw metadata structure between failing and working nodes
var targets = [
  { label: 'Nibiru84 (FAIL)', match: '1vq8huvtkh3t' },
  { label: 'Nibiru111 (OK)', match: '12xsa762csrd' },
  { label: 'Nibiru81 (FAIL)', match: '1d9k7vf7asmt' },
  { label: 'BUSURNODE-CA-002 (FAIL)', match: '1vfdgskvj7f0' },
];

targets.forEach(function(t) {
  var r = d.find(function(x) { return x.address.indexOf(t.match) !== -1; });
  if (!r) { console.log(t.label + ': NOT FOUND'); return; }
  var diag = r.diag || {};
  console.log('=== ' + t.label + ' ===');
  console.log('Raw metadata:');
  var meta = diag.v2rayRawMeta || [];
  meta.forEach(function(m, i) {
    console.log('  [' + i + '] ALL FIELDS:', JSON.stringify(m, null, 4));
  });
  console.log('');
});
