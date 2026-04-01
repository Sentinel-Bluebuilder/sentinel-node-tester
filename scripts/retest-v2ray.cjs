// Retest failing V2Ray nodes — proper status check
const https = require('https');

const nodes = [
  { addr: 'sentnode1yqyza6uatdtcu7u0pn0ua6qt7azsha96lmfduz', url: 'https://myra.busur.cc:63116' },
  { addr: 'sentnode1zwfqm6zg3nq82vlnzs404emce25j4rmw80euzq', url: 'https://suwatt.thddns.net:54656' },
  { addr: 'sentnode19vgpan39wcccnvp86djnemw6rpanphlyf66v7n', url: 'https://193.32.163.45:8585' },
  { addr: 'sentnode1x80sq9rdd9ljfm46006qd3almffx6ja0mthktn', url: 'https://23.95.216.102:8585' },
  { addr: 'sentnode1x3vm6kunezsjymen6mdkx42khkxpjedmu07vkl', url: 'https://107.172.92.53:8585' },
  { addr: 'sentnode1xdzszkj3nxj3nlagzrwrp7tg44axtylmu2pa32', url: 'https://sg2v2.pytonode.my.id:23457' },
  { addr: 'sentnode1vq8huvtkh3tktcwj9edujvyx2y2g7x34xhds8f', url: 'https://87.229.95.96:9933' },
];

async function checkNode(n) {
  return new Promise(resolve => {
    const u = new URL(n.url + '/');  // root path = status
    const req = https.get(u, { rejectUnauthorized: false, timeout: 10000 }, res => {
      let data = '';
      const dateHeader = res.headers['date'];
      res.on('data', d => data += d);
      res.on('end', () => {
        let clockDrift = null;
        if (dateHeader) {
          clockDrift = Math.round((new Date(dateHeader).getTime() - Date.now()) / 1000);
        }
        try {
          const j = JSON.parse(data);
          const r = j.result || {};
          resolve({
            ...n, online: true, clockDrift,
            moniker: r.moniker,
            peers: r.peers,
            type: r.type === 3 ? 'V2Ray' : r.type === 1 ? 'WireGuard' : r.type,
            version: r.version,
            bandwidth: r.bandwidth,
          });
        } catch {
          resolve({ ...n, online: true, clockDrift, raw: data.slice(0, 300) });
        }
      });
    });
    req.on('error', e => resolve({ ...n, online: false, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ...n, online: false, error: 'TIMEOUT' }); });
  });
}

(async () => {
  const results = await Promise.all(nodes.map(checkNode));
  console.log('Node Status Check:\n');
  results.forEach(r => {
    if (r.online) {
      console.log(`${r.addr.slice(0,20)}... ONLINE  drift=${r.clockDrift}s  peers=${r.peers}  ${r.moniker || ''}`);
    } else {
      console.log(`${r.addr.slice(0,20)}... OFFLINE  ${r.error}`);
    }
  });

  const online = results.filter(r => r.online);
  const testable = online.filter(r => Math.abs(r.clockDrift || 0) <= 120);
  console.log(`\n${online.length}/${results.length} reachable, ${testable.length} within clock tolerance`);

  if (testable.length > 0) {
    console.log('\nTestable nodes:');
    testable.forEach(r => console.log(`  ${r.addr}  ${r.url}  drift=${r.clockDrift}s  peers=${r.peers}`));
  }
})();
