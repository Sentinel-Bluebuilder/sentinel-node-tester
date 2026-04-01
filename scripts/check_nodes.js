// Quick check: what do raw LCD node entries look like?
import https from 'https';

const agent = new https.Agent({ rejectUnauthorized: false });

async function main() {
  // 1. Fetch first 10 nodes from LCD and show their raw remote_addrs
  console.log('=== LCD Node Sample ===');
  const r = await fetch('https://sentinel-api.polkachu.com/sentinel/node/v3/nodes?status=1&pagination.limit=10', {
    signal: AbortSignal.timeout(10000),
  });
  const data = await r.json();
  for (const n of (data.nodes || [])) {
    console.log(`Address: ${n.address}`);
    console.log(`remote_addrs: ${JSON.stringify(n.remote_addrs)}`);
    console.log(`gigabyte_prices: ${JSON.stringify(n.gigabyte_prices)}`);
    console.log('---');
  }

  // 2. Try probing the first few with /status
  console.log('\n=== Probing /status on first 10 nodes ===');
  const { default: axios } = await import('axios');
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  for (const n of (data.nodes || [])) {
    const rawAddr = (n.remote_addrs || [])[0] || '';
    const remoteUrl = rawAddr.startsWith('http') ? rawAddr : `https://${rawAddr}`;
    try {
      const res = await axios.get(remoteUrl + '/status', {
        httpsAgent,
        timeout: 8000,
      });
      console.log(`✓ ONLINE  ${remoteUrl}  →  type=${res.data?.result?.type}, city=${res.data?.result?.location?.city}`);
    } catch (err) {
      const code = err.response?.status || err.code || err.message;
      console.log(`✗ ${code}  ${remoteUrl}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
