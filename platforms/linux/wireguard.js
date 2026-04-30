// Linux WireGuard tunnel management
// Uses wg-quick up/down (requires root/sudo)

import { execSync, execFileSync, spawnSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, statSync } from 'fs';
import path from 'path';
import os from 'os';

// ─── Admin detection ──────────────────────────────────────────────────────────
function checkIsAdmin() {
  try {
    return process.getuid() === 0;
  } catch {
    return false;
  }
}

export const IS_ADMIN = checkIsAdmin();

// ─── WireGuard binary detection ───────────────────────────────────────────────
function findWireGuardExe() {
  const paths = [
    '/usr/bin/wg',
    '/usr/local/bin/wg',
    '/usr/sbin/wg',
    process.env.WIREGUARD_PATH || '',
  ].filter(Boolean);
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  // Probe `wg` directly via PATH — `which` may not exist in minimal containers
  const probe = spawnSync('wg', ['--version'], { stdio: 'ignore' });
  if (!probe.error && (probe.status === 0 || probe.status === 1)) return 'wg';
  return null;
}

function findWgQuick() {
  const paths = [
    '/usr/bin/wg-quick',
    '/usr/local/bin/wg-quick',
    '/usr/sbin/wg-quick',
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  // Probe `wg-quick` directly via PATH — `which` may not exist in minimal containers
  const probe = spawnSync('wg-quick', ['--help'], { stdio: 'ignore' });
  if (!probe.error && (probe.status === 0 || probe.status === 1)) return 'wg-quick';
  return null;
}

export const WG_EXE = findWireGuardExe();
export const WG_QUICK = findWgQuick();
export const WG_AVAILABLE = !!(WG_QUICK || WG_EXE);

let activeTunnelName = null;
let activeTunnelConf = null;
let tunnelInstalledAt = 0;
const TUNNEL_MAX_AGE_MS = 45_000; // 45s max — force-kill if exceeded

// ─── Emergency cleanup (exported for process exit handlers) ──────────────────
/**
 * Force-kill ALL WireGuard tunnels matching "wgsent*".
 * Safe to call multiple times. Does NOT throw.
 * Uses sync APIs only (safe in process exit handlers).
 */
export function emergencyCleanupSync() {
  if (!WG_QUICK) return;
  for (const name of ['wgsent0', activeTunnelName].filter(Boolean)) {
    try {
      execSync(`"${WG_QUICK}" down ${name}`, { timeout: 10_000, stdio: 'pipe' });
    } catch {}
  }
  // Also try to find and remove any lingering wgsent interfaces
  try {
    const links = execSync('ip -o link show', { encoding: 'utf8', timeout: 5000 });
    const matches = links.match(/wgsent\S*/g) || [];
    for (const iface of matches) {
      const cleanName = iface.replace(/:$/, '');
      try { execSync(`"${WG_QUICK}" down ${cleanName}`, { timeout: 5000, stdio: 'pipe' }); } catch {}
      try { execSync(`ip link delete ${cleanName}`, { timeout: 5000, stdio: 'pipe' }); } catch {}
    }
  } catch {}
  activeTunnelName = null;
  activeTunnelConf = null;
  tunnelInstalledAt = 0;
}

/**
 * Check if tunnel has been up too long and force-kill it.
 * Call this periodically (e.g. every 10s) as a watchdog.
 */
export function watchdogCheck() {
  if (!activeTunnelName || tunnelInstalledAt === 0) return false;
  if (Date.now() - tunnelInstalledAt > TUNNEL_MAX_AGE_MS) {
    console.error(`[WG WATCHDOG] Tunnel ${activeTunnelName} exceeded ${TUNNEL_MAX_AGE_MS / 1000}s — force-killing`);
    emergencyCleanupSync();
    return true;
  }
  return false;
}

// ─── Install tunnel ───────────────────────────────────────────────────────────
/**
 * Install and activate a WireGuard tunnel via wg-quick.
 * confPath: absolute path to the .conf file.
 * timeoutMs: max time to wait for wg-quick up (default 30s).
 */
export async function installWgTunnel(confPath, timeoutMs = 30_000) {
  if (!WG_QUICK) {
    throw new Error('WireGuard not found. Install via: sudo apt install wireguard-tools (Debian/Ubuntu) or sudo dnf install wireguard-tools (Fedora)');
  }
  if (!IS_ADMIN) {
    throw new Error('Root required for WireGuard. Run with sudo or as root.');
  }

  const name = path.basename(confPath, '.conf'); // e.g. "wgsent0"

  // Force-stop any leftover tunnel before installing
  try {
    execSync(`"${WG_QUICK}" down ${name}`, { timeout: 10_000, stdio: 'pipe' });
  } catch {}
  await sleep(300);

  // Install the tunnel
  execSync(`"${WG_QUICK}" up "${confPath}"`, { timeout: timeoutMs, stdio: 'pipe' });

  activeTunnelConf = confPath;
  activeTunnelName = name;
  tunnelInstalledAt = Date.now();

  // Verify the interface is actually up
  const verified = await verifyTunnelRunning(name);
  if (!verified) {
    try { execSync(`"${WG_QUICK}" down ${name}`, { timeout: 10_000, stdio: 'pipe' }); } catch {}
    activeTunnelConf = null;
    activeTunnelName = null;
    tunnelInstalledAt = 0;
    throw new Error(
      `WireGuard tunnel '${name}' failed to start — interface not found after wg-quick up. ` +
      `Config path: ${confPath}. Ensure running as root/sudo.`,
    );
  }

  return activeTunnelName;
}

/**
 * Verify a WireGuard tunnel interface is actually up.
 * Checks wg show and ip link for the interface.
 */
async function verifyTunnelRunning(tunnelName, maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      // wg show will list active interfaces
      const out = execSync('wg show', { encoding: 'utf8', timeout: 3000, stdio: 'pipe' });
      if (out.includes(tunnelName)) return true;
    } catch {}
    // Also check via ip link
    try {
      const out = execSync(`ip link show ${tunnelName}`, { encoding: 'utf8', timeout: 3000, stdio: 'pipe' });
      if (out.includes('UP') || out.includes('UNKNOWN')) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

// ─── Uninstall tunnel ─────────────────────────────────────────────────────────
export async function uninstallWgTunnel(tunnelName, timeoutMs = 15_000) {
  const name = tunnelName || activeTunnelName;
  if (!name) return;

  try {
    if (WG_QUICK) {
      // wg-quick down accepts either interface name or conf path
      if (activeTunnelConf && existsSync(activeTunnelConf)) {
        execSync(`"${WG_QUICK}" down "${activeTunnelConf}"`, { timeout: timeoutMs, stdio: 'pipe' });
      } else {
        execSync(`"${WG_QUICK}" down ${name}`, { timeout: timeoutMs, stdio: 'pipe' });
      }
    }
  } catch (err) {
    console.error(`  [WG] Disconnect warning: ${err.message}`);
  }

  // Scrub private key before deletion
  try {
    if (activeTunnelConf && existsSync(activeTunnelConf)) {
      try { const sz = statSync(activeTunnelConf).size; writeFileSync(activeTunnelConf, Buffer.alloc(sz, 0)); } catch {}
      unlinkSync(activeTunnelConf);
    }
  } catch {}
  activeTunnelName = null;
  activeTunnelConf = null;
  tunnelInstalledAt = 0;
}

// ─── Legacy compat (still used by old connectWireGuard callers) ───────────────
export async function connectWireGuard(wgInstance) {
  const tmpDir = path.join(os.tmpdir(), 'sentinel-wg');
  mkdirSync(tmpDir, { recursive: true });
  const confPath = path.join(tmpDir, 'wgsent0.conf');
  wgInstance.writeConfig(confPath);
  return installWgTunnel(confPath);
}

export async function disconnectWireGuard() {
  return uninstallWgTunnel(activeTunnelName);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
