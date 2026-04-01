var fs = require('fs');
var d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));

// Nibiru84 (FAIL) vs Nibiru111 (OK) - same ports 9966/6699
var fail84 = d.find(function(r) { return r.address.indexOf('1vq8huvtkh3t') !== -1; });
var ok111 = d.find(function(r) { return r.address.indexOf('12xsa762csrd') !== -1; });
var fail81 = d.find(function(r) { return r.address.indexOf('1d9k7vf7asmt') !== -1; });

function showMeta(label, r) {
  if (!r) { console.log(label + ': NOT FOUND'); return; }
  var diag = r.diag || {};
  console.log('=== ' + label + ' ===');
  console.log('address:', r.address);
  console.log('moniker:', r.moniker, '| peers:', r.peers, '| speed:', r.actualMbps);
  console.log('remoteUrl:', diag.remoteUrl);
  console.log('serverHost:', diag.serverHost);
  console.log('metadataCount:', diag.v2rayMetadataCount);
  var meta = diag.v2rayRawMeta || [];
  meta.forEach(function(m, i) {
    console.log('  meta[' + i + ']:', JSON.stringify(m));
  });
  console.log('used:', diag.v2rayProto + '/' + diag.v2rayTransport + '/' + diag.v2raySecurity + ':' + diag.v2rayPort);
  console.log('');
}

showMeta('Nibiru84 (FAIL)', fail84);
showMeta('Nibiru111 (OK)', ok111);
showMeta('Nibiru81 (FAIL)', fail81);

// Also find a working BUSUR V2Ray node to compare
var failBusur = d.find(function(r) { return (r.moniker || '').indexOf('BUSURNODE-CA-002') !== -1; });
var okBusurV2 = d.filter(function(r) { return (r.moniker || '').indexOf('BUSURNODE') !== -1 && r.type === 'V2Ray' && r.actualMbps > 0; });
showMeta('BUSURNODE-CA-002 (FAIL)', failBusur);
if (okBusurV2.length) showMeta('BUSUR V2Ray OK example: ' + okBusurV2[0].moniker, okBusurV2[0]);
