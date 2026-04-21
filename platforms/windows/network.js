/**
 * Sentinel Node Tester — Windows Network Detection
 * Detects VPN interference, checks adapters, DNS, and routes.
 */

import { execSync } from 'child_process';
import dns from 'dns';

// Known Sentinel adapter names (ours — don't flag these)
const SENTINEL_ADAPTERS = ['wgsent0', 'wgsent1', 'sentinel'];

/**
 * Get list of connected VPN adapters that are NOT ours.
 * Uses `netsh interface show interface` to detect active adapters.
 * @returns {string[]} Names of non-Sentinel VPN adapters in Connected state
 */
export function getActiveVpnAdapters() {
  try {
    const output = execSync('netsh interface show interface', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: 'pipe',
    });
    const lines = output.split('\n').filter(l => l.includes('Connected'));
    const vpnAdapters = [];
    for (const line of lines) {
      const name = line.split(/\s{2,}/).pop()?.trim() || '';
      if (!name) continue;
      // Skip known non-VPN adapters
      if (/^(Ethernet|Wi-Fi|WiFi|Local Area|Loopback|vEthernet|Bluetooth)/i.test(name)) continue;
      // Skip our own adapters
      if (SENTINEL_ADAPTERS.some(s => name.toLowerCase().includes(s))) continue;
      // Likely a VPN adapter
      if (/vpn|tap|tun|wg|wireguard|proton|nord|express|mullvad|pia|surfshark|cyber/i.test(name)) {
        vpnAdapters.push(name);
      }
    }
    return vpnAdapters;
  } catch {
    return []; // If command fails, assume no interference
  }
}

/**
 * Check if there's a non-Sentinel default route (0.0.0.0/0) in the routing table.
 * @returns {boolean} True if a suspicious default route exists
 */
export function hasSuspiciousDefaultRoute() {
  try {
    const output = execSync('route print 0.0.0.0', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: 'pipe',
    });
    // Look for 0.0.0.0 routes that go through VPN-like gateways
    const lines = output.split('\n');
    for (const line of lines) {
      if (/0\.0\.0\.0\s+0\.0\.0\.0/.test(line)) {
        // Check if gateway is a typical VPN gateway (10.x.x.1, 172.16-31.x.1)
        const match = line.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/);
        if (match) {
          const gw = match[1];
          // Only flag CGNAT (100.64.0.0/10) and classic VPN client ranges
          // (10.8.x.x WireGuard default, 10.200.200.x, 10.8.0.x). Plain
          // 10.x and 172.16-31.x are legitimate home/corporate LANs — the
          // adapter-name check above is the authoritative VPN signal.
          if (/^(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|10\.(8|200)\.)/.test(gw)) {
            return true;
          }
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Quick DNS resolution check — can we resolve a known domain?
 * @returns {Promise<boolean>}
 */
export async function checkDnsWorking() {
  try {
    await dns.promises.resolve4('cloudflare.com');
    return true;
  } catch {
    try {
      const resolver = new dns.Resolver();
      resolver.setServers(['1.1.1.1', '8.8.8.8']);
      await new Promise((resolve, reject) => {
        resolver.resolve4('cloudflare.com', (err, addresses) => err ? reject(err) : resolve(addresses));
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Full VPN interference detection.
 * Returns null if no interference, or a description string if detected.
 * @returns {Promise<string|null>}
 */
export async function detectVpnInterference() {
  // Check 1: Non-Sentinel VPN adapters
  const vpnAdapters = getActiveVpnAdapters();
  if (vpnAdapters.length > 0) {
    return `Active VPN adapter(s) detected: ${vpnAdapters.join(', ')}`;
  }

  // Check 2: Suspicious default routes
  if (hasSuspiciousDefaultRoute()) {
    return 'Non-standard default route detected (possible VPN tunnel)';
  }

  // Check 3: DNS resolution
  const dnsOk = await checkDnsWorking();
  if (!dnsOk) {
    return 'DNS resolution failing — network may be captured by VPN';
  }

  return null; // No interference detected
}
