// Windows WireGuard tunnel management
// Uses wireguard.exe /installtunnelservice (requires admin OR elevation)

import { execSync, execFileSync, spawnSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Admin detection ──────────────────────────────────────────────────────────
function checkIsAdmin() {
  try {
    execSync('net session', { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export const IS_ADMIN = checkIsAdmin();

// ─── WireGuard binary detection ───────────────────────────────────────────────
const WG_PATHS = [
  'C:\\Program Files\\WireGuard\\wireguard.exe',
  'C:\\Program Files (x86)\\WireGuard\\wireguard.exe',
  process.env.WIREGUARD_PATH || '',
].filter(Boolean);

function findWireGuardExe() {
  for (const p of WG_PATHS) {
    if (existsSync(p)) return p;
  }
  try {
    const result = execSync('where wireguard.exe', { encoding: 'utf8', stdio: 'pipe' }).trim();
    if (result) return result.split('\n')[0].trim();
  } catch {}
  return null;
}

function findWgQuick() {
  try {
    execSync('wg-quick --version', { encoding: 'utf8', stdio: 'pipe' });
    return 'wg-quick';
  } catch {}
  return null;
}

export const WG_EXE   = findWireGuardExe();
export const WG_QUICK = findWgQuick();
export const WG_AVAILABLE = !!(WG_EXE || WG_QUICK);

let activeTunnelName = null;
let activeTunnelConf = null;
let tunnelInstalledAt = 0;  // timestamp when tunnel was installed
const TUNNEL_MAX_AGE_MS = 45_000;  // 45s max — force-kill if exceeded

// ─── Emergency cleanup (exported for process exit handlers) ──────────────────
/**
 * Force-kill ALL WireGuard tunnels matching "wgsent*".
 * Safe to call multiple times. Does NOT throw.
 * Uses sync APIs only (safe in process exit handlers).
 */
export function emergencyCleanupSync() {
  if (!WG_EXE) return;
  // Try uninstalling known tunnel names
  for (const name of ['wgsent0', activeTunnelName].filter(Boolean)) {
    try {
      execFileSync(WG_EXE, ['/uninstalltunnelservice', name], { timeout: 10_000, stdio: 'pipe' });
    } catch {}
  }
  // Also stop any WireGuardTunnel$wgsent* services via sc
  try {
    const services = execSync('sc query type= service state= all', { encoding: 'utf8', timeout: 5000 });
    const matches = services.match(/WireGuardTunnel\$wgsent\S*/g) || [];
    for (const svc of matches) {
      try { execSync(`sc stop "${svc}"`, { timeout: 5000, stdio: 'pipe' }); } catch {}
      try { execSync(`sc delete "${svc}"`, { timeout: 5000, stdio: 'pipe' }); } catch {}
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
    console.error(`[WG WATCHDOG] Tunnel ${activeTunnelName} exceeded ${TUNNEL_MAX_AGE_MS/1000}s — force-killing`);
    emergencyCleanupSync();
    return true;
  }
  return false;
}

// ─── Elevated WireGuard runner ────────────────────────────────────────────────
/**
 * Run a WireGuard command, elevating via PowerShell if not already admin.
 * When already admin: direct execFileSync.
 * When not admin: Start-Process -Verb RunAs -Wait (pops UAC once per call).
 */
function runWgCommand(args, timeoutMs = 30_000) {
  if (!WG_EXE) throw new Error('WireGuard not found');

  if (IS_ADMIN) {
    // Already elevated — run directly
    execFileSync(WG_EXE, args, { timeout: timeoutMs, stdio: 'pipe' });
    return;
  }

  // Not admin — elevate via PowerShell Start-Process -Verb RunAs
  // This pops a one-time UAC dialog per tunnel operation.
  const argStr = args.map(a => `'${a.replace(/'/g, "''")}'`).join(',');
  const ps = `Start-Process -FilePath '${WG_EXE.replace(/'/g, "''")}' -ArgumentList ${argStr} -Verb RunAs -Wait -WindowStyle Hidden`;
  const result = spawnSync('powershell', ['-NoProfile', '-Command', ps], {
    timeout: timeoutMs + 5000,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').trim();
    throw new Error(`WireGuard elevated run failed: ${msg || `exit code ${result.status}`}`);
  }
}

// ─── Install tunnel ───────────────────────────────────────────────────────────
/**
 * Install and activate a WireGuard tunnel.
 * confPath: absolute path to the .conf file.
 * NOTE: activeTunnelName is set ONLY after successful install so that
 * a failed install doesn't cause uninstallWgTunnel to attempt removal of
 * a service that was never registered (avoids "service does not exist" error).
 */
export async function installWgTunnel(confPath) {
  const name = path.basename(confPath, '.conf');  // e.g. "wgsent0"

  if (WG_EXE) {
    // Always force-remove any leftover tunnel with this name before installing
    try { runWgCommand(['/uninstalltunnelservice', name], 10_000); } catch { }
    await sleep(1000);

    // Exponential retry: most peers register within 1-2s. Try at 1.5s, 1.5s, 2s (5s total budget).
    const installDelays = [1500, 1500, 2000];
    let installed = false;
    for (let i = 0; i < installDelays.length; i++) {
      try {
        runWgCommand(['/installtunnelservice', confPath], 30_000);
        installed = true;
        break;
      } catch (installErr) {
        if (i === installDelays.length - 1) throw installErr;
        await sleep(installDelays[i]);
      }
    }
    // Only mark active AFTER successful install
    activeTunnelConf = confPath;
    activeTunnelName = name;
    tunnelInstalledAt = Date.now();
    await sleep(1500); // give tunnel time to establish
    return activeTunnelName;
  } else if (WG_QUICK) {
    execSync(`wg-quick up "${confPath}"`, { timeout: 30_000, stdio: 'inherit' });
    activeTunnelConf = confPath;
    activeTunnelName = name;
    return activeTunnelName;
  } else {
    throw new Error('WireGuard not found. Install from https://download.wireguard.com/windows-client/wireguard-installer.exe');
  }
}

// ─── Uninstall tunnel ─────────────────────────────────────────────────────────
export async function uninstallWgTunnel(tunnelName) {
  const name = tunnelName || activeTunnelName;
  if (!name) return;

  try {
    if (WG_EXE) {
      runWgCommand(['/uninstalltunnelservice', name], 15_000);
    } else if (WG_QUICK && activeTunnelConf) {
      execSync(`wg-quick down "${activeTunnelConf}"`, { timeout: 15_000, stdio: 'pipe' });
    }
  } catch (err) {
    console.error(`  [WG] Disconnect warning: ${err.message}`);
  }

  try { if (activeTunnelConf && existsSync(activeTunnelConf)) unlinkSync(activeTunnelConf); } catch {}
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
