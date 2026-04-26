/**
 * Sentinel Node Tester — Single Node Test
 * Extracted from server.js testNode (~450 lines).
 * Tests a single node (WireGuard or V2Ray) and returns a TestResult.
 */

import { randomUUID } from 'crypto';
import { existsSync, appendFileSync } from 'fs';
import path from 'path';

import { DENOM, GIGS, V3_MSG_TYPE, FAILURE_LOG, ACTIVE_DNS } from '../core/constants.js';
import { queryNodeStatusDirect } from '../core/chain.js';
import { BRIDGE_AVAILABLE, bridgeNodeStatus, bridgeHandshakeWG, bridgeHandshakeV2Ray } from '../core/csharp-bridge.js';
import { TKD_AVAILABLE, tkdNodeStatus, tkdHandshakeWG, tkdHandshakeV2Ray } from '../core/tkd-bridge.js';
import {
  getCredential, saveCredential, clearCredential,
  markSessionPoisoned, isPaid, markPaid, clearPaidNodes,
  addToSessionMap, findExistingSession,
  waitForSessionActive, parseNodePriceUdvpn,
} from '../core/session.js';
import {
  reorderOutbounds, recordTransportSuccess, recordTransportFailure,
  getCachedTransport, saveTransportCache,
} from '../core/transport-cache.js';
import { signAndBroadcastRetry, assertIsDeliverTxSuccess } from '../core/wallet.js';
import {
  nodeStatusV3, generateWgKeyPair, initHandshakeV3, initHandshakeV3V2Ray,
  buildV2RayClientConfig, writeWgConfig, extractSessionId, waitForPort,
} from '../protocol/v3protocol.js';
import { speedtestDirect, speedtestViaSocks5, sleep, resolveSpeedtestIPs, checkGoogleDirect, checkGoogleViaSocks5 } from '../protocol/speedtest.js';
// Platform-aware imports
let installWgTunnel, uninstallWgTunnel, WG_AVAILABLE, emergencyCleanupSync;
let spawnV2Ray, cleanupV2Ray, killAllV2Ray, killV2RayByPid, nextSocksPort;
if (process.platform === 'win32') {
  ({ installWgTunnel, uninstallWgTunnel, WG_AVAILABLE, emergencyCleanupSync } = await import('../platforms/windows/wireguard.js'));
  ({ spawnV2Ray, cleanupV2Ray, killAllV2Ray, killV2RayByPid, nextSocksPort } = await import('../platforms/windows/v2ray.js'));
} else {
  const { spawn: _spawn, execSync: _execSync } = await import('child_process');
  const { writeFileSync: _wfs } = await import('fs');
  const _os = await import('os');
  const _path = await import('path');
  WG_AVAILABLE = false;
  emergencyCleanupSync = () => {};
  installWgTunnel = async () => { throw new Error('WireGuard not implemented for ' + process.platform); };
  uninstallWgTunnel = async () => {};
  let _socksPort = 10800;
  nextSocksPort = async () => _socksPort++;
  spawnV2Ray = async (config, outbound, socksPort) => {
    const cfgPath = _path.join(_os.tmpdir(), 'sentinel-v2ray.json');
    _wfs(cfgPath, JSON.stringify(config, null, 2));
    const proc = _spawn('v2ray', ['run', '-config', cfgPath], { stdio: 'pipe' });
    let stderr = '', stdout = '';
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    proc.stdout?.on('data', d => { stdout += d.toString(); });
    proc.on('error', err => { stderr += `spawn error: ${err.message}`; });
    return { proc, cfgPath, getStdout: () => stdout, getStderr: () => stderr };
  };
  cleanupV2Ray = (proc) => { if (proc) try { proc.kill(); } catch {} };
  killAllV2Ray = () => { try { _execSync('pkill -f v2ray 2>/dev/null', { stdio: 'ignore' }); } catch {} };
  killV2RayByPid = (pid) => { if (pid) try { process.kill(pid); } catch {} };
}
function logFailure(nodeAddr, error, context = {}) {
  const entry = { ts: new Date().toISOString(), node: nodeAddr, error, ...context };
  appendFileSync(FAILURE_LOG, JSON.stringify(entry) + '\n', 'utf8');
}

// Sleep but break out within ~250ms when state.stopRequested flips.
async function stopAwareSleep(ms, state) {
  const tick = 250;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (state?.stopRequested) throw new Error('Stop requested');
    await sleep(Math.min(tick, deadline - Date.now()));
  }
  if (state?.stopRequested) throw new Error('Stop requested');
}

// Race a promise against state.stopRequested polling so long awaits abort fast.
async function withStopGuard(promise, state) {
  let cancelled = false;
  const stopPoll = new Promise((_, reject) => {
    const iv = setInterval(() => {
      if (cancelled) { clearInterval(iv); return; }
      if (state?.stopRequested) { clearInterval(iv); reject(new Error('Stop requested')); }
    }, 250);
  });
  try { return await Promise.race([promise, stopPoll]); }
  finally { cancelled = true; }
}

/**
 * Test a single node. Returns a TestResult or null if fundamentally untestable.
 * With the zero-skip system, null is only returned for truly untestable cases
 * (no WG binary, no V2Ray binary). Everything else throws for retry handling.
 *
 * @param {SigningStargateClient} client
 * @param {Object} account
 * @param {Buffer} privkey
 * @param {import('../core/types.js').ChainNode} node
 * @param {Object} opts
 * @param {BigInt|null} preSessionId - From batch payment
 * @param {Function} broadcast - SSE broadcast function
 * @param {Object} state - Audit state
 * @returns {import('../core/types.js').TestResult|null}
 */
export async function testNode(client, account, privkey, node, opts, preSessionId, broadcast, state) {
  const { testMb, gigabytes, denom, v2rayAvailable, baselineMbps, onlineTimeoutMs = 6_000, nodeStatus = null } = opts;
  const useCSharp = state.activeSDK === 'csharp' && BRIDGE_AVAILABLE;
  const useTkd = state.activeSDK === 'tkd' && TKD_AVAILABLE;

  // ─── Online check (with remote_addrs fallback) ──────────────────────────
  const statusFn = useCSharp ? bridgeNodeStatus : useTkd ? tkdNodeStatus : nodeStatusV3;
  if (useCSharp && broadcast) broadcast('log', { msg: '  [Blue C#]' });
  if (useTkd && broadcast) broadcast('log', { msg: '  [TKD JS]' });
  let status = nodeStatus;
  const altAddrs = (node.remoteAddrs || []).filter(a => a !== node.remoteUrl);
  if (!status) {
    // Try primary address, retry once on failure, then try alternates
    const addrsToTry = [node.remoteUrl, node.remoteUrl, ...altAddrs];
    for (let ai = 0; ai < addrsToTry.length; ai++) {
      const addr = addrsToTry[ai];
      try {
        status = await Promise.race([
          statusFn(addr),
          sleep(onlineTimeoutMs).then(() => { throw new Error('timeout'); }),
        ]);
        if (ai > 0) node.remoteUrl = addr;
        break;
      } catch (err) {
        if (ai === 0) {
          // First try failed — retry same address after 3s (transient)
          if (broadcast) broadcast('log', { msg: `  ⚠ Status failed — retrying in 3s...` });
          await sleep(3_000);
        } else if (ai < addrsToTry.length - 1) {
          if (broadcast) broadcast('log', { msg: `  ⚠ ${addr.slice(0, 30)} failed — trying next...` });
        } else {
          throw new Error(`Node unreachable: ${err.message}`);
        }
      }
    }
  }

  const typeName = status.type === 'wireguard' ? 'WireGuard' : 'V2Ray';
  state.currentType = typeName;
  state.currentLocation = `${status.location.city}, ${status.location.country}`;
  if (broadcast) broadcast('progress', { state });

  if (typeName === 'WireGuard' && !WG_AVAILABLE) return null;
  if (typeName === 'V2Ray' && !v2rayAvailable) return null;

  // ─── Clock drift detection ────────────────────────────────────────────────
  const extremeDrift = typeName === 'V2Ray' && status.clockDriftSec != null && Math.abs(status.clockDriftSec) > 120;
  if (extremeDrift) {
    const dir = status.clockDriftSec > 0 ? 'ahead' : 'behind';
    if (broadcast) broadcast('log', { msg: `⚠ Clock drift ${Math.abs(status.clockDriftSec)}s ${dir} (VMess AEAD tolerance ±120s)` });
  }

  const reportedDownloadMbps = status.bandwidth.download * 8 / 1_000_000;

  // ─── V2Ray port pre-check (before payment — saves tokens) ──────────────
  // Probe common V2Ray ports to detect dead V2Ray daemons before paying.
  // NOTE: Many nodes run V2Ray on the SAME port as their status API (e.g. 6636).
  // We must NOT skip the status port — it's a valid V2Ray port too.
  const serverHost = new URL(node.remoteUrl).hostname;
  if (typeName === 'V2Ray' && !getCredential(node.address)) {
    const statusPort = parseInt(new URL(node.remoteUrl).port, 10) || 0;
    const probePorts = [8686, 8787, 7874, 7876, 443, 8443, 55215, 55216, 9966, 6699, 6636];
    // Include the status port in probe list if not already there
    if (statusPort && !probePorts.includes(statusPort)) probePorts.push(statusPort);
    // Include cached transport port (from previous successful test)
    const cachedTransport = getCachedTransport(node.address);
    if (cachedTransport?.port && !probePorts.includes(cachedTransport.port)) {
      probePorts.unshift(cachedTransport.port); // try cached port first
    }
    let anyOpen = false;
    for (const p of probePorts) {
      if (await waitForPort(p, 2000, serverHost)) { anyOpen = true; break; }
    }
    if (!anyOpen) {
      // IRON RULE: peers > 0 = our bug. If others connect, V2Ray is alive on a port we didn't probe.
      if (status.peers > 0) {
        if (broadcast) broadcast('log', { msg: `  ⚠ No probed ports open on ${serverHost} but node has ${status.peers} peers — proceeding to handshake` });
      } else {
        if (broadcast) broadcast('log', { msg: `  ⚠ No V2Ray ports open on ${serverHost}, 0 peers — V2Ray service likely dead` });
        throw new Error(`V2Ray service dead: no open ports on ${serverHost} (status OK, V2Ray not listening, 0 peers)`);
      }
    }
  }

  // ─── Price check ──────────────────────────────────────────────────────────
  // Pricing mode: 'gigabytes' (default) or 'hours'.
  // In subscription-plan flows the pipeline supplies its own messages — this
  // toggle only affects the P2P MsgStartSession path below.
  const pricingMode = state.pricingMode === 'hours' ? 'hours' : 'gigabytes';
  const gigabytePrice = (node.gigabyte_prices || []).find(p => p.denom === denom);
  const hourlyPrice = (node.hourly_prices || []).find(p => p.denom === denom);

  if (pricingMode === 'hours' && !hourlyPrice) {
    throw new Error('No hourly udvpn pricing available (node has no hourly_prices entry)');
  }
  if (pricingMode === 'gigabytes' && !gigabytePrice) {
    throw new Error('No udvpn pricing available');
  }

  const priceEntry = pricingMode === 'hours' ? hourlyPrice : gigabytePrice;
  const sessionGigabytes = pricingMode === 'hours' ? 0 : gigabytes;
  const sessionHours = pricingMode === 'hours' ? 1 : 0;
  const priceUnits = pricingMode === 'hours' ? sessionHours : sessionGigabytes;

  const nodePriceUdvpn = Math.round(parseFloat(priceEntry.quote_value) || 0);
  const thisCostUdvpn = nodePriceUdvpn * priceUnits;

  if (state.testRun) {
    if (broadcast) broadcast('log', { msg: '  🧪 TEST RUN — skipping payment + handshake + speedtest.' });
    const _reportedDownloadMbps = status.bandwidth.download * 8 / 1_000_000;
    return {
      timestamp: new Date().toISOString(),
      address: node.address,
      type: typeName,
      moniker: status.moniker || '',
      country: status.location.country || '',
      countryCode: status.location.country_code || '',
      city: status.location.city || '',
      reportedDownloadMbps: parseFloat(_reportedDownloadMbps.toFixed(2)),
      actualMbps: null,
      skipped: true,
      error: 'TEST_RUN_SKIP',
      errorCode: 'TEST_RUN_SKIP',
      baselineAtTest: baselineMbps,
      ispBottleneck: false,
      baselineViable: baselineMbps != null && baselineMbps >= 30,
      dynamicThreshold: null,
      slaApplicable: false,
      pass15mbps: false,
      pass10mbps: false,
      passBaseline: false,
      peers: status.peers,
      maxPeers: status.qos?.max_peers,
      gigabytePrices: node.gigabyte_prices || [],
      googleAccessible: null,
      googleLatencyMs: null,
      sdk: state.activeSDK || 'js',
      os: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
      inPlan: (node.planIds || []).length > 0,
      planIds: node.planIds || [],
    };
  }

  // ─── Session resolution ───────────────────────────────────────────────────
  const cached = getCredential(node.address);
  let useCached = false;
  let sessionId = preSessionId || null;

  if (cached) {
    if (broadcast) broadcast('log', { msg: `  ⚡ Cached session ${cached.sessionId} — skipping payment & handshake (FREE)` });
    sessionId = BigInt(cached.sessionId);
    useCached = true;
  }

  // Duplicate payment guard — skip in retest mode (nodes are known-failed, fresh payment expected)
  if (!sessionId && isPaid(node.address) && !state.retestMode) {
    throw new Error('Already paid this run but no session ID — duplicate payment guard');
  }
  if (!sessionId && isPaid(node.address) && state.retestMode) {
    // In retest: clear stale paid flag, allow fresh payment
    clearPaidNodes();
  }

// Balance check — return PAUSE signal instead of failing
  const remainingBalance = Math.max(0, state.balanceUdvpn - state.spentUdvpn);
  const isInPlan = (node.planIds || []).length > 0;
  if (!sessionId && !isInPlan && remainingBalance < thisCostUdvpn + 10_000) {
    const err = new Error('INSUFFICIENT_BALANCE');
    err._pauseAudit = true; // Signal to pipeline: pause, don't fail
    throw err;
  }
  if (remainingBalance < 500_000 && !state.lowBalanceWarning) {
    state.lowBalanceWarning = true;
    if (broadcast) broadcast('log', { msg: `⚠ LOW BALANCE: ${(remainingBalance / 1_000_000).toFixed(4)} P2P` });
  }

  const unitLabel = pricingMode === 'hours' ? `${sessionHours}h` : `${sessionGigabytes}GB`;
  const costLabel = preSessionId ? 'pre-paid' : sessionId ? '0 (reuse)' : `${thisCostUdvpn} udvpn (${unitLabel})`;
  if (broadcast) broadcast('log', {
    msg: `→ ${typeName} | ${status.location.city}, ${status.location.country} | ${reportedDownloadMbps.toFixed(1)} Mbps | Cost: ${costLabel}`,
  });

  // ─── Payment (if needed) ──────────────────────────────────────────────────
  if (sessionId && !preSessionId) {
    if (broadcast) broadcast('log', { msg: `  ♻ Reusing existing session ${sessionId}` });
  } else if (!sessionId) {
    const fee = { amount: [{ denom, amount: '200000' }], gas: '800000' };
    let txResult;
    try {
      txResult = await signAndBroadcastRetry(client, account.address, [{
        typeUrl: V3_MSG_TYPE,
        value: {
          from: account.address, node_address: node.address,
          gigabytes: sessionGigabytes, hours: sessionHours,
          max_price: { denom: priceEntry.denom, base_value: priceEntry.base_value, quote_value: priceEntry.quote_value },
        },
      }], fee, broadcast);
      assertIsDeliverTxSuccess(txResult);
    } catch (txErr) {
      // Code 105: node is inactive on chain despite appearing in active node list (LCD stale)
      // Fresh re-query across multiple LCD endpoints before giving up
      if (/invalid status inactive|Code: 105/i.test(txErr.message)) {
        // Check node's REAL status across all LCD endpoints
        const liveStatus = await queryNodeStatusDirect(node.address);
        if (!liveStatus.active) {
          // Confirmed inactive across multiple LCDs — genuinely deactivated
          throw new Error(`Node genuinely inactive on chain (confirmed across LCDs, peers=${status.peers})`);
        }
        // LCD says active — blockchain lag or RPC endpoint stale. Retry with longer wait.
        if (broadcast) broadcast('log', { msg: `  ⚠ Code 105 but LCD confirms active — blockchain lag. Waiting 20s...` });
        await sleep(20_000);
        try {
          txResult = await signAndBroadcastRetry(client, account.address, [{
            typeUrl: V3_MSG_TYPE,
            value: {
              from: account.address, node_address: node.address,
              gigabytes: sessionGigabytes, hours: sessionHours,
              max_price: { denom: priceEntry.denom, base_value: priceEntry.base_value, quote_value: priceEntry.quote_value },
            },
          }], fee, broadcast);
          assertIsDeliverTxSuccess(txResult);
        } catch (retryErr) {
          // Third attempt after 30s — some RPC endpoints lag significantly
          if (/invalid status inactive|Code: 105/i.test(retryErr.message)) {
            if (broadcast) broadcast('log', { msg: `  ⚠ Still Code 105 — final attempt in 30s...` });
            await sleep(30_000);
            try {
              txResult = await signAndBroadcastRetry(client, account.address, [{
                typeUrl: V3_MSG_TYPE,
                value: {
                  from: account.address, node_address: node.address,
                  gigabytes: sessionGigabytes, hours: sessionHours,
                  max_price: { denom: priceEntry.denom, base_value: priceEntry.base_value, quote_value: priceEntry.quote_value },
                },
              }], fee, broadcast);
              assertIsDeliverTxSuccess(txResult);
            } catch (finalErr) {
              throw new Error(`Node active on LCD but chain rejects payment (blockchain lag, peers=${status.peers}): ${finalErr.message.slice(0, 80)}`);
            }
          } else {
            throw retryErr;
          }
        }
      } else if (/invalid price|code: 106/i.test(txErr.message)) {
        // Chain rejects node's own price in max_price — retry WITHOUT max_price
        if (broadcast) broadcast('log', { msg: `  ⚠ "invalid price" — retrying without max_price constraint...` });
        try {
          txResult = await signAndBroadcastRetry(client, account.address, [{
            typeUrl: V3_MSG_TYPE,
            value: {
              from: account.address, node_address: node.address,
              gigabytes: sessionGigabytes, hours: sessionHours,
            },
          }], fee, broadcast);
          assertIsDeliverTxSuccess(txResult);
        } catch (noPriceErr) {
          throw new Error(`Payment failed even without max_price: ${noPriceErr.message.slice(0, 120)}`);
        }
      } else {
        throw txErr;
      }
    }

    state.spentUdvpn += thisCostUdvpn + 200000;
    state.balance = `${(Math.max(0, state.balanceUdvpn - state.spentUdvpn) / 1_000_000).toFixed(4)} P2P (est. remaining)`;
    state.estimatedTotalCost = `${(state.spentUdvpn / 1_000_000).toFixed(4)} P2P`;
    if (broadcast) broadcast('state', { state });

    sessionId = extractSessionId(txResult);
    if (!sessionId) throw new Error('Could not extract session ID from tx');
    addToSessionMap(node.address, sessionId);
    markPaid(node.address);

    if (broadcast) broadcast('log', { msg: `  Session ${sessionId} — polling for chain confirmation…` });
    await withStopGuard(waitForSessionActive(node.address, account.address, 20_000, sessionId), state);
    // Extra delay: node needs time to index the session into its own DB
    // Without this, handshake races with node indexing → 409 "already exists"
    if (broadcast) broadcast('log', { msg: `  Waiting 5s for node to index session…` });
    await stopAwareSleep(5_000, state);
  }

  // ─── Handshake + Connect ──────────────────────────────────────────────────
  let actualMbps = null;
  const diag = {};
  if (status.clockDriftSec != null) diag.clockDriftSec = status.clockDriftSec;

  // Pay for a fresh session when 409 persists (stale session blocking handshake)
  async function payForFreshSession() {
    if (broadcast) broadcast('log', { msg: `  💳 Paying for FRESH session (old session stale on node)...` });
    const fee = { amount: [{ denom, amount: '200000' }], gas: '800000' };
    let txResult;
    try {
      txResult = await signAndBroadcastRetry(client, account.address, [{
        typeUrl: V3_MSG_TYPE,
        value: {
          from: account.address, node_address: node.address,
          gigabytes: sessionGigabytes, hours: sessionHours,
          max_price: { denom: priceEntry.denom, base_value: priceEntry.base_value, quote_value: priceEntry.quote_value },
        },
      }], fee, broadcast);
      assertIsDeliverTxSuccess(txResult);
    } catch (txErr) {
      if (/invalid price|code: 106/i.test(txErr.message)) {
        if (broadcast) broadcast('log', { msg: `  ⚠ "invalid price" — retrying fresh session without max_price...` });
        txResult = await signAndBroadcastRetry(client, account.address, [{
          typeUrl: V3_MSG_TYPE,
          value: { from: account.address, node_address: node.address, gigabytes: sessionGigabytes, hours: sessionHours },
        }], fee, broadcast);
        assertIsDeliverTxSuccess(txResult);
      } else {
        throw txErr;
      }
    }
    const newId = extractSessionId(txResult);
    if (!newId) throw new Error('Could not extract fresh session ID from tx');
    // Mark old session as poisoned so it won't be reused
    if (sessionId) markSessionPoisoned(node.address, String(sessionId));
    sessionId = newId;
    addToSessionMap(node.address, sessionId);
    state.spentUdvpn += thisCostUdvpn + 200000;
    state.balance = `${(Math.max(0, state.balanceUdvpn - state.spentUdvpn) / 1_000_000).toFixed(4)} P2P (est. remaining)`;
    state.estimatedTotalCost = `${(state.spentUdvpn / 1_000_000).toFixed(4)} P2P`;
    if (broadcast) broadcast('state', { state });
    if (broadcast) broadcast('log', { msg: `  Fresh session ${sessionId} — waiting for chain + node indexing...` });
    await withStopGuard(waitForSessionActive(node.address, account.address, 20_000, sessionId), state);
    await stopAwareSleep(5_000, state);
    return sessionId;
  }

  async function handshakeWithRetry(fn, makeFn) {
    if (state.stopRequested) throw new Error('Stop requested');
    try { return await fn(); } catch (err) {
      if (state.stopRequested) throw new Error('Stop requested');
      // Node database issues — retry once (node may recover, or session needs time to index)
      if (/no such table|database is locked|disk I\/O error|retrieving session|database corrupt/i.test(err.message)) {
        if (broadcast) broadcast('log', { msg: `  ⚠ Node DB issue — waiting 15s then retrying...` });
        await sleep(15_000);
        try { return await fn(); } catch (retryErr) {
          throw new Error(`Node database error (persistent): ${retryErr.message.slice(0, 100)}`);
        }
      }
      // Node address mismatch — try ALL remote_addrs before giving up
      if (/address mismatch/i.test(err.message)) {
        const altAddrs = (node.remoteAddrs || []).filter(a => a !== node.remoteUrl);
        if (altAddrs.length > 0) {
          for (const altAddr of altAddrs) {
            const altUrl = altAddr.startsWith('http') ? altAddr : `https://${altAddr}`;
            if (broadcast) broadcast('log', { msg: `  ⚠ Address mismatch — trying alternate: ${altUrl}` });
            node.remoteUrl = altUrl;
            await sleep(3_000);
            try { return await fn(); } catch (altErr) {
              if (!/address mismatch/i.test(altErr.message)) throw altErr;
            }
          }
        }
        // All remote_addrs tried — still mismatch
        throw new Error(`Node address mismatch (persistent, tried ${1 + altAddrs.length} addrs): ${err.message.slice(0, 120)}`);
      }
      // Node RPC timeout — node can't verify session on its own RPC backend
      if (/ABCI query failed|context deadline exceeded/i.test(err.message)) {
        if (broadcast) broadcast('log', { msg: `  ⚠ Node RPC timeout — waiting 20s then retrying...` });
        await sleep(20_000);
        try { return await fn(); } catch (retryErr) {
          throw new Error(`Node RPC broken after retry: ${retryErr.message.slice(0, 120)}`);
        }
      }
      // Session already exists on node — race between our handshake and node's chain indexing
      // Blue JS throws "already exists", TKD/axios throws "Request failed with status code 409"
      if (/already exists|status code 409/i.test(err.message) || err.response?.status === 409) {
        if (state.retestMode && makeFn) {
          // Retest mode: known 409 nodes — skip waits, go straight to fresh session
          if (broadcast) broadcast('log', { msg: `  ⚠ 409 in retest — paying for fresh session immediately...` });
          try {
            await payForFreshSession();
            return await makeFn(sessionId);
          } catch (freshErr) {
            throw new Error(`409 persistent even after fresh session: ${freshErr.message.slice(0, 120)}`);
          }
        }
        // Normal mode: try waits first (indexing race may resolve)
        if (broadcast) broadcast('log', { msg: `  ⚠ Session exists on node (indexing race) — waiting 15s then retrying...` });
        await sleep(15_000);
        try { return await fn(); } catch (retryErr) {
          if (/already exists|status code 409/i.test(retryErr.message) || retryErr.response?.status === 409) {
            if (broadcast) broadcast('log', { msg: `  ⚠ Still 409 — final retry in 20s...` });
            await sleep(20_000);
            try { return await fn(); } catch (finalErr) {
              if ((/already exists|status code 409/i.test(finalErr.message) || finalErr.response?.status === 409) && makeFn) {
                try {
                  await payForFreshSession();
                  return await makeFn(sessionId);
                } catch (freshErr) {
                  throw new Error(`409 persistent even after fresh session: ${freshErr.message.slice(0, 120)}`);
                }
              }
              throw finalErr;
            }
          }
          throw retryErr;
        }
      }
      if (/does not exist/i.test(err.message)) {
        if (broadcast) broadcast('log', { msg: `  ⏳ Session not yet visible to node — waiting 10s and retrying...` });
        await sleep(10_000);
        return await fn();
      }
      throw err;
    }
  }

  try {
  if (typeName === 'WireGuard') {
    let wgPriv, hs, splitIPs, confPath;
    if (useCached && cached.type === 'wireguard') {
      wgPriv = Buffer.from(cached.wgPrivateKey, 'base64');
      hs = { assignedAddrs: cached.wgAssignedAddrs, serverPubKey: cached.wgServerPubKey, serverEndpoint: cached.wgServerEndpoint };
      splitIPs = await resolveSpeedtestIPs();
      confPath = writeWgConfig(wgPriv, hs.assignedAddrs, hs.serverPubKey, hs.serverEndpoint, splitIPs, { dns: ACTIVE_DNS.join(',') });
    } else if (useCSharp) {
      // C# SDK handshake — bridge generates its own WG keypair
      hs = await handshakeWithRetry(
        () => bridgeHandshakeWG(node.remoteUrl, sessionId),
        (newSid) => bridgeHandshakeWG(node.remoteUrl, newSid),
      );
      wgPriv = hs.clientPrivateKey ? Buffer.from(hs.clientPrivateKey, 'base64') : generateWgKeyPair().privateKey;
      splitIPs = await resolveSpeedtestIPs();
      confPath = writeWgConfig(wgPriv, hs.assignedAddrs, hs.serverPubKey, hs.serverEndpoint, splitIPs, { dns: ACTIVE_DNS.join(',') });
    } else if (useTkd) {
      // TKD SDK handshake — uses @sentinel-official/sentinel-js-sdk handshake() + Wireguard class
      if (broadcast) broadcast('log', { msg: `  [TKD] WireGuard handshake...` });
      hs = await handshakeWithRetry(
        () => tkdHandshakeWG(node.remoteUrl, sessionId),
        (newSid) => tkdHandshakeWG(node.remoteUrl, newSid),
      );
      wgPriv = hs.clientPrivateKey ? Buffer.from(hs.clientPrivateKey, 'base64') : generateWgKeyPair().privateKey;
      splitIPs = await resolveSpeedtestIPs();
      confPath = writeWgConfig(wgPriv, hs.assignedAddrs, hs.serverPubKey, hs.serverEndpoint, splitIPs, { dns: ACTIVE_DNS.join(',') });
    } else {
      const keys = generateWgKeyPair();
      wgPriv = keys.privateKey;
      hs = await handshakeWithRetry(
        () => initHandshakeV3(node.remoteUrl, sessionId, privkey, keys.publicKey),
        (newSid) => initHandshakeV3(node.remoteUrl, newSid, privkey, keys.publicKey),
      );
      splitIPs = await resolveSpeedtestIPs();
      confPath = writeWgConfig(wgPriv, hs.assignedAddrs, hs.serverPubKey, hs.serverEndpoint, splitIPs, { dns: ACTIVE_DNS.join(',') });
    }
    if (broadcast) broadcast('log', { msg: `  WG assigned ${hs.assignedAddrs.join(', ')} → ${hs.serverEndpoint} (split: ${splitIPs.length} IPs)` });

    saveCredential(node.address, {
      type: 'wireguard', sessionId: String(sessionId),
      wgPrivateKey: wgPriv.toString('base64'),
      wgServerPubKey: hs.serverPubKey,
      wgAssignedAddrs: hs.assignedAddrs,
      wgServerEndpoint: hs.serverEndpoint,
      remoteUrl: node.remoteUrl,
    });

    diag.wgAssignedAddrs = hs.assignedAddrs;
    diag.wgServerEndpoint = hs.serverEndpoint;
    diag.wgSplitIPs = splitIPs;
    diag.remoteUrl = node.remoteUrl;
    diag.sessionId = String(sessionId);

    try {
      await installWgTunnel(confPath);
      await sleep(1_000);
      const r = await speedtestDirect();
      actualMbps = r.mbps;
      diag.speedtestMethod = r.adaptive || 'unknown';
      if (broadcast) broadcast('log', { msg: `  Speed: ${actualMbps} Mbps` });

      // ─── Google accessibility check (informational — don't fail on block) ──
      const googleCheck = await checkGoogleDirect(10_000);
      diag.googleAccessible = googleCheck.googleAccessible;
      diag.googleLatencyMs = googleCheck.googleLatencyMs;
      if (googleCheck.googleError) diag.googleError = googleCheck.googleError;
      if (broadcast) broadcast('log', { msg: `  Google: ${googleCheck.googleAccessible ? `✓ reachable (${googleCheck.googleLatencyMs}ms)` : `✗ blocked (node may restrict Google — not a failure)`}` });
    } finally {
      try { await uninstallWgTunnel(); } catch { }
      emergencyCleanupSync();
    }

  } else {
    // ─── V2Ray ────────────────────────────────────────────────────────────
    killAllV2Ray();
    await sleep(1500);

    let uuid, socksPort, hsConfig;
    if (useCached && cached.type === 'v2ray') {
      uuid = cached.uuid;
      socksPort = await nextSocksPort();
      hsConfig = cached.v2rayConfig;
      if (broadcast) broadcast('log', { msg: `  V2Ray cached UUID: ${uuid} (SOCKS:${socksPort})` });
      await sleep(2_000);
    } else if (useCSharp) {
      // C# SDK handshake — bridge generates UUID internally
      socksPort = await nextSocksPort();
      const hs = await handshakeWithRetry(
        () => bridgeHandshakeV2Ray(node.remoteUrl, sessionId),
        (newSid) => bridgeHandshakeV2Ray(node.remoteUrl, newSid),
      );
      uuid = hs.uuid || randomUUID();
      hsConfig = hs.config;
      if (broadcast) broadcast('log', { msg: `  [C#] Handshake OK — UUID: ${uuid} (SOCKS:${socksPort})` });
    } else if (useTkd) {
      // TKD SDK handshake — uses @sentinel-official/sentinel-js-sdk handshake() + V2Ray class
      socksPort = await nextSocksPort();
      if (broadcast) broadcast('log', { msg: `  [TKD] V2Ray handshake...` });
      const hs = await handshakeWithRetry(
        () => tkdHandshakeV2Ray(node.remoteUrl, sessionId),
        (newSid) => tkdHandshakeV2Ray(node.remoteUrl, newSid),
      );
      uuid = hs.uuid || randomUUID();
      hsConfig = hs.config;
      if (broadcast) broadcast('log', { msg: `  [TKD] Handshake OK — UUID: ${uuid} (SOCKS:${socksPort})` });

      saveCredential(node.address, {
        type: 'v2ray', sessionId: String(sessionId),
        uuid, v2rayConfig: hsConfig,
        remoteUrl: node.remoteUrl, socksPort,
      });

      if (broadcast) broadcast('log', { msg: `  Waiting 10s for node to register UUID...` });
      await sleep(10_000);
    } else {
      uuid = randomUUID();
      socksPort = await nextSocksPort();
      if (broadcast) broadcast('log', { msg: `  V2Ray UUID: ${uuid} (SOCKS:${socksPort})` });

      const hs = await handshakeWithRetry(
        () => initHandshakeV3V2Ray(node.remoteUrl, sessionId, privkey, uuid),
        (newSid) => initHandshakeV3V2Ray(node.remoteUrl, newSid, privkey, uuid),
      );
      hsConfig = hs.config;
      if (broadcast) broadcast('log', { msg: `  Handshake OK — config: ${hsConfig.substring(0, 120)}...` });

      saveCredential(node.address, {
        type: 'v2ray', sessionId: String(sessionId),
        uuid, v2rayConfig: hsConfig,
        remoteUrl: node.remoteUrl, socksPort,
      });

      if (broadcast) broadcast('log', { msg: `  Waiting 10s for node to register UUID...` });
      await sleep(10_000);
    }

    const v2rayConfig = buildV2RayClientConfig(serverHost, hsConfig, uuid, socksPort, { clockDriftSec: status.clockDriftSec || 0, dns: ACTIVE_DNS.join(',') });
    const allMeta = JSON.parse(hsConfig).metadata || [];

    // Log alterId for drift debugging
    const firstUser = v2rayConfig.outbounds?.[0]?.settings?.vnext?.[0]?.users?.[0];
    if (firstUser && extremeDrift) {
      if (broadcast) broadcast('log', { msg: `  alterId=${firstUser.alterId} (drift: ${status.clockDriftSec}s, ${firstUser.alterId > 0 ? 'LEGACY' : 'AEAD'})` });
    }

    // Post-handshake viability checks — clock drift kills VMess AEAD
    if (extremeDrift) {
      const hasVless = allMeta.some(m => m.proxy_protocol === 1);
      if (hasVless) {
        // Strip VMess outbounds — VLess doesn't use clock-sensitive AEAD
        if (broadcast) broadcast('log', { msg: `  VLess only — stripping VMess (${Math.abs(status.clockDriftSec)}s drift kills AEAD)` });
        v2rayConfig.outbounds = v2rayConfig.outbounds.filter(o => o.protocol === 'vless');
      } else {
        // VMess-only + drift — try anyway. HTTP Date header may not reflect V2Ray clock.
        // Iron Rule: peers > 0 = our bug. Don't pre-reject.
        if (broadcast) broadcast('log', { msg: `  ⚠ VMess-only + ${Math.abs(status.clockDriftSec)}s drift — trying anyway (${status.peers} peers connected)` });
        diag.clockDriftWarning = true;
      }
    }

    // Strip unreliable transports: quic rarely works, mkcp is flaky
    const reliableOutbounds = v2rayConfig.outbounds.filter(o => {
      const net = o.streamSettings?.network;
      if (net === 'quic') { if (broadcast) broadcast('log', { msg: `  Skipping QUIC outbound (unreliable)` }); return false; }
      return true;
    });
    if (reliableOutbounds.length > 0) v2rayConfig.outbounds = reliableOutbounds;

    const viableMeta = allMeta.filter(m => m.transport_protocol !== 1);
    if (viableMeta.length === 0 && allMeta.length > 0) {
      if (broadcast) broadcast('log', { msg: `  ⊘ All ${allMeta.length} transport(s) are domainsocket (unusable remotely)` });
      diag.v2rayRawMeta = allMeta;
      diag.remoteUrl = node.remoteUrl;
      throw new Error('All transports are domainsocket (unusable remotely)');
    }

    diag.remoteUrl = node.remoteUrl;
    diag.serverHost = serverHost;
    diag.sessionId = String(sessionId);
    diag.v2rayMetadataCount = allMeta.length;
    diag.v2rayRawMeta = allMeta;
    diag.v2rayUUID = uuid;
    diag.hsConfig = hsConfig?.substring(0, 500);

    // ─── Transport intelligence: reorder outbounds by learned success ──────
    const cachedHit = getCachedTransport(node.address);
    if (cachedHit) {
      if (broadcast) broadcast('log', { msg: `  🧠 Transport cache: ${cachedHit.key} port=${cachedHit.port} (${cachedHit.successCount}× success)` });
    }
    v2rayConfig.outbounds = reorderOutbounds(node.address, v2rayConfig.outbounds);

    const numOutbounds = v2rayConfig.outbounds.length;
    let lastV2Err = null;
    let lastV2RayPid = null;
    const allAttempts = [];

    for (let oi = 0; oi < numOutbounds; oi++) {
      if (state.stopRequested) throw new Error('Stop requested');
      const ob = v2rayConfig.outbounds[oi];
      const protoName = ob.protocol || 'unknown';
      const transportName = ob.streamSettings?.network || 'unknown';
      const securityName = ob.streamSettings?.security || 'none';
      const selectedPort = ob.settings?.vnext?.[0]?.port || 'N/A';
      if (broadcast) broadcast('log', { msg: `  V2Ray [${oi + 1}/${numOutbounds}]: ${serverHost} ${protoName}/${transportName}/${securityName} port=${selectedPort}` });

      diag.v2rayProto = protoName;
      diag.v2rayTransport = transportName;
      diag.v2raySecurity = securityName;
      diag.v2rayPort = selectedPort;

      // TCP port probe — log warning but DON'T skip. Let V2Ray try anyway.
      // Raw TCP SYN can fail when gRPC/HTTP2 works (firewall, port knocking, etc.)
      let tcpProbeOk = true;
      if (['tcp', 'websocket', 'grpc', 'gun', 'http'].includes(transportName)) {
        tcpProbeOk = await waitForPort(selectedPort, 8000, serverHost);
        if (!tcpProbeOk) {
          if (broadcast) broadcast('log', { msg: `  ⚠ Port ${selectedPort} TCP probe failed — trying V2Ray anyway...` });
        }
      }

      // Kill previous v2ray — wait for port release on Windows
      if (lastV2RayPid) {
        killV2RayByPid(lastV2RayPid);
        lastV2RayPid = null;
      } else if (oi === 0) {
        killAllV2Ray();
      }
      await sleep(oi > 0 ? 4000 : 2000); // Extra wait between outbounds for port release

      const attemptLabel = `[${oi + 1}/${numOutbounds}] ${protoName}/${transportName}/${securityName}:${selectedPort}`;

      let proc, getStdout, getStderr;
      try {
        ({ proc, getStdout, getStderr } = await spawnV2Ray(v2rayConfig, ob, socksPort));
      } catch (spawnErr) {
        // spawn UNKNOWN on Windows: binary locked by antivirus, handle exhaustion, etc.
        // Retry once after a short delay
        if (broadcast) broadcast('log', { msg: `  ⚠ V2Ray spawn failed (${spawnErr.message}) — retrying in 3s...` });
        await sleep(3000);
        try {
          ({ proc, getStdout, getStderr } = await spawnV2Ray(v2rayConfig, ob, socksPort));
        } catch (spawnErr2) {
          allAttempts.push({ label: attemptLabel, result: 'FAIL', error: `spawn failed: ${spawnErr2.message}`, stdout: '', stderr: '' });
          lastV2Err = spawnErr2;
          if (broadcast) broadcast('log', { msg: `  ✗ V2Ray spawn retry failed: ${spawnErr2.message}` });
          continue;
        }
      }
      lastV2RayPid = proc.pid;

      try {
        // When TCP probe already failed, use shorter SOCKS5 timeout (5s vs 12/8s)
        // to fail faster and move to next outbound — saves ~15s per unreachable port
        const socksTimeout = tcpProbeOk ? (oi === 0 ? 12_000 : 8_000) : 5_000;
        const portReady = await waitForPort(socksPort, socksTimeout);
        if (!portReady || proc.exitCode !== null) {
          throw new Error(`v2ray ${proc.exitCode !== null ? `exited prematurely (code ${proc.exitCode}): ${getStderr().trim().slice(0, 500)}` : 'SOCKS5 port not ready after timeout'}`);
        }
        await sleep(2000);

        // Quick connectivity pre-check (3s) — detect dead tunnels fast before slow speedtest
        const quickCheck = await checkGoogleViaSocks5(socksPort, 3_000);
        if (!quickCheck.googleAccessible) {
          throw new Error(`SOCKS5 tunnel has no internet connectivity (google/cloudflare/1.1.1.1 all unreachable after 3 attempts)`);
        }

        const r = await speedtestViaSocks5(5, socksPort);
        actualMbps = r.mbps;
        diag.speedtestMethod = r.adaptive || 'unknown';

        // ─── Google accessibility check (informational — don't fail on block) ──
        const googleCheck = await checkGoogleViaSocks5(socksPort, 10_000);
        diag.googleAccessible = googleCheck.googleAccessible;
        diag.googleLatencyMs = googleCheck.googleLatencyMs;
        if (googleCheck.googleError) diag.googleError = googleCheck.googleError;
        if (broadcast) broadcast('log', { msg: `  Google: ${googleCheck.googleAccessible ? `✓ reachable (${googleCheck.googleLatencyMs}ms)` : `✗ blocked (node may restrict Google — not a failure)`}` });

        allAttempts.push({ label: attemptLabel, result: 'OK', stdout: getStdout().trim().slice(0, 4000), stderr: getStderr().trim().slice(0, 2000) });
        diag.v2rayAttempts = allAttempts;
        diag.v2rayStdout = allAttempts.map(a => `--- ${a.label} (${a.result}) ---\n${a.stdout}`).join('\n');
        if (broadcast) broadcast('log', { msg: `  V2Ray speed: ${actualMbps} Mbps` });

        // Record winning transport for future scans
        recordTransportSuccess(node.address, { protocol: protoName, network: transportName, security: securityName, port: selectedPort });
        saveTransportCache();
        if (broadcast) broadcast('log', { msg: `  💾 Cached: ${protoName}/${transportName}/${securityName}:${selectedPort}` });

        lastV2Err = null;
        break;
      } catch (v2Err) {
        allAttempts.push({ label: attemptLabel, result: 'FAIL', error: v2Err.message?.slice(0, 200), stdout: getStdout().trim().slice(0, 4000), stderr: getStderr().trim().slice(0, 2000) });
        recordTransportFailure({ protocol: protoName, network: transportName, security: securityName });
        lastV2Err = v2Err;

        // ── Clock drift retry: try alterId=0 (AEAD) if legacy failed ──────
        // VMess legacy (alterId=64) silently fails on AEAD-only servers.
        // Try AEAD (alterId=0): it fails fast with clock drift but might
        // reveal that the transport works (different error = port is OK).
        if (ob._driftRetry && ob.settings?.vnext?.[0]?.users?.[0]?.alterId === 64
            && /no internet|SOCKS5 tunnel/i.test(v2Err.message) && tcpProbeOk) {
          if (broadcast) broadcast('log', { msg: `  🔄 Drift retry: trying alterId=0 (AEAD) on same port...` });
          const aeadOb = JSON.parse(JSON.stringify(ob));
          aeadOb.settings.vnext[0].users[0].alterId = 0;
          aeadOb.tag = ob.tag + '_aead';
          cleanupV2Ray(proc);
          lastV2RayPid = null;
          await sleep(2000);
          const { proc: ap, getStdout: ao, getStderr: ae } = await spawnV2Ray(v2rayConfig, aeadOb, socksPort);
          try {
            const pr = await waitForPort(socksPort, 8_000);
            if (pr && ap.exitCode === null) {
              await sleep(2000);
              const qc = await checkGoogleViaSocks5(socksPort, 5_000);
              if (qc.googleAccessible) {
                const r = await speedtestViaSocks5(5, socksPort);
                actualMbps = r.mbps;
                diag.speedtestMethod = 'aead-drift-retry';
                if (broadcast) broadcast('log', { msg: `  ✓ AEAD worked! ${actualMbps} Mbps (drift ${status.clockDriftSec}s tolerated by server)` });
                recordTransportSuccess(node.address, { protocol: protoName, network: transportName, security: securityName, port: selectedPort });
                saveTransportCache();
                lastV2Err = null;
              }
            }
          } catch (aeadErr) {
            if (broadcast) broadcast('log', { msg: `  AEAD retry also failed: ${aeadErr.message?.slice(0, 60)}` });
          } finally {
            cleanupV2Ray(ap);
          }
          if (!lastV2Err) break; // AEAD worked
        }

        if (oi < numOutbounds - 1) {
          if (broadcast) broadcast('log', { msg: `  Transport ${transportName}/${securityName} failed, trying next...` });
        }
      } finally {
        if (proc && !proc.killed && proc.exitCode === null) cleanupV2Ray(proc);
        lastV2RayPid = null;
      }
    }

    if (lastV2Err) {
      // ─── Fallback: try status port as V2Ray port ───────────────────────
      // Many sentinel-go-sdk nodes serve both status API and V2Ray on the same port.
      // If all metadata ports failed, the status port might be the real V2Ray port.
      const statusPort = parseInt(new URL(node.remoteUrl).port, 10) || 0;
      const triedPorts = new Set(allAttempts.map(a => {
        const m = a.label?.match(/:(\d+)$/);
        return m ? parseInt(m[1], 10) : 0;
      }).filter(Boolean));
      if (statusPort && !triedPorts.has(statusPort) && status.peers > 0) {
        if (broadcast) broadcast('log', { msg: `  🔄 All metadata ports failed — trying status port ${statusPort} as V2Ray fallback (${status.peers} peers connected)` });
        const templateOb = v2rayConfig.outbounds[0];
        if (templateOb) {
          const fbOb = JSON.parse(JSON.stringify(templateOb));
          fbOb.tag = `${serverHost}_${statusPort}_status_fallback`;
          if (fbOb.settings?.vnext?.[0]) fbOb.settings.vnext[0].port = statusPort;

          killAllV2Ray();
          await sleep(3000);
          const { proc: fbProc, getStdout: fbOut, getStderr: fbErr } = await spawnV2Ray(v2rayConfig, fbOb, socksPort);
          try {
            const portReady = await waitForPort(socksPort, 12_000);
            if (portReady && fbProc.exitCode === null) {
              await sleep(2000);
              const r = await speedtestViaSocks5(5, socksPort);
              actualMbps = r.mbps;
              diag.speedtestMethod = r.adaptive || 'status-port-fallback';
              diag.v2rayPort = statusPort;
              diag.statusPortFallback = true;
              if (broadcast) broadcast('log', { msg: `  ✓ Status port ${statusPort} works as V2Ray! ${actualMbps} Mbps` });
              recordTransportSuccess(node.address, { protocol: fbOb.protocol, network: fbOb.streamSettings?.network, security: fbOb.streamSettings?.security || 'none', port: statusPort });
              saveTransportCache();
              lastV2Err = null;
            }
          } catch (fbErr2) {
            if (broadcast) broadcast('log', { msg: `  Status port fallback failed: ${fbErr2.message?.slice(0, 80)}` });
          } finally {
            cleanupV2Ray(fbProc);
          }
        }
      }

      // Check if all failures were port-related (REFUSED/TIMEOUT) — node may have moved V2Ray ports
      const allPortFails = lastV2Err && allAttempts.every(a => a.result === 'FAIL' && /no internet connectivity|speed test failed|SOCKS5|timed out|timeout/i.test(a.error || ''));
      if (allPortFails && status.peers > 0) {
        diag.portScanAttempted = true;
        if (broadcast) broadcast('log', { msg: `  🔍 All transports failed but ${status.peers} peers connected — scanning for V2Ray ports...` });
        // Quick scan: check ports near the metadata ports + common V2Ray ranges
        const metaPorts = new Set(allMeta.map(m => parseInt(m.port, 10)).filter(Boolean));
        const scanPorts = new Set();
        for (const mp of metaPorts) {
          for (let delta = -200; delta <= 200; delta += 2) scanPorts.add(mp + delta);
        }
        // Also scan 7000-9000 range (common V2Ray)
        for (let p = 7000; p <= 9000; p += 2) scanPorts.add(p);
        const openPorts = [];
        const statusPort = parseInt(new URL(node.remoteUrl).port, 10) || 0;
        const batchSize = 100;
        const portsArr = [...scanPorts].filter(p => p > 0 && p < 65536 && p !== statusPort);
        for (let i = 0; i < portsArr.length; i += batchSize) {
          const batch = portsArr.slice(i, i + batchSize);
          await Promise.all(batch.map(p => waitForPort(p, 2000, serverHost).then(open => { if (open) openPorts.push(p); })));
        }
        if (openPorts.length > 0) {
          diag.discoveredPorts = openPorts;
          if (broadcast) broadcast('log', { msg: `  🔍 Found open ports: ${openPorts.join(', ')} — retrying with discovered ports` });

          // Rebuild V2Ray config: clone first outbound's proto/transport, swap port to discovered
          for (const discoveredPort of openPorts) {
            if (state.stopRequested) break;
            const templateOb = v2rayConfig.outbounds[0];
            if (!templateOb) break;
            const newOb = JSON.parse(JSON.stringify(templateOb));
            newOb.tag = `${serverHost}_${discoveredPort}_discovered`;
            if (newOb.settings?.vnext?.[0]) newOb.settings.vnext[0].port = discoveredPort;

            if (broadcast) broadcast('log', { msg: `  🔍 Trying discovered port ${discoveredPort} (${newOb.protocol}/${newOb.streamSettings?.network})` });

            killAllV2Ray();
            await sleep(3000);
            const { proc: dProc, getStdout: dOut, getStderr: dErr } = await spawnV2Ray(v2rayConfig, newOb, socksPort);
            try {
              const portReady = await waitForPort(socksPort, 12_000);
              if (!portReady || dProc.exitCode !== null) { cleanupV2Ray(dProc); continue; }
              await sleep(2000);
              const r = await speedtestViaSocks5(5, socksPort);
              actualMbps = r.mbps;
              diag.speedtestMethod = r.adaptive || 'discovered-port';
              diag.v2rayPort = discoveredPort;
              diag.discoveredPortUsed = discoveredPort;
              if (broadcast) broadcast('log', { msg: `  ✓ Discovered port ${discoveredPort} works! ${actualMbps} Mbps` });
              recordTransportSuccess(node.address, { protocol: newOb.protocol, network: newOb.streamSettings?.network, security: newOb.streamSettings?.security || 'none', port: discoveredPort });
              saveTransportCache();
              lastV2Err = null;
              cleanupV2Ray(dProc);
              break;
            } catch (dErr2) {
              cleanupV2Ray(dProc);
              if (broadcast) broadcast('log', { msg: `  ✗ Discovered port ${discoveredPort} failed: ${dErr2.message?.slice(0, 60)}` });
            }
          }
        }
      }

      // Fallback succeeded — lastV2Err was cleared, skip the throw
      if (!lastV2Err) {
        // A fallback path (status port, discovered port, or AEAD retry) worked
        // actualMbps is already set — continue to speed cap & scoring
      } else {
        if (sessionId) markSessionPoisoned(node.address, String(sessionId));
        clearCredential(node.address);
        diag.v2rayConfig = v2rayConfig;
        diag.v2rayAttempts = allAttempts;
        diag.v2rayStdout = allAttempts.map(a => `--- ${a.label} (${a.result}) ---\n${a.stdout}`).join('\n');
        diag.v2rayStderr = allAttempts.map(a => `--- ${a.label} (${a.result}) ---\n${a.stderr}`).join('\n');
        const err = new Error(lastV2Err.message);
        err.diag = diag;
        throw err;
      }
    }
  }

  // ─── Speed cap & scoring ──────────────────────────────────────────────────
  if (actualMbps != null && baselineMbps != null && actualMbps > baselineMbps) {
    actualMbps = parseFloat((baselineMbps * 0.97).toFixed(2));
  }

  const BASELINE_MIN = 30;
  const dynamicThreshold = baselineMbps != null ? baselineMbps * 0.5 : null;
  const baselineViable = baselineMbps != null && baselineMbps >= BASELINE_MIN;
  const passBaseline = actualMbps != null && dynamicThreshold != null && actualMbps >= dynamicThreshold;
  const ispBottleneck = actualMbps != null && baselineMbps != null && baselineMbps > 0
    && (actualMbps / baselineMbps) >= 0.85;

  return {
    timestamp: new Date().toISOString(),
    address: node.address,
    type: typeName,
    moniker: status.moniker || '',
    country: status.location.country || '',
    countryCode: status.location.country_code || '',
    city: status.location.city || '',
    reportedDownloadMbps: parseFloat(reportedDownloadMbps.toFixed(2)),
    actualMbps,
    baselineAtTest: baselineMbps,
    ispBottleneck,
    baselineViable,
    dynamicThreshold: dynamicThreshold != null ? parseFloat(dynamicThreshold.toFixed(2)) : null,
    slaApplicable: baselineMbps != null && baselineMbps >= 30,
    pass15mbps: actualMbps != null && actualMbps >= 15,
    pass10mbps: actualMbps != null && actualMbps >= 10,
    passBaseline,
    peers: status.peers,
    maxPeers: status.qos?.max_peers,
    gigabytePrices: node.gigabyte_prices || [],
    googleAccessible: diag.googleAccessible ?? null,
    googleLatencyMs: diag.googleLatencyMs ?? null,
    sdk: state.activeSDK || 'js',
    os: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
    inPlan: (node.planIds || []).length > 0,
    planIds: node.planIds || [],
    diag,
  };

  } catch (testErr) {
    if (useCached) clearCredential(node.address);
    if (sessionId && /handshake|already exists|status code 409|proxy.*fail/i.test(testErr.message)) {
      markSessionPoisoned(node.address, String(sessionId));
    }
    logFailure(node.address, testErr.message, {
      type: typeName,
      sessionId: sessionId ? String(sessionId) : null,
      diag,
      location: `${status.location.city}, ${status.location.country}`,
    });
    testErr.diag = diag;
    throw testErr;
  }
}
