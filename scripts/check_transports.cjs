var fs = require('fs');
var d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));
var TMAP = { 1:'domainsocket', 2:'gun', 3:'grpc', 4:'http', 5:'kcp', 6:'quic', 7:'tcp', 8:'websocket' };

var transportCounts = {};
d.forEach(function(r) {
  if (r.type !== 'V2Ray') return;
  var meta = (r.diag || {}).v2rayRawMeta || [];
  var ok = r.actualMbps > 0;
  meta.forEach(function(m) {
    var t = TMAP[m.transport_protocol] || 'unknown';
    var s = m.transport_security === 2 ? 'tls' : 'none';
    var key = t + '/' + s;
    if (!transportCounts[key]) transportCounts[key] = { ok: 0, fail: 0 };
    if (ok) transportCounts[key].ok++;
    else transportCounts[key].fail++;
  });
});

console.log('=== TRANSPORT SUCCESS RATES (per metadata entry) ===');
Object.keys(transportCounts).sort().forEach(function(k) {
  var c = transportCounts[k];
  console.log(k + ': OK=' + c.ok + ' FAIL=' + c.fail);
});

console.log('\n=== WORKING V2RAY NODES WITH QUIC OR GRPC ===');
d.forEach(function(r) {
  if (r.type !== 'V2Ray' || r.actualMbps <= 0) return;
  var diag = r.diag || {};
  var meta = diag.v2rayRawMeta || [];
  var hasQuicOrGrpc = meta.some(function(m) { return m.transport_protocol === 3 || m.transport_protocol === 6; });
  if (!hasQuicOrGrpc) return;
  var transports = meta.map(function(m) {
    var t = TMAP[m.transport_protocol] || '?';
    var s = m.transport_security === 2 ? 'tls' : 'none';
    return t + '/' + s + ':' + m.port;
  }).join(', ');
  console.log(r.address.slice(0, 40) + ' | ' + r.actualMbps + 'Mbps | ' + transports);
  // Show which outbound was actually used
  if (diag.v2rayProto) {
    console.log('  Used: ' + diag.v2rayProto + '/' + diag.v2rayTransport + '/' + diag.v2raySecurity + ':' + diag.v2rayPort);
  }
});
