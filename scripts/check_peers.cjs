var https = require('https');
var http = require('http');

var nodes = [
  { addr: 'sentnode1yqyza6uatdtcu7u0pn0ua6qt7azsha96lmfduz', host: 'myra.busur.cc', label: 'QUIC/tls' },
  { addr: 'sentnode1x3vm6kunezsjymen6mdkx42khkxpjedmu07vkl', host: '107.172.92.53', label: 'QUIC/tls' },
  { addr: 'sentnode1xdzszkj3nxj3nlagzrwrp7tg44axtylmu2pa32', host: 'sg2v2.pytonode.my.id', label: 'QUIC/none+tls' },
  { addr: 'sentnode1zwfqm6zg3nq82vlnzs404emce25j4rmw80euzq', host: 'suwatt.thddns.net', label: 'gRPC/tls' },
  { addr: 'sentnode19vgpan39wcccnvp86djnemw6rpanphlyf66v7n', host: '193.32.163.45', label: 'gRPC/tls' },
  { addr: 'sentnode1x80sq9rdd9ljfm46006qd3almffx6ja0mthktn', host: '23.95.216.102', label: 'gRPC/none' },
];

// Query LCD for active sessions (peers) for each node
var LCD = 'https://lcd.sentinel.co';
var pending = nodes.length;

nodes.forEach(function(n) {
  var url = LCD + '/sentinel/nodes/' + n.addr;
  https.get(url, { timeout: 10000 }, function(res) {
    var body = '';
    res.on('data', function(c) { body += c; });
    res.on('end', function() {
      try {
        var d = JSON.parse(body);
        var node = d.node || {};
        console.log(n.label + ' | ' + n.addr.slice(0, 30) + ' | status:', node.status, '| remote_url:', (node.remote_url || '').slice(0, 60));
      } catch(e) {
        console.log(n.label + ' | ' + n.addr.slice(0, 30) + ' | parse error:', body.slice(0, 100));
      }
      if (--pending === 0) fetchSessions();
    });
  }).on('error', function(e) {
    console.log(n.label + ' | ' + n.addr.slice(0, 30) + ' | error:', e.message);
    if (--pending === 0) fetchSessions();
  });
});

function fetchSessions() {
  console.log('\n=== Checking active sessions per node ===');
  var done = nodes.length;
  nodes.forEach(function(n) {
    var url = LCD + '/sentinel/sessions?node_address=' + n.addr + '&status=SESSION_STATUS_ACTIVE&pagination.limit=5';
    https.get(url, { timeout: 10000 }, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        try {
          var d = JSON.parse(body);
          var sessions = d.sessions || [];
          console.log(n.label + ' | ' + n.addr.slice(0, 30) + ' | active_sessions:', sessions.length);
          sessions.forEach(function(s) {
            console.log('    session', s.id, 'from', s.address, 'status:', s.status_at);
          });
        } catch(e) {
          console.log(n.label + ' | ' + n.addr.slice(0, 30) + ' | parse error');
        }
        if (--done === 0) queryNodeAPIs();
      });
    }).on('error', function(e) {
      console.log(n.label + ' | ' + n.addr.slice(0, 30) + ' | error:', e.message);
      if (--done === 0) queryNodeAPIs();
    });
  });
}

// Also query the node's own API for peer count
function queryNodeAPIs() {
  console.log('\n=== Querying node APIs for peer count ===');
  // Need remote_url from each node's chain record — we'll get it from LCD
  var done2 = nodes.length;
  nodes.forEach(function(n) {
    var url = LCD + '/sentinel/nodes/' + n.addr;
    https.get(url, { timeout: 10000 }, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        try {
          var d = JSON.parse(body);
          var remoteUrl = (d.node || {}).remote_url || '';
          if (!remoteUrl) {
            console.log(n.label + ' | no remote_url');
            if (--done2 === 0) process.exit(0);
            return;
          }
          // Query node status
          var statusUrl = remoteUrl.replace(/\/$/, '') + '/status';
          var mod = statusUrl.startsWith('https') ? https : http;
          mod.get(statusUrl, { timeout: 8000, rejectUnauthorized: false }, function(r2) {
            var b2 = '';
            r2.on('data', function(c) { b2 += c; });
            r2.on('end', function() {
              try {
                var s = JSON.parse(b2);
                var result = s.result || s;
                console.log(n.label + ' | ' + n.addr.slice(0, 30) + ' | peers:', result.peers, '| type:', result.type, '| version:', result.version);
              } catch(e) {
                console.log(n.label + ' | ' + n.addr.slice(0, 30) + ' | status parse error:', b2.slice(0, 100));
              }
              if (--done2 === 0) process.exit(0);
            });
          }).on('error', function(e) {
            console.log(n.label + ' | ' + n.addr.slice(0, 30) + ' | status unreachable:', e.message);
            if (--done2 === 0) process.exit(0);
          });
        } catch(e) {
          console.log(n.label + ' | parse error');
          if (--done2 === 0) process.exit(0);
        }
      });
    }).on('error', function(e) {
      console.log(n.label + ' | error:', e.message);
      if (--done2 === 0) process.exit(0);
    });
  });
}
