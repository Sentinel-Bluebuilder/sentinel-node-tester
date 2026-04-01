// Experiment: multi-request sequential downloads
// Each chunk = fresh TCP+TLS connection. VPN's extra latency compounds.
// This is FAIR (same test for both) but latency-sensitive (realistic).

const https = require('https');
const dns = require('dns');

const CF_HOST = 'speed.cloudflare.com';
let cfIp = null;

async function resolveCf() {
  if (cfIp) return cfIp;
  try {
    const resolver = new dns.Resolver();
    resolver.setServers(['1.1.1.1', '8.8.8.8']);
    cfIp = await new Promise((resolve, reject) => {
      resolver.resolve4(CF_HOST, (err, addrs) => err ? reject(err) : resolve(addrs[0]));
    });
  } catch {
    const { address } = await dns.promises.lookup(CF_HOST);
    cfIp = address;
  }
  return cfIp;
}

function freshDownload(ip, bytes) {
  return new Promise((resolve, reject) => {
    let downloaded = 0;
    let finished = false;
    const start = Date.now();

    function done(err) {
      if (finished) return;
      finished = true;
      if (err && downloaded === 0) { reject(err); return; }
      resolve({ bytes: downloaded, ms: Date.now() - start });
    }

    // agent: false = no keep-alive, fresh TCP+TLS per request
    const req = https.get({
      hostname: ip,
      path: `/__down?bytes=${bytes}`,
      headers: { Host: CF_HOST },
      servername: CF_HOST,
      rejectUnauthorized: false,
      agent: false,  // CRITICAL: forces fresh connection each time
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
    req.setTimeout(30000, () => { req.destroy(); done(new Error('timeout')); });
  });
}

async function multiRequestTest(ip, chunkBytes, chunks) {
  let totalBytes = 0;
  const overallStart = Date.now();
  const chunkTimes = [];

  for (let i = 0; i < chunks; i++) {
    const r = await freshDownload(ip, chunkBytes);
    totalBytes += r.bytes;
    chunkTimes.push(r.ms);
  }

  const totalMs = Date.now() - overallStart;
  const mbps = (totalBytes * 8) / (totalMs / 1000) / 1_000_000;
  return { mbps: parseFloat(mbps.toFixed(2)), totalBytes, totalMs, chunks, chunkTimes };
}

async function singleStreamTest(ip, bytes) {
  const start = Date.now();
  const r = await freshDownload(ip, bytes);
  const mbps = (r.bytes * 8) / (r.ms / 1000) / 1_000_000;
  return { mbps: parseFloat(mbps.toFixed(2)), bytes: r.bytes, ms: r.ms };
}

async function run() {
  const ip = await resolveCf();
  console.log(`CF IP: ${ip}\n`);

  // Test various approaches to find best gap-creating method

  console.log('=== A: Current approach (single 10MB stream) ===');
  for (let i = 0; i < 3; i++) {
    const r = await singleStreamTest(ip, 10 * 1024 * 1024);
    console.log(`  Run ${i+1}: ${r.mbps} Mbps (${r.ms}ms)`);
  }

  console.log('\n=== B: 5 × 1MB sequential fresh connections ===');
  for (let i = 0; i < 3; i++) {
    const r = await multiRequestTest(ip, 1 * 1024 * 1024, 5);
    console.log(`  Run ${i+1}: ${r.mbps} Mbps (${r.totalMs}ms, chunks: [${r.chunkTimes.join(', ')}]ms)`);
  }

  console.log('\n=== C: 10 × 500KB sequential fresh connections ===');
  for (let i = 0; i < 3; i++) {
    const r = await multiRequestTest(ip, 512 * 1024, 10);
    console.log(`  Run ${i+1}: ${r.mbps} Mbps (${r.totalMs}ms, chunks: [${r.chunkTimes.join(', ')}]ms)`);
  }

  console.log('\n=== D: 5 × 2MB sequential fresh connections ===');
  for (let i = 0; i < 3; i++) {
    const r = await multiRequestTest(ip, 2 * 1024 * 1024, 5);
    console.log(`  Run ${i+1}: ${r.mbps} Mbps (${r.totalMs}ms, chunks: [${r.chunkTimes.join(', ')}]ms)`);
  }

  console.log('\n=== E: 3 × 2MB sequential fresh connections ===');
  for (let i = 0; i < 3; i++) {
    const r = await multiRequestTest(ip, 2 * 1024 * 1024, 3);
    console.log(`  Run ${i+1}: ${r.mbps} Mbps (${r.totalMs}ms, chunks: [${r.chunkTimes.join(', ')}]ms)`);
  }

  console.log('\nDone.');
}

run().catch(console.error);
