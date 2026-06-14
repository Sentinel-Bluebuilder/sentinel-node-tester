/**
 * Sentinel Node Tester — Windows V2Ray Process Management
 * Extracted from server.js testNode V2Ray section.
 */

import { spawn, execSync, execFileSync } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import net from 'net';
import path from 'path';
import os from 'os';
import { PROJECT_ROOT } from '../../core/constants.js';

// ─── V2Ray Binary Detection ─────────────────────────────────────────────────
const LOCAL_V2RAY_EXE = path.join(PROJECT_ROOT, 'bin', 'v2ray.exe');

export function getV2RayExe() {
  if (existsSync(LOCAL_V2RAY_EXE)) return LOCAL_V2RAY_EXE;
  return 'v2ray.exe';
}

export async function checkV2Ray() {
  if (existsSync(LOCAL_V2RAY_EXE)) return true;
  for (const cmd of ['v2ray version', 'v2ray.exe version']) {
    try { execSync(cmd, { stdio: 'pipe' }); return true; } catch { }
  }
  return false;
}

// ─── V2Ray Config Path ──────────────────────────────────────────────────────
export function getConfigPath() {
  return path.join(os.tmpdir(), 'sentinel-v2ray.json');
}

// ─── Rotating SOCKS port (with availability check) ─────────────────────────
let _socksPort = 10800 + Math.floor(Math.random() * 1000);

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(); resolve(true); });
    srv.listen(port, '127.0.0.1');
  });
}

export async function nextSocksPort() {
  for (let attempts = 0; attempts < 20; attempts++) {
    const port = _socksPort++;
    if (_socksPort > 60000) _socksPort = 10800;
    if (await isPortFree(port)) return port;
  }
  // Fallback — return next port and hope for the best
  return _socksPort++;
}

// ─── Kill V2Ray by PID ──────────────────────────────────────────────────────
export function killV2RayByPid(pid) {
  if (!pid) return;
  // execFileSync (no shell) — injection-safe and can't create a `nul` file.
  try { execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }); } catch { }
}

/** Kill all v2ray.exe processes — use ONLY for pre-test cleanup */
export function killAllV2Ray() {
  try { execFileSync('taskkill', ['/F', '/IM', 'v2ray.exe'], { stdio: 'ignore' }); } catch { }
}

/**
 * Spawn a V2Ray process with the given config.
 * @param {object} v2rayConfig - V2Ray config object
 * @param {object} outbound - The specific outbound to route through
 * @param {number} socksPort - SOCKS5 listening port
 * @returns {{ proc: ChildProcess, cfgPath: string, getStdout: Function, getStderr: Function }}
 */
export async function spawnV2Ray(v2rayConfig, outbound, socksPort) {
  const v2rayExe = getV2RayExe();
  const cfgPath = getConfigPath();

  let attemptApiPort = 10000 + Math.floor(Math.random() * 50000);
  for (let i = 0; i < 10; i++) {
    if (await isPortFree(attemptApiPort)) break;
    attemptApiPort = 10000 + Math.floor(Math.random() * 50000);
  }
  const attemptInbounds = v2rayConfig.inbounds.map(ib =>
    ib.tag === 'api' ? { ...ib, port: attemptApiPort } : ib
  );
  const cfgForAttempt = {
    ...v2rayConfig,
    inbounds: attemptInbounds,
    log: { loglevel: 'debug' },
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [
        { inboundTag: ['api'], outboundTag: 'api', type: 'field' },
        { inboundTag: ['proxy'], outboundTag: outbound.tag, type: 'field' },
      ],
    },
  };
  writeFileSync(cfgPath, JSON.stringify(cfgForAttempt, null, 2));

  const proc = spawn(v2rayExe, ['run', '-config', cfgPath], { stdio: 'pipe', windowsHide: true });
  let stderr = '';
  let stdout = '';
  proc.stderr?.on('data', d => { stderr += d.toString(); });
  proc.stdout?.on('data', d => { stdout += d.toString(); });
  proc.on('error', err => { stderr += `spawn error: ${err.message}`; });

  return {
    proc,
    cfgPath,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

/**
 * Clean up a V2Ray process — kill by proc.kill() then taskkill by PID as backup.
 */
export function cleanupV2Ray(proc) {
  if (!proc) return;
  try { proc.kill(); } catch { }
  if (proc.pid) {
    killV2RayByPid(proc.pid);
  }
}
