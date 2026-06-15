/**
 * universal-test — One-shot end-to-end verification of every Sentinel Node
 * Tester subsystem. Runs each phase in sequence, captures pass/fail/timing,
 * and returns a consolidated report. Phases that need real funds use the
 * configured MNEMONIC wallet and consume gas (1udvpn self-send + ≤200k udvpn
 * fee per on-chain phase).
 *
 * Use this as the canonical health check before a release, after a refactor,
 * or to prove every code path still works against live mainnet.
 *
 *   sentinel-audit universal-test --pretty
 *   sentinel-audit universal-test --skip-paid          # read-only flows only
 *   sentinel-audit universal-test --plan 36            # override plan id
 */

import { MNEMONIC, DENOM, TEST_MB, GIGS } from '../../core/constants.js';
import {
  ensureLcd,
  getActiveLcd,
  withFreshRpc,
  discoverPlans,
  querySubscriptions,
  queryFeeGrantRpcFirst,
  rpcFetchAllNodesForPlanPaginated,
  getAllNodes,
} from '../../core/chain.js';
import { cachedWalletSetup, createFreshClient } from '../../core/wallet.js';
import { verifyAllSdks } from '../../core/sdk-verify.js';
import { speedtestDirect } from '../../protocol/speedtest.js';
import { encodeBatch, decodeMemo, resultToRecord, commitBatch } from '../../core/onchain-report.js';
import {
  getDb, useDb,
  insertRun, updateRunOnFinish, insertResultsBatch, insertErrorLog,
  getRun, findRunByKey, listRuns, getActiveRun, getLastCompletedRun,
  getLatestResultPerNode, getNodeHistory, getNetworkStats, getBandwidthHistory,
  getNodeErrors, getNodeDetail, searchNodes, getCountryList, searchErrors,
  insertBatch, updateBatchOnFinish, insertBatchResult, listBatches, getBatchResults,
  getActiveBatch, getLastBatch, closeDb,
} from '../../core/db.js';
import { toBase64 } from '@cosmjs/encoding';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';

export const name = 'universal-test';
export const description = 'Run every Sentinel Node Tester subsystem end-to-end and report per-phase pass/fail.';
export const usage = 'sentinel-audit universal-test [--plan 36] [--skip-paid] [--skip-tests] [--pretty]';
export const flags = [
  { flag: '--plan',       description: 'Plan ID to use for plan-nodes / feegrant phases. Default: 36.' },
  { flag: '--skip-paid',  description: 'Skip phases that broadcast TXs (single-node-test, sntr1-roundtrip).' },
  { flag: '--skip-tests', description: 'Skip the bundled test-suite phase (~30s).' },
  { flag: '--pretty',     description: 'Human-readable output.' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRunner() {
  const phases = [];
  return {
    phases,
    async run(name, fn) {
      const t0 = Date.now();
      try {
        const detail = await fn();
        phases.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? null });
      } catch (err) {
        phases.push({ name, ok: false, ms: Date.now() - t0, error: err?.message || String(err) });
      }
    },
  };
}

function summary(phases) {
  const passed = phases.filter(p => p.ok).length;
  const failed = phases.length - passed;
  return { total: phases.length, passed, failed, ok: failed === 0 };
}

function spawnNode(args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
    child.on('error', e => { clearTimeout(t); resolve({ code: -1, out, err: err + e.message }); });
  });
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export async function run({ flags: f = {} } = {}) {
  const planId = parseInt(f['--plan'] || '36', 10);
  const skipPaid = f['--skip-paid'] === true || f['--skip-paid'] === 'true';
  const skipTests = f['--skip-tests'] === true || f['--skip-tests'] === 'true';
  const pretty = !!f['--pretty'];

  const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname0, '..', '..');

  const r = makeRunner();
  const ctx = {};

  // 1. env
  await r.run('env', () => {
    if (!MNEMONIC || !MNEMONIC.trim()) throw new Error('MNEMONIC not set in .env');
    return { mnemonicLen: MNEMONIC.split(/\s+/).length, denom: DENOM };
  });

  // 2. sdk-verify
  await r.run('sdk-verify', async () => {
    const res = await verifyAllSdks(rootDir);
    const bad = Object.entries(res).filter(([, v]) => v.match === false).map(([k]) => k);
    if (bad.length) throw new Error(`SDK mismatch: ${bad.join(', ')}`);
    return Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { match: v.match, version: v.installed?.pkg }]));
  });

  // 3. rpc-connect
  await r.run('rpc-connect', async () => {
    const height = await withFreshRpc(async (rpc) => {
      const status = await rpc?.tmClient?.status?.();
      return status?.syncInfo?.latestBlockHeight ?? null;
    }, 'status').catch(() => null);
    ctx.height = height;
    return { latestBlockHeight: height };
  });

  // 4. wallet
  await r.run('wallet', async () => {
    await ensureLcd();
    const { wallet, account } = await cachedWalletSetup(MNEMONIC);
    const client = await createFreshClient(wallet);
    const bal = await client.getBalance(account.address, DENOM);
    ctx.wallet = wallet;
    ctx.account = account;
    ctx.client = client;
    ctx.balanceUdvpn = parseInt(bal?.amount || '0', 10);
    return { address: account.address, balanceUdvpn: ctx.balanceUdvpn };
  });

  // 5. plans
  await r.run('plans', async () => {
    const plans = await discoverPlans();
    if (!Array.isArray(plans) || plans.length === 0) throw new Error('discoverPlans returned no plans');
    return { count: plans.length, sampleIds: plans.slice(0, 5).map(p => p.id) };
  });

  // 6. subscriptions
  await r.run('subscriptions', async () => {
    if (!ctx.account) throw new Error('wallet phase failed — no account');
    const subs = await querySubscriptions(ctx.account.address);
    ctx.subs = Array.isArray(subs) ? subs : [];
    return { count: ctx.subs.length };
  });

  // 7. fee-grants
  await r.run('fee-grants', async () => {
    if (!ctx.account) throw new Error('wallet phase failed — no account');
    const sub = (ctx.subs || []).find(s => String(s.plan_id || s.planId) === String(planId));
    if (!sub) return { skipped: true, reason: `no active subscription for plan ${planId}` };
    const granter = sub.granter || sub.subscriptionGranter || sub.ownerAddress || sub.plan_owner || sub.planOwner;
    if (!granter) return { skipped: true, reason: 'subscription has no granter' };
    const lcd = getActiveLcd();
    const fg = await withFreshRpc(
      (rpc) => queryFeeGrantRpcFirst(rpc, lcd, granter, ctx.account.address),
      'queryFeeGrant',
    ).catch(() => null);
    return { granter, hasFeeGrant: !!fg };
  });

  // 8. plan-nodes
  await r.run('plan-nodes', async () => {
    let nodes = [];
    let source = 'rpc';
    try {
      nodes = await withFreshRpc(
        (rpc) => rpcFetchAllNodesForPlanPaginated(rpc, planId, () => {}),
        `rpcFetchAllNodesForPlan(${planId})`,
      );
    } catch { nodes = []; }
    if (!nodes || nodes.length === 0) {
      source = 'getAllNodes-filter';
      const all = await getAllNodes(null);
      nodes = (all || []).filter(n => Array.isArray(n.plans) && n.plans.includes(planId));
    }
    if (!nodes || nodes.length === 0) throw new Error(`Plan ${planId}: no nodes via RPC or fallback`);
    ctx.planNodes = nodes.map(n => {
      if (n.remoteUrl) return n;
      const raw = (n.remote_addrs || []).map(a => a.startsWith('http') ? a : `https://${a}`);
      return {
        address: n.address,
        remoteUrl: raw[0] || '',
        remoteAddrs: raw,
        gigabyte_prices: n.gigabyte_prices || [],
        status: n.status ?? 1,
        planIds: [planId],
      };
    });
    return { source, count: ctx.planNodes.length };
  });

  // 9. plan-reachability — mirror dashboard's scanNodesParallel against the
  //    full plan-node population. Catches the case where every plan node is
  //    unreachable (DNS dead, TLS broken, port closed) — exactly what
  //    `single-node-test` misses by giving up after 5 candidates.
  await r.run('plan-reachability', async () => {
    if (!ctx.planNodes || ctx.planNodes.length === 0) throw new Error('no plan nodes from prior phase');
    const { scanNodesParallel } = await import('../../audit/pipeline.js');
    const probeNodes = ctx.planNodes.filter(n => n && n.remoteUrl);
    if (!probeNodes.length) throw new Error('plan has nodes but none expose a remoteUrl');
    const fakeState = {};
    const t0 = Date.now();
    const online = await scanNodesParallel(probeNodes, 25, null, fakeState);
    const elapsedMs = Date.now() - t0;
    const total = probeNodes.length;
    const onlineCount = online.length;
    const offline = total - onlineCount;
    const onlinePct = total ? (onlineCount / total) * 100 : 0;
    const errorBuckets = fakeState.lastScanErrorBuckets || online.errorBuckets || {};
    ctx.reachableNodes = online.map(o => o.node);
    ctx.reachability = { total, online: onlineCount, offline, onlinePct, errorBuckets, elapsedMs };
    const minOnline = 1;
    const minPctThreshold = 1; // <1% online indicates a systemic problem.
    if (onlineCount < minOnline || onlinePct < minPctThreshold) {
      const top = Object.entries(errorBuckets)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, v]) => `${k}:${v}`)
        .join(' ');
      throw new Error(
        `plan ${planId} unreachable: ${onlineCount}/${total} online (${onlinePct.toFixed(1)}%) [${top || 'no error buckets'}]`,
      );
    }
    return {
      total, online: onlineCount, offline,
      onlinePct: Number(onlinePct.toFixed(2)),
      errorBuckets, elapsedMs,
    };
  });

  // 10. baseline-speed
  await r.run('baseline-speed', async () => {
    const res = await speedtestDirect();
    const mbps = typeof res === 'number' ? res : res?.mbps;
    if (!Number.isFinite(mbps) || mbps <= 0) throw new Error(`baseline=${mbps}`);
    ctx.baselineMbps = mbps;
    return { baselineMbps: Number(mbps.toFixed(2)) };
  });

  // 10. single-node-test (paid)
  if (!skipPaid) {
    await r.run('single-node-test', async () => {
      const { testNode } = await import('../../audit/node-test.js');
      const { createState } = await import('../../audit/pipeline.js');
      if (!ctx.planNodes || ctx.planNodes.length === 0) throw new Error('no plan nodes available');
      // Prefer reachable subset from plan-reachability — picking from there
      // means we exercise a node we *know* responded to nodeStatusV3, not the
      // first 5 in an arbitrary list that may all be dead.
      const pool = (ctx.reachableNodes && ctx.reachableNodes.length)
        ? ctx.reachableNodes
        : ctx.planNodes;
      const candidates = pool.filter(n => n.remoteUrl && n.address);
      if (!candidates.length) throw new Error('no candidate node with remoteUrl');
      const { privKeyFromMnemonic } = await import('../../core/wallet.js');
      const privkey = await privKeyFromMnemonic(MNEMONIC);
      const tried = [];
      let result = null;
      // Try up to 5 candidates — testNode returns null when the picked node's
      // type doesn't match available transports (V2Ray binary not present, etc.).
      for (let i = 0; i < Math.min(5, candidates.length) && !result; i++) {
        const candidate = candidates[i];
        const state = createState();
        state.activeSDK = 'js';
        state.balanceUdvpn = ctx.balanceUdvpn;
        state.spentUdvpn = 0;
        try {
          const r2 = await testNode(
            ctx.client, ctx.account, privkey, candidate,
            { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable: false, baselineMbps: ctx.baselineMbps, onlineTimeoutMs: 20_000, nodeStatus: null },
            null, () => {}, state,
          );
          if (r2) { result = r2; break; }
          tried.push({ address: candidate.address, reason: 'type mismatch (likely V2Ray)' });
        } catch (err) {
          tried.push({ address: candidate.address, reason: err?.message || String(err) });
        }
      }
      ctx.singleResult = result;
      if (!result) throw new Error(`no compatible node out of ${tried.length} tried`);
      return { address: result.address, errorCode: result.errorCode || null, actualMbps: result.actualMbps, attempted: tried.length + 1 };
    });
  } else {
    r.phases.push({ name: 'single-node-test', ok: true, ms: 0, detail: { skipped: true, reason: '--skip-paid' } });
  }

  // 11. sntr1-roundtrip (paid)
  if (!skipPaid) {
    await r.run('sntr1-roundtrip', async () => {
      const fakeResults = (ctx.planNodes || []).slice(0, 2).map((n, i) => ({
        address: n.address,
        actualMbps: i === 0 ? 12.3 : null,
        errorCode: i === 0 ? null : 'TIMEOUT',
        peers: 5 + i,
        diag: { handshakeLatencyMs: 150 + i * 10 },
      }));
      const records = fakeResults.map(resultToRecord).filter(Boolean);
      if (records.length < 1) throw new Error('no encodable records');
      const encoded = encodeBatch({ region: 'US', baselineMbps: ctx.baselineMbps || 0, startedAt: Date.now() }, records);
      const decoded = decodeMemo(toBase64(encoded));
      if (!decoded || decoded.count !== records.length) throw new Error('local round-trip failed');
      const tx = await commitBatch(ctx.client, ctx.account.address, encoded, () => {});
      return { localRoundTrip: true, txhash: tx.txhash, height: tx.height, memoBase64Bytes: tx.base64Bytes };
    });
  } else {
    r.phases.push({ name: 'sntr1-roundtrip', ok: true, ms: 0, detail: { skipped: true, reason: '--skip-paid' } });
  }

  // 12. index-exports — every export from index.js resolves to a defined value
  await r.run('index-exports', async () => {
    const idx = await import(pathToFileURL(path.join(rootDir, 'index.js')).href);
    const names = Object.keys(idx);
    const undef = names.filter(n => idx[n] === undefined);
    if (undef.length) throw new Error(`undefined exports: ${undef.join(', ')}`);
    const fnCount = names.filter(n => typeof idx[n] === 'function').length;
    return { totalExports: names.length, functions: fnCount };
  });

  // 13. cli-commands — invoke each read-only CLI command in-process
  await r.run('cli-commands', async () => {
    const cmds = ['list', 'functions', 'verify-sdks', 'plans', 'subscriptions', 'balance', 'nodes'];
    const out = {};
    for (const c of cmds) {
      const filePath = path.join(rootDir, 'bin', 'commands', `${c}.js`);
      if (!existsSync(filePath)) { out[c] = { ok: false, error: 'missing' }; continue; }
      try {
        const mod = await import(pathToFileURL(filePath).href);
        if (typeof mod.run !== 'function') { out[c] = { ok: false, error: 'no run()' }; continue; }
        const t0 = Date.now();
        const origLog = console.log;
        const origErr = console.error;
        console.log = () => {};
        console.error = () => {};
        let result;
        try {
          result = await mod.run({ command: c, positional: [], flags: {} });
        } finally {
          console.log = origLog;
          console.error = origErr;
        }
        out[c] = { ok: true, ms: Date.now() - t0, hasResult: result !== undefined };
      } catch (err) {
        out[c] = { ok: false, error: err?.message || String(err) };
      }
    }
    const failed = Object.entries(out).filter(([, v]) => !v.ok).map(([k, v]) => `${k}:${v.error}`);
    if (failed.length) throw new Error(failed.join('; '));
    return { tested: Object.keys(out).length, results: out };
  });

  // 14. test-suite — run the bundled tests and parse pass/fail counts
  if (!skipTests) {
    await r.run('test-suite', async () => {
      const testFiles = [
        'test/smoke.test.js',
        'test/db.smoke.test.js',
        'test/continuous.smoke.test.js',
        'test/security.test.js',
      ];
      const results = {};
      let totalPass = 0, totalFail = 0;
      for (const tf of testFiles) {
        const full = path.join(rootDir, tf);
        if (!existsSync(full)) { results[tf] = { skipped: 'missing' }; continue; }
        const { code, out, err } = await spawnNode([full], rootDir, 120_000);
        const combined = out + err;
        const m = combined.match(/(\d+)\s+passed,\s+(\d+)\s+failed/i);
        const passed = m ? parseInt(m[1], 10) : 0;
        const failed = m ? parseInt(m[2], 10) : (code === 0 ? 0 : -1);
        totalPass += passed;
        totalFail += Math.max(0, failed);
        results[tf] = { code, passed, failed };
        if (code !== 0) throw new Error(`${tf} exited ${code} (${passed}p/${failed}f)`);
      }
      return { files: testFiles.length, totalPass, totalFail, perFile: results };
    });
  } else {
    r.phases.push({ name: 'test-suite', ok: true, ms: 0, detail: { skipped: true, reason: '--skip-tests' } });
  }

  // 15. agent-endpoints — hit every safe public endpoint if a server is running
  await r.run('agent-endpoints', async () => {
    const port = process.env.PORT || '3001';
    const base = `http://127.0.0.1:${port}`;
    const probes = [
      '/health',
      '/api/public/nodes?limit=1',
      '/api/public/countries',
      '/api/public/stats',
      '/api/public/runs/last',
      '/api/public/runs',
      '/api/public/batches',
      '/api/public/logs',
      '/api/public/live-state',
      '/api/public/test/status',
      '/api/public/errors',
      '/api/broadcast',
    ];
    const out = {};
    let reachable = 0;
    for (const p of probes) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(base + p, { signal: ctrl.signal });
        clearTimeout(t);
        out[p] = res.status;
        if (res.status === 200) reachable++;
      } catch (e) {
        out[p] = e.message;
      }
    }
    if (reachable === 0) return { skipped: true, reason: `no server on ${base}`, probes: out };
    return { server: base, ok: reachable, total: probes.length, probes: out };
  });

  // 16. db-write
  await r.run('db-write', async () => {
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    const required = ['runs', 'results', 'error_logs', 'schema_version'];
    const missing = required.filter(t => !tables.includes(t));
    if (missing.length) throw new Error(`missing tables: ${missing.join(',')}`);
    const ver = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
    return { schemaVersion: ver?.version ?? null, tables: tables.length };
  });

  // 17. db-lifecycle — full 0→100 CRUD against an in-memory DB
  await r.run('db-lifecycle', async () => {
    const mem = getDb(':memory:');
    useDb(mem);

    const tables = mem.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name);
    const required = ['runs', 'results', 'error_logs', 'schema_version', 'batches', 'batch_results'];
    const missingTables = required.filter(t => !tables.includes(t));
    if (missingTables.length) throw new Error(`missing tables: ${missingTables.join(',')}`);

    const startedAt = Date.now() - 60_000;
    const runId = insertRun({
      started_at: startedAt, mode: 'p2p', plan_id: '36',
      wallet_address: 'sent1xxxtestxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      notes: 'universal-test lifecycle', tester_sdk: 'js',
    });
    if (!runId) throw new Error('insertRun returned no id');

    const fakeResults = [
      {
        address: 'sent1node1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        moniker: 'alpha', country: 'United States', city: 'Dallas', type: 'wireguard',
        reportedDownloadMbps: 100, actualMbps: 42.5,
        diag: { handshakeOk: true, latencyMs: 88 },
        timestamp: new Date().toISOString(), sdk: 'js', testerOs: process.platform,
      },
      {
        address: 'sent1node2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        moniker: 'beta', country: 'Germany', city: 'Berlin', type: 'v2ray',
        reportedDownloadMbps: 200, actualMbps: null,
        diag: { handshakeOk: false, latencyMs: null },
        error: 'handshake failed: address mismatch', errorCode: 'HANDSHAKE_FAILED',
        timestamp: new Date().toISOString(), sdk: 'js', testerOs: process.platform,
      },
      {
        address: 'sent1node3ccccccccccccccccccccccccccccccccccc',
        moniker: 'gamma', country: 'Japan', city: 'Tokyo', type: 'wireguard',
        reportedDownloadMbps: 50, actualMbps: 18.2,
        diag: { handshakeOk: true, latencyMs: 150 },
        timestamp: new Date().toISOString(), sdk: 'js', testerOs: process.platform,
      },
    ];
    insertResultsBatch(runId, fakeResults);

    const failedRow = mem.prepare('SELECT id FROM results WHERE node_addr = @addr').get({ addr: fakeResults[1].address });
    if (!failedRow) throw new Error('failed result row missing');
    const errLogId = insertErrorLog({
      result_id: failedRow.id, stage: 'handshake',
      error_code: 'HANDSHAKE_FAILED', error_message: 'address mismatch',
      log_snippet: 'tunnel up\nhandshake error: address mismatch\nreturning early',
    });
    if (!errLogId) throw new Error('insertErrorLog returned no id');

    updateRunOnFinish(runId, { finished_at: Date.now(), node_count: 3, pass_count: 2 });

    const got = getRun(runId);
    if (!got || got.pass_count !== 2 || got.node_count !== 3) throw new Error('getRun mismatch');

    const found = findRunByKey(startedAt, 'p2p');
    if (!found || found.id !== runId) throw new Error('findRunByKey mismatch');

    const allRuns = listRuns({ limit: 5 });
    if (!allRuns.some(r => r.id === runId)) throw new Error('listRuns missing run');

    const lastDone = getLastCompletedRun();
    if (!lastDone || lastDone.id !== runId) throw new Error('getLastCompletedRun missing');

    const active = getActiveRun();
    if (active) throw new Error('getActiveRun should be null after finish');

    const latest = getLatestResultPerNode({ limit: 50 });
    if (!Array.isArray(latest) || latest.length < 3) throw new Error(`latest count=${latest.length}`);

    const stats = getNetworkStats();
    if (!stats || typeof stats !== 'object') throw new Error('getNetworkStats null');

    const history = getNodeHistory(fakeResults[0].address);
    if (!history || history.length < 1) throw new Error('getNodeHistory empty');

    const bw = getBandwidthHistory(fakeResults[0].address, { limit: 10 });
    if (!Array.isArray(bw)) throw new Error('getBandwidthHistory not array');

    const detail = getNodeDetail(fakeResults[1].address);
    if (!detail || !detail.node || !Array.isArray(detail.errors)) throw new Error('getNodeDetail malformed');
    if (detail.errors.length < 1) throw new Error('getNodeDetail no errors');

    const nodeErrs = getNodeErrors(fakeResults[1].address);
    if (!nodeErrs.length) throw new Error('getNodeErrors empty');

    const search = searchNodes({ limit: 20, window: 5 });
    if (!Array.isArray(search) || search.length < 3) throw new Error(`searchNodes len=${search.length}`);

    const searchByCountry = searchNodes({ country: 'Germany', limit: 5, window: 5 });
    if (!searchByCountry.some(n => n.node_addr === fakeResults[1].address)) throw new Error('searchNodes country filter failed');

    const errSearch = searchErrors({ q: 'mismatch', limit: 5 });
    if (!errSearch || errSearch.total < 1 || !Array.isArray(errSearch.items) || errSearch.items.length < 1) {
      throw new Error(`searchErrors no match (total=${errSearch?.total})`);
    }

    const countries = getCountryList();
    if (!Array.isArray(countries) || countries.length < 1) throw new Error('getCountryList empty');

    // Batch lifecycle
    const batchId = insertBatch({ started_at: Date.now(), snapshot_size: 3, mode: 'p2p' });
    if (!batchId) throw new Error('insertBatch returned no id');
    const activeBatch = getActiveBatch();
    if (!activeBatch || !activeBatch.batch || activeBatch.batch.id !== batchId) throw new Error('getActiveBatch mismatch');
    insertBatchResult(batchId, fakeResults[0]);
    insertBatchResult(batchId, fakeResults[1]);
    updateBatchOnFinish(batchId, { finished_at: Date.now(), passed: 1, failed: 1 });
    const lastBatch = getLastBatch();
    if (!lastBatch || !lastBatch.batch || lastBatch.batch.id !== batchId) throw new Error('getLastBatch mismatch');
    const batchList = listBatches({ limit: 5 });
    if (!batchList.some(b => b.id === batchId)) throw new Error('listBatches missing batch');
    const batchRows = getBatchResults(batchId, { limit: 10 });
    if (!batchRows || !batchRows.batch || !Array.isArray(batchRows.results) || batchRows.results.length < 2) {
      throw new Error(`getBatchResults short (results=${batchRows?.results?.length})`);
    }

    // Verify raw_json round-trip. raw_json is offloaded to a per-run file
    // (results/raw/run-<id>/<rid>.json) and the column is NULL; getNodeHistory
    // rehydrates it from disk, so this exercises the full offload+rehydrate path.
    const rawHist = getNodeHistory(fakeResults[0].address, { limit: 1 });
    const parsed = JSON.parse(rawHist[0].raw_json);
    if (parsed.address !== fakeResults[0].address) throw new Error('raw_json round-trip failed');

    closeDb();
    useDb(getDb()); // restore real DB handle for subsequent phases (none after this point)

    return {
      runId, errLogId, batchId,
      runs: allRuns.length, results: latest.length, batchRows: batchRows.results.length,
      countries: countries.length, errSearch: errSearch.total,
      helpersExercised: 22,
    };
  });

  // 18. deploy-readiness — verify cross-platform install & Linux deployability
  await r.run('deploy-readiness', async () => {
    const issues = [];
    const warnings = [];

    const pkgPath = path.join(rootDir, 'package.json');
    if (!existsSync(pkgPath)) throw new Error('package.json missing');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

    if (!pkg.engines?.node) issues.push('package.json missing engines.node');
    if (!pkg.scripts?.start) issues.push('package.json missing scripts.start');
    if (!pkg.scripts?.test) issues.push('package.json missing scripts.test');
    if (!pkg.scripts?.postinstall) issues.push('package.json missing scripts.postinstall');
    if (pkg.type !== 'module') issues.push('package.json type must be "module"');

    const postinstallPath = path.join(rootDir, 'scripts', 'postinstall.js');
    if (!existsSync(postinstallPath)) issues.push('scripts/postinstall.js missing');
    const piSrc = readFileSync(postinstallPath, 'utf8');
    if (!piSrc.includes('linux-x64')) issues.push('postinstall.js missing linux-x64 mapping');
    if (!piSrc.includes('linux-arm64')) issues.push('postinstall.js missing linux-arm64 mapping');
    if (!piSrc.includes('chmodSync')) issues.push('postinstall.js missing chmod for unix exec bit');

    const platformsRoot = path.join(rootDir, 'platforms');
    for (const p of ['linux', 'macos', 'windows']) {
      const dir = path.join(platformsRoot, p);
      if (!existsSync(dir)) { issues.push(`platforms/${p} missing`); continue; }
      const files = readdirSync(dir);
      if (!files.some(f => f === 'wireguard.js')) issues.push(`platforms/${p}/wireguard.js missing`);
      if (p !== 'windows' && !files.some(f => f === 'v2ray.js')) issues.push(`platforms/${p}/v2ray.js missing`);
    }

    // CLI must declare a node bin entry and a shebang
    if (!pkg.bin?.['sentinel-audit']) issues.push('package.json bin.sentinel-audit missing');
    const cliPath = path.join(rootDir, 'bin', 'cli.js');
    if (!existsSync(cliPath)) issues.push('bin/cli.js missing');
    else {
      const head = readFileSync(cliPath, 'utf8').slice(0, 64);
      if (!head.startsWith('#!/usr/bin/env node')) issues.push('bin/cli.js missing shebang');
    }

    // Scan core/ for hardcoded Windows-only paths (allowed only inside platforms/windows/)
    // Allow files that explicitly branch on process.platform — those are platform-aware.
    const coreDir = path.join(rootDir, 'core');
    const coreFiles = readdirSync(coreDir).filter(f => f.endsWith('.js'));
    const winPathRe = /(C:\\\\|C:\/|\\bAppData\\b|\\bProgramFiles\\b)/i;
    const winLeaks = [];
    for (const f of coreFiles) {
      const src = readFileSync(path.join(coreDir, f), 'utf8');
      // Skip files that gate Windows code by process.platform — they're cross-platform aware.
      if (/process\.platform\s*===?\s*['"]win32['"]/.test(src)) continue;
      const lines = src.split('\n');
      lines.forEach((ln, i) => {
        if (/^\s*\/\//.test(ln) || /^\s*\*/.test(ln)) return;
        if (winPathRe.test(ln)) winLeaks.push(`${f}:${i + 1}`);
      });
    }
    if (winLeaks.length) warnings.push(`possible Windows-only refs in core/: ${winLeaks.slice(0, 5).join(', ')}${winLeaks.length > 5 ? '…' : ''}`);

    // Verify required runtime deps are pure-JS or have prebuilt linux binaries
    const portableDeps = Object.keys(pkg.dependencies || {});
    const nativeDeps = portableDeps.filter(d => d === 'better-sqlite3'); // known native via prebuilds
    // better-sqlite3 ships prebuilds for linux-x64 + linux-arm64 — fine.
    // No other native deps allowed without prebuilds; flag any unknown native modules.
    const knownPureOrPrebuilt = new Set([
      '@cosmjs/proto-signing', '@cosmjs/stargate', '@noble/curves',
      '@sentinel-official/sentinel-js-sdk', 'axios', 'better-sqlite3',
      'blue-js-sdk', 'cookie-parser', 'dotenv', 'express', 'long', 'socks-proxy-agent',
    ]);
    const unknownDeps = portableDeps.filter(d => !knownPureOrPrebuilt.has(d));
    if (unknownDeps.length) warnings.push(`unknown deps (verify Linux prebuilds): ${unknownDeps.join(', ')}`);

    // Node engine sanity — current process must satisfy engines.node
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    const engineSpec = pkg.engines?.node || '>=20.0.0';
    const minMajorMatch = engineSpec.match(/(\d+)/);
    const minMajor = minMajorMatch ? parseInt(minMajorMatch[1], 10) : null;
    if (Number.isFinite(minMajor) && nodeMajor < minMajor) {
      issues.push(`node ${process.versions.node} < required ${engineSpec}`);
    }

    // .env.example present so a fresh user knows what to set
    if (!existsSync(path.join(rootDir, '.env.example'))) issues.push('.env.example missing');

    // README + LICENSE
    if (!existsSync(path.join(rootDir, 'README.md'))) warnings.push('README.md missing');
    if (!existsSync(path.join(rootDir, 'LICENSE'))) warnings.push('LICENSE missing');

    if (issues.length) throw new Error(issues.join('; '));

    return {
      node: process.versions.node,
      requiredNode: pkg.engines.node,
      platform: process.platform,
      arch: process.arch,
      platformDirs: ['linux', 'macos', 'windows'],
      depsOk: portableDeps.length,
      nativeDeps,
      warnings,
    };
  });

  const sum = summary(r.phases);

  if (pretty) {
    const pad = (s, n) => String(s).padEnd(n);
    console.log('\n  Sentinel Node Tester — Universal Test');
    console.log('  ' + '─'.repeat(72));
    for (const p of r.phases) {
      const mark = p.ok ? '✓' : '✗';
      const detailStr = p.error
        ? `error: ${p.error}`
        : p.detail?.skipped ? `skipped (${p.detail.reason || ''})`
        : (p.detail?.warnings?.length ? `warn: ${p.detail.warnings[0]}` : '');
      console.log(`  ${mark} ${pad(p.name, 22)} ${pad(p.ms + 'ms', 10)} ${detailStr}`);
    }
    console.log('  ' + '─'.repeat(72));
    console.log(`  ${sum.ok ? 'ALL PASS' : 'FAIL'}: ${sum.passed}/${sum.total} phases passed (planId=${planId}, skipPaid=${skipPaid}, skipTests=${skipTests})\n`);
    process.exit(sum.ok ? 0 : 1);
  }

  return { ok: sum.ok, summary: sum, planId, skipPaid, skipTests, phases: r.phases };
}
