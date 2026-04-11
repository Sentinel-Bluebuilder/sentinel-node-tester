/**
 * Sentinel Node Tester — Easy Integration API
 *
 * Drop-in node testing for any application. Three functions, zero config complexity.
 *
 * Quick start:
 *   import { audit, testOne, getNodes } from 'sentinel-node-tester/easy';
 *
 *   // Test all nodes (full audit)
 *   const results = await audit({ mnemonic: 'your twelve words...' });
 *
 *   // Test a single node
 *   const result = await testOne({ mnemonic: '...', node: 'sentnode1abc...' });
 *
 *   // Just list online nodes (free, no wallet needed)
 *   const nodes = await getNodes();
 */

import { getAllNodes, queryNodeStatusDirect, cleanupRpc } from './core/chain.js';
import { cachedWalletSetup, createFreshClient, buildV3Registry } from './core/wallet.js';
import { findExistingSession, submitBatchPayment, clearPaidNodes, buildSessionMap } from './core/session.js';
import { testNode } from './audit/node-test.js';
import { testWithRetry } from './audit/retry.js';
import { loadTransportCache, saveTransportCache } from './core/transport-cache.js';
import { speedtestDirect, resolveSpeedtestIPs } from './protocol/speedtest.js';
import { DENOM } from './core/constants.js';

// ─── getNodes() — List online nodes (no wallet needed) ────────────────────

/**
 * Fetch all online Sentinel dVPN nodes from the blockchain.
 * No wallet or payment required — this is a free read-only query.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxNodes=0] - Limit results (0 = all)
 * @param {string} [opts.country] - Filter by country name (e.g. 'United States')
 * @param {'wireguard'|'v2ray'} [opts.type] - Filter by VPN protocol
 * @param {boolean} [opts.withStatus=false] - Include peer count and bandwidth (slower, queries each node)
 * @param {function} [opts.onProgress] - Progress callback: ({ total, checked, online }) => void
 * @returns {Promise<Array<{ address, remoteUrl, country, city, type, peers, bandwidth, prices }>>}
 *
 * @example
 *   const nodes = await getNodes();
 *   console.log(`${nodes.length} nodes online`);
 *
 * @example
 *   const usNodes = await getNodes({ country: 'United States', type: 'wireguard' });
 */
export async function getNodes(opts = {}) {
  const { maxNodes = 0, country, type, withStatus = false, onProgress } = opts;

  const raw = await getAllNodes(null);
  let nodes = raw;

  // Enrich with status if requested
  if (withStatus) {
    const enriched = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      try {
        const status = await queryNodeStatusDirect(node.address);
        enriched.push({
          address: node.address,
          remoteUrl: node.remoteUrl,
          country: status?.location?.country || '',
          city: status?.location?.city || '',
          type: status?.type || 'unknown',
          peers: status?.peers || 0,
          bandwidth: status?.bandwidth || { download: 0, upload: 0 },
          moniker: status?.moniker || '',
          prices: node.gigabyte_prices || [],
        });
      } catch {
        enriched.push({ address: node.address, remoteUrl: node.remoteUrl, type: 'unknown', peers: 0, prices: node.gigabyte_prices || [] });
      }
      if (onProgress) onProgress({ total: nodes.length, checked: i + 1, online: enriched.filter(n => n.peers > 0).length });
    }
    nodes = enriched;
  } else {
    nodes = raw.map(n => ({
      address: n.address,
      remoteUrl: n.remoteUrl,
      prices: n.gigabyte_prices || [],
      planIds: n.planIds || [],
    }));
  }

  // Filter
  if (country) nodes = nodes.filter(n => n.country?.toLowerCase().includes(country.toLowerCase()));
  if (type) nodes = nodes.filter(n => n.type === type);
  if (maxNodes > 0) nodes = nodes.slice(0, maxNodes);

  return nodes;
}

// ─── testOne() — Test a single node ───────────────────────────────────────

/**
 * Test a single node for VPN connectivity and speed.
 * Pays for a 1GB session, connects, measures throughput, disconnects.
 *
 * @param {object} opts
 * @param {string} opts.mnemonic - Wallet mnemonic (12 or 24 words)
 * @param {string} opts.node - Node address (sentnode1...)
 * @param {number} [opts.gigabytes=1] - GB to allocate (1 = minimum, ~40 P2P)
 * @param {number} [opts.testMb=10] - MB to download for speed test
 * @param {function} [opts.onLog] - Log callback: (message: string) => void
 * @returns {Promise<{ pass, speed, type, country, city, moniker, peers, google, error }>}
 *
 * @example
 *   const result = await testOne({
 *     mnemonic: 'your twelve words...',
 *     node: 'sentnode1qx2p7kyep6m44ae47yh9zf3cfxrzrv5zt9vdnj',
 *   });
 *   console.log(result.pass ? `PASS: ${result.speed} Mbps` : `FAIL: ${result.error}`);
 */
export async function testOne(opts) {
  const { mnemonic, node: nodeAddr, gigabytes = 1, testMb = 10, onLog } = opts;
  if (!mnemonic) throw new Error('mnemonic is required');
  if (!nodeAddr) throw new Error('node address is required');

  const broadcast = onLog ? (type, data) => { if (type === 'log') onLog(data.msg); } : null;
  loadTransportCache();

  const { wallet, account, privkey } = await cachedWalletSetup(mnemonic);
  const client = await createFreshClient(wallet, broadcast);

  // Get node info
  const allNodes = await getAllNodes(broadcast);
  const nodeData = allNodes.find(n => n.address === nodeAddr);
  if (!nodeData) throw new Error(`Node ${nodeAddr} not found on chain`);

  // Get baseline speed
  await resolveSpeedtestIPs();
  const baseline = await speedtestDirect(5);
  const baselineMbps = baseline?.mbps || null;

  // Build state object for testNode
  const state = {
    activeSDK: 'js',
    stopRequested: false,
    balanceUdvpn: 0,
    spentUdvpn: 0,
    balance: '',
    estimatedTotalCost: '',
  };

  const { result, error } = await testWithRetry(
    () => testNode(client, account, privkey, nodeData,
      { testMb, gigabytes, denom: DENOM, v2rayAvailable: true, baselineMbps },
      null, broadcast, state,
    ),
    broadcast, state, nodeAddr,
  );

  saveTransportCache();
  cleanupRpc();

  if (result) {
    return {
      pass: true,
      speed: result.actualMbps,
      type: result.type,
      country: result.country,
      city: result.city,
      moniker: result.moniker,
      peers: result.peers,
      google: result.googleAccessible,
      error: null,
    };
  }
  return {
    pass: false,
    speed: null,
    type: null,
    country: null,
    city: null,
    moniker: null,
    peers: null,
    google: null,
    error: error?.message || 'Unknown error',
  };
}

// ─── audit() — Full network audit ─────────────────────────────────────────

/**
 * Run a full network audit. Tests every online node (or a subset).
 * Returns an array of results with pass/fail, speed, and diagnostics.
 *
 * Cost: ~40 P2P per node. Full audit of 1000 nodes ≈ 700-800 P2P.
 *
 * @param {object} opts
 * @param {string} opts.mnemonic - Wallet mnemonic (12 or 24 words)
 * @param {number} [opts.maxNodes=0] - Max nodes to test (0 = all online)
 * @param {number} [opts.gigabytes=1] - GB per node session
 * @param {number} [opts.testMb=10] - MB to download per speed test
 * @param {function} [opts.onResult] - Per-result callback: (result) => void
 * @param {function} [opts.onLog] - Log callback: (message: string) => void
 * @param {function} [opts.onProgress] - Progress callback: ({ tested, total, passed, failed }) => void
 * @returns {Promise<{ results, summary }>}
 *
 * @example
 *   const { results, summary } = await audit({
 *     mnemonic: 'your twelve words...',
 *     maxNodes: 50,
 *     onProgress: ({ tested, total }) => console.log(`${tested}/${total}`),
 *   });
 *   console.log(`${summary.passed}/${summary.tested} passed, avg ${summary.avgSpeed} Mbps`);
 *
 * @example
 *   // Embed in Express app
 *   app.post('/api/audit', async (req, res) => {
 *     const { results, summary } = await audit({
 *       mnemonic: process.env.MNEMONIC,
 *       maxNodes: 20,
 *     });
 *     res.json(summary);
 *   });
 */
export async function audit(opts) {
  const { mnemonic, maxNodes = 0, gigabytes = 1, testMb = 10, onResult, onLog, onProgress } = opts;
  if (!mnemonic) throw new Error('mnemonic is required');

  const broadcast = (type, data) => {
    if (type === 'log' && onLog) onLog(data.msg);
    if (type === 'result' && onResult) onResult(data.result);
  };

  loadTransportCache();
  const { wallet, account, privkey } = await cachedWalletSetup(mnemonic);
  const client = await createFreshClient(wallet, broadcast);

  // Fetch and scan nodes
  const allNodes = await getAllNodes(broadcast);
  let testableNodes = allNodes;
  if (maxNodes > 0) testableNodes = testableNodes.slice(0, maxNodes);

  // Get baseline
  await resolveSpeedtestIPs();
  const baseline = await speedtestDirect(5);
  const baselineMbps = baseline?.mbps || null;

  // Build sessions and test
  const results = [];
  const state = {
    activeSDK: 'js',
    stopRequested: false,
    balanceUdvpn: 0,
    spentUdvpn: 0,
    balance: '',
    estimatedTotalCost: '',
  };

  for (let i = 0; i < testableNodes.length; i++) {
    const node = testableNodes[i];
    const { result, error } = await testWithRetry(
      () => testNode(client, account, privkey, node,
        { testMb, gigabytes, denom: DENOM, v2rayAvailable: true, baselineMbps },
        null, broadcast, state,
      ),
      broadcast, state, node.address,
    );

    if (result) {
      results.push(result);
    } else if (error) {
      results.push({
        address: node.address,
        pass: false,
        error: error.message,
        actualMbps: null,
      });
    }

    if (onProgress) {
      onProgress({
        tested: i + 1,
        total: testableNodes.length,
        passed: results.filter(r => r.actualMbps > 0).length,
        failed: results.filter(r => !r.actualMbps).length,
      });
    }
  }

  saveTransportCache();
  cleanupRpc();

  const passed = results.filter(r => r.actualMbps > 0);
  const summary = {
    tested: results.length,
    passed: passed.length,
    failed: results.length - passed.length,
    passRate: results.length > 0 ? (passed.length / results.length * 100).toFixed(1) + '%' : '0%',
    avgSpeed: passed.length > 0 ? (passed.reduce((s, r) => s + r.actualMbps, 0) / passed.length).toFixed(1) : 0,
    fastest: passed.length > 0 ? Math.max(...passed.map(r => r.actualMbps)).toFixed(1) : 0,
    slowest: passed.length > 0 ? Math.min(...passed.map(r => r.actualMbps)).toFixed(1) : 0,
  };

  return { results, summary };
}

// ─── middleware() — Express middleware for existing apps ───────────────────

/**
 * Express middleware that adds node testing API routes to your existing app.
 * Mount it at any path prefix.
 *
 * @param {object} opts
 * @param {string} opts.mnemonic - Wallet mnemonic
 * @param {string} [opts.prefix='/sentinel'] - Route prefix
 * @returns {import('express').Router}
 *
 * @example
 *   import express from 'express';
 *   import { middleware } from 'sentinel-node-tester/easy';
 *
 *   const app = express();
 *   app.use(middleware({ mnemonic: process.env.MNEMONIC }));
 *   // Now available: GET /sentinel/nodes, POST /sentinel/test, GET /sentinel/health
 *   app.listen(3000);
 */
export function middleware(opts = {}) {
  const { mnemonic, prefix = '/sentinel' } = opts;

  // Lazy import express Router to avoid hard dependency
  return async (req, res, next) => {
    const path = req.path;

    if (path === `${prefix}/nodes` && req.method === 'GET') {
      try {
        const nodes = await getNodes({ withStatus: false });
        res.json({ count: nodes.length, nodes });
      } catch (e) { res.status(500).json({ error: e.message }); }
      return;
    }

    if (path === `${prefix}/test` && req.method === 'POST') {
      const { node, maxNodes } = req.body || {};
      try {
        if (node) {
          const result = await testOne({ mnemonic, node, onLog: msg => console.log(msg) });
          res.json(result);
        } else {
          const { results, summary } = await audit({ mnemonic, maxNodes: maxNodes || 10 });
          res.json({ summary, results });
        }
      } catch (e) { res.status(500).json({ error: e.message }); }
      return;
    }

    if (path === `${prefix}/health` && req.method === 'GET') {
      res.json({
        status: mnemonic ? 'ready' : 'no_mnemonic',
        platform: process.platform,
        mnemonic: mnemonic ? 'set' : 'missing',
      });
      return;
    }

    next();
  };
}
