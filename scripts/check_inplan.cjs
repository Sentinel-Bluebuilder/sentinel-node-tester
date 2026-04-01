var fs = require('fs');
var d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));

var targets = [
  'sentnode1vq8huvtkh3tktcwj9edujvyx2y2g7x34xhds8f',
  'sentnode1vfdgskvj7f0lqk6wawhzs7vhh8wlncynw765te'
];

targets.forEach(function(addr) {
  var r = d.find(function(x) { return x.address === addr; });
  if (!r) { console.log('NOT FOUND: ' + addr); return; }
  var diag = r.diag || {};
  console.log('=== ' + addr + ' ===');
  console.log('moniker:', r.moniker, '| peers:', r.peers, '| inPlan:', r.inPlan, '| plans:', JSON.stringify(r.planIds));
  console.log('error:', (r.error || '').slice(0, 200));
  console.log('timestamp:', r.timestamp);
  console.log('type:', r.type);

  var meta = diag.v2rayRawMeta || [];
  if (meta.length) {
    var TMAP = { 1:'ds', 2:'gun', 3:'grpc', 4:'http', 5:'kcp', 6:'quic', 7:'tcp', 8:'ws' };
    console.log('Metadata entries:');
    meta.forEach(function(m, i) {
      var proto = m.proxy_protocol === 1 ? 'vless' : 'vmess';
      var transport = TMAP[m.transport_protocol] || '?';
      var sec = m.transport_security === 2 ? 'tls' : 'none';
      console.log('  [' + i + '] ' + proto + '/' + transport + '/' + sec + ':' + m.port);
    });
  }

  if (diag.v2rayConfig) {
    var obs = diag.v2rayConfig.outbounds || [];
    console.log('Config outbounds (' + obs.length + '):');
    obs.forEach(function(o, i) {
      var ss = o.streamSettings || {};
      var vnext = (o.settings || {}).vnext;
      var port = vnext && vnext[0] ? vnext[0].port : '?';
      console.log('  [' + i + '] tag=' + o.tag + ' proto=' + o.protocol + ' net=' + ss.network + ' sec=' + ss.security + ' port=' + port);
    });
    var rules = (diag.v2rayConfig.routing || {}).rules || [];
    rules.forEach(function(rule) {
      if (rule.inboundTag && rule.inboundTag.indexOf('proxy') !== -1) {
        console.log('Proxy routes to: ' + (rule.outboundTag || rule.balancerTag || '?'));
      }
    });
  }

  if (diag.v2rayStdout) {
    console.log('V2Ray stdout:');
    diag.v2rayStdout.split('\n').forEach(function(l) { if (l.trim()) console.log('  ' + l); });
  }
  if (diag.v2rayStderr) {
    console.log('V2Ray stderr:');
    diag.v2rayStderr.split('\n').forEach(function(l) { if (l.trim()) console.log('  ' + l); });
  }
  console.log('');
});
