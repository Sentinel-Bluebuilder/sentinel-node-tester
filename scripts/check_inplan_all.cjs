var fs = require('fs');
var d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));
var fails = d.filter(function(r) { return r.error; });

console.log('=== ALL ' + fails.length + ' FAILURES ===\n');
fails.forEach(function(r) {
  var diag = r.diag || {};
  console.log('=== ' + r.address + ' ===');
  console.log('moniker:', r.moniker, '| peers:', r.peers, '| inPlan:', r.inPlan, '| plans:', JSON.stringify(r.planIds));
  console.log('error:', (r.error || '').slice(0, 200));
  console.log('timestamp:', r.timestamp);
  console.log('type:', r.type);

  // Show all transport attempts if available
  var attempts = diag.v2rayAttempts || [];
  if (attempts.length) {
    console.log('Transport attempts (' + attempts.length + '):');
    attempts.forEach(function(a, i) {
      console.log('  [' + i + '] ' + a.label + ' => ' + a.result);
      if (a.error) console.log('      error: ' + a.error);
      if (a.stdout) {
        a.stdout.split('\n').slice(0, 10).forEach(function(l) {
          if (l.trim()) console.log('      stdout: ' + l.trim());
        });
      }
      if (a.stderr) {
        a.stderr.split('\n').slice(0, 5).forEach(function(l) {
          if (l.trim()) console.log('      stderr: ' + l.trim());
        });
      }
    });
  }

  // Fallback: show old-style diag
  if (!attempts.length) {
    var meta = diag.v2rayRawMeta || [];
    var TMAP = { 1:'ds', 2:'gun', 3:'grpc', 4:'http', 5:'kcp', 6:'quic', 7:'tcp', 8:'ws' };
    if (meta.length) {
      console.log('Metadata entries:');
      meta.forEach(function(m, i) {
        var proto = m.proxy_protocol === 1 ? 'vless' : 'vmess';
        var transport = TMAP[m.transport_protocol] || '?';
        var sec = m.transport_security === 2 ? 'tls' : 'none';
        console.log('  [' + i + '] ' + proto + '/' + transport + '/' + sec + ':' + m.port);
      });
    }
    if (diag.v2rayStdout) {
      console.log('V2Ray stdout (last attempt):');
      diag.v2rayStdout.split('\n').slice(0, 10).forEach(function(l) { if (l.trim()) console.log('  ' + l); });
    }
    if (diag.v2rayStderr) {
      console.log('V2Ray stderr (last attempt):');
      diag.v2rayStderr.split('\n').slice(0, 5).forEach(function(l) { if (l.trim()) console.log('  ' + l); });
    }
  }

  console.log('');
});
