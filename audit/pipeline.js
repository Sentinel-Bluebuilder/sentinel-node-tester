/**
 * Sentinel Node Tester — Audit Pipeline
 * Main audit loop (runAudit), retest (runRetestSkips), plan test (runPlanTest).
 * Zero-skip system: every node ends as PASS or FAIL.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

import {
  MNEMONIC, DENOM, GIGS, TEST_MB, MAX_NODES, NODE_DELAY,
  RESULTS_DIR, RESULTS_FILE, FAILURE_LOG, BATCH_SIZE, PROJECT_ROOT,
  V3_SUB_TYPE, V3_SUB_SESSION_TYPE,
} from '../core/constants.js';
import { cachedWalletSetup, createFreshClient, signAndBroadcastRetry } from '../core/wallet.js';
import { getAllNodes, fetchPlanMembership, ensureLcd, getActiveLcd, getRpcClient, rpcFetchAllNodesForPlanPaginated } from '../core/chain.js';
import { rpcQueryNode } from 'sentinel-dvpn-sdk';
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
import { insertResult as _dbInsertResult, insertErrorLog as _dbInsertErrorLog } from '../core/db.js';

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
 * Pause audit when internet is down. Poll with backoff until it comes back.
 * Uses short sleep intervals so stop requests take effect quickly.
 * Backoff: 30s → 1m → 2m → 5m → 10m → 15m (max).
 */
async function waitForInternet(broadcast, state) {
  state.status = 'paused_internet';
  state.pauseReason = 'Internet down — checking with backoff';
  broadcast('state', { state });
  broadcast('log', { msg: `\n🌐 Internet appears down. Pausing audit...` });

  const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000, INTERNET_POLL_MS];
  let attempt = 0;

  while (!state.stopRequested) {
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    // Sleep in 2s chunks so stop requests take effect quickly
    const chunks = Math.ceil(delay / 2000);
    for (let i = 0; i < chunks; i++) {
      if (state.stopRequested) return false;
      await sleep(2000);
    }
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
    const nextDelay = BACKOFF_MS[Math.min(attempt + 1, BACKOFF_MS.length - 1)];
    broadcast('log', { msg: `🌐 ✗ Still down. Next check in ${Math.round(nextDelay / 1000)}s...` });
    attempt++;
  }
  return false;
}

// ─── Pipeline Event Emitter ──────────────────────────────────────────────────
// Allows server.js to subscribe to pipeline events (e.g. public-test:error)
// without a circular dependency (pipeline → continuous is forbidden).
export const pipelineEmitter = new EventEmitter();
pipelineEmitter.setMaxListeners(20);

// Public-mode flag — set by server.js via setPipelinePublicMode() when the
// continuous loop starts/stops in public mode. upsertResult checks this flag
// before emitting public-test:error to avoid leaking admin-session failures.
let _pipelinePublicMode = false;
export function setPipelinePublicMode(on) { _pipelinePublicMode = !!on; }

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
let _activeDbRunId = null;

export function setActiveRunDir(dir) { _activeRunDir = dir; }

/** Set the SQLite run_id for the current audit run (called from server.js). */
export function setActiveDbRunId(id) { _activeDbRunId = id; }
/** Get the current SQLite run_id (null if not yet set). */
export function getActiveDbRunId() { return _activeDbRunId; }

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

// ─── Log-snippet sanitizer ────────────────────────────────────────────────────
// Strip anything that looks like a wallet address, mnemonic, key material,
// or auth header before persisting or broadcasting.
const _WALLET_RE    = /sent1[a-z0-9]{38}/g;
const _MNEMONIC_RE  = /MNEMONIC\s*=\s*\S+/gi;
const _HEX64_RE     = /[0-9a-fA-F]{64}/g;
// Lines containing Bearer tokens or Authorization headers are dropped entirely.
const _AUTH_LINE_RE = /^.*(?:BEARER\s|Authorization:).*/gim;
const _MAX_SNIPPET  = 4096;

function _sanitizeSnippet(raw) {
  if (!raw) return null;
  const s = String(raw)
    .replace(_AUTH_LINE_RE, '[auth-redacted]')
    .replace(_WALLET_RE, '[addr]')
    .replace(_MNEMONIC_RE, 'MNEMONIC=[redacted]')
    .replace(_HEX64_RE, '[key]');
  return s.length > _MAX_SNIPPET ? s.slice(-_MAX_SNIPPET) : s;
}

function upsertResult(result, logSnippet = null) {
  const idx = results.findIndex(r => r.address === result.address);
  if (idx !== -1) results[idx] = result;
  else results.push(result);

  // ─── SQLite persistence (non-blocking — failure must not stop the audit) ─
  if (_activeDbRunId != null) {
    try {
      const resultId = _dbInsertResult(_activeDbRunId, result);
      // For failed tests, also write a detailed error_log row.
      if (result.actualMbps == null && result.error && resultId) {
        try {
          // Derive stage from the error text (mirrors deriveStage in db.js)
          const err = result.error || '';
          let stage = 'other';
          if (/insufficient|no udvpn pricing|no pricing/i.test(err)) stage = 'wallet';
          else if (/rpc|abci query|broadcast|tx failed|sign|code: 1\d\d/i.test(err)) stage = 'rpc';
          else if (/handshake|address mismatch|already exists|409|does not exist/i.test(err)) stage = 'handshake';
          else if (/session|sessionid|waitforsession/i.test(err)) stage = 'session';
          else if (/speed|socks5|mbps|tunnel|throughput/i.test(err)) stage = 'speedtest';
          _dbInsertErrorLog({
            result_id:     Number(resultId),
            stage,
            error_code:    result.errorCode || null,
            error_message: err.slice(0, 2048),
            log_snippet:   _sanitizeSnippet(logSnippet),
          });
          // ─── Public SSE: emit only when loop is running in public mode ───
          if (_pipelinePublicMode) {
            pipelineEmitter.emit('public-test:error', {
              node_addr:     result.address || '',
              moniker:       result.moniker  || '',
              country:       result.country  || '',
              stage,
              error_code:    result.errorCode || null,
              error_message: err.slice(0, 200),
              log_snippet:   _sanitizeSnippet(logSnippet) || null,
              captured_at:   result.timestamp || new Date().toISOString(),
              run_id:        _activeDbRunId,
              iteration:     null, // iteration context not available here; filled by server.js
            });
          }
        } catch (elErr) {
          console.error(`[db] insertErrorLog failed: ${elErr.message}`);
        }
      }
    } catch (dbErr) {
      // Log but never throw — JSON file is the authoritative backup
      console.error(`[db] insertResult failed: ${dbErr.message}`);
    }
  }
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
    type: state.currentType || status?.type || prevResult?.type || null,
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
export async function runAudit(resume, state, broadcast, preloadedNodes = null, opts = {}) {
  state.status = 'running';
  state.startedAt = new Date().toISOString();
  state.errorMessage = null;
  state.retryCount = 0;
  state.retestMode = false;
  state.retestPassed = null;
  state.retestFailed = null;

  state.dryRun = !!opts.dryRun;

  // ─── TEST RUN fast path ───────────────────────────────────────────────────
  // When dryRun is set: skip chain ops, skip payments, emit a fake result per
  // node with errorCode 'TEST_RUN_SKIP'. Still writes to audit.db (mode='dry').
  if (opts.dryRun) {
    broadcast('log', { msg: '🧪 TEST RUN mode — skipping chain ops and payments.' });

    results.length = 0;
    state.testedNodes = 0;
    state.failedNodes = 0;
    state.passed15 = 0;
    state.passed10 = 0;
    state.passedBaseline = 0;
    state.nodeSpeedHistory = [];
    state.baselineHistory = [];
    saveResults();

    // Resolve node list (or use preloaded snapshot)
    let dryNodes;
    if (Array.isArray(preloadedNodes) && preloadedNodes.length > 0) {
      dryNodes = preloadedNodes;
    } else {
      broadcast('log', { msg: '🔍 Fetching node list for TEST RUN...' });
      try {
        dryNodes = await Promise.race([
          getAllNodes(broadcast),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Node list fetch timeout (60s)')), 60_000)),
        ]);
      } catch (err) {
        broadcast('log', { msg: `⚠ Node list fetch failed: ${err.message}` });
        dryNodes = [];
      }
    }

    const nodesToDry = MAX_NODES > 0 ? dryNodes.slice(0, MAX_NODES) : dryNodes;
    state.totalNodes = nodesToDry.length;
    broadcast('log', { msg: `TEST RUN: simulating ${nodesToDry.length} nodes...` });
    broadcast('state', { state });

    for (let i = 0; i < nodesToDry.length; i++) {
      if (state.stopRequested) break;
      const node = nodesToDry[i];
      const addr = node.address || node.addr || '';
      state.currentNode = addr;
      broadcast('state', { state });

      await new Promise(r => setTimeout(r, 5 + Math.random() * 15));

      const result = {
        timestamp:           new Date().toISOString(),
        address:             addr,
        type:                node.type || null,
        moniker:             node.moniker || '',
        country:             node.location?.country || node.country || '',
        countryCode:         node.location?.country_code || node.countryCode || '',
        city:                node.location?.city || node.city || '',
        reportedDownloadMbps: 0,
        actualMbps:          null,
        skipped:             true,
        error:               'TEST_RUN_SKIP',
        errorCode:           'TEST_RUN_SKIP',
        peers:               node.peers ?? null,
        maxPeers:            node.qos?.max_peers ?? null,
        sdk:                 state.activeSDK || 'js',
        os:                  process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
      };

      state.failedNodes++;
      upsertResult(result);
      saveResults();
      broadcast('result', { result, state });

      const nodeNum = i + 1;
      broadcast('log', { msg: `[${nodeNum}/${nodesToDry.length}] TEST_RUN_SKIP ${addr.slice(0, 20)}…` });
    }

    state.status = 'idle';
    state.currentNode = null;
    broadcast('state', { state });
    broadcast('log', { msg: `🧪 TEST RUN complete (${nodesToDry.length} nodes simulated).` });
    return;
  }
  // ─── End TEST RUN fast path ───────────────────────────────────────────────

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

  // ─── Wallet / client setup ────────────────────────
  broadcast('log', { msg: '🔑 Setting up wallet...' });
  const { wallet, account, privkey } = await cachedWalletSetup(MNEMONIC);
  state.walletAddress = account.address;
  broadcast('log', { msg: `Wallet: ${account.address}` });

  const client = await createFreshClient(wallet, broadcast);

  const balRes = await client.getBalance(account.address, DENOM);
  state.balanceUdvpn = parseInt(balRes?.amount || '0', 10);
  state.balance = `${(state.balanceUdvpn / 1_000_000).toFixed(4)} P2P`;
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
    broadcast('log', { msg: `Baseline speed test failed: ${_sanitizeSnippet(e.message)}` });
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
  let allNodes;
  if (Array.isArray(preloadedNodes) && preloadedNodes.length > 0) {
    broadcast('log', { msg: `🔒 Using frozen snapshot (${preloadedNodes.length} nodes).` });
    allNodes = preloadedNodes;
  } else {
    broadcast('log', { msg: '🔍 Fetching node list...' });
    allNodes = await Promise.race([
      getAllNodes(broadcast),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Node list fetch timeout (60s)')), 60_000)),
    ]);
  }
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
    broadcast('log', { msg: `⚠ Plan membership skipped: ${_sanitizeSnippet(planErr.message)}` });
  }

  // ── Phase 2: Parallel online scan ──
  broadcast('log', { msg: `\n🔍 Phase 2: Scanning ${nodesToTest.length} nodes in parallel (30 concurrent)...` });
  const onlineNodes = await scanNodesParallel(nodesToTest, 30, broadcast, state);
  broadcast('log', { msg: `Scan complete: ${onlineNodes.length}/${nodesToTest.length} online.` });

  const viableNodes = onlineNodes.filter(({ node, status }) => {
    if (status.type === 'wireguard' && !WG_AVAILABLE) return false;
    if (status.type === 'v2ray' && !v2rayAvailable) return false;
    return (node.gigabyte_prices || []).some(p => p.denom === DENOM);
  });

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
  state.estimatedTotalCost = '0.0000 P2P';
  broadcast('log', { msg: `${viableNodes.length} testable nodes. ~${(avgCostPerNode / 1_000_000).toFixed(4)} P2P/node avg, ~${(estCostUdvpn / 1_000_000).toFixed(2)} P2P total est.` });
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
        state.balance = `${(realBalance / 1_000_000).toFixed(4)} P2P`;
        _lastBalanceRefresh = Date.now();
      } catch { /* non-critical — estimate continues */ }
    }

    // VPN interference check before each batch
    const canProceed = await checkAndPauseIfInterference(broadcast, state);
    if (!canProceed) { broadcast('log', { msg: '⏹ Aborting — VPN interference not cleared.' }); break; }

    let batchSessionMap;
    {
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
              state.balance = `${(realBal / 1_000_000).toFixed(4)} P2P`;
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
            broadcast('log', { msg: `  Batch retry also failed: ${_sanitizeSnippet(retryErr.message)}` });
            batchSessionMap = new Map();
          }
        } else {
          broadcast('log', { msg: `  Batch payment FAILED: ${_sanitizeSnippet(payErr.message)}` });
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

      // ─── Per-node log buffer (last 40 lines or 4 KB) ───────────────────
      // Intercept broadcast('log') during the test to capture log lines for
      // error_logs.log_snippet. The outer broadcast (SSE + file log) is
      // still called — we add capture on top.
      const _nodeLogLines = [];
      const _MAX_LOG_LINES = 40;
      const _MAX_LOG_BYTES = 4096;
      const _capturingBroadcast = (type, data) => {
        broadcast(type, data);
        if (type === 'log' && data?.msg) {
          _nodeLogLines.push(String(data.msg));
          if (_nodeLogLines.length > _MAX_LOG_LINES) _nodeLogLines.shift();
        }
      };

      let result, retried, error;
      ({ result, retried, error } = await testWithRetry(
        () => testNode(client, account, privkey, node,
          { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps, nodeStatus: status },
          sessionId, _capturingBroadcast, state
        ),
        _capturingBroadcast, state, node.address,
      ));

      // Build snippet: last 40 lines, trimmed to 4 KB from the tail
      const _rawSnippet = _nodeLogLines.join('\n');
      const _logSnippet = _rawSnippet.length > _MAX_LOG_BYTES
        ? _rawSnippet.slice(-_MAX_LOG_BYTES)
        : (_rawSnippet || null);

      if (result) {
        state.testedNodes++;
        if (result.slaApplicable && result.pass15mbps) state.passed15++;
        if (result.pass10mbps) state.passed10++;
        if (result.passBaseline) state.passedBaseline++;
        upsertResult(result); // success — no snippet needed
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
          state.pauseReason = `Insufficient P2P balance (${(Math.max(0, state.balanceUdvpn - state.spentUdvpn) / 1_000_000).toFixed(2)} P2P remaining)`;
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
              state.balance = `${(realBalance / 1_000_000).toFixed(4)} P2P`;
              broadcast('log', { msg: `💰 Balance check: ${state.balance}` });
              if (realBalance > 1_000_000) { // > 1 P2P
                broadcast('log', { msg: `💰 Balance restored! Resuming audit...` });
                state.status = 'running';
                state.pauseReason = null;
                broadcast('state', { state });
                balanceRestored = true;
                break;
              }
            } catch (balErr) {
              broadcast('log', { msg: `💰 Balance check failed: ${_sanitizeSnippet(balErr.message)} — retrying in 5 min` });
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
        upsertResult(failResult, _logSnippet);
        saveResults();
        broadcast('result', { result: failResult, state });
        const retryLabel = retried > 0 ? ` (${retried} retries)` : '';
        const label = /timeout/i.test(errMsg) ? '⏱ Timeout' : /already exists/i.test(errMsg) ? '🚫 Node bug' : 'FAIL';
        broadcast('log', { msg: `${label} [${node.address.slice(0, 20)}…]: ${errMsg}${retryLabel}` });

        // ─── Internet-down detection ───────────────────────────────────
        // If this failure looks like a network issue, clean up tunnels FIRST
        // (WG can corrupt routing tables), then check if internet is really down.
        if (isInternetError(error) && !state.stopRequested) {
          // Clean up WireGuard/V2Ray before checking — tunnel may be corrupting routes
          try { await uninstallWgTunnel(); } catch { }
          emergencyCleanupSync();
          await sleep(1000); // Let routing tables settle
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

      const _irLogLines = [];
      const _irBroadcast = (type, data) => {
        broadcast(type, data);
        if (type === 'log' && data?.msg) {
          _irLogLines.push(String(data.msg));
          if (_irLogLines.length > 40) _irLogLines.shift();
        }
      };

      const { result, retried, error } = await testWithRetry(
        () => testNode(client, account, privkey, node,
          { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps, nodeStatus: status },
          null, _irBroadcast, state
        ),
        _irBroadcast, state, node.address,
      );
      const _irRaw = _irLogLines.join('\n');
      const _irSnippet = _irRaw.length > 4096 ? _irRaw.slice(-4096) : (_irRaw || null);

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
        upsertResult(failResult, _sanitizeSnippet(_irSnippet));
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

      const _ironLogLines = [];
      const _ironBroadcast = (type, data) => {
        broadcast(type, data);
        if (type === 'log' && data?.msg) {
          _ironLogLines.push(String(data.msg));
          if (_ironLogLines.length > 40) _ironLogLines.shift();
        }
      };

      const { result, retried, error } = await testWithRetry(
        () => testNode(client, account, privkey, node,
          { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps, nodeStatus: status },
          null, _ironBroadcast, state
        ),
        _ironBroadcast, state, node.address,
      );
      const _ironRaw = _ironLogLines.join('\n');
      const _ironSnippet = _ironRaw.length > 4096 ? _ironRaw.slice(-4096) : (_ironRaw || null);

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
        upsertResult(failResult, _sanitizeSnippet(_ironSnippet));
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
  state.dryRun = false;
  state.completedAt = new Date().toISOString();
  state.currentNode = null;
  broadcast('state', { state });
  const finalFailed = results.filter(r => r.actualMbps == null && r.error).length;
  broadcast('log', { msg: `✅ Audit complete. Tested ${state.testedNodes}, Failed ${finalFailed}. ${state.retryCount} retries total.` });
  broadcast('log', { msg: `🧠 Transport cache: ${finalCache.nodesCached} nodes learned for next scan.` });
}

// ─── Retest Previously-Failed Nodes ─────────────────────────────────────────
export async function runRetestSkips(skipAddrs, state, broadcast) {
  state.dryRun = false;
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
  state.balance = `${(state.balanceUdvpn / 1_000_000).toFixed(4)} P2P`;
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
  } catch (e) { broadcast('log', { msg: `Baseline failed: ${_sanitizeSnippet(e.message)}` }); }

  broadcast('log', { msg: '🔍 Fetching node list...' });
  const allNodes = await getAllNodes(broadcast);

  const skipSet = new Set(skipAddrs);
  const toTest = allNodes.filter(n => skipSet.has(n.address));

  // Direct lookup for nodes not found in paginated list (pagination can miss nodes)
  // RPC primary (fast single-node lookup), LCD fallback
  const foundAddrs = new Set(toTest.map(n => n.address));
  const missingAddrs = skipAddrs.filter(a => !foundAddrs.has(a));
  if (missingAddrs.length > 0) {
    broadcast('log', { msg: `⚠ ${missingAddrs.length} nodes not in paginated list — doing direct lookup...` });
    const rpcClient = await getRpcClient();
    for (const addr of missingAddrs) {
      try {
        let node = null;
        // Try RPC first
        if (rpcClient) {
          node = await rpcQueryNode(rpcClient, addr);
        }
        if (node) {
          const rawAddrs = (node.remote_addrs || []).filter(Boolean);
          const rawAddr = rawAddrs[0] || '';
          toTest.push({
            address: node.address || addr,
            remoteUrl: rawAddr.startsWith('http') ? rawAddr : `https://${rawAddr}`,
            remoteAddrs: rawAddrs.map(a => a.startsWith('http') ? a : `https://${a}`),
            gigabyte_prices: node.gigabyte_prices || [],
            hourly_prices: node.hourly_prices || [],
            planIds: [],
          });
          broadcast('log', { msg: `  ✓ Found ${addr.slice(0, 20)}… via RPC` });
        } else {
          // LCD fallback
          const activeLcd = getActiveLcd();
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
            broadcast('log', { msg: `  ✓ Found ${addr.slice(0, 20)}… via LCD fallback` });
          }
        }
      } catch (e) {
        broadcast('log', { msg: `  ✗ ${addr.slice(0, 20)}… lookup failed: ${_sanitizeSnippet(e.message?.slice(0, 50))}` });
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

    const _rrLogLines = [];
    const _rrBroadcast = (type, data) => {
      broadcast(type, data);
      if (type === 'log' && data?.msg) {
        _rrLogLines.push(String(data.msg));
        if (_rrLogLines.length > 40) _rrLogLines.shift();
      }
    };

    const { result, retried, error } = await testWithRetry(
      () => testNode(client, account, privkey, node,
        { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps },
        null, _rrBroadcast, state
      ),
      _rrBroadcast, state, node.address,
    );
    const _rrRaw = _rrLogLines.join('\n');
    const _rrSnippet = _rrRaw.length > 4096 ? _rrRaw.slice(-4096) : (_rrRaw || null);

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
      upsertResult(failResult, _sanitizeSnippet(_rrSnippet));
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
  state.balance = `${(state.balanceUdvpn / 1_000_000).toFixed(4)} P2P`;
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
    broadcast('log', { msg: `  ✗ Subscribe failed: ${_sanitizeSnippet(err.message)}` });
    state.status = 'error';
    state.errorMessage = `Plan subscribe failed: ${_sanitizeSnippet(err.message)}`;
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

  // 2. Fetch plan nodes (RPC primary, LCD fallback)
  broadcast('log', { msg: `  Fetching plan ${planId} nodes...` });
  let planNodes = [];
  try {
    let allPlanNodes = [];
    // Try RPC first (paginated — walks all pages)
    const rpcClient = await getRpcClient();
    if (rpcClient) {
      try {
        allPlanNodes = await rpcFetchAllNodesForPlanPaginated(rpcClient, planId, broadcast);
        broadcast('log', { msg: `  Fetched ${allPlanNodes.length} plan nodes via RPC (paginated)` });
      } catch (e) {
        broadcast('log', { msg: `  RPC plan-nodes fetch failed: ${_sanitizeSnippet(e.message)}` });
        allPlanNodes = [];
      }
    }
    // LCD fallback if RPC failed
    if (allPlanNodes.length === 0) {
      const activeLcd = await ensureLcd();
      // Chain truncates at `limit` without emitting next_key, so request a big page.
      const pnUrl = `${activeLcd}/sentinel/node/v3/plans/${planId}/nodes?status=1&pagination.limit=10000`;
      const nr = await fetch(pnUrl, { signal: AbortSignal.timeout(20000) });
      const nd = await nr.json();
      allPlanNodes.push(...(nd.nodes || []));
    }
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
  } catch (e) { broadcast('log', { msg: `  Baseline failed: ${_sanitizeSnippet(e.message)}` }); }

  let planPassed = 0, planFailed = 0;

  // 4. Test each node via subscription session
  for (let i = 0; i < shuffled.length; i++) {
    if (state.stopRequested) { broadcast('log', { msg: '⏹ Stop requested.' }); break; }
    const { node, status } = shuffled[i];
    state.currentNode = node.address;
    broadcast('state', { state });
    broadcast('log', { msg: `[${i + 1}/${shuffled.length}] Testing ${node.address.slice(0, 20)}… via plan ${planId}` });

    const _ptLogLines = [];
    const _ptBroadcast = (type, data) => {
      broadcast(type, data);
      if (type === 'log' && data?.msg) {
        _ptLogLines.push(String(data.msg));
        if (_ptLogLines.length > 40) _ptLogLines.shift();
      }
    };

    // Start session via subscription
    let sessionId = null;
    try {
      const sessMsg = {
        typeUrl: V3_SUB_SESSION_TYPE,
        value: { from: account.address, id: BigInt(subscriptionId), nodeAddress: node.address },
      };
      _ptBroadcast('log', { msg: `  Starting session on subscription ${subscriptionId}...` });
      const sessResult = await signAndBroadcastRetry(client, account.address, [sessMsg], fee, _ptBroadcast);
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
      _ptBroadcast('log', { msg: `  ✓ Session ${sessionId} via subscription — tx=${sessResult.transactionHash}` });
      await waitForSessionActive(node.address, account.address, 20_000);
    } catch (err) {
      _ptBroadcast('log', { msg: `  ✗ Session start failed: ${_sanitizeSnippet(err.message)}` });
      planFailed++;
      const _ptRawSess = _ptLogLines.join('\n');
      const _ptSnippetSess = _ptRawSess.length > 4096 ? _ptRawSess.slice(-4096) : (_ptRawSess || null);
      const errResult = buildFailResult(node, status, state, `plan-session: ${_sanitizeSnippet(err.message)}`, { planId, subscriptionId });
      errResult.inPlan = true;
      errResult.planIds = [planId];
      upsertResult(errResult, _sanitizeSnippet(_ptSnippetSess));
      saveResults();
      broadcast('result', { result: errResult, state });
      continue;
    }

    // Test with retry
    const { result, retried, error } = await testWithRetry(
      () => testNode(client, account, privkey, node,
        { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps, nodeStatus: status },
        BigInt(sessionId), _ptBroadcast, state
      ),
      _ptBroadcast, state, node.address,
    );
    const _ptRaw = _ptLogLines.join('\n');
    const _ptSnippet = _ptRaw.length > 4096 ? _ptRaw.slice(-4096) : (_ptRaw || null);

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
      upsertResult(failResult, _sanitizeSnippet(_ptSnippet));
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

// ─── Sub. Plan Test (fee-granted, mirrors Android/iOS consumer flow) ────────
/**
 * Test every active node in a plan the wallet is already subscribed to.
 * Every session TX is fee-granted by the plan owner — the wallet pays ZERO gas.
 *
 * Flow:
 *   1. Verify the wallet is subscribed to this plan (uses the provided subscriptionId)
 *   2. Verify the plan owner has an active fee grant for this wallet
 *   3. Fetch all active nodes in the plan
 *   4. For each node: start a session via subscription, fee-granted by plan owner
 *   5. Run the standard testNode speed/reachability flow
 *
 * This mirrors how Android/iOS consumer apps ship — the end user never holds
 * P2P, the plan operator covers all on-chain fees via a pre-granted feegrant.
 */
export async function runSubPlanTest(planId, subscriptionId, granterAddr, state, broadcast) {
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

  broadcast('log', { msg: `📋 Sub. Plan ${planId} — sub ${subscriptionId} — granter ${granterAddr.slice(0, 16)}…` });
  broadcast('log', { msg: `  Mode: fee-granted (wallet pays zero gas; plan owner pays all TXs)` });

  const { wallet, account, privkey } = await cachedWalletSetup(MNEMONIC);
  state.walletAddress = account.address;
  const client = await createFreshClient(wallet, broadcast);

  const balRes = await client.getBalance(account.address, DENOM);
  state.balanceUdvpn = parseInt(balRes?.amount || '0', 10);
  state.balance = `${(state.balanceUdvpn / 1_000_000).toFixed(4)} P2P`;
  state.spentUdvpn = 0;
  broadcast('state', { state });

  // Pre-broadcast fee grant verification — abort with structured error if missing/expired.
  // A revoked fee grant means EVERY session TX will fail; fail fast before spending any chain time.
  const { queryFeeGrant, queryFeeGrantRpcFirst, getRpcClient: _getRpcClient, broadcastWithFeeGrant, hasActiveSubscription, ensureLcd: _ensureLcd } = await import('../core/chain.js');
  const lcd = await _ensureLcd();
  const _fgRpcClient = await _getRpcClient();
  try {
    const allowance = await queryFeeGrantRpcFirst(_fgRpcClient, lcd, granterAddr, account.address);
    if (!allowance) {
      const abortErr = {
        code: 'FEE_GRANT_MISSING_AT_START',
        granter: granterAddr,
        grantee: account.address,
        allowanceType: null,
        spendLimit: null,
        message: `Plan owner ${granterAddr.slice(0, 16)}… has no active fee grant for this wallet`,
      };
      state.status = 'error';
      state.errorMessage = abortErr.message;
      state.errorCode = abortErr.code;
      broadcast('state', { state });
      broadcast('log', { msg: `  ✗ FEE_GRANT_MISSING_AT_START — cannot continue (plan owner must grant first)` });
      return;
    }
    // Surface allowance details in log for operator debugging
    const allowanceType = allowance['@type'] || allowance.type_url || null;
    const spendLimit = allowance.spend_limit || allowance.allowance?.spend_limit || null;
    broadcast('log', { msg: `  ✓ Fee grant verified — type=${allowanceType || 'unknown'} limit=${JSON.stringify(spendLimit) || 'none'}` });
  } catch (err) {
    // If the query itself throws (network error), abort rather than silently proceeding —
    // we cannot know whether the grant exists, and every session TX would fail.
    const abortErr = {
      code: 'FEE_GRANT_MISSING_AT_START',
      granter: granterAddr,
      grantee: account.address,
      allowanceType: null,
      spendLimit: null,
      message: `Fee grant check threw: ${_sanitizeSnippet(err.message)}`,
    };
    state.status = 'error';
    state.errorMessage = abortErr.message;
    state.errorCode = abortErr.code;
    broadcast('state', { state });
    broadcast('log', { msg: `  ✗ FEE_GRANT_MISSING_AT_START — check threw error, aborting: ${_sanitizeSnippet(err.message)}` });
    return;
  }

  // Verify subscription still active
  const subCheck = await hasActiveSubscription(account.address, planId);
  if (!subCheck.has) {
    state.status = 'error';
    state.errorMessage = `Wallet is no longer subscribed to plan ${planId}`;
    broadcast('state', { state });
    return;
  }
  // Allow subscriptionId from caller; fall back to whatever the chain reports.
  subscriptionId = subscriptionId || subCheck.subscriptionId;

  const v2rayAvailable = await checkV2Ray();

  // Fetch plan nodes (RPC primary, LCD fallback)
  broadcast('log', { msg: `  Fetching plan ${planId} nodes...` });
  let planNodes = [];
  try {
    let allPlanNodes = [];
    const rpcClient = await getRpcClient();
    if (rpcClient) {
      try {
        allPlanNodes = await rpcFetchAllNodesForPlanPaginated(rpcClient, planId, broadcast);
        broadcast('log', { msg: `  Fetched ${allPlanNodes.length} plan nodes via RPC (paginated)` });
      } catch (e) {
        broadcast('log', { msg: `  RPC plan-nodes fetch failed: ${_sanitizeSnippet(e.message)}` });
        allPlanNodes = [];
      }
    }
    if (allPlanNodes.length === 0) {
      const activeLcd = await ensureLcd();
      // Chain truncates at `limit` without emitting next_key, so request a big page.
      const pnUrl = `${activeLcd}/sentinel/node/v3/plans/${planId}/nodes?status=1&pagination.limit=10000`;
      const nr = await fetch(pnUrl, { signal: AbortSignal.timeout(20000) });
      const nd = await nr.json();
      allPlanNodes.push(...(nd.nodes || []));
    }
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

  broadcast('log', { msg: `  Scanning plan nodes for online status...` });
  const onlineNodes = await scanNodesParallel(planNodes, 20, broadcast, state);
  broadcast('log', { msg: `  ${onlineNodes.length}/${planNodes.length} plan nodes are online` });

  if (onlineNodes.length === 0) {
    state.status = 'done';
    state.completedAt = new Date().toISOString();
    broadcast('state', { state });
    return;
  }

  state.totalNodes = onlineNodes.length;
  broadcast('state', { state });

  broadcast('log', { msg: `📡 Running baseline...` });
  try {
    const bl = await speedtestDirect();
    state.baselineMbps = bl.mbps;
    broadcast('log', { msg: `  Baseline: ${bl.mbps} Mbps` });
  } catch (e) { broadcast('log', { msg: `  Baseline failed: ${_sanitizeSnippet(e.message)}` }); }

  let subPassed = 0, subFailed = 0;

  for (let i = 0; i < onlineNodes.length; i++) {
    if (state.stopRequested) { broadcast('log', { msg: '⏹ Stop requested.' }); break; }
    const { node, status } = onlineNodes[i];
    state.currentNode = node.address;
    broadcast('state', { state });
    broadcast('log', { msg: `[${i + 1}/${onlineNodes.length}] Testing ${node.address.slice(0, 20)}… via Sub. Plan ${planId}` });

    const _spLogLines = [];
    const _spBroadcast = (type, data) => {
      broadcast(type, data);
      if (type === 'log' && data?.msg) {
        _spLogLines.push(String(data.msg));
        if (_spLogLines.length > 40) _spLogLines.shift();
      }
    };

    let sessionId = null;
    try {
      const sessMsg = {
        typeUrl: V3_SUB_SESSION_TYPE,
        value: { from: account.address, id: BigInt(subscriptionId), nodeAddress: node.address },
      };
      _spBroadcast('log', { msg: `  Starting session (fee-granted by ${granterAddr.slice(0, 12)}…)` });
      const sessResult = await broadcastWithFeeGrant(client, account.address, [sessMsg], granterAddr);
      if (sessResult.code !== 0) {
        throw new Error(`Session tx failed code=${sessResult.code}: ${sessResult.rawLog}`);
      }
      // Wallet pays zero — do NOT increment spentUdvpn on fee-granted TX

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
      _spBroadcast('log', { msg: `  ✓ Session ${sessionId} (fee-granted) — tx=${sessResult.transactionHash}` });
      await waitForSessionActive(node.address, account.address, 20_000);
    } catch (err) {
      _spBroadcast('log', { msg: `  ✗ Fee-granted session start failed: ${_sanitizeSnippet(err.message)}` });
      subFailed++;
      const _spRawSess = _spLogLines.join('\n');
      const _spSnippetSess = _spRawSess.length > 4096 ? _spRawSess.slice(-4096) : (_spRawSess || null);
      const errResult = buildFailResult(node, status, state, `sub-plan-session: ${_sanitizeSnippet(err.message)}`, { planId, subscriptionId, granter: granterAddr });
      errResult.inPlan = true;
      errResult.planIds = [planId];
      errResult.diag = errResult.diag || {};
      errResult.diag.viaSubscription = true;
      errResult.diag.feeGranted = true;
      errResult.diag.granter = granterAddr;
      upsertResult(errResult, _sanitizeSnippet(_spSnippetSess));
      saveResults();
      broadcast('result', { result: errResult, state });
      continue;
    }

    const { result, retried, error } = await testWithRetry(
      () => testNode(client, account, privkey, node,
        { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps, nodeStatus: status },
        BigInt(sessionId), _spBroadcast, state
      ),
      _spBroadcast, state, node.address,
    );
    const _spRaw = _spLogLines.join('\n');
    const _spSnippet = _spRaw.length > 4096 ? _spRaw.slice(-4096) : (_spRaw || null);

    if (result) {
      state.testedNodes++;
      result.inPlan = true;
      result.planIds = [planId];
      result.diag = result.diag || {};
      result.diag.planId = planId;
      result.diag.subscriptionId = subscriptionId;
      result.diag.viaSubscription = true;
      result.diag.feeGranted = true;
      result.diag.granter = granterAddr;
      if (result.slaApplicable && result.pass15mbps) state.passed15++;
      if (result.pass10mbps) state.passed10++;
      if (result.passBaseline) state.passedBaseline++;
      upsertResult(result);
      saveResults();
      broadcast('result', { result, state });
      if (result.actualMbps != null) {
        subPassed++;
        broadcast('log', { msg: `  ✓ Sub. Plan node OK: ${result.actualMbps} Mbps` });
      } else {
        subFailed++;
        broadcast('log', { msg: `  ✗ Sub. Plan node failed` });
      }
    } else if (error?._stopRequested || error?.message === 'Stop requested') {
      broadcast('log', { msg: `⏸ Sub. Plan test interrupted — remaining nodes untouched` });
      break;
    } else {
      state.failedNodes++;
      subFailed++;
      const errMsg = error?.message || 'Unknown error';
      const failResult = buildFailResult(node, status, state, `sub-plan-test: ${errMsg}`, error?.diag || {});
      failResult.inPlan = true;
      failResult.planIds = [planId];
      failResult.diag = failResult.diag || {};
      failResult.diag.viaSubscription = true;
      failResult.diag.feeGranted = true;
      failResult.diag.granter = granterAddr;
      upsertResult(failResult, _sanitizeSnippet(_spSnippet));
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
  broadcast('log', { msg: `✅ Sub. Plan ${planId} test complete. ${subPassed} passed, ${subFailed} failed out of ${onlineNodes.length} tested.` });
  broadcast('log', { msg: `  Wallet paid: 0 P2P (all gas covered by granter ${granterAddr.slice(0, 16)}…)` });
}
