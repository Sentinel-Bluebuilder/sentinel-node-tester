/**
 * Speed test using Cloudflare's public speed test CDN.
 * No token or auth required. Accurate and reliable.
 *
 * WireGuard: direct (all traffic routes through tunnel)
 * V2Ray:     via SOCKS5 proxy on localhost:PORT
 *
 * Multi-request methodology:
 *   Downloads N sequential chunks, each over a FRESH TCP+TLS connection.
 *   VPN overhead (extra RTT per connection) compounds across chunks,
 *   creating a genuine, measurable speed gap vs direct connection.
 *   This is both FAIR (same test for both) and REALISTIC (real browsing
 *   makes many small requests, not one big stream).
 *
 * Adaptive:
 *   Phase 1: Quick 1MB single probe (~1s at 10 Mbps)
 *   Phase 2: If probe > 3 Mbps, full 5 × 1MB multi-request test
 *   If probe < 3 Mbps, report probe result directly (saves time on slow nodes)
 */

import axios from 'axios';
import https from 'https';
import dns from 'dns';
import { SocksProxyAgent } from 'socks-proxy-agent';

// Force axios to use the Node.js http adapter, NOT the fetch adapter.
axios.defaults.adapter = 'http';

// Cloudflare speed test CDN — always up, no auth, geographically distributed
const CF_HOST = 'speed.cloudflare.com';
const CF_DOWN = `https://${CF_HOST}/__down`;

// Multi-request test parameters
const CHUNK_BYTES = 1 * 1024 * 1024;  // 1MB per chunk
const CHUNK_COUNT = 5;                  // 5 sequential requests = 5MB total
const PROBE_BYTES = 1 * 1024 * 1024;   // 1MB probe

// Fallback download targets when Cloudflare is unreachable through a tunnel
const FALLBACK_URLS = [
  { host: 'proof.ovh.net', path: '/files/1Mb.dat', size: 1_000_000 },
  { host: 'speedtest.tele2.net', path: '/1MB.zip', size: 1_000_000 },
];

// Cache resolved IP with TTL (survives WireGuard DNS breakage, refreshes on stale)
let cachedCfIp = null;
let cachedCfTime = 0;
let cachedFallbackIps = {};
const DNS_CACHE_TTL = 5 * 60_000; // 5 minutes

async function resolveCfHost() {
  if (cachedCfIp && Date.now() - cachedCfTime < DNS_CACHE_TTL) return cachedCfIp;

  // Method 1: Explicit resolver to 1.1.1.1 (most reliable — bypasses broken system DNS)
  try {
    const resolver = new dns.Resolver();
    resolver.setServers(['1.1.1.1', '8.8.8.8']);
    const addrs = await new Promise((resolve, reject) => {
      resolver.resolve4(CF_HOST, (err, addresses) => err ? reject(err) : resolve(addresses));
    });
    if (addrs.length > 0) { cachedCfIp = addrs[0]; cachedCfTime = Date.now(); return cachedCfIp; }
  } catch { }

  // Method 2: Default resolve4 (uses c-ares — fails on Windows 11 DoH setups)
  try {
    const addrs = await dns.promises.resolve4(CF_HOST);
    if (addrs.length > 0) { cachedCfIp = addrs[0]; cachedCfTime = Date.now(); return cachedCfIp; }
  } catch { }

  // Method 3: OS resolver (getaddrinfo — always works but may return CDN-specific IP)
  try {
    const { address } = await dns.promises.lookup(CF_HOST);
    cachedCfIp = address;
    cachedCfTime = Date.now();
    return cachedCfIp;
  } catch { }

  return null;
}

/** Pre-resolve fallback hosts so they work behind WireGuard tunnels too. */
async function resolveFallbackHosts() {
  for (const fb of FALLBACK_URLS) {
    if (cachedFallbackIps[fb.host]) continue;
    try {
      const { address } = await dns.promises.lookup(fb.host);
      cachedFallbackIps[fb.host] = address;
    } catch {}
  }
}

/**
 * Download limitBytes from url with a FRESH TCP+TLS connection.
 * Uses https.get (NOT fetch) because native fetch silently ignores the agent option.
 * agent: false ensures no keep-alive — every call does a full TCP+TLS handshake.
 * timeoutMs defaults to 30s but can be increased for tunnel retries.
 */
function freshDownload(url, limitBytes, agentOpts, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let downloaded = 0;
    const start = Date.now();
    const parsed = new URL(url);
    let finished = false;

    function done(err) {
      if (finished) return;
      finished = true;
      const elapsed = (Date.now() - start) / 1000;
      if (err && downloaded === 0) { reject(err); return; }
      if (elapsed <= 0 || downloaded === 0) { reject(new Error('No data received')); return; }
      resolve({ bytes: downloaded, seconds: elapsed });
    }

    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {},
      rejectUnauthorized: false,
      agent: false,  // CRITICAL: fresh TCP+TLS connection every time (no keep-alive)
    };

    // IP-based URL: set Host header and TLS SNI so server accepts it
    if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)) {
      const hostName = agentOpts?.fallbackHost || CF_HOST;
      options.headers['Host'] = hostName;
      options.servername = hostName;
    }

    // Allow custom agent (overrides agent: false) for specific cases
    if (agentOpts?.httpsAgent) {
      options.agent = agentOpts.httpsAgent;
    }

    const req = https.get(options, (res) => {
      if (res.statusCode !== 200) {
        req.destroy();
        done(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (downloaded >= limitBytes) {
          res.destroy();
          done();
        }
      });
      res.on('end', () => done());
      res.on('error', (err) => done(err));
    });

    req.on('error', (err) => done(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done(new Error('timeout'));
    });
  });
}

/**
 * Last-resort single-stream download with long timeout (60s).
 * Used when the multi-request test fails through a tunnel.
 * Downloads a smaller amount (2MB) with a keep-alive agent for reliability.
 * Returns low but valid speed rather than failing the node entirely.
 */
async function rescueDownload() {
  const RESCUE_BYTES = 2 * 1024 * 1024;
  const rescueAgent = new https.Agent({ rejectUnauthorized: false, servername: CF_HOST, keepAlive: true });

  // Try: IP with agent, hostname with agent, fallback hosts
  const urls = [];
  if (cachedCfIp) urls.push(`https://${cachedCfIp}/__down?bytes=${RESCUE_BYTES}`);
  urls.push(`${CF_DOWN}?bytes=${RESCUE_BYTES}`);

  for (const url of urls) {
    try {
      const r = await freshDownload(url, RESCUE_BYTES, { httpsAgent: rescueAgent }, 60000);
      const mbps = (r.bytes * 8) / r.seconds / 1_000_000;
      rescueAgent.destroy();
      return { mbps: parseFloat(mbps.toFixed(2)), chunks: 1, adaptive: 'rescue' };
    } catch {}
  }

  // Try fallback URLs with long timeout
  for (const fb of FALLBACK_URLS) {
    const ip = cachedFallbackIps[fb.host];
    const targets = [];
    if (ip) targets.push({ url: `https://${ip}${fb.path}`, opts: { httpsAgent: rescueAgent, fallbackHost: fb.host } });
    targets.push({ url: `https://${fb.host}${fb.path}`, opts: { httpsAgent: rescueAgent } });

    for (const t of targets) {
      try {
        const r = await freshDownload(t.url, fb.size, t.opts, 60000);
        const mbps = (r.bytes * 8) / r.seconds / 1_000_000;
        rescueAgent.destroy();
        return { mbps: parseFloat(mbps.toFixed(2)), chunks: 1, adaptive: 'rescue-fallback', fallbackHost: fb.host };
      } catch {}
    }
  }

  rescueAgent.destroy();
  return null;
}

/**
 * Multi-request speed test: download N chunks sequentially, each with fresh TCP+TLS.
 * Total elapsed time includes all connection overhead (handshakes compound).
 * VPN latency shows up as genuinely lower effective throughput.
 */
async function multiRequestMeasure(baseUrl, chunkBytes, chunkCount, agentOpts) {
  let totalBytes = 0;
  let successCount = 0;
  const overallStart = Date.now();

  for (let i = 0; i < chunkCount; i++) {
    try {
      const r = await freshDownload(baseUrl, chunkBytes, agentOpts);
      totalBytes += r.bytes;
      successCount++;
    } catch {
      // Allow partial success — report based on successful chunks
      if (successCount === 0 && i === chunkCount - 1) {
        throw new Error('All chunks failed');
      }
    }
  }

  if (successCount === 0) throw new Error('All chunks failed');

  const totalElapsed = (Date.now() - overallStart) / 1000;
  const mbps = (totalBytes * 8) / totalElapsed / 1_000_000;
  return { mbps: parseFloat(mbps.toFixed(2)), chunks: successCount, totalBytes, seconds: totalElapsed };
}

/**
 * Fallback speed measurement — download a known-size file via HTTPS.
 * Used when Cloudflare is unreachable through a WireGuard tunnel.
 */
async function fallbackMeasure(agentOpts) {
  for (const fb of FALLBACK_URLS) {
    const ip = cachedFallbackIps[fb.host];
    if (!ip) continue;
    try {
      const result = await freshDownload(
        `https://${ip}${fb.path}`,
        fb.size,
        { ...agentOpts, fallbackHost: fb.host }
      );
      const mbps = (result.bytes * 8) / result.seconds / 1_000_000;
      return { mbps: parseFloat(mbps.toFixed(2)), chunks: 1, adaptive: 'fallback', fallbackHost: fb.host };
    } catch {}
    // Also try hostname directly
    try {
      const result = await freshDownload(
        `https://${fb.host}${fb.path}`,
        fb.size,
        agentOpts
      );
      const mbps = (result.bytes * 8) / result.seconds / 1_000_000;
      return { mbps: parseFloat(mbps.toFixed(2)), chunks: 1, adaptive: 'fallback', fallbackHost: fb.host };
    } catch {}
  }
  return null;
}


/**
 * Direct speedtest — used for baseline and WireGuard tunnel testing.
 * All traffic goes through the active network interface (WireGuard tunnel when up).
 * Pre-resolves CF hostname to avoid DNS failures behind WireGuard tunnels.
 *
 * Multi-request approach: 5 × 1MB sequential downloads, each with fresh TCP+TLS.
 * VPN overhead (extra handshake latency per request) creates genuine speed gap.
 */
export async function speedtestDirect() {
  await resolveCfHost();
  await resolveFallbackHosts();

  // Build URL — try IP first (avoids DNS failures behind WireGuard tunnels)
  function cfUrl(bytes) {
    return cachedCfIp
      ? `https://${cachedCfIp}/__down?bytes=${bytes}`
      : `${CF_DOWN}?bytes=${bytes}`;
  }
  function cfUrlHostname(bytes) {
    return `${CF_DOWN}?bytes=${bytes}`;
  }

  // Phase 1: Quick 1MB single probe
  let probe;
  try {
    probe = await freshDownload(cfUrl(PROBE_BYTES), PROBE_BYTES, {});
  } catch {
    // IP failed, try hostname
    try {
      probe = await freshDownload(cfUrlHostname(PROBE_BYTES), PROBE_BYTES, {});
    } catch {
      // Cloudflare unreachable with fresh connections — try fallback targets
      const fb = await fallbackMeasure({});
      if (fb) return fb;
      // Last resort: rescue download with keep-alive agent + 60s timeout
      const rescue = await rescueDownload();
      if (rescue) return rescue;
      throw new Error('Speed test failed (CF and all fallbacks unreachable)');
    }
  }

  const probeMbps = parseFloat(((probe.bytes * 8) / probe.seconds / 1_000_000).toFixed(2));

  // If probe speed is low (< 3 Mbps), don't waste time on full test
  if (probeMbps < 3) {
    return { mbps: probeMbps, chunks: 1, adaptive: 'probe-only' };
  }

  // Phase 2: Multi-request test — 5 × 1MB sequential downloads
  const url = cfUrl(CHUNK_BYTES);
  try {
    const full = await multiRequestMeasure(url, CHUNK_BYTES, CHUNK_COUNT, {});
    return { mbps: full.mbps, chunks: full.chunks, adaptive: 'multi-request' };
  } catch {
    // Try hostname fallback
    try {
      const full = await multiRequestMeasure(cfUrlHostname(CHUNK_BYTES), CHUNK_BYTES, CHUNK_COUNT, {});
      return { mbps: full.mbps, chunks: full.chunks, adaptive: 'multi-request' };
    } catch {
      // Full test failed but probe worked — return probe result
      return { mbps: probeMbps, chunks: 1, adaptive: 'probe-fallback' };
    }
  }
}

/**
 * SOCKS5 speedtest — used for V2Ray tunnel testing.
 * Routes through the SOCKS5 proxy at localhost:proxyPort.
 * Uses axios (not native fetch) because undici ignores the agent option for SOCKS5.
 *
 * IMPORTANT: Creates a fresh SocksProxyAgent per request to avoid connection
 * reuse issues with V2Ray's SOCKS5 handler. Uses arraybuffer mode (not stream)
 * because stream mode causes TLS handshake failures with some SOCKS5 proxies.
 *
 * Multi-request: 5 × 1MB sequential downloads, each with fresh SOCKS5+TCP+TLS.
 */
export async function speedtestViaSocks5(testMb = 5, proxyPort = 1080) {
  // Fresh agent per request — V2Ray SOCKS5 can fail with connection reuse
  function makeAgent() {
    return new SocksProxyAgent(`socks5://127.0.0.1:${proxyPort}`);
  }

  async function measure(url, bytes, timeoutMs = 30_000) {
    const agent = makeAgent();
    try {
      const start = Date.now();
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        httpAgent: agent,
        httpsAgent: agent,
      });
      const downloaded = res.data.byteLength;
      const elapsed = (Date.now() - start) / 1000;
      if (elapsed <= 0 || downloaded === 0) throw new Error('No data received');
      return { bytes: downloaded, seconds: elapsed };
    } finally {
      agent.destroy();
    }
  }

  // Phase 0: Quick connectivity check — verify the SOCKS5 tunnel can reach the internet at all.
  // Without this, nodes with working tunnels get marked as failures just because speedtest
  // targets (CF, OVH, Tele2) are blocked by the node's ISP/firewall.
  //
  // Retry once: V2Ray SOCKS5 binding is async and variable. Even after waiting for the port
  // to accept TCP connections, the proxy pipeline may not be fully ready. A single retry
  // after a 3s pause catches slow-starting nodes that would otherwise be false failures.
  const CONNECTIVITY_TARGETS = [
    'https://www.google.com',
    'https://www.cloudflare.com',
    'https://one.one.one.one',
  ];
  let tunnelConnected = false;
  for (let attempt = 0; attempt < 2 && !tunnelConnected; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
    for (const target of CONNECTIVITY_TARGETS) {
      const agent = makeAgent();
      try {
        await axios.get(target, { timeout: 10_000, httpAgent: agent, httpsAgent: agent, maxRedirects: 2, validateStatus: () => true });
        tunnelConnected = true;
        break;
      } catch {} finally { agent.destroy(); }
    }
  }
  if (!tunnelConnected) {
    throw new Error('SOCKS5 tunnel has no internet connectivity (google/cloudflare/1.1.1.1 all unreachable after 2 attempts)');
  }

  // Phase 1: 1MB single probe — try CF first, then fallback targets, then rescue with 60s timeout
  let probe;
  let probeSource = 'cloudflare';
  try {
    probe = await measure(`${CF_DOWN}?bytes=${PROBE_BYTES}`, PROBE_BYTES);
  } catch {
    // CF download failed via SOCKS5 — try fallback download targets
    let fallbackOk = false;
    for (const fb of FALLBACK_URLS) {
      try {
        probe = await measure(`https://${fb.host}${fb.path}`, fb.size);
        probeSource = fb.host;
        fallbackOk = true;
        break;
      } catch {}
    }
    if (!fallbackOk) {
      // Last resort: retry CF with 60s timeout (slow tunnels need more time)
      try {
        probe = await measure(`${CF_DOWN}?bytes=${PROBE_BYTES}`, PROBE_BYTES, 60_000);
      } catch {
        // Tunnel IS connected (phase 0 passed) but all download targets are blocked.
        // Use a timed GET of a known page as rough speed estimate instead of giving up.
        const agent = makeAgent();
        try {
          const start = Date.now();
          const res = await axios.get('https://www.google.com', {
            responseType: 'arraybuffer', timeout: 15_000,
            httpAgent: agent, httpsAgent: agent,
          });
          const bytes = res.data.byteLength;
          const elapsed = (Date.now() - start) / 1000;
          if (bytes > 0 && elapsed > 0) {
            const mbps = parseFloat(((bytes * 8) / elapsed / 1_000_000).toFixed(2));
            return { mbps: Math.max(mbps, 0.1), chunks: 1, adaptive: 'google-fallback' };
          }
        } catch {} finally { agent.destroy(); }
        throw new Error('SOCKS5 speed test failed (CF and all fallbacks unreachable)');
      }
    }
  }

  const probeMbps = parseFloat(((probe.bytes * 8) / probe.seconds / 1_000_000).toFixed(2));

  if (probeMbps < 3) {
    return { mbps: probeMbps, chunks: 1, adaptive: 'probe-only' };
  }

  // Phase 2: Multi-request — 5 × 1MB sequential downloads, each with fresh SOCKS5 agent
  let totalBytes = 0;
  let successCount = 0;
  const overallStart = Date.now();

  for (let i = 0; i < CHUNK_COUNT; i++) {
    try {
      const r = await measure(`${CF_DOWN}?bytes=${CHUNK_BYTES}`, CHUNK_BYTES);
      totalBytes += r.bytes;
      successCount++;
    } catch {
      if (successCount === 0 && i === CHUNK_COUNT - 1) {
        // All failed — return probe
        return { mbps: probeMbps, chunks: 1, adaptive: 'probe-fallback' };
      }
    }
  }

  if (successCount === 0) {
    return { mbps: probeMbps, chunks: 1, adaptive: 'probe-fallback' };
  }

  const totalElapsed = (Date.now() - overallStart) / 1000;
  const mbps = (totalBytes * 8) / totalElapsed / 1_000_000;
  return { mbps: parseFloat(mbps.toFixed(2)), chunks: successCount, adaptive: 'multi-request' };
}

/** Pre-resolve CF hostname so WireGuard DNS issues don't affect speedtests. Call once at startup. */
export { resolveCfHost };

/**
 * Resolve all speedtest target IPs (Cloudflare + fallbacks).
 * Used for WireGuard split tunneling — only these IPs get routed through the tunnel.
 * MUST be called BEFORE installing the tunnel (DNS won't work through a dead tunnel).
 */
export async function resolveSpeedtestIPs() {
  await resolveCfHost();
  await resolveFallbackHosts();
  const ips = [];
  if (cachedCfIp) ips.push(cachedCfIp);
  for (const ip of Object.values(cachedFallbackIps)) {
    if (ip) ips.push(ip);
  }
  return ips;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
