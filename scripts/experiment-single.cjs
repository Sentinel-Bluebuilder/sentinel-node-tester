// Experiment: single-stream downloads at various sizes
// This simulates what a VPN node test would look like with single-stream
// Goal: see how much variance and how sensitive to latency/overhead

const https = require('https');
const dns = require('dns');

const CF_HOST = 'speed.cloudflare.com';

// Resolve CF IP first
async function resolveCf() {
  try {
    const resolver = new dns.Resolver();
    resolver.setServers(['1.1.1.1', '8.8.8.8']);
    return await new Promise((resolve, reject) => {
      resolver.resolve4(CF_HOST, (err, addrs) => err ? reject(err) : resolve(addrs[0]));
    });
  } catch {
    const { address } = await dns.promises.lookup(CF_HOST);
    return address;
  }
}

function singleStreamDownload(ip, bytes) {
  return new Promise((resolve, reject) => {
    let downloaded = 0;
    const start = Date.now();
    let finished = false;

    function done(err) {
      if (finished) return;
      finished = true;
      const elapsed = (Date.now() - start) / 1000;
      if (err && downloaded === 0) { reject(err); return; }
      if (elapsed <= 0 || downloaded === 0) { reject(new Error('No data')); return; }
      const mbps = (downloaded * 8) / elapsed / 1_000_000;
      resolve({ mbps: parseFloat(mbps.toFixed(2)), bytes: downloaded, seconds: parseFloat(elapsed.toFixed(2)) });
    }

    const req = https.get({
      hostname: ip,
      path: `/__down?bytes=${bytes}`,
      headers: { Host: CF_HOST },
      servername: CF_HOST,
      rejectUnauthorized: false,
    }, (res) => {
      if (res.statusCode !== 200) { req.destroy(); done(new Error(`HTTP ${res.statusCode}`)); return; }
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (downloaded >= bytes) { res.destroy(); done(); }
      });
      res.on('end', () => done());
      res.on('error', (err) => done(err));
    });
    req.on('error', (err) => done(err));
    req.setTimeout(60000, () => { req.destroy(); done(new Error('timeout')); });
  });
}

async function run() {
  const ip = await resolveCf();
  console.log(`CF IP: ${ip}\n`);

  const sizes = [
    { label: '1MB', bytes: 1 * 1024 * 1024 },
    { label: '2MB', bytes: 2 * 1024 * 1024 },
    { label: '3MB', bytes: 3 * 1024 * 1024 },
    { label: '5MB', bytes: 5 * 1024 * 1024 },
    { label: '8MB', bytes: 8 * 1024 * 1024 },
    { label: '10MB', bytes: 10 * 1024 * 1024 },
  ];

  for (const { label, bytes } of sizes) {
    console.log(`--- Single-stream ${label} ---`);
    const results = [];
    for (let i = 0; i < 3; i++) {
      try {
        const r = await singleStreamDownload(ip, bytes);
        results.push(r.mbps);
        console.log(`  Run ${i+1}: ${r.mbps} Mbps (${r.seconds}s, ${(r.bytes/1024/1024).toFixed(1)}MB)`);
      } catch (e) {
        console.log(`  Run ${i+1}: FAILED - ${e.message}`);
      }
    }
    if (results.length > 0) {
      const avg = results.reduce((s,v) => s+v, 0) / results.length;
      const min = Math.min(...results);
      const max = Math.max(...results);
      console.log(`  Avg: ${avg.toFixed(2)} | Min: ${min} | Max: ${max} | Spread: ${(max-min).toFixed(2)}`);
    }
    console.log('');
  }
}

run().catch(console.error);
