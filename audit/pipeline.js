/**
 * Sentinel Node Tester — Audit Pipeline
 * Main audit loop (runAudit), retest (runRetestSkips), plan test (runPlanTest).
 * Zero-skip system: every node ends as PASS or FAIL.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import path from 'path';

import {
  MNEMONIC, DENOM, GIGS, TEST_MB, MAX_NODES, NODE_DELAY,
  RESULTS_DIR, RESULTS_FILE, FAILURE_LOG, BATCH_SIZE, PROJECT_ROOT,
  V3_SUB_TYPE, V3_SUB_SESSION_TYPE,
} from '../core/constants.js';
import { cachedWalletSetup, createFreshClient, signAndBroadcastRetry } from '../core/wallet.js';
import { getAllNodes, fetchPlanMembership, ensureLcd, getActiveLcd } from '../core/chain.js';
import {
  submitBatchPayment, waitForBatchSessions, waitForSessionActive,
  clearPoisonedSessions, clearPaidNodes, clearAllCredentials, invalidateSessionCache, parseNodePriceUdvpn,
} from '../core/session.js';
import { nodeStatusV3 } from '../protocol/v3protocol.js';
import { speedtestDirect, sleep, resolveCfHost } from '../protocol/speedtest.js';
// Platform-aware imports — Windows has full implementation, others get stubs
let WG_AVAILABLE, IS_ADMIN, emergencyCleanupSync, uninstallWgTunnel, checkV2Ray;
if (process.platform === 'win32') {
  ({ WG_AVAILABLE, IS_ADMIN, emergencyCleanupSync, uninstallWgTunnel } = await import('../platforms/windows/wireguard.js'));
  ({ checkV2Ray } = await import('../platforms/windows/v2ray.js'));
} else {
  WG_AVAILABLE = false;
  IS_ADMIN = process.getuid?.() === 0 || false;
  emergencyCleanupSync = () => {};
  uninstallWgTunnel = async () => {};
  checkV2Ray = async () => {
    try { const { execSync } = await import('child_process'); execSync('which v2ray', { stdio: 'pipe' }); return true; } catch { return false; }
  };
}
import { checkAndPauseIfInterference, classifyFailure } from '../protocol/diagnostics.js';
import { loadTransportCache, getCacheStats, saveTransportCache } from '../core/transport-cache.js';
import { testNode } from './node-test.js';
import { testWithRetry } from './retry.js';

// ─── Internet Health Check & Auto-Resume ─────────────────────────────────────
const INTERNET_CHECK_TARGETS = ['https://www.google.com', 'https://1.1.1.1', 'https://www.cloudflare.com'];
const INTERNET_POLL_MS = 15 * 60_000; // 15 minutes

async function checkInternet() {
  for (const url of INTERNET_CHECK_TARGETS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok || res.status < 500) return true;
    } catch {}
  }
  return false;
}

function isInternetError(err) {
  const msg = err?.message || '';
  return /ENETUNREACH|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network|fetch failed|socket hang up/i.test(msg);
}

/**
 * Pause audit when internet is down. Poll every 15 min until it comes back.
 * Returns true when internet restored, false if stop requested.
 */
async function waitForInternet(broadcast, state) {
  state.status = 'paused_internet';
  state.pauseReason = 'Internet down — checking every 15 minutes';
  broadcast('state', { state });
  broadcast('log', { msg: `\n🌐 Internet appears down. Pausing audit. Will check every 15 minutes...` });

  while (!state.stopRequested) {
    await sleep(INTERNET_POLL_MS);
    if (state.stopRequested) return false;
    broadcast('log', { msg: `🌐 Checking internet connectivity...` });
    const online = await checkInternet();
    if (online) {
      broadcast('log', { msg: `🌐 ✓ Internet restored! Resuming audit...` });
      state.status = 'running';
      state.pauseReason = null;
      broadcast('state', { state });
      return true;
    }
    broadcast('log', { msg: `🌐 ✗ Still down. Next check in 15 minutes...` });
  }
  return false;
}

// ─── Results & State (shared across pipeline functions) ─────────────────────
mkdirSync(RESULTS_DIR, { recursive: true });

let results = [];
if (existsSync(RESULTS_FILE)) {
  try { results = JSON.parse(readFileSync(RESULTS_FILE, 'utf8')); } catch { }
}

export function getResults() { return results; }

// ─── Crash-Safe Results Persistence ────────────────────────────────────────
// Write to temp file then rename (atomic on most filesystems).
// Also continuously save to the active run directory so a kill never loses data.
let _activeRunDir = null;

export function setActiveRunDir(dir) { _activeRunDir = dir; }

export function saveResults() {
  const data = JSON.stringify(results, null, 2);
  const tmpFile = RESULTS_FILE + '.tmp';
  writeFileSync(tmpFile, data, 'utf8');
  try { renameSync(tmpFile, RESULTS_FILE); } catch { writeFileSync(RESULTS_FILE, data, 'utf8'); }

  // Also save to the active run directory (crash-safe copy)
  if (_activeRunDir) {
    const runFile = path.join(_activeRunDir, 'results.json');
    const runTmp = runFile + '.tmp';
    try {
      writeFileSync(runTmp, data, 'utf8');
      try { renameSync(runTmp, runFile); } catch { writeFileSync(runFile, data, 'utf8'); }
    } catch { /* run dir may not exist yet */ }
  }
}

export function logFailure(nodeAddr, error, context = {}) {
  const entry = { ts: new Date().toISOString(), node: nodeAddr, error, ...context };
  appendFileSync(FAILURE_LOG, JSON.stringify(entry) + '\n', 'utf8');
}

function upsertResult(result) {
  const idx = results.findIndex(r => r.address === result.address);
  if (idx !== -1) results[idx] = result;
  else results.push(result);
}

/**
 * Create initial state object.
 * Note: 'skippedNodes' is now 'failedNodes' — zero-skip system.
 */
export function createState() {
  return {
    status: 'idle',
    totalNodes: 0,
    testedNodes: 0,
    failedNodes: 0,
    retryCount: 0,
    passed15: 0,
    passed10: 0,
    passedBaseline: 0,
    baselineMbps: null,
    baselineHistory: [],
    nodeSpeedHistory: [],
    currentNode: null,
    currentType: null,
    currentLocation: null,
    walletAddress: null,
    balance: null,
    balanceUdvpn: 0,
    estimatedTotalCost: null,
    spentUdvpn: 0,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    stopRequested: false,
    lowBalanceWarning: false,
    economyMode: false,
    pauseReason: null,
  };
}

/** Recompute state counters from current results */
function recomputeCounters(state) {
  state.testedNodes = results.filter(r => r.actualMbps != null).length;
  state.failedNodes = results.filter(r => r.actualMbps == null).length;
  state.passed15 = results.filter(r => r.baselineAtTest >= 30 && r.actualMbps >= 15).length;
  state.passed10 = results.filter(r => r.actualMbps >= 10).length;
  state.passedBaseline = results.filter(r => {
    const thresh = r.dynamicThreshold != null ? r.dynamicThreshold
      : (r.baselineAtTest != null ? r.baselineAtTest * 0.5 : null);
    return thresh != null && r.actualMbps >= thresh;
  }).length;
}

/** Scan nodes for online status in parallel */
async function scanNodesParallel(nodes, concurrency, broadcast, state) {
  const online = [];
  let idx = 0;
  let scanned = 0;
  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= nodes.length) break;
      const node = nodes[i];
      try {
        const status = await Promise.race([
          nodeStatusV3(node.remoteUrl),
          sleep(6000).then(() => { throw new Error('timeout'); }),
        ]);
        online.push({ node, status });
      } catch { }
      scanned++;
      if (scanned % 100 === 0 || scanned === nodes.length) {
        if (broadcast) broadcast('log', { msg: `  Scanned ${scanned}/${nodes.length} — ${online.length} online` });
        if (broadcast) broadcast('state', { state });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, nodes.length) }, worker));
  return online;
}

/**
 * Build a FAIL result from an error (zero-skip: every failure is explicit).
 */
function buildFailResult(node, status, state, errMsg, diag = {}) {
  const bl = state.baselineMbps;
  // Use diag or previous result data for fields when status is null (retest path)
  const prevResult = results.find(r => r.address === node.address);
  return {
    timestamp: new Date().toISOString(),
    address: node.address,
    type: state.currentType || status?.type || prevResult?.type || 'UNKNOWN',
    moniker: status?.moniker || prevResult?.moniker || '',
    country: status?.location?.country || prevResult?.country || '',
    countryCode: status?.location?.country_code || prevResult?.countryCode || '',
    city: status?.location?.city || prevResult?.city || '',
    reportedDownloadMbps: 0,
    actualMbps: null,
    baselineAtTest: bl ?? null,
    ispBottleneck: false,
    baselineViable: bl != null && bl >= 30,
    dynamicThreshold: bl != null ? parseFloat((bl * 0.5).toFixed(2)) : null,
    slaApplicable: bl != null && bl >= 30,
    pass15mbps: false,
    pass10mbps: false,
    passBaseline: false,
    peers: status?.peers ?? prevResult?.peers ?? null,
    maxPeers: status?.qos?.max_peers ?? prevResult?.maxPeers ?? null,
    gigabytePrices: node.gigabyte_prices || [],
    inPlan: (node.planIds || []).length > 0,
    planIds: node.planIds || [],
    googleAccessible: null,
    googleLatencyMs: null,
    sdk: state.activeSDK || 'js',
    os: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
    error: errMsg,
    timedOut: /timeout/i.test(errMsg),
    diag,
  };
}

// ─── Main Audit ─────────────────────────────────────────────────────────────
export async function runAudit(resume, state, broadcast) {
  state.status = 'running';
  state.startedAt = new Date().toISOString();
  state.errorMessage = null;
  state.retryCount = 0;
  state.retestMode = false;
  state.retestPassed = null;
  state.retestFailed = null;
  clearPoisonedSessions();
  clearPaidNodes();
  clearAllCredentials(); // Wipe stale sessions from previous runs — force fresh payment
  invalidateSessionCache(); // Wipe stale session map — prevents wrong node→session mapping
  broadcast('state', { state });

  // Create audit log file
  const logTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const auditLogPath = path.join(PROJECT_ROOT, 'results', `audit-${logTs}.log`);
  state.auditLogPath = auditLogPath;
  const logLine = (msg) => { try { appendFileSync(auditLogPath, msg + '\n', 'utf8'); } catch {} };
  logLine(`Sentinel Node Tester — Full Audit Log`);
  logLine(`Started: ${state.startedAt} | Resume: ${resume}`);
  logLine(`${'='.repeat(80)}`);

  // Wrap broadcast to also write to log file
  const origBroadcast = broadcast;
  broadcast = (type, data) => {
    origBroadcast(type, data);
    if (type === 'log' && data?.msg) logLine(data.msg);
  };

  broadcast('log', { msg: `📝 Log file: results/audit-${logTs}.log` });
  broadcast('log', { msg: '🔑 Setting up wallet...' });
  const { wallet, account, privkey } = await cachedWalletSetup(MNEMONIC);
  state.walletAddress = account.address;
  broadcast('log', { msg: `Wallet: ${account.address}` });

  const client = await createFreshClient(wallet, broadcast);

  const balRes = await client.getBalance(account.address, DENOM);
  state.balanceUdvpn = parseInt(balRes?.amount || '0', 10);
  state.balance = `${(state.balanceUdvpn / 1_000_000).toFixed(4)} DVPN`;
  state.spentUdvpn = 0;

  if (resume) {
    broadcast('log', { msg: `Resuming audit with ${results.length} existing results...` });
    recomputeCounters(state);
  } else {
    results.length = 0;
    state.testedNodes = 0;
    state.failedNodes = 0;
    state.passed15 = 0;
    state.passed10 = 0;
    state.passedBaseline = 0;
    state.nodeSpeedHistory = [];
    state.baselineHistory = [];
    saveResults();
  }

  broadcast('log', { msg: `Balance: ${state.balance}` });
  broadcast('state', { state });

  const v2rayAvailable = await checkV2Ray();
  broadcast('log', { msg: `V2Ray:     ${v2rayAvailable ? '✓ available' : '✗ not found'}` });
  broadcast('log', { msg: `WireGuard: ${WG_AVAILABLE ? '✓ available' : '✗ not found'}` });
  broadcast('log', { msg: `Admin:     ${IS_ADMIN ? '✓ running as Administrator' : '⚠ NOT admin — use SentinelAudit.vbs for WireGuard'}` });

  // ── Transport intelligence cache ────────────────────────────────────────
  loadTransportCache();
  const cacheStats = getCacheStats();
  if (cacheStats.nodesCached > 0) {
    broadcast('log', { msg: `🧠 Transport cache: ${cacheStats.nodesCached} nodes learned` });
    for (const ts of cacheStats.transportStats.slice(0, 5)) {
      broadcast('log', { msg: `   ${ts.transport}: ${ts.rate} (${ts.successes}/${ts.attempts})` });
    }
  } else {
    broadcast('log', { msg: `🧠 Transport cache: empty — will learn as we go` });
  }

  const cfIp = await resolveCfHost();
  if (cfIp) broadcast('log', { msg: `Cloudflare CDN resolved: ${cfIp} (cached for tunnel tests)` });

  // ── Baseline speed ─────────────────────────────────────────────────────
  broadcast('log', { msg: '📡 Running baseline speed test (direct connection)...' });
  try {
    const baseline = await speedtestDirect();
    state.baselineMbps = baseline.mbps;
    broadcast('log', { msg: `Baseline speed: ${baseline.mbps} Mbps (${baseline.chunks} chunks, ${baseline.adaptive})` });
    broadcast('state', { state });
  } catch (e) {
    broadcast('log', { msg: `Baseline speed test failed: ${e.message}` });
  }

  async function refreshBaseline() {
    try {
      const bl = await speedtestDirect();
      state.baselineMbps = bl.mbps;
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      state.baselineHistory = [...state.baselineHistory, { mbps: bl.mbps, ts }].slice(-10);
      broadcast('state', { state });
    } catch { }
  }

  // ── Phase 1: Fetch node list ───────────────────────────────────────────
  broadcast('log', { msg: '🔍 Fetching node list...' });
  const allNodes = await Promise.race([
    getAllNodes(broadcast),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Node list fetch timeout (60s)')), 60_000)),
  ]);
  const nodesToTest = MAX_NODES > 0 ? allNodes.slice(0, MAX_NODES) : allNodes;
  broadcast('log', { msg: `Fetched ${nodesToTest.length} nodes total.` });
  broadcast('state', { state });

  broadcast('log', { msg: '📋 Checking subscription plan membership...' });
  try {
    await Promise.race([
      fetchPlanMembership(nodesToTest, broadcast),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Plan fetch timeout (30s)')), 30_000)),
    ]);
  } catch (planErr) {
    broadcast('log', { msg: `⚠ Plan membership skipped: ${planErr.message}` });
  }

  // ── Phase 2: Parallel online scan ──────────────────────────────────────
  broadcast('log', { msg: `\n🔍 Phase 2: Scanning ${nodesToTest.length} nodes in parallel (30 concurrent)...` });
  const onlineNodes = await scanNodesParallel(nodesToTest, 30, broadcast, state);
  broadcast('log', { msg: `Scan complete: ${onlineNodes.length}/${nodesToTest.length} online.` });

  const viableNodes = onlineNodes.filter(({ node, status }) => {
    if (status.type === 'wireguard' && !WG_AVAILABLE) return false;
    if (status.type === 'v2ray' && !v2rayAvailable) return false;
    return (node.gigabyte_prices || []).some(p => p.denom === DENOM);
  });

  // Economy mode cap
  if (state.economyMode) {
    const balanceUdvpn = state.balanceUdvpn - state.spentUdvpn;
    const avgPriceUdvpn = 40_000_000;
    const gasPerNode = 200_000;
    const maxAffordable = Math.floor(balanceUdvpn / (avgPriceUdvpn + gasPerNode));
    if (maxAffordable < viableNodes.length) {
      const before = viableNodes.length;
      viableNodes.length = maxAffordable;
      broadcast('log', { msg: `♻ Economy mode: capped to ${maxAffordable}/${before} nodes` });
    }
  }

  // Resume mode: filter already-tested
  if (resume) {
    const testedAddrs = new Set(results.map(r => r.address));
    const before = viableNodes.length;
    const filtered = viableNodes.filter(({ node }) => !testedAddrs.has(node.address));
    viableNodes.length = 0;
    viableNodes.push(...filtered);
    broadcast('log', { msg: `Resume: skipping ${before - viableNodes.length} already-tested, ${viableNodes.length} remaining.` });
  }

  state.totalNodes = (resume ? results.length : 0) + viableNodes.length;
  const estCostUdvpn = viableNodes.reduce(
    (sum, { node }) => sum + parseNodePriceUdvpn(node.gigabyte_prices) * GIGS, 0
  );
  const avgCostPerNode = viableNodes.length > 0 ? estCostUdvpn / viableNodes.length : 0;
  state.estimatedTotalCost = '0.0000 DVPN';
  broadcast('log', { msg: `${viableNodes.length} testable nodes. ~${(avgCostPerNode / 1_000_000).toFixed(4)} DVPN/node avg, ~${(estCostUdvpn / 1_000_000).toFixed(2)} DVPN total est.` });
  broadcast('state', { state });

  if (!IS_ADMIN && WG_AVAILABLE) {
    broadcast('log', { msg: '⚠ NOT running as Administrator — WireGuard nodes will fail!' });
  }

  // ── Phase 3: Batched payment + sequential test ─────────────────────────
  const batches = [];
  for (let i = 0; i < viableNodes.length; i += BATCH_SIZE) {
    batches.push(viableNodes.slice(i, i + BATCH_SIZE));
  }
  broadcast('log', { msg: `\n💳 Phase 3: ${batches.length} payment batches × ${BATCH_SIZE} nodes.` });

  let _lastBalanceRefresh = Date.now();
  const BALANCE_REFRESH_INTERVAL = 5 * 60_000; // Refresh real balance every 5 minutes

  for (let b = 0; b < batches.length; b++) {
    if (state.stopRequested) { broadcast('log', { msg: '⏹ Stop requested.' }); break; }
    const batch = batches[b];

    // Periodic real balance refresh (prevents stale estimate drift)
    if (Date.now() - _lastBalanceRefresh > BALANCE_REFRESH_INTERVAL) {
      try {
        const freshBal = await client.getBalance(account.address, DENOM);
        const realBalance = parseInt(freshBal?.amount || '0', 10);
        state.balanceUdvpn = realBalance;
        state.spentUdvpn = 0; // Reset spent — real balance is the truth
        state.balance = `${(realBalance / 1_000_000).toFixed(4)} DVPN`;
        _lastBalanceRefresh = Date.now();
      } catch { /* non-critical — estimate continues */ }
    }

    // VPN interference check before each batch
    const canProceed = await checkAndPauseIfInterference(broadcast, state);
    if (!canProceed) { broadcast('log', { msg: '⏹ Aborting — VPN interference not cleared.' }); break; }

    let batchSessionMap;
    try {
      broadcast('log', { msg: `\n💳 Batch ${b + 1}/${batches.length} (${batch.length} nodes) — paying...` });
      batchSessionMap = await submitBatchPayment(client, account, DENOM, GIGS, batch, state, broadcast);
    } catch (payErr) {
      // Insufficient funds from chain — pause instead of failing
      if (/insufficient funds|insufficient balance/i.test(payErr.message)) {
        broadcast('log', { msg: `💰 Batch payment failed: insufficient P2P. Pausing...` });
        state.status = 'paused_balance';
        state.pauseReason = `Insufficient P2P for batch payment`;
        broadcast('state', { state });
        let restored = false;
        while (!state.stopRequested) {
          await sleep(5 * 60_000);
          if (state.stopRequested) break;
          try {
            const freshBal = await client.getBalance(account.address, DENOM);
            const realBal = parseInt(freshBal?.amount || '0', 10);
            state.balanceUdvpn = realBal;
            state.spentUdvpn = 0;
            state.balance = `${(realBal / 1_000_000).toFixed(4)} DVPN`;
            broadcast('log', { msg: `💰 Balance check: ${state.balance}` });
            if (realBal > 1_000_000) {
              broadcast('log', { msg: `💰 Balance restored! Retrying batch...` });
              state.status = 'running';
              state.pauseReason = null;
              broadcast('state', { state });
              restored = true;
              break;
            }
          } catch { }
        }
        if (!restored) break;
        // Retry the batch payment
        try {
          batchSessionMap = await submitBatchPayment(client, account, DENOM, GIGS, batch, state, broadcast);
        } catch (retryErr) {
          broadcast('log', { msg: `  Batch retry also failed: ${retryErr.message}` });
          batchSessionMap = new Map();
        }
      } else {
        broadcast('log', { msg: `  Batch payment FAILED: ${payErr.message}` });
        broadcast('log', { msg: `  Falling back to individual payments per node...` });
        batchSessionMap = new Map();
      }
    }

    const reusedAddrs = batchSessionMap._reusedAddrs || new Set();
    const newSessionAddrs = [...batchSessionMap.keys()].filter(a => !reusedAddrs.has(a));
    if (newSessionAddrs.length > 0) {
      broadcast('log', { msg: `  Polling chain for ${newSessionAddrs.length} new sessions...` });
      await waitForBatchSessions(newSessionAddrs, account.address, 20_000);
      broadcast('log', { msg: `  Sessions confirmed ✓` });
    }

    // Test each node with zero-skip retry
    for (let j = 0; j < batch.length; j++) {
      if (state.stopRequested) break;
      const { node, status } = batch[j];
      const sessionId = batchSessionMap.get(node.address) || null;
      const nodeNum = b * BATCH_SIZE + j + 1;

      state.currentNode = node.address;
      broadcast('state', { state });
      broadcast('log', { msg: `[${nodeNum}/${viableNodes.length}] Testing ${node.address.slice(0, 20)}…` });

      await refreshBaseline();

      const { result, retried, error } = await testWithRetry(
        () => testNode(client, account, privkey, node,
          { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps, nodeStatus: status },
          sessionId, broadcast, state
        ),
        broadcast, state, node.address,
      );

      if (result) {
        state.testedNodes++;
        if (result.slaApplicable && result.pass15mbps) state.passed15++;
        if (result.pass10mbps) state.passed10++;
        if (result.passBaseline) state.passedBaseline++;
        upsertResult(result);
        saveResults();
        broadcast('result', { result, state });
        if (result.actualMbps != null) {
          const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
          state.nodeSpeedHistory = [...state.nodeSpeedHistory, { mbps: result.actualMbps, addr: node.address.slice(0, 14), ts }].slice(-10);
          broadcast('state', { state });
        }
        const retryLabel = retried > 0 ? ` (${retried} retries)` : '';
        broadcast('log', { msg: `✓ [${nodeNum}/${viableNodes.length}] ${result.actualMbps != null ? result.actualMbps + ' Mbps' : 'N/A'} | baseline ${state.baselineMbps != null ? state.baselineMbps + ' Mbps' : '--'}${retryLabel}` });
      } else {
        const errMsg = error?.message || 'Unknown error';

        // ─── Stop requested — NOT a failure ────────────────────────────
        // When user pauses/stops, the current node should remain untested
        // so it's first in line on resume. Don't record, don't increment.
        if (error?._stopRequested || errMsg === 'Stop requested') {
          broadcast('log', { msg: `⏸ Node ${node.address.slice(0, 20)}… interrupted — will retry on resume` });
          break;
        }

        // ─── Insufficient balance — PAUSE, don't fail ──────────────────
        // Balance issues are wallet problems, not node problems. Pause the
        // audit and poll for balance top-up. The node stays untested (not failed).
        if (error?._pauseAudit || /INSUFFICIENT_BALANCE|insufficient funds/i.test(errMsg)) {
          broadcast('log', { msg: `💰 Insufficient P2P balance — pausing audit. Top up wallet and balance will be checked every 5 minutes.` });
          state.status = 'paused_balance';
          state.pauseReason = `Insufficient P2P balance (${(Math.max(0, state.balanceUdvpn - state.spentUdvpn) / 1_000_000).toFixed(2)} DVPN remaining)`;
          broadcast('state', { state });

          // Poll for balance top-up every 5 minutes
          let balanceRestored = false;
          while (!state.stopRequested) {
            await sleep(5 * 60_000);
            if (state.stopRequested) break;
            try {
              const freshBal = await client.getBalance(account.address, DENOM);
              const realBalance = parseInt(freshBal?.amount || '0', 10);
              state.balanceUdvpn = realBalance;
              state.spentUdvpn = 0;
              state.balance = `${(realBalance / 1_000_000).toFixed(4)} DVPN`;
              broadcast('log', { msg: `💰 Balance check: ${state.balance}` });
              if (realBalance > 1_000_000) { // > 1 DVPN
                broadcast('log', { msg: `💰 Balance restored! Resuming audit...` });
                state.status = 'running';
                state.pauseReason = null;
                broadcast('state', { state });
                balanceRestored = true;
                break;
              }
            } catch (balErr) {
              broadcast('log', { msg: `💰 Balance check failed: ${balErr.message} — retrying in 5 min` });
            }
          }
          if (!balanceRestored) break; // stopRequested
          // Retry this same node — decrement j so the loop re-tests it
          j--;
          continue;
        }

        // FAIL result — zero-skip: explicit failure
        const failResult = buildFailResult(node, status, state, errMsg, error?.diag || {});
        state.failedNodes++;
        upsertResult(failResult);
        saveResults();
        broadcast('result', { result: failResult, state });
        const retryLabel = retried > 0 ? ` (${retried} retries)` : '';
        const label = /timeout/i.test(errMsg) ? '⏱ Timeout' : /already exists/i.test(errMsg) ? '🚫 Node bug' : 'FAIL';
        broadcast('log', { msg: `${label} [${node.address.slice(0, 20)}…]: ${errMsg}${retryLabel}` });

        // ─── Internet-down detection ───────────────────────────────────
        // If this failure looks like a network issue, check if internet is down.
        // If down, pause the audit and wait for recovery — don't burn through
        // hundreds of nodes while offline (wastes tokens on batch payments).
        if (isInternetError(error) && !state.stopRequested) {
          const online = await checkInternet();
          if (!online) {
            // Mark this node for retest after internet returns
            if (!state._internetFailAddrs) state._internetFailAddrs = new Set();
            state._internetFailAddrs.add(node.address);
            const resumed = await waitForInternet(broadcast, state);
            if (!resumed) break;
          }
        }
      }

      // Cleanup
      try { await uninstallWgTunnel(); } catch { }
      await sleep(500);
      emergencyCleanupSync();
      if (NODE_DELAY > 0) await sleep(NODE_DELAY);
    }
  }

  emergencyCleanupSync();
  saveTransportCache();

  // ─── Auto-retest internet-failure nodes ─────────────────────────────────
  const internetFailAddrs = state._internetFailAddrs;
  if (internetFailAddrs && internetFailAddrs.size > 0 && !state.stopRequested) {
    broadcast('log', { msg: `\n🌐 Retesting ${internetFailAddrs.size} nodes that failed during internet outage...` });
    state.retestMode = true;
    clearPoisonedSessions();
    clearPaidNodes();
    const retestNodes = viableNodes.filter(n => internetFailAddrs.has(n.node.address));

    for (let ri = 0; ri < retestNodes.length; ri++) {
      if (state.stopRequested) break;
      const { node, status } = retestNodes[ri];
      state.currentNode = node.address;
      broadcast('state', { state });
      broadcast('log', { msg: `🌐 [${ri + 1}/${retestNodes.length}] Retesting ${node.address.slice(0, 20)}… (internet-failure recovery)` });

      const { result, retried, error } = await testWithRetry(
        () => testNode(client, account, privkey, node,
          { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps, nodeStatus: status },
          null, broadcast, state
        ),
        broadcast, state, node.address,
      );

      if (error?._stopRequested || error?.message === 'Stop requested') {
        broadcast('log', { msg: `⏸ Internet-recovery retest interrupted — remaining nodes untouched` });
        break;
      }

      if (result) {
        state.failedNodes = Math.max(0, state.failedNodes - 1);
        state.testedNodes++;
        if (result.pass10mbps) state.passed10++;
        upsertResult(result);
        saveResults();
        broadcast('result', { result, state });
        broadcast('log', { msg: `  ✓ Internet-recovery retest PASS: ${result.actualMbps} Mbps` });
      } else {
        const errMsg = error?.message || 'Unknown';
        const failResult = buildFailResult(node, status, state, errMsg, error?.diag || {});
        upsertResult(failResult);
        saveResults();
        broadcast('result', { result: failResult, state });
        broadcast('log', { msg: `  ✗ Internet-recovery retest FAIL: ${errMsg.slice(0, 80)}` });
      }

      try { await uninstallWgTunnel(); } catch { }
      emergencyCleanupSync();
      if (NODE_DELAY > 0) await sleep(NODE_DELAY);
    }
    state.retestMode = false;
    state._internetFailAddrs = null;
  }

  // ─── Auto-retest failures with peers (Iron Rule) ──────────────────────────
  const failedWithPeers = results.filter(r => r.actualMbps == null && r.error && (r.peers ?? 0) > 0);
  if (failedWithPeers.length > 0 && !state.stopRequested) {
    broadcast('log', { msg: `🔄 Auto-retesting ${failedWithPeers.length} failures with peers > 0 (Iron Rule)...` });
    state.retestMode = true;
    clearPoisonedSessions();
    clearPaidNodes();
    const failAddrs = failedWithPeers.map(r => r.address);
    const retestNodes = viableNodes.filter(n => failAddrs.includes(n.node.address));

    for (let ri = 0; ri < retestNodes.length; ri++) {
      if (state.stopRequested) break;
      const { node, status } = retestNodes[ri];
      state.currentNode = node.address;
      broadcast('state', { state });
      broadcast('log', { msg: `🔄 [${ri + 1}/${retestNodes.length}] Retesting ${node.address.slice(0, 20)}…` });

      const { result, retried, error } = await testWithRetry(
        () => testNode(client, account, privkey, node,
          { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps, nodeStatus: status },
          null, broadcast, state
        ),
        broadcast, state, node.address,
      );

      if (error?._stopRequested || error?.message === 'Stop requested') {
        broadcast('log', { msg: `⏸ Iron Rule retest interrupted — remaining nodes untouched` });
        break;
      }

      if (result) {
        state.failedNodes = Math.max(0, state.failedNodes - 1);
        state.testedNodes++;
        if (result.pass10mbps) state.passed10++;
        upsertResult(result);
        saveResults();
        broadcast('result', { result, state });
        broadcast('log', { msg: `  ✓ Retest PASS: ${result.actualMbps} Mbps` });
      } else {
        const errMsg = error?.message || 'Unknown';
        const failResult = buildFailResult(node, status, state, errMsg, error?.diag || {});
        upsertResult(failResult);
        saveResults();
        broadcast('result', { result: failResult, state });
        broadcast('log', { msg: `  ✗ Retest FAIL: ${errMsg.slice(0, 80)}` });
      }

      try { await uninstallWgTunnel(); } catch { }
      emergencyCleanupSync();
      if (NODE_DELAY > 0) await sleep(NODE_DELAY);
    }
    state.retestMode = false;
  }

  const finalCache = getCacheStats();
  state.status = 'done';
  state.completedAt = new Date().toISOString();
  state.currentNode = null;
  broadcast('state', { state });
  const finalFailed = results.filter(r => r.actualMbps == null && r.error).length;
  broadcast('log', { msg: `✅ Audit complete. Tested ${state.testedNodes}, Failed ${finalFailed}. ${state.retryCount} retries total.` });
  broadcast('log', { msg: `🧠 Transport cache: ${finalCache.nodesCached} nodes learned for next scan.` });
}

// ─── Retest Previously-Failed Nodes ─────────────────────────────────────────
export async function runRetestSkips(skipAddrs, state, broadcast) {
  state.status = 'running';
  state.startedAt = new Date().toISOString();
  state.errorMessage = null;
  state.retryCount = 0;
  state.retestMode = true;
  state.retestTotal = skipAddrs.length;
  state.retestTested = 0;
  state.retestPassed = 0;
  state.retestFailed = 0;
  recomputeCounters(state);
  state.totalNodes = state.testedNodes + state.failedNodes; // show grand total
  clearPoisonedSessions();
  clearPaidNodes();
  invalidateSessionCache(); // Force fresh session lookups — prevents stale mappings
  broadcast('state', { state });

  // Create test log file
  const logTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logPath = path.join(PROJECT_ROOT, 'results', `retest-${logTs}.log`);
  const logLine = (msg) => appendFileSync(logPath, msg + '\n', 'utf8');
  logLine(`Sentinel Node Tester — Retest Log`);
  logLine(`Started: ${state.startedAt}`);
  logLine(`Nodes to retest: ${skipAddrs.length}`);
  logLine(`${'='.repeat(80)}`);

  broadcast('log', { msg: `🔄 Retesting ${skipAddrs.length} previously-failed nodes...` });
  broadcast('log', { msg: `📝 Log file: results/retest-${logTs}.log` });

  const { wallet, account, privkey } = await cachedWalletSetup(MNEMONIC);
  state.walletAddress = account.address;
  const client = await createFreshClient(wallet, broadcast);

  const balRes = await client.getBalance(account.address, DENOM);
  state.balanceUdvpn = parseInt(balRes?.amount || '0', 10);
  state.balance = `${(state.balanceUdvpn / 1_000_000).toFixed(4)} DVPN`;
  state.spentUdvpn = 0;
  broadcast('state', { state });

  const v2rayAvailable = await checkV2Ray();
  const cfIp = await resolveCfHost();
  if (cfIp) broadcast('log', { msg: `Cloudflare CDN resolved: ${cfIp}` });

  loadTransportCache();
  const cacheStats = getCacheStats();
  if (cacheStats.nodesCached > 0) {
    broadcast('log', { msg: `🧠 Transport cache: ${cacheStats.nodesCached} nodes learned` });
  }

  broadcast('log', { msg: '📡 Running baseline...' });
  try {
    const bl = await speedtestDirect();
    state.baselineMbps = bl.mbps;
    broadcast('log', { msg: `Baseline: ${bl.mbps} Mbps` });
  } catch (e) { broadcast('log', { msg: `Baseline failed: ${e.message}` }); }

  broadcast('log', { msg: '🔍 Fetching node list...' });
  const allNodes = await getAllNodes(broadcast);

  const skipSet = new Set(skipAddrs);
  const toTest = allNodes.filter(n => skipSet.has(n.address));

  // Direct lookup for nodes not found in paginated list (pagination can miss nodes)
  const foundAddrs = new Set(toTest.map(n => n.address));
  const missingAddrs = skipAddrs.filter(a => !foundAddrs.has(a));
  if (missingAddrs.length > 0) {
    broadcast('log', { msg: `⚠ ${missingAddrs.length} nodes not in paginated list — doing direct lookup...` });
    const activeLcd = getActiveLcd();
    for (const addr of missingAddrs) {
      try {
        const res = await fetch(`${activeLcd}/sentinel/node/v3/nodes/${addr}`, { signal: AbortSignal.timeout(10000) });
        const data = await res.json();
        if (data.node) {
          const rawAddrs = (data.node.remote_addrs || []).filter(Boolean);
          const rawAddr = rawAddrs[0] || '';
          toTest.push({
            address: data.node.address || addr,
            remoteUrl: rawAddr.startsWith('http') ? rawAddr : `https://${rawAddr}`,
            remoteAddrs: rawAddrs.map(a => a.startsWith('http') ? a : `https://${a}`),
            gigabyte_prices: data.node.gigabyte_prices || [],
            hourly_prices: data.node.hourly_prices || [],
            planIds: [],
          });
          broadcast('log', { msg: `  ✓ Found ${addr.slice(0, 20)}… via direct lookup` });
        }
      } catch (e) {
        broadcast('log', { msg: `  ✗ ${addr.slice(0, 20)}… lookup failed: ${e.message?.slice(0, 50)}` });
      }
    }
  }
  broadcast('log', { msg: `Found ${toTest.length}/${skipAddrs.length} nodes to retest.` });

  state.retestTotal = toTest.length;
  state.retestTested = 0;
  state.retestPassed = 0;
  state.retestFailed = 0;
  broadcast('state', { state });

  logLine(`Nodes found on chain: ${toTest.length}/${skipAddrs.length}`);
  logLine(`Baseline: ${state.baselineMbps || '?'} Mbps`);
  logLine(`${'─'.repeat(80)}`);

  for (let i = 0; i < toTest.length; i++) {
    if (state.stopRequested) { broadcast('log', { msg: '⏹ Stop requested.' }); logLine('STOPPED by user'); break; }
    const node = toTest[i];
    const testNum = i + 1;
    state.currentNode = node.address;
    state.retestTested = testNum;
    broadcast('state', { state });
    broadcast('log', { msg: `[#${testNum}/${toTest.length}] Retesting ${node.address.slice(0, 20)}…` });
    logLine(`\n[#${testNum}/${toTest.length}] ${node.address}`);

    const { result, retried, error } = await testWithRetry(
      () => testNode(client, account, privkey, node,
        { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps },
        null, broadcast, state
      ),
      broadcast, state, node.address,
    );

    if (error?._stopRequested || error?.message === 'Stop requested') {
      broadcast('log', { msg: `⏸ Retest interrupted — remaining nodes untouched` });
      logLine(`  STOPPED by user (node not counted as failed)`);
      break;
    }

    if (result && result.actualMbps != null) {
      recomputeCounters(state);
      upsertResult(result);
      saveResults();
      broadcast('result', { result, state });
      state.retestPassed++;
      const sla = result.actualMbps >= 10 ? 'SLA:PASS' : 'SLA:FAIL';
      const googleTag = result.googleAccessible === true ? 'Google:YES' : result.googleAccessible === false ? 'Google:NO' : 'Google:?';
      broadcast('log', { msg: `  ✓ #${testNum} PASS: ${result.actualMbps} Mbps | ${result.type} | ${sla} | ${googleTag}` });
      logLine(`  PASS | ${result.actualMbps} Mbps | ${result.type} | ${result.moniker} | ${result.city}, ${result.country} | ${sla} | ${googleTag}`);
    } else {
      const errMsg = error?.message || result?.error || 'Unknown';
      const failResult = result || buildFailResult(node, null, state, errMsg, error?.diag || {});
      recomputeCounters(state);
      upsertResult(failResult);
      saveResults();
      broadcast('result', { result: failResult, state });
      state.retestFailed++;
      broadcast('log', { msg: `  ✗ #${testNum} FAIL: ${errMsg.slice(0, 80)}` });
      logLine(`  FAIL | ${errMsg.slice(0, 120)}`);
      if (failResult.diag?.v2rayAttempts) {
        for (const a of failResult.diag.v2rayAttempts) {
          logLine(`    attempt: ${a.label} -> ${a.result} ${(a.error || '').slice(0, 80)}`);
        }
      }
    }

    try { await uninstallWgTunnel(); } catch { }
    emergencyCleanupSync();
    if (NODE_DELAY > 0) await sleep(NODE_DELAY);
  }

  emergencyCleanupSync();
  state.status = 'done';
  state.completedAt = new Date().toISOString();
  state.currentNode = null;
  state.retestMode = false;
  recomputeCounters(state);
  broadcast('state', { state });

  const summary = `✅ Retest complete. ${state.retestPassed} now working, ${state.retestFailed} still failing out of ${toTest.length} retested.`;
  broadcast('log', { msg: summary });
  logLine(`\n${'='.repeat(80)}`);
  logLine(summary);
  logLine(`Grand total: ${state.testedNodes} passed, ${state.failedNodes} failed out of ${state.testedNodes + state.failedNodes}`);
  logLine(`Success rate: ${((state.testedNodes / (state.testedNodes + state.failedNodes)) * 100).toFixed(1)}%`);
  logLine(`Completed: ${state.completedAt}`);
}

// ─── Plan Subscription Test ─────────────────────────────────────────────────
export async function runPlanTest(planId, state, broadcast) {
  state.status = 'running';
  state.startedAt = new Date().toISOString();
  state.errorMessage = null;
  state.totalNodes = 0;
  state.testedNodes = 0;
  state.failedNodes = 0;
  state.retryCount = 0;
  recomputeCounters(state);
  clearPoisonedSessions();
  clearPaidNodes();
  broadcast('state', { state });

  broadcast('log', { msg: `📋 Plan ${planId} — subscribing and testing connectivity...` });

  const { wallet, account, privkey } = await cachedWalletSetup(MNEMONIC);
  state.walletAddress = account.address;
  const client = await createFreshClient(wallet, broadcast);

  const balRes = await client.getBalance(account.address, DENOM);
  state.balanceUdvpn = parseInt(balRes?.amount || '0', 10);
  state.balance = `${(state.balanceUdvpn / 1_000_000).toFixed(4)} DVPN`;
  state.spentUdvpn = 0;
  broadcast('state', { state });

  const v2rayAvailable = await checkV2Ray();

  // 1. Check existing subscription before paying
  const fee = { amount: [{ denom: DENOM, amount: '200000' }], gas: '800000' };
  let subscriptionId = null;

  const { hasActiveSubscription } = await import('../core/chain.js');
  const existingSub = await hasActiveSubscription(account.address, planId);
  if (existingSub.has) {
    subscriptionId = existingSub.subscriptionId;
    broadcast('log', { msg: `  ♻ Already subscribed — subscription ${subscriptionId} (FREE)` });
  } else {
    broadcast('log', { msg: `  Subscribing to plan ${planId}...` });
    const subMsg = {
      typeUrl: V3_SUB_TYPE,
      value: { from: account.address, id: BigInt(planId), denom: 'udvpn', renewalPricePolicy: 0 },
    };
  try {
    const subResult = await signAndBroadcastRetry(client, account.address, [subMsg], fee, broadcast);
    if (subResult.code !== 0) {
      throw new Error(`Subscribe tx failed code=${subResult.code}: ${subResult.rawLog}`);
    }
    state.spentUdvpn += 200000;
    for (const event of (subResult.events || [])) {
      if (/subscription/i.test(event.type)) {
        for (const attr of event.attributes) {
          const k = typeof attr.key === 'string' ? attr.key : Buffer.from(attr.key, 'base64').toString('utf8');
          const v = typeof attr.value === 'string' ? attr.value : Buffer.from(attr.value, 'base64').toString('utf8');
          if (k === 'subscription_id' || k === 'id') {
            const parsed = v.replace(/"/g, '');
            if (parsed && parseInt(parsed) > 0) subscriptionId = parsed;
          }
        }
      }
    }
    broadcast('log', { msg: `  ✓ Subscribed — subscription_id=${subscriptionId} tx=${subResult.transactionHash}` });
  } catch (err) {
    broadcast('log', { msg: `  ✗ Subscribe failed: ${err.message}` });
    state.status = 'error';
    state.errorMessage = `Plan subscribe failed: ${err.message}`;
    broadcast('state', { state });
    return;
  }
  } // close else block for hasActiveSubscription

  if (!subscriptionId) {
    state.status = 'error';
    state.errorMessage = 'No subscription_id in tx events';
    broadcast('state', { state });
    return;
  }

  // 2. Fetch plan nodes
  const activeLcd = await ensureLcd();
  broadcast('log', { msg: `  Fetching plan ${planId} nodes...` });
  let planNodes = [];
  try {
    let allPlanNodes = [], pnNextKey = null;
    do {
      let pnUrl = `${activeLcd}/sentinel/node/v3/plans/${planId}/nodes?pagination.limit=200`;
      if (pnNextKey) pnUrl += `&pagination.key=${encodeURIComponent(pnNextKey)}`;
      const nr = await fetch(pnUrl, { signal: AbortSignal.timeout(15000) });
      const nd = await nr.json();
      allPlanNodes.push(...(nd.nodes || []));
      pnNextKey = nd.pagination?.next_key || null;
    } while (pnNextKey);
    planNodes = allPlanNodes.map(n => {
      const rawAddr = (n.remote_addrs || [])[0] || '';
      return {
        address: n.address,
        remoteUrl: rawAddr.startsWith('http') ? rawAddr : `https://${rawAddr}`,
        gigabyte_prices: n.gigabyte_prices || [],
        planIds: [planId],
      };
    });
  } catch (err) {
    state.status = 'error';
    state.errorMessage = err.message;
    broadcast('state', { state });
    return;
  }

  broadcast('log', { msg: `  Found ${planNodes.length} nodes in plan ${planId}` });
  if (planNodes.length === 0) {
    state.status = 'done';
    state.completedAt = new Date().toISOString();
    broadcast('state', { state });
    return;
  }

  // 3. Scan for online nodes
  broadcast('log', { msg: `  Scanning plan nodes for online status...` });
  const onlineNodes = await scanNodesParallel(planNodes, 20, broadcast, state);
  broadcast('log', { msg: `  ${onlineNodes.length}/${planNodes.length} plan nodes are online` });

  if (onlineNodes.length === 0) {
    state.status = 'done';
    state.completedAt = new Date().toISOString();
    broadcast('state', { state });
    return;
  }

  const shuffled = onlineNodes.sort(() => Math.random() - 0.5).slice(0, 5);
  state.totalNodes = shuffled.length;
  broadcast('state', { state });

  broadcast('log', { msg: `📡 Running baseline...` });
  try {
    const bl = await speedtestDirect();
    state.baselineMbps = bl.mbps;
    broadcast('log', { msg: `  Baseline: ${bl.mbps} Mbps` });
  } catch (e) { broadcast('log', { msg: `  Baseline failed: ${e.message}` }); }

  let planPassed = 0, planFailed = 0;

  // 4. Test each node via subscription session
  for (let i = 0; i < shuffled.length; i++) {
    if (state.stopRequested) { broadcast('log', { msg: '⏹ Stop requested.' }); break; }
    const { node, status } = shuffled[i];
    state.currentNode = node.address;
    broadcast('state', { state });
    broadcast('log', { msg: `[${i + 1}/${shuffled.length}] Testing ${node.address.slice(0, 20)}… via plan ${planId}` });

    // Start session via subscription
    let sessionId = null;
    try {
      const sessMsg = {
        typeUrl: V3_SUB_SESSION_TYPE,
        value: { from: account.address, id: BigInt(subscriptionId), nodeAddress: node.address },
      };
      broadcast('log', { msg: `  Starting session on subscription ${subscriptionId}...` });
      const sessResult = await signAndBroadcastRetry(client, account.address, [sessMsg], fee, broadcast);
      if (sessResult.code !== 0) {
        throw new Error(`Session tx failed code=${sessResult.code}: ${sessResult.rawLog}`);
      }
      state.spentUdvpn += 200000;

      for (const event of (sessResult.events || [])) {
        if (/session/i.test(event.type)) {
          for (const attr of event.attributes) {
            const k = typeof attr.key === 'string' ? attr.key : Buffer.from(attr.key, 'base64').toString('utf8');
            const v = typeof attr.value === 'string' ? attr.value : Buffer.from(attr.value, 'base64').toString('utf8');
            if (k === 'session_id' || k === 'id') {
              const parsed = v.replace(/"/g, '');
              if (parsed && parseInt(parsed) > 0) sessionId = parsed;
            }
          }
        }
      }

      if (!sessionId) throw new Error('No session_id in tx events');
      broadcast('log', { msg: `  ✓ Session ${sessionId} via subscription — tx=${sessResult.transactionHash}` });
      await waitForSessionActive(node.address, account.address, 20_000);
    } catch (err) {
      broadcast('log', { msg: `  ✗ Session start failed: ${err.message}` });
      planFailed++;
      const errResult = buildFailResult(node, status, state, `plan-session: ${err.message}`, { planId, subscriptionId });
      errResult.inPlan = true;
      errResult.planIds = [planId];
      upsertResult(errResult);
      saveResults();
      broadcast('result', { result: errResult, state });
      continue;
    }

    // Test with retry
    const { result, retried, error } = await testWithRetry(
      () => testNode(client, account, privkey, node,
        { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps, nodeStatus: status },
        BigInt(sessionId), broadcast, state
      ),
      broadcast, state, node.address,
    );

    if (result) {
      state.testedNodes++;
      result.inPlan = true;
      result.planIds = [planId];
      result.diag = result.diag || {};
      result.diag.planId = planId;
      result.diag.subscriptionId = subscriptionId;
      result.diag.viaSubscription = true;
      if (result.slaApplicable && result.pass15mbps) state.passed15++;
      if (result.pass10mbps) state.passed10++;
      if (result.passBaseline) state.passedBaseline++;
      upsertResult(result);
      saveResults();
      broadcast('result', { result, state });
      if (result.actualMbps != null) {
        planPassed++;
        broadcast('log', { msg: `  ✓ Plan node OK: ${result.actualMbps} Mbps` });
      } else {
        planFailed++;
        broadcast('log', { msg: `  ✗ Plan node failed` });
      }
    } else if (error?._stopRequested || error?.message === 'Stop requested') {
      broadcast('log', { msg: `⏸ Plan test interrupted — remaining nodes untouched` });
      break;
    } else {
      state.failedNodes++;
      planFailed++;
      const errMsg = error?.message || 'Unknown error';
      const failResult = buildFailResult(node, status, state, `plan-test: ${errMsg}`, error?.diag || {});
      failResult.inPlan = true;
      failResult.planIds = [planId];
      upsertResult(failResult);
      saveResults();
      broadcast('result', { result: failResult, state });
      broadcast('log', { msg: `  ✗ Test error: ${errMsg}` });
    }

    try { await uninstallWgTunnel(); } catch { }
    emergencyCleanupSync();
    if (NODE_DELAY > 0) await sleep(NODE_DELAY);
  }

  emergencyCleanupSync();
  state.status = 'done';
  state.completedAt = new Date().toISOString();
  state.currentNode = null;
  broadcast('state', { state });
  broadcast('log', { msg: `✅ Plan ${planId} test complete. ${planPassed} passed, ${planFailed} failed out of ${shuffled.length} tested.` });
}
