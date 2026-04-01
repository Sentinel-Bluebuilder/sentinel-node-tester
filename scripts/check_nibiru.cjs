var fs = require('fs');
var d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));

// Find all Nibiru nodes
var nibiru = d.filter(function(r) { return (r.moniker || '').indexOf('Nibiru') !== -1; });
console.log('=== ALL NIBIRU NODES (' + nibiru.length + ') ===');
nibiru.forEach(function(r) {
  var status = r.error ? 'FAIL: ' + (r.error || '').slice(0, 80) : 'OK: ' + r.actualMbps + ' Mbps';
  console.log(r.address.slice(0, 20) + ' | ' + r.moniker + ' | peers=' + r.peers + ' | ' + status);
});

// Check the other in-plan failures
console.log('\n=== OTHER IN-PLAN FAILURES ===');
var inPlanFails = d.filter(function(r) { return r.error && r.inPlan; });
inPlanFails.forEach(function(r) {
  console.log(r.address);
  console.log('  moniker:', r.moniker, '| type:', r.type, '| peers:', r.peers);
  console.log('  error:', (r.error || '').slice(0, 200));
  console.log('  plans:', JSON.stringify(r.planIds));
  var diag = r.diag || {};
  if (diag.v2rayRawMeta) {
    var TMAP = { 1:'ds', 2:'gun', 3:'grpc', 4:'http', 5:'kcp', 6:'quic', 7:'tcp', 8:'ws' };
    var transports = diag.v2rayRawMeta.map(function(m) {
      return (m.proxy_protocol === 1 ? 'vless' : 'vmess') + '/' + (TMAP[m.transport_protocol] || '?') + '/' + (m.transport_security === 2 ? 'tls' : 'none') + ':' + m.port;
    });
    console.log('  transports:', transports.join(', '));
  }
  console.log('');
});

// BUSUR nodes
console.log('=== ALL BUSUR NODES ===');
var busur = d.filter(function(r) { return (r.moniker || '').indexOf('BUSUR') !== -1; });
busur.forEach(function(r) {
  var status = r.error ? 'FAIL: ' + (r.error || '').slice(0, 80) : 'OK: ' + r.actualMbps + ' Mbps';
  console.log(r.address.slice(0, 20) + ' | ' + r.moniker + ' | peers=' + r.peers + ' | ' + status);
});
