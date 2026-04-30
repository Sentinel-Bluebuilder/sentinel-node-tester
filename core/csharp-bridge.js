/**
 * C# Bridge Wrapper — calls SentinelBridge.exe and maps output to JS shapes.
 * Used when activeSDK === 'csharp' to test the C# SDK's actual handshake/status code.
 * Payment + tunnel management stay in JS (not SDK-specific).
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MNEMONIC } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the C# bridge per-platform RID. .NET publishes RID-specific binaries
// (e.g. win-x64, linux-x64, osx-arm64). Fallback chain handles arch mismatches.
function _resolveBridgeExe() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(path.join(__dirname, '..', 'csharp-bridge', 'bin', 'Debug', 'net8.0', `win-${arch}`, 'SentinelBridge.exe'));
    candidates.push(path.join(__dirname, '..', 'csharp-bridge', 'bin', 'Debug', 'net8.0', 'win-x64', 'SentinelBridge.exe'));
  } else if (process.platform === 'linux') {
    candidates.push(path.join(__dirname, '..', 'csharp-bridge', 'bin', 'Debug', 'net8.0', `linux-${arch}`, 'SentinelBridge'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(__dirname, '..', 'csharp-bridge', 'bin', 'Debug', 'net8.0', `osx-${arch}`, 'SentinelBridge'));
    candidates.push(path.join(__dirname, '..', 'csharp-bridge', 'bin', 'Debug', 'net8.0', 'osx-x64', 'SentinelBridge'));
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0] || null;
}

const BRIDGE_EXE = _resolveBridgeExe();

export const BRIDGE_AVAILABLE = !!(BRIDGE_EXE && existsSync(BRIDGE_EXE));
if (!BRIDGE_AVAILABLE) {
  console.log('[bridge] C# bridge not built — running in JS-only mode. This is fine for most users.');
}

// ─── Execute bridge command ─────────────────────────────────────────────────

function runBridge(args, timeoutMs = 120_000, extraEnv = null) {
  return new Promise((resolve, reject) => {
    const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
    execFile(BRIDGE_EXE, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (stderr) process.stderr.write(`[bridge] ${stderr}`);
      if (err && !stdout) {
        reject(new Error(`Bridge error: ${err.message}`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        if (!result.success) {
          const msg = result.error || 'Unknown bridge error';
          const code = result.code || '';
          reject(new Error(`${msg}${code ? ` (${code})` : ''}`));
          return;
        }
        resolve(result.data);
      } catch (parseErr) {
        reject(new Error(`Bridge output parse error: ${parseErr.message} — stdout: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

// ─── Node Status (C# SDK) ──────────────────────────────────────────────────

/**
 * Query node status via C# SDK. Returns same shape as JS nodeStatusV3().
 */
export async function bridgeNodeStatus(remoteUrl) {
  const data = await runBridge(['status', remoteUrl], 20_000);
  return {
    type: data.type === 'wireguard' ? 'wireguard' : 'v2ray',
    moniker: data.moniker || '',
    peers: data.peers || 0,
    bandwidth: {
      download: data.bandwidth?.download || 0,
      upload: data.bandwidth?.upload || 0,
    },
    location: {
      city: data.location?.city || '',
      country: data.location?.country || '',
      country_code: data.location?.countryCode || '',
      latitude: data.location?.latitude || 0,
      longitude: data.location?.longitude || 0,
    },
    qos: { max_peers: data.maxPeers || null },
    clockDriftSec: data.clockDriftSec ?? null,
    gigabyte_prices: [],
  };
}

// ─── WireGuard Handshake (C# SDK) ──────────────────────────────────────────

/**
 * Perform WireGuard handshake via C# SDK.
 * Returns same shape as JS initHandshakeV3().
 */
export async function bridgeHandshakeWG(remoteUrl, sessionId) {
  // Mnemonic also exported as env var so the C# bridge (once updated) can
  // prefer it over argv[3] (which is readable via tasklist/Process Hacker/ETW).
  // Argv kept for back-compat with existing built bridge.exe.
  const data = await runBridge(
    ['handshake', remoteUrl, String(sessionId), MNEMONIC, 'wireguard'],
    120_000,
    { SENTINEL_BRIDGE_MNEMONIC: MNEMONIC },
  );
  return {
    assignedAddrs: data.assignedAddresses || [],
    serverPubKey: data.serverPublicKey || '',
    serverEndpoint: data.serverEndpoint || '',
    serverEndpoints: [],
    clientPrivateKey: data.clientPrivateKey || null,
  };
}

// ─── V2Ray Handshake (C# SDK) ──────────────────────────────────────────────

/**
 * Perform V2Ray handshake via C# SDK.
 * Returns { uuid, allEntries } — caller builds V2Ray config from entries.
 */
export async function bridgeHandshakeV2Ray(remoteUrl, sessionId) {
  // See bridgeHandshakeWG for env-var rationale.
  const data = await runBridge(
    ['handshake', remoteUrl, String(sessionId), MNEMONIC, 'v2ray'],
    120_000,
    { SENTINEL_BRIDGE_MNEMONIC: MNEMONIC },
  );
  // Build a fake hsConfig JSON that matches what buildV2RayClientConfig expects
  // C# SDK uses 0-indexed transport_security (0=none, 1=tls)
  // JS/protocol uses 1-indexed (1=none, 2=tls) — remap: C# value + 1
  const rawEntries = data.allEntries || [{
    proxy_protocol: data.proxyProtocol,
    transport_protocol: data.transport,
    transport_security: data.tls,
    port: data.port,
  }];
  const entries = rawEntries.map(e => ({
    ...e,
    transport_security: (e.transport_security ?? 0) + 1,
    port: String(e.port),
  }));
  const fakeConfig = JSON.stringify({ metadata: entries });
  return {
    config: fakeConfig,
    serverEndpoints: [],
    uuid: data.uuid,
  };
}
