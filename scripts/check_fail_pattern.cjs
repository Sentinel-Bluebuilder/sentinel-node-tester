var fs = require('fs');
var d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));
var fails = d.filter(function(r) { return r.error; });
var ok = d.filter(function(r) { return r.actualMbps > 0; });
var TMAP = { 1:'ds', 2:'gun', 3:'grpc', 4:'http', 5:'kcp', 6:'quic', 7:'tcp', 8:'ws' };

console.log('=== FAILURE TRANSPORT PATTERNS ===');
fails.forEach(function(r) {
  var diag = r.diag || {};
  var meta = diag.v2rayRawMeta || [];
  var transports = meta.map(function(m) {
    return (m.proxy_protocol === 1 ? 'vless' : 'vmess') + '/' + (TMAP[m.transport_protocol] || '?') + '/' + (m.transport_security === 2 ? 'tls' : 'none') + ':' + m.port;
  });
  console.log(r.address.slice(8, 20) + ' | ' + (r.moniker || '').slice(0, 30) + ' | ' + transports.join(', ') + ' | inPlan=' + r.inPlan);
});

console.log('\n=== TRANSPORT OVERLAP: Do any OK nodes share the SAME transport combo? ===');
// For each failure, check if successful nodes use exactly the same transport
fails.forEach(function(r) {
  var diag = r.diag || {};
  var usedProto = diag.v2rayProto;
  var usedTransport = diag.v2rayTransport;
  var usedSec = diag.v2raySecurity;
  if (!usedProto) return;
  var key = usedProto + '/' + usedTransport + '/' + usedSec;
  var matching = ok.filter(function(o) {
    var od = o.diag || {};
    return od.v2rayProto === usedProto && od.v2rayTransport === usedTransport && od.v2raySecurity === usedSec;
  });
  console.log(r.address.slice(8, 20) + ' used ' + key + ' → ' + matching.length + ' OK nodes use same combo');
});

// Check if any grpc/none nodes that WORKED have similar metadata
console.log('\n=== WORKING vmess/grpc/none nodes (first 10) ===');
var grpcOk = ok.filter(function(o) {
  var od = o.diag || {};
  return od.v2rayProto === 'vmess' && od.v2rayTransport === 'grpc' && od.v2raySecurity === 'none';
});
grpcOk.slice(0, 10).forEach(function(r) {
  var diag = r.diag || {};
  var meta = diag.v2rayRawMeta || [];
  var transports = meta.map(function(m) {
    return (m.proxy_protocol === 1 ? 'vless' : 'vmess') + '/' + (TMAP[m.transport_protocol] || '?') + '/' + (m.transport_security === 2 ? 'tls' : 'none') + ':' + m.port;
  });
  console.log('  ' + r.address.slice(8, 20) + ' | ' + r.actualMbps + 'Mbps | ' + (r.moniker || '').slice(0, 25) + ' | ' + transports.join(', '));
});
