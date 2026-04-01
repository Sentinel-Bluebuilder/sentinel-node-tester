var fs = require('fs');
var d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));
var failed = d.filter(function(r) { return r.error; });

console.log('=== ' + failed.length + ' FAILURES ===\n');
failed.forEach(function(r) {
  var diag = r.diag || {};
  console.log('NODE: ' + r.address);
  console.log('  Type: ' + r.type + ' | Moniker: ' + r.moniker + ' | Peers: ' + r.peers);
  console.log('  Error: ' + (r.error || '').slice(0, 200));
  console.log('  Timestamp: ' + (r.testedAt || 'none'));
  if (diag.v2rayRawMeta) {
    console.log('  Meta entries: ' + diag.v2rayRawMeta.length);
    diag.v2rayRawMeta.forEach(function(m, i) {
      var proto = m.proxy_protocol === 1 ? 'vless' : 'vmess';
      var TMAP = { 1:'domainsocket', 2:'gun', 3:'grpc', 4:'http', 5:'kcp', 6:'quic', 7:'tcp', 8:'websocket' };
      var transport = TMAP[m.transport_protocol] || 'unknown(' + m.transport_protocol + ')';
      var sec = m.transport_security === 2 ? 'tls' : 'none';
      console.log('    [' + i + '] port=' + m.port + ' ' + proto + '/' + transport + '/' + sec);
    });
  }
  if (diag.v2rayStderr) {
    console.log('  Stderr: ' + diag.v2rayStderr.slice(0, 300));
  }
  console.log('');
});
