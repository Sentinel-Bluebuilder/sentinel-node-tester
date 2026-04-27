/**
 * Sentinel Node Tester — Speed Testing
 * Re-exports SDK speedtest functions + local Google accessibility checks.
 *
 * SDK provides:
 *   - speedtestDirect / speedtestViaSocks5 (6-level fallback chain)
 *   - resolveSpeedtestIPs / resolveCfHost (DNS pre-resolution)
 *   - flushSpeedTestDnsCache (between connections)
 *   - compareSpeedTests, SPEEDTEST_DEFAULTS
 */

import https from 'https';
import dns from 'dns';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import {
  sleep as sdkSleep,
  speedtestDirect,
  speedtestViaSocks5,
  resolveSpeedtestIPs,
  flushSpeedTestDnsCache,
  compareSpeedTests,
  SPEEDTEST_DEFAULTS,
} from 'blue-js-sdk';

// Re-export SDK functions
export { speedtestDirect, speedtestViaSocks5, resolveSpeedtestIPs, flushSpeedTestDnsCache, compareSpeedTests, SPEEDTEST_DEFAULTS };

// resolveCfHost: delegates to SDK's DNS resolution
export function resolveCfHost() { return resolveSpeedtestIPs().then(ips => ips?.[0] || null).catch(() => null); }

// Re-export sleep
export const sleep = sdkSleep;

// ─── Google Accessibility Check (Node Tester-specific) ──────────────────────

const GOOGLE_HOST = 'www.google.com';
const DNS_CACHE_TTL = 5 * 60_000;
let cachedGoogleIp = null;
let cachedGoogleTime = 0;

async function resolveGoogleIp() {
  if (cachedGoogleIp && Date.now() - cachedGoogleTime < DNS_CACHE_TTL) return cachedGoogleIp;
  try {
    const resolver = new dns.Resolver();
    resolver.setServers(['8.8.8.8', '1.1.1.1']);
    const addrs = await new Promise((resolve, reject) => {
      resolver.resolve4(GOOGLE_HOST, (err, addresses) => err ? reject(err) : resolve(addresses));
    });
    if (addrs.length > 0) { cachedGoogleIp = addrs[0]; cachedGoogleTime = Date.now(); return cachedGoogleIp; }
  } catch { }
  try {
    const addrs = await dns.promises.resolve4(GOOGLE_HOST);
    if (addrs.length > 0) { cachedGoogleIp = addrs[0]; cachedGoogleTime = Date.now(); return cachedGoogleIp; }
  } catch { }
  try {
    const { address } = await dns.promises.lookup(GOOGLE_HOST);
    cachedGoogleIp = address;
    cachedGoogleTime = Date.now();
    return cachedGoogleIp;
  } catch { }
  return null;
}

/**
 * Check if google.com is reachable through the active WireGuard tunnel (direct).
 * Uses IP-based request with Host header to avoid DNS issues behind tunnel.
 */
export async function checkGoogleDirect(timeoutMs = 10_000) {
  const start = Date.now();
  const targetIp = await resolveGoogleIp();
  const targets = [];
  if (targetIp) targets.push(`https://${targetIp}/`);
  targets.push(`https://${GOOGLE_HOST}/`);

  for (const url of targets) {
    try {
      await new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
          hostname: parsed.hostname,
          path: '/',
          method: 'GET',
          rejectUnauthorized: false,
          agent: false,
          headers: { Host: GOOGLE_HOST },
          servername: GOOGLE_HOST,
        };
        const req = https.get(options, (res) => {
          res.destroy();
          resolve();
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return {
        googleAccessible: true,
        googleLatencyMs: Date.now() - start,
        googleError: null,
      };
    } catch { }
  }

  return {
    googleAccessible: false,
    googleLatencyMs: null,
    googleError: 'Google unreachable through WireGuard tunnel',
  };
}

/**
 * Check if google.com is reachable through a V2Ray SOCKS5 proxy.
 * Uses axios with SocksProxyAgent (same pattern as speedtest).
 */
export async function checkGoogleViaSocks5(proxyPort, timeoutMs = 10_000) {
  const start = Date.now();
  const agent = new SocksProxyAgent(`socks5://127.0.0.1:${proxyPort}`);
  try {
    await axios.get(`https://${GOOGLE_HOST}/`, {
      timeout: timeoutMs,
      httpAgent: agent,
      httpsAgent: agent,
      maxRedirects: 2,
      validateStatus: () => true,
    });
    return {
      googleAccessible: true,
      googleLatencyMs: Date.now() - start,
      googleError: null,
    };
  } catch (err) {
    return {
      googleAccessible: false,
      googleLatencyMs: null,
      googleError: err.message || 'Google unreachable through SOCKS5',
    };
  } finally {
    agent.destroy();
  }
}
