const https = require('https');
const r = JSON.parse(require('fs').readFileSync('results/results.json', 'utf8'));

// Get 5 working V2Ray nodes with diag data
const working = r.filter(x => x.type === 'V2Ray' && x.actualMbps > 0 && x.diag && x.diag.remoteUrl);
const sample = working.slice(0, 5);

// Also check node 1
const node1 = r.find(x => x.address && x.address.includes('vfdgskvj7f0lqk6'));

const all = [];
if (node1 && node1.diag) all.push({ label: 'FAIL node1', url: node1.diag.remoteUrl });
sample.forEach((n, i) => all.push({ label: `PASS #${i+1} (${n.actualMbps}Mbps)`, url: n.diag.remoteUrl }));

const agent = new https.Agent({ rejectUnauthorized: false });

Promise.all(all.map(item => {
  const url = item.url.replace(/\/+$/, '') + '/status';
  return new Promise(resolve => {
    const req = https.get(url, { agent, timeout: 10000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const v = j.result && j.result.version;
          resolve(`${item.label}: ${url} → v${v && v.tag} peers=${j.result && j.result.peers} handshake_dns=${j.result && j.result.handshake_dns}`);
        } catch(e) {
          resolve(`${item.label}: ${url} → parse error: ${data.substring(0, 100)}`);
        }
      });
    });
    req.on('error', e => resolve(`${item.label}: ${url} → ${e.message}`));
    req.on('timeout', () => { req.destroy(); resolve(`${item.label}: ${url} → timeout`); });
  });
})).then(results => results.forEach(r => console.log(r)));
