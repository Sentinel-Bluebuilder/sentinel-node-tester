var fs = require('fs');
var d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));
var socks = d.filter(function(r) { return r.error && r.error.indexOf('SOCKS5') !== -1; });

console.log('=== ' + socks.length + ' SOCKS5 FAILURES — DEEP PROXY ANALYSIS ===\n');
socks.forEach(function(r) {
  var diag = r.diag || {};
  console.log('NODE:', r.address);
  console.log('  Moniker:', r.moniker, '| Peers:', r.peers, '| Timestamp:', r.timestamp);
  console.log('  Error:', (r.error || '').slice(0, 200));

  if (diag.v2rayProto) {
    console.log('  V2Ray Proto:', diag.v2rayProto, '| Transport:', diag.v2rayTransport, '| Security:', diag.v2raySecurity);
    console.log('  Port:', diag.v2rayPort, '| Host:', diag.serverHost);
  }

  if (diag.v2rayRawMeta) {
    console.log('  Raw metadata entries (' + diag.v2rayRawMeta.length + '):');
    diag.v2rayRawMeta.forEach(function(m, i) {
      var proto = m.proxy_protocol === 1 ? 'vless' : 'vmess';
      var TMAP = { 1:'domainsocket', 2:'gun', 3:'grpc', 4:'http', 5:'kcp', 6:'quic', 7:'tcp', 8:'websocket' };
      var transport = TMAP[m.transport_protocol] || 'unknown(' + m.transport_protocol + ')';
      var sec = m.transport_security === 2 ? 'tls' : 'none';
      console.log('    [' + i + '] port=' + m.port + ' ' + proto + '/' + transport + '/' + sec);
    });
  }

  if (diag.v2rayConfig) {
    var cfg = diag.v2rayConfig;
    var obs = cfg.outbounds || [];
    console.log('  Config outbounds (' + obs.length + '):');
    obs.forEach(function(o, i) {
      var ss = o.streamSettings || {};
      var vnext = (o.settings || {}).vnext;
      var port = vnext && vnext[0] ? vnext[0].port : '?';
      console.log('    [' + i + '] tag=' + o.tag + ' proto=' + o.protocol + ' net=' + ss.network + ' sec=' + ss.security + ' port=' + port);
      if (ss.quicSettings) console.log('         quicSettings:', JSON.stringify(ss.quicSettings));
      if (ss.grpcSettings) console.log('         grpcSettings:', JSON.stringify(ss.grpcSettings));
      if (ss.gunSettings) console.log('         gunSettings:', JSON.stringify(ss.gunSettings));
      if (ss.tlsSettings) console.log('         tlsSettings:', JSON.stringify(ss.tlsSettings));
    });
    var bal = (cfg.routing || {}).balancers;
    if (bal && bal[0]) {
      console.log('  Balancer strategy:', bal[0].strategy ? bal[0].strategy.type : 'none');
      console.log('  Balancer selectors:', (bal[0].selector || []).length);
    }
  }

  if (diag.v2rayStdout) {
    console.log('  V2Ray STDOUT:');
    var lines = diag.v2rayStdout.split('\n');
    lines.forEach(function(l) { if (l.trim()) console.log('    ' + l); });
  }
  if (diag.v2rayStderr) {
    console.log('  V2Ray STDERR:');
    var lines = diag.v2rayStderr.slice(0, 800).split('\n');
    lines.forEach(function(l) { if (l.trim()) console.log('    ' + l); });
  }

  console.log('');
});
