/**
 * Sentinel dVPN Network Audit — Server
 * Thin Express server: API routes, SSE, imports from modular architecture.
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { existsSync } from 'fs';

import { MNEMONIC, DENOM, GAS_PRICE, PORT, LCD_ENDPOINTS, PROJECT_ROOT, DNS_PRESETS, ACTIVE_DNS, setActiveDns } from './core/constants.js';
import { cachedWalletSetup, createFreshClient } from './core/wallet.js';
import { ensureLcd, getActiveLcd, cleanupRpc } from './core/chain.js';
import { createState, runAudit, runRetestSkips, runPlanTest, getResults, saveResults, setActiveRunDir } from './audit/pipeline.js';
// Platform-aware WireGuard import — Windows has full implementation, others get stubs
let emergencyCleanupSync, watchdogCheck, WG_AVAILABLE, IS_ADMIN;
if (process.platform === 'win32') {
  ({ emergencyCleanupSync, watchdogCheck, WG_AVAILABLE, IS_ADMIN } = await import('./platforms/windows/wireguard.js'));
} else {
  emergencyCleanupSync = () => {};
  watchdogCheck = () => {};
  WG_AVAILABLE = false;
  IS_ADMIN = process.getuid?.() === 0 || false;
}
import { loadTransportCache, getCacheStats } from './core/transport-cache.js';

import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { SigningStargateClient, GasPrice } from '@cosmjs/stargate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.PATH = path.join(__dirname, 'bin') + path.delimiter + (process.env.PATH || '');

// ─── WireGuard Safety: cleanup on ANY exit ──────────────────────────────────
emergencyCleanupSync();

function onProcessExit() { cleanupRpc(); emergencyCleanupSync(); }
process.on('exit', onProcessExit);
process.on('SIGINT', () => { onProcessExit(); process.exit(130); });
process.on('SIGTERM', () => { onProcessExit(); process.exit(143); });
process.on('uncaughtException', (err) => {
  const msg = err?.stack || err?.message || String(err);
  console.error(`[uncaughtException] ${msg}`);
  emergencyCleanupSync();
});
process.on('unhandledRejection', (reason) => {
  console.error(`[unhandledRejection] ${String(reason)}`);
  emergencyCleanupSync();
});

// Watchdog: every 5s, check if a tunnel has been up too long
setInterval(() => {
  if (watchdogCheck()) {
    broadcast('log', { msg: '⚠ WATCHDOG: Force-killed stale WireGuard tunnel' });
  }
}, 5_000);

// ─── SSE ────────────────────────────────────────────────────────────────────
const emitter = new EventEmitter();
emitter.setMaxListeners(100);
const LOG_BUFFER_MAX = 100;
const logBuffer = [];

// ─── State Snapshot (persists volatile fields across restarts) ───────────────
const STATE_SNAPSHOT_FILE = path.join(__dirname, 'results', '.state-snapshot.json');
let _lastSnapshotTs = 0;

function saveStateSnapshot() {
  // Throttle: save at most every 5 seconds to avoid disk thrashing
  const now = Date.now();
  if (now - _lastSnapshotTs < 5_000) return;
  _lastSnapshotTs = now;
  try {
    _wfs(STATE_SNAPSHOT_FILE, JSON.stringify({
      baselineHistory: state.baselineHistory,
      nodeSpeedHistory: state.nodeSpeedHistory,
      spentUdvpn: state.spentUdvpn,
      balanceUdvpn: state.balanceUdvpn,
      balance: state.balance,
      estimatedTotalCost: state.estimatedTotalCost,
      startedAt: state.startedAt,
      baselineMbps: state.baselineMbps,
      totalNodes: state.totalNodes,
      status: state.status,
    }), 'utf8');
  } catch { }
}

function broadcast(type, data = {}) {
  if (type === 'log' && data.msg) {
    logBuffer.push(data.msg);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  }
  if (type === 'state' || type === 'result') saveStateSnapshot();
  emitter.emit('update', { type, ...data });
}

// ─── State ──────────────────────────────────────────────────────────────────
const state = createState();

// Persist SDK choice to disk so it survives restarts
const SDK_PREF_FILE = path.join(__dirname, 'results', '.sdk-preference');
try { state.activeSDK = _rfs(SDK_PREF_FILE, 'utf8').trim() || 'js'; } catch { state.activeSDK = 'js'; }

// ─── Restore log buffer from most recent audit log (survives server restart) ─
try {
  const logDir = path.join(__dirname, 'results');
  const logFiles = _rd(logDir).filter(f => /^(audit|retest)-.*\.log$/.test(f)).sort().reverse();
  if (logFiles.length > 0) {
    const lastLog = _rfs(path.join(logDir, logFiles[0]), 'utf8');
    const lines = lastLog.split('\n').filter(l => l.trim());
    const tail = lines.slice(-LOG_BUFFER_MAX);
    logBuffer.push(...tail);
  }
} catch { }

// ─── Test Run Management ─────────────────────────────────────────────────────
import { readFileSync as _rfs, writeFileSync as _wfs, mkdirSync as _mkd, existsSync as _ex, readdirSync as _rd, copyFileSync as _cp } from 'fs';

const RUNS_DIR = path.join(__dirname, 'results', 'runs');
const RUNS_INDEX = path.join(RUNS_DIR, 'index.json');
if (!_ex(RUNS_DIR)) _mkd(RUNS_DIR, { recursive: true });

function loadRunsIndex() {
  if (!_ex(RUNS_INDEX)) return { runs: [], activeRun: null };
  return JSON.parse(_rfs(RUNS_INDEX, 'utf8'));
}

function saveRunsIndex(index) {
  _wfs(RUNS_INDEX, JSON.stringify(index, null, 2), 'utf8');
}

function getNextRunNumber() {
  const index = loadRunsIndex();
  return (index.runs.length > 0 ? Math.max(...index.runs.map(r => r.number)) : 0) + 1;
}

function saveCurrentRun(label) {
  const results = getResults();
  if (results.length === 0) return null;
  const num = getNextRunNumber();
  const runDir = path.join(RUNS_DIR, `test-${String(num).padStart(3, '0')}`);
  _mkd(runDir, { recursive: true });

  // Save results
  _wfs(path.join(runDir, 'results.json'), JSON.stringify(results, null, 2), 'utf8');

  // Save summary
  const passed = results.filter(r => r.actualMbps != null);
  const failed = results.filter(r => r.actualMbps == null);
  const pass10 = passed.filter(r => r.actualMbps >= 10);
  const summary = [
    `Test #${num} — ${label || 'Full Audit'}`,
    `Date: ${new Date().toISOString()}`,
    `${'='.repeat(60)}`,
    `Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`,
    `Success Rate: ${(passed.length / results.length * 100).toFixed(1)}%`,
    `Pass 10 Mbps SLA: ${pass10.length} (${(pass10.length / passed.length * 100).toFixed(1)}%)`,
    ``,
    `── Passed Nodes (${passed.length}) ──`,
    ...passed.map(r => `  ${r.address.slice(0, 25)}... | ${r.actualMbps} Mbps | ${r.type} | ${r.moniker} | ${r.city}, ${r.country} | Google: ${r.googleAccessible === true ? 'YES' : r.googleAccessible === false ? 'NO' : '?'}`),
    ``,
    `── Failed Nodes (${failed.length}) ──`,
    ...failed.map(r => `  ${r.address.slice(0, 25)}... | ${r.type} | ${r.moniker} | ${r.city}, ${r.country} | peers=${r.peers ?? '?'} | ${(r.error || '').slice(0, 80)}`),
  ].join('\n');
  _wfs(path.join(runDir, 'summary.txt'), summary, 'utf8');

  // Copy failures log
  const failLog = path.join(__dirname, 'results', 'failures.jsonl');
  if (_ex(failLog)) _cp(failLog, path.join(runDir, 'failures.jsonl'));

  // Update index
  const index = loadRunsIndex();
  index.runs.push({
    number: num,
    label: label || 'Full Audit',
    date: new Date().toISOString(),
    total: results.length,
    passed: passed.length,
    failed: failed.length,
    pass10: pass10.length,
    sdk: state.activeSDK,
  });
  index.activeRun = num;
  saveRunsIndex(index);

  return num;
}

function loadRun(num) {
  const runDir = path.join(RUNS_DIR, `test-${String(num).padStart(3, '0')}`);
  const resultsPath = path.join(runDir, 'results.json');
  if (!_ex(resultsPath)) return null;
  return JSON.parse(_rfs(resultsPath, 'utf8'));
}

// ─── Rehydrate state from results.json on startup ───────────────────────────
function rehydrateState(results) {
  state.testedNodes = results.filter(r => r.actualMbps != null).length;
  state.failedNodes = results.filter(r => r.actualMbps == null).length;
  // Do NOT set totalNodes here — it must come from snapshot (last known chain total).
  // results.length = how many we tested, NOT how many exist on chain.
  state.passed10 = results.filter(r => r.actualMbps != null && r.actualMbps >= 10).length;
  state.passed15 = results.filter(r => r.actualMbps != null && r.actualMbps >= 15).length;
  state.passedBaseline = results.filter(r => {
    const thresh = r.dynamicThreshold != null ? r.dynamicThreshold : (r.baselineAtTest != null ? r.baselineAtTest * 0.5 : null);
    return thresh != null && r.actualMbps >= thresh;
  }).length;
}

{
  const results = getResults();
  if (results.length > 0) {
    rehydrateState(results);
    state.status = 'idle';

    // Restore volatile state (history, balance, baseline) from snapshot
    try {
      const snap = JSON.parse(_rfs(STATE_SNAPSHOT_FILE, 'utf8'));
      if (snap.baselineHistory?.length) state.baselineHistory = snap.baselineHistory;
      if (snap.nodeSpeedHistory?.length) state.nodeSpeedHistory = snap.nodeSpeedHistory;
      // Don't restore spentUdvpn from snapshot — it accumulates across restarts
      // and causes negative balance display. Balance is queried fresh from chain on audit start.
      // Only restore for display purposes, capped to prevent negative.
      if (snap.balanceUdvpn) state.balanceUdvpn = snap.balanceUdvpn;
      if (snap.spentUdvpn) state.spentUdvpn = Math.min(snap.spentUdvpn, state.balanceUdvpn);
      const remaining = Math.max(0, state.balanceUdvpn - state.spentUdvpn);
      state.balance = `${(remaining / 1_000_000).toFixed(4)} DVPN`;
      if (snap.estimatedTotalCost) state.estimatedTotalCost = snap.estimatedTotalCost;
      if (snap.startedAt) state.startedAt = snap.startedAt;
      if (snap.baselineMbps) state.baselineMbps = snap.baselineMbps;
      if (snap.totalNodes) state.totalNodes = snap.totalNodes;
      console.log(`State snapshot restored: baseline=${snap.baselineHistory?.length || 0} readings, speeds=${snap.nodeSpeedHistory?.length || 0} nodes, total=${state.totalNodes}`);
    } catch { }

    // Resume the active test — DON'T create a new one on restart
    const index = loadRunsIndex();
    if (index.runs.length === 0) {
      // First ever boot — save as Test #1
      const num = saveCurrentRun('Initial Audit');
      console.log(`Saved existing data as Test #${num}`);
    }
    // Always resume the last active test number
    state.activeRunNumber = index.activeRun || (index.runs.length > 0 ? index.runs[index.runs.length - 1].number : 1);

    console.log(`Resuming Test #${state.activeRunNumber} | ${results.length} results: ${state.testedNodes} passed, ${state.failedNodes} failed | SDK: ${state.activeSDK}`);
  }
}

// ─── Express ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Fast stats-only (no results payload) — for instant page load
app.get('/api/stats', (req, res) => {
  res.json({ state });
});

// Full state + results
app.get('/api/state', (req, res) => {
  const results = getResults();
  res.json({ state, results });
});

app.get('/api/results', (req, res) => {
  const results = getResults();
  const page = parseInt(req.query.page || '1', 10);
  const limit = parseInt(req.query.limit || '100', 10);
  const start = (page - 1) * limit;
  res.json({ total: results.length, page, results: results.slice(start, start + limit) });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const results = getResults();
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: 'init', state, results, logs: logBuffer.slice() });
  const handler = (data) => send(data);
  emitter.on('update', handler);
  req.on('close', () => emitter.off('update', handler));
});

// ─── Audit Control Routes ───────────────────────────────────────────────────

// Start NEW test (saves current, clears, starts fresh)
app.post('/api/start', async (req, res) => {
  if (state.status === 'running' || state.status === 'paused') return res.json({ error: 'Already running' });
  if (!MNEMONIC) return res.json({ error: 'MNEMONIC not set in .env' });

  // Save current results before starting fresh — NEVER lose data
  const prevResults = getResults();
  if (prevResults.length > 0) {
    const runDir = path.join(RUNS_DIR, `test-${String(state.activeRunNumber).padStart(3, '0')}`);
    try { _mkd(runDir, { recursive: true }); } catch { }
    _wfs(path.join(runDir, 'results.json'), JSON.stringify(prevResults, null, 2), 'utf8');
    // Also save failures snapshot
    try { _cp(path.join(__dirname, 'results', 'failures.jsonl'), path.join(runDir, 'failures.jsonl')); } catch { }
    const idx = loadRunsIndex();
    const existingRun = idx.runs.find(r => r.number === state.activeRunNumber);
    if (!existingRun) {
      // Auto-register this run in the index
      idx.runs.push({
        number: state.activeRunNumber,
        label: `Auto-save before Test #${getNextRunNumber()}`,
        date: new Date().toISOString(),
        total: prevResults.length,
        passed: prevResults.filter(r => r.actualMbps != null).length,
        failed: prevResults.filter(r => r.actualMbps == null).length,
        pass10: prevResults.filter(r => r.pass10mbps).length,
        sdk: state.activeSDK || 'js',
      });
      saveRunsIndex(idx);
    }
    broadcast('log', { msg: `💾 Saved Test #${state.activeRunNumber} (${prevResults.length} results) before starting fresh` });
  }

  const newNum = getNextRunNumber();
  state.activeRunNumber = newNum;
  state.stopRequested = false;

  // Clear state snapshot for fresh test
  try { _wfs(STATE_SNAPSHOT_FILE, '{}', 'utf8'); } catch { }

  // Create run directory and set it as active — results save here continuously
  const newRunDir = path.join(RUNS_DIR, `test-${String(newNum).padStart(3, '0')}`);
  try { _mkd(newRunDir, { recursive: true }); } catch { }
  setActiveRunDir(newRunDir);

  // Update runs index with new test
  const idx2 = loadRunsIndex();
  idx2.activeRun = newNum;
  saveRunsIndex(idx2);

  const SDK_LABELS = { js: 'Blue JS', csharp: 'Blue C#', tkd: 'TKD JS' };
  broadcast('log', { msg: `🚀 Starting Test #${newNum} (${SDK_LABELS[state.activeSDK] || state.activeSDK} SDK, ${process.platform === 'win32' ? 'Windows' : process.platform})` });
  res.json({ ok: true, testNumber: newNum });
  runAudit(false, state, broadcast).then(() => {
    saveCurrentRun(`Test #${newNum}`);
    broadcast('log', { msg: `💾 Test #${newNum} complete and saved` });
  }).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    broadcast('state', { state });
  });
});

// Resume CURRENT test from where it left off (skips already-tested nodes)
app.post('/api/resume', async (req, res) => {
  if (state.status === 'running' || state.status === 'paused') return res.json({ error: 'Already running' });
  if (!MNEMONIC) return res.json({ error: 'MNEMONIC not set in .env' });
  const results = getResults();
  if (results.length === 0) return res.json({ error: 'No results to resume from. Use Start to begin a new test.' });
  state.stopRequested = false;
  // Ensure run directory exists and is active for continuous saves
  const resumeRunDir = path.join(RUNS_DIR, `test-${String(state.activeRunNumber).padStart(3, '0')}`);
  try { _mkd(resumeRunDir, { recursive: true }); } catch { }
  setActiveRunDir(resumeRunDir);

  broadcast('log', { msg: `▶ Resuming Test #${state.activeRunNumber} from node ${results.length + 1} (${results.length} already tested, SDK: ${state.activeSDK.toUpperCase()})` });
  res.json({ ok: true, testNumber: state.activeRunNumber, resumeFrom: results.length });
  runAudit(true, state, broadcast).then(() => {
    // Update saved run with final results
    saveCurrentRun(`Test #${state.activeRunNumber}`);
    broadcast('log', { msg: `💾 Test #${state.activeRunNumber} saved` });
  }).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    broadcast('state', { state });
  });
});

app.post('/api/stop', (req, res) => { state.stopRequested = true; res.json({ ok: true }); });

app.post('/api/economy', (req, res) => {
  state.economyMode = !state.economyMode;
  broadcast('state', { state });
  broadcast('log', { msg: `${state.economyMode ? '♻ Economy mode ON — caps nodes to what balance can afford' : '💳 Economy mode OFF — tests all nodes'}` });
  res.json({ ok: true, economyMode: state.economyMode });
});

app.post('/api/retest-skips', async (req, res) => {
  if (state.status === 'running' || state.status === 'paused') return res.json({ error: 'Already running' });
  if (!MNEMONIC) return res.json({ error: 'MNEMONIC not set in .env' });
  const results = getResults();
  const skipAddrs = results.filter(r => r.actualMbps == null && /unreachable/i.test(r.error || '')).map(r => r.address);
  if (skipAddrs.length === 0) return res.json({ error: 'No unreachable failures to retest' });
  state.stopRequested = false;
  res.json({ ok: true, retesting: skipAddrs.length });
  runRetestSkips(skipAddrs, state, broadcast).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    broadcast('state', { state });
  });
});

app.post('/api/retest-fails', async (req, res) => {
  if (state.status === 'running' || state.status === 'paused') return res.json({ error: 'Already running' });
  if (!MNEMONIC) return res.json({ error: 'MNEMONIC not set in .env' });
  const results = getResults();
  const specific = req.body?.addresses;
  const failAddrs = specific && specific.length > 0
    ? specific
    : results.filter(r => r.error && r.actualMbps == null
        && !r.error.includes('insufficient funds')
        && !r.error.includes('domainsocket')
      ).map(r => r.address);
  if (failAddrs.length === 0) return res.json({ error: 'No failures to retest' });
  state.stopRequested = false;
  res.json({ ok: true, retesting: failAddrs.length, addresses: failAddrs });
  runRetestSkips(failAddrs, state, broadcast).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    broadcast('state', { state });
  });
});

// DEPRECATED: Plan testing is WIP — hidden from dashboard, endpoint still functional for API callers
app.post('/api/test-plan', async (req, res) => {
  if (state.status === 'running' || state.status === 'paused') return res.json({ error: 'Already running' });
  if (!MNEMONIC) return res.json({ error: 'MNEMONIC not set in .env' });
  const { planId } = req.body;
  if (!planId) return res.status(400).json({ error: 'planId required' });
  state.stopRequested = false;
  res.json({ ok: true, planId });
  runPlanTest(parseInt(planId), state, broadcast).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    broadcast('state', { state });
  });
});

app.get('/api/plans', async (req, res) => {
  try {
    const { discoverPlans } = await import('./core/chain.js');
    const plans = await discoverPlans(null, { maxId: 100 });
    plans.sort((a, b) => b.subscribers - a.subscribers);
    res.json({ plans });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/subscriptions', async (req, res) => {
  try {
    const { querySubscriptions } = await import('./core/chain.js');
    const subs = await querySubscriptions(state.walletAddress);
    res.json({ subscriptions: subs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clear', (req, res) => {
  const results = getResults();
  results.length = 0;
  state.testedNodes = state.failedNodes = state.passed15 = state.passed10 = state.passedBaseline = 0;
  state.retryCount = 0;
  state.baselineHistory = [];
  state.nodeSpeedHistory = [];
  saveResults();
  broadcast('state', { state, results });
  res.json({ ok: true });
});

// ─── Failure Analysis API ────────────────────────────────────────────────────
app.get('/api/failure-analysis', (req, res) => {
  const results = getResults();
  const failed = results.filter(r => r.actualMbps == null);
  const analysis = {
    total: results.length,
    passed: results.filter(r => r.actualMbps != null).length,
    failed: failed.length,
    successRate: results.length > 0 ? ((results.filter(r => r.actualMbps != null).length / results.length) * 100).toFixed(1) + '%' : '0%',
    categories: {},
    retestable: [],
    dead: [],
  };

  for (const r of failed) {
    const err = r.error || '';
    let cat, retestable = false, reason;

    if (/already exists/i.test(err)) {
      cat = '409_SESSION_EXISTS'; retestable = true; reason = 'Indexing race — retry with delay';
    } else if (/invalid status inactive|Code: 105/i.test(err)) {
      cat = 'CODE_105_INACTIVE'; retestable = true; reason = 'LCD stale — may have reactivated';
    } else if (/invalid price|code: 106/i.test(err)) {
      cat = 'INVALID_PRICE'; retestable = true; reason = 'Chain rejects price — retry without max_price';
    } else if (/V2Ray service dead|TCP port.*not reachable/i.test(err)) {
      cat = 'TCP_PORT_DEAD'; retestable = false; reason = 'V2Ray proxy down on node';
    } else if (/timed out/i.test(err)) {
      cat = 'NODE_TIMEOUT'; retestable = true; reason = 'Node slow or overloaded — retry later';
    } else if (/address mismatch/i.test(err)) {
      cat = 'ADDRESS_MISMATCH'; retestable = false; reason = 'Node config wrong';
    } else if (/ABCI query failed/i.test(err)) {
      cat = 'NODE_RPC_BROKEN'; retestable = true; reason = 'RPC congestion — may be transient';
    } else if (/timeout of (45|90)000ms/i.test(err)) {
      cat = 'HANDSHAKE_TIMEOUT'; retestable = true; reason = 'Node overloaded — retry later';
    } else if (/duplicate payment/i.test(err)) {
      cat = 'DUPLICATE_PAYMENT'; retestable = true; reason = 'Code bug fixed — should pass now';
    } else if (/SOCKS5.*no internet/i.test(err)) {
      cat = 'SOCKS5_NO_CONNECTIVITY'; retestable = true; reason = 'Tunnel routing dead — intermittent';
    } else if (/database corrupt/i.test(err)) {
      cat = 'NODE_DB_CORRUPT'; retestable = false; reason = 'Node DB broken';
    } else if (/insufficient/i.test(err)) {
      cat = 'INSUFFICIENT_FUNDS'; retestable = false; reason = 'Need more P2P';
    } else {
      cat = 'OTHER'; retestable = true; reason = 'Unknown — worth retrying';
    }

    if (!analysis.categories[cat]) analysis.categories[cat] = { count: 0, retestable, reason, nodes: [] };
    analysis.categories[cat].count++;
    analysis.categories[cat].nodes.push({
      address: r.address, moniker: r.moniker, country: r.country,
      city: r.city, peers: r.peers, type: r.type,
      error: (r.error || '').slice(0, 100),
    });

    if (retestable && r.peers > 0) analysis.retestable.push(r.address);
    else analysis.dead.push(r.address);
  }

  res.json(analysis);
});

// ─── Rescan: re-fetch node list from chain to verify current total ───────────
app.post('/api/rescan', async (req, res) => {
  try {
    broadcast('log', { msg: '🔍 Rescanning chain for current node count...' });
    await ensureLcd();
    const allNodes = await getAllNodes(broadcast);
    const testedAddrs = new Set(getResults().map(r => r.address));
    const remaining = allNodes.filter(n => !testedAddrs.has(n.address)).length;
    state.totalNodes = testedAddrs.size + remaining;
    broadcast('state', { state });
    broadcast('log', { msg: `Rescan: ${allNodes.length} nodes on chain, ${testedAddrs.size} tested, ${remaining} remaining` });
    res.json({ total: allNodes.length, tested: testedAddrs.size, remaining });
  } catch (err) {
    broadcast('log', { msg: `Rescan failed: ${err.message}` });
    res.json({ error: err.message });
  }
});

// ─── Transport Intelligence Cache API ────────────────────────────────────────
app.get('/api/transport-cache', (req, res) => {
  loadTransportCache();
  res.json(getCacheStats());
});

// Auto-retest: analyze failures, retest all retestable nodes in one shot
app.post('/api/auto-retest', async (req, res) => {
  if (state.status === 'running' || state.status === 'paused') return res.json({ error: 'Already running' });
  if (!MNEMONIC) return res.json({ error: 'MNEMONIC not set in .env' });

  const force = req.body?.force === true;
  const results = getResults();
  // Iron Rule: peers > 0 = our fault. Also include peers: null (unknown) for retest.
  const failed = results.filter(r => r.actualMbps == null && r.error);
  const retestable = force ? failed : failed.filter(r => {
    const err = r.error || '';
    if (/No udvpn pricing/i.test(err)) return false;
    return true;
  });

  if (retestable.length === 0) return res.json({ error: 'No retestable failures found' });

  state.stopRequested = false;
  res.json({ ok: true, retesting: retestable.length, addresses: retestable.map(r => r.address) });

  const { runRetestSkips } = await import('./audit/pipeline.js');
  runRetestSkips(retestable.map(r => r.address), state, broadcast).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    broadcast('state', { state });
  });
});

// ─── Test Run Management API ────────────────────────────────────────────────
app.get('/api/runs', (req, res) => {
  const index = loadRunsIndex();
  res.json({ runs: index.runs, activeRun: state.activeRunNumber });
});

app.post('/api/runs/save', (req, res) => {
  const label = req.body?.label || '';
  const num = saveCurrentRun(label);
  if (num) {
    state.activeRunNumber = num;
    broadcast('log', { msg: `💾 Saved as Test #${num}` });
    res.json({ ok: true, number: num });
  } else {
    res.json({ error: 'No results to save' });
  }
});

app.get('/api/runs/:num', (req, res) => {
  const num = parseInt(req.params.num);
  const data = loadRun(num);
  if (!data) return res.status(404).json({ error: `Test #${num} not found` });
  const passed = data.filter(r => r.actualMbps != null);
  const failed = data.filter(r => r.actualMbps == null);
  res.json({
    number: num,
    total: data.length,
    passed: passed.length,
    failed: failed.length,
    pass10: passed.filter(r => r.actualMbps >= 10).length,
    results: data,
  });
});

app.post('/api/runs/load/:num', (req, res) => {
  const num = parseInt(req.params.num);
  const data = loadRun(num);
  if (!data) return res.status(404).json({ error: `Test #${num} not found` });

  // Replace current results with loaded run
  const results = getResults();
  results.length = 0;
  results.push(...data);
  saveResults();
  rehydrateState(data);
  state.activeRunNumber = num;
  state.status = 'idle';
  broadcast('state', { state, results: data });
  broadcast('log', { msg: `📂 Loaded Test #${num} (${data.length} results)` });
  res.json({ ok: true, number: num, total: data.length });
});

// ─── SDK Toggle ─────────────────────────────────────────────────────────────
app.post('/api/sdk', (req, res) => {
  const { sdk } = req.body;
  const SDK_LABELS = { js: 'Blue JS', csharp: 'Blue C#', tkd: 'TKD JS (Official)' };
  if (SDK_LABELS[sdk]) {
    state.activeSDK = sdk;
    try { _wfs(SDK_PREF_FILE, sdk, 'utf8'); } catch {}
    broadcast('state', { state });
    broadcast('log', { msg: `SDK switched to ${SDK_LABELS[sdk]}` });
    res.json({ ok: true, sdk });
  } else {
    res.status(400).json({ error: 'Invalid SDK. Use "js", "csharp", or "tkd"' });
  }
});

app.get('/api/sdk', (req, res) => {
  res.json({ sdk: state.activeSDK });
});

// ─── Health Check (prelaunch validation for AI/automation) ─────────────────
app.get('/api/health', async (req, res) => {
  const { checkV2Ray } = process.platform === 'win32'
    ? await import('./platforms/windows/v2ray.js')
    : { checkV2Ray: async () => { try { const { execSync } = await import('child_process'); execSync('which v2ray', { stdio: 'pipe' }); return true; } catch { return false; } } };
  const v2ray = await checkV2Ray();
  const issues = [];
  if (!MNEMONIC) issues.push('MNEMONIC not set in .env — copy .env.example to .env and add your wallet mnemonic');
  if (!IS_ADMIN && WG_AVAILABLE) issues.push('Not running as Administrator — WireGuard nodes will fail. Use SentinelAudit.vbs (Windows) or sudo (macOS/Linux)');
  if (!v2ray) issues.push('V2Ray binary not found — download from https://github.com/v2fly/v2ray-core/releases and place in bin/');
  if (!WG_AVAILABLE && process.platform === 'win32') issues.push('WireGuard not installed — install from https://www.wireguard.com/install/');
  res.json({
    status: issues.length === 0 ? 'ready' : 'issues',
    platform: process.platform,
    admin: IS_ADMIN,
    mnemonic: MNEMONIC ? 'set' : 'missing',
    wireguard: WG_AVAILABLE,
    v2ray,
    sdk: state.activeSDK,
    balance: state.balance || 'unknown',
    issues,
  });
});

// ─── Cross-SDK Comparison Data ─────────────────────────────────────────────
app.get('/api/cross-sdk', (req, res) => {
  // Build a map of nodeAddress → { sdk: { passed, speed, error, run, date } } from all saved runs
  const map = {};
  const idx = loadRunsIndex();
  for (const run of (idx.runs || [])) {
    const runDir = path.join(RUNS_DIR, `test-${String(run.number).padStart(3, '0')}`);
    const rFile = path.join(runDir, 'results.json');
    if (!existsSync(rFile)) continue;
    let results;
    try { results = JSON.parse(_rfs(rFile, 'utf8')); } catch { continue; }
    const sdk = run.sdk || 'js';
    const runDate = run.date || '';
    const runNum = run.number;
    for (const r of results) {
      if (!r.address) continue;
      if (!map[r.address]) map[r.address] = {};
      const passed = r.actualMbps != null && r.actualMbps > 0;
      if (!map[r.address][sdk] || (passed && !map[r.address][sdk].passed)) {
        map[r.address][sdk] = { passed, speed: r.actualMbps, error: r.error?.slice(0, 60) || null, run: runNum, date: runDate };
      }
    }
  }
  // Also include current live results
  const currentResults = getResults();
  const currentSdk = state.activeSDK || 'js';
  const now = new Date().toISOString();
  for (const r of currentResults) {
    if (!r.address) continue;
    if (!map[r.address]) map[r.address] = {};
    const passed = r.actualMbps != null && r.actualMbps > 0;
    if (!map[r.address][currentSdk] || (passed && !map[r.address][currentSdk].passed)) {
      map[r.address][currentSdk] = { passed, speed: r.actualMbps, error: r.error?.slice(0, 60) || null, run: state.activeRunNumber, date: now };
    }
  }
  res.json(map);
});

// ─── DNS Configuration ──────────────────────────────────────────────────────
app.get('/api/dns', (req, res) => {
  res.json({ servers: ACTIVE_DNS, presets: Object.keys(DNS_PRESETS) });
});

app.post('/api/dns', (req, res) => {
  const { preset, servers } = req.body || {};
  if (preset && DNS_PRESETS[preset]) {
    setActiveDns([...DNS_PRESETS[preset]]);
    broadcast('log', { msg: `🔧 DNS changed to ${preset}: ${DNS_PRESETS[preset].join(', ')}` });
    return res.json({ ok: true, servers: DNS_PRESETS[preset], preset });
  }
  if (servers && Array.isArray(servers) && servers.length > 0) {
    setActiveDns(servers);
    broadcast('log', { msg: `🔧 DNS changed to custom: ${servers.join(', ')}` });
    return res.json({ ok: true, servers });
  }
  res.status(400).json({ error: 'Provide preset (default|hns|cloudflare|google) or servers array' });
});

// ─── Dictator Mode ──────────────────────────────────────────────────────────
app.get('/dictator', (req, res) => res.sendFile(path.join(__dirname, 'dictator.html')));

app.get('/api/dictator', (req, res) => {
  const results = getResults();
  const countryMap = {};
  for (const r of results) {
    const country = r.country || 'Unknown';
    if (!countryMap[country]) {
      countryMap[country] = {
        country,
        total: 0,
        tested: 0,
        googleYes: 0,
        googleNo: 0,
        googleUnknown: 0,
        googleLatencySum: 0,
        googleLatencyCount: 0,
        nodes: [],
      };
    }
    const c = countryMap[country];
    c.total++;
    if (r.actualMbps != null) c.tested++;
    if (r.googleAccessible === true) {
      c.googleYes++;
      if (r.googleLatencyMs != null) {
        c.googleLatencySum += r.googleLatencyMs;
        c.googleLatencyCount++;
      }
    } else if (r.googleAccessible === false) {
      c.googleNo++;
    } else {
      c.googleUnknown++;
    }
    c.nodes.push({
      address: r.address,
      moniker: r.moniker,
      city: r.city,
      googleAccessible: r.googleAccessible,
      googleLatencyMs: r.googleLatencyMs,
      actualMbps: r.actualMbps,
      type: r.type,
      error: r.error || null,
    });
  }
  const countries = Object.values(countryMap)
    .map(c => ({
      country: c.country,
      total: c.total,
      tested: c.tested,
      googleYes: c.googleYes,
      googleNo: c.googleNo,
      googleUnknown: c.googleUnknown,
      avgGoogleLatencyMs: c.googleLatencyCount > 0
        ? Math.round(c.googleLatencySum / c.googleLatencyCount)
        : null,
      nodes: c.nodes,
    }))
    .sort((a, b) => a.country.localeCompare(b.country));
  res.json({ sdk: state.activeSDK, countries, generatedAt: new Date().toISOString() });
});

// ─── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Server Startup ─────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\nSentinel Node Audit Dashboard → http://localhost:${PORT}`);
  console.log(`Dictator Mode → http://localhost:${PORT}/dictator\n`);
  if (!IS_ADMIN) {
    console.warn('⚠  NOT running as Administrator — WireGuard tests will be skipped.');
  } else {
    console.log('✓  Running as Administrator — WireGuard tunnels will work without UAC.\n');
  }

  if (!MNEMONIC) {
    console.log('┌──────────────────────────────────────────────────────────────┐');
    console.log('│  No MNEMONIC configured — dashboard is view-only.           │');
    console.log('│                                                              │');
    console.log('│  To run audits:                                              │');
    console.log('│    1. Copy .env.example to .env                              │');
    console.log('│    2. Add your Sentinel wallet mnemonic                      │');
    console.log('│    3. Restart the server                                     │');
    console.log('└──────────────────────────────────────────────────────────────┘');
  }

  if (MNEMONIC) {
    try {
      const w = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'sent' });
      const [acc] = await w.getAccounts();
      state.walletAddress = acc.address;
      const tmpClient = await SigningStargateClient.connectWithSigner(
        'https://rpc.sentinel.co:443', w,
        { gasPrice: GasPrice.fromString(GAS_PRICE) },
      );
      const bal = await tmpClient.getBalance(acc.address, DENOM);
      state.balanceUdvpn = parseInt(bal?.amount || '0', 10);
      state.spentUdvpn = 0; // Real chain balance is the truth — reset estimate
      state.balance = `${(state.balanceUdvpn / 1_000_000).toFixed(4)} DVPN`;
      state.estimatedTotalCost = '0 DVPN';
      tmpClient.disconnect();
      console.log(`Wallet: ${acc.address} | Balance: ${state.balance}`);
      // Broadcast fresh balance to any SSE clients that connected before chain query finished
      broadcast('state', { state });
    } catch (err) {
      console.error('Failed to fetch initial balance:', err.message);
    }
  }

  // ─── Periodic balance refresh (runs even when idle) ────────────────────────
  if (MNEMONIC) {
    setInterval(async () => {
      // Skip refresh during active audit — pipeline handles its own refresh
      if (state.status === 'running' || state.status === 'paused_balance') return;
      try {
        const w = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'sent' });
        const [acc] = await w.getAccounts();
        const tmpClient = await SigningStargateClient.connectWithSigner(
          'https://rpc.sentinel.co:443', w,
          { gasPrice: GasPrice.fromString(GAS_PRICE) },
        );
        const bal = await tmpClient.getBalance(acc.address, DENOM);
        const fresh = parseInt(bal?.amount || '0', 10);
        tmpClient.disconnect();
        if (fresh !== state.balanceUdvpn) {
          state.balanceUdvpn = fresh;
          state.spentUdvpn = 0;
          state.balance = `${(fresh / 1_000_000).toFixed(4)} DVPN`;
          broadcast('state', { state });
        }
      } catch { /* non-critical */ }
    }, 2 * 60_000); // Every 2 minutes
  }
});
