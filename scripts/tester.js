/**
 * Sentinel dVPN Node Performance Tester
 * Tests every active Sentinel node for:
 *   - Actual download speed (Mbps)
 *   - Pass/fail: >= 15 Mbps
 *   - Within 30% of node's reported benchmark
 *
 * Supports both WireGuard and V2Ray node types.
 * Run as Administrator (required for WireGuard tunnel management).
 */

import 'dotenv/config';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { GasPrice, assertIsDeliverTxSuccess } from '@cosmjs/stargate';
import Long from 'long';

import {
  SentinelClient,
  SigningSentinelClient,
  Wireguard,
  V2Ray,
  postSession,
  signSessionId,
  privKeyFromMnemonic,
  nodeStatus,
  Status,
  PageRequest,
  NodeEventCreateSubscription,
  isNodeEventCreateSubscription,
  SessionEventStart,
  isSessionEventStart,
  nodeSubscribe,
  sessionStart,
  sessionEnd,
  searchEvent,
  NodeVPNType,
} from '@sentinel-official/sentinel-js-sdk';

import { connectWireGuard, disconnectWireGuard, WG_AVAILABLE } from './lib/wireguard-win.js';
import { speedtestDirect, speedtestViaSocks5, sleep } from './lib/speedtest.js';
import { initLogger, saveResult, printResult, printSummary, log } from './lib/logger.js';

// ─── Config ──────────────────────────────────────────────────────────────────
const MNEMONIC    = process.env.MNEMONIC;
const RPC         = process.env.RPC         || 'https://rpc.sentinel.co:443';
const DENOM       = process.env.DENOM       || 'udvpn';
const GAS_PRICE   = process.env.GAS_PRICE   || '0.2udvpn';
const GIGS        = parseInt(process.env.GIGABYTES_PER_NODE || '1', 10);
const TEST_MB     = parseInt(process.env.TEST_MB   || '25', 10);
const MAX_NODES   = parseInt(process.env.MAX_NODES || '0', 10);
const NODE_DELAY  = parseInt(process.env.NODE_DELAY_MS || '5000', 10);

// CLI flags
const args = process.argv.slice(2);
const ONLY_TYPE = args.includes('--type') ? args[args.indexOf('--type') + 1] : null;
// e.g. --type wireguard or --type v2ray

if (!MNEMONIC) {
  console.error('ERROR: MNEMONIC not set in .env');
  process.exit(1);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  initLogger();

  console.log('Sentinel dVPN Node Tester');
  console.log('─'.repeat(50));

  // 1. Init wallet
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'sent' });
  const [account] = await wallet.getAccounts();
  const privkey = await privKeyFromMnemonic({ mnemonic: MNEMONIC });

  console.log(`Wallet: ${account.address}`);

  // 2. Check balance
  const queryClient = await SentinelClient.connect(RPC);
  const balances = await queryClient.getAllBalances(account.address);
  const dvpnBal = balances.find(b => b.denom === DENOM);
  console.log(`Balance: ${dvpnBal ? `${dvpnBal.amount} ${DENOM}` : '0 ' + DENOM}`);

  // 3. Init signing client
  const client = await SigningSentinelClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString(GAS_PRICE),
  });

  // 4. Get ALL active nodes (paginate through all pages)
  console.log('\nFetching all active nodes...');
  const allNodes = await getAllNodes(queryClient);
  console.log(`Found ${allNodes.length} active nodes`);
  log(`Found ${allNodes.length} active nodes`);

  // Filter by type if requested
  const testNodes = ONLY_TYPE
    ? allNodes  // type filter applied after nodeStatus call
    : allNodes;

  const nodesToTest = MAX_NODES > 0 ? testNodes.slice(0, MAX_NODES) : testNodes;
  console.log(`Testing ${nodesToTest.length} nodes${MAX_NODES ? ` (capped at ${MAX_NODES})` : ''}`);
  console.log('─'.repeat(50));

  // WireGuard availability check
  if (!WG_AVAILABLE) {
    console.warn('\n⚠️  WireGuard not found. WireGuard nodes will be skipped.');
    console.warn('   Install from: https://download.wireguard.com/windows-client/wireguard-installer.exe');
    console.warn('   Then run this script as Administrator.\n');
  }

  // V2Ray availability check
  const v2rayAvailable = await checkV2Ray();
  if (!v2rayAvailable) {
    console.warn('\n⚠️  v2ray not found in PATH. V2Ray nodes will be skipped.');
    console.warn('   Install from: https://github.com/v2fly/v2ray-core/releases\n');
  }

  // 5. Test each node
  let tested = 0, passed15 = 0, withinBenchmark = 0;

  for (let i = 0; i < nodesToTest.length; i++) {
    const node = nodesToTest[i];
    console.log(`\n[${i + 1}/${nodesToTest.length}] ${node.address}`);

    try {
      const result = await testNode(client, account, privkey, node, {
        testMb: TEST_MB,
        gigabytes: GIGS,
        denom: DENOM,
        v2rayAvailable,
        onlyType: ONLY_TYPE,
      });

      if (result === null) continue; // skipped (offline or wrong type)

      tested++;
      if (result.pass15mbps)      passed15++;
      if (result.withinBenchmark) withinBenchmark++;

      saveResult(result);
      printResult(result);

    } catch (err) {
      const errResult = {
        timestamp: new Date().toISOString(),
        address: node.address,
        type: 'UNKNOWN',
        moniker: '',
        country: '',
        city: '',
        reportedDownloadMbps: 0,
        actualMbps: null,
        pass15mbps: false,
        withinBenchmark: false,
        error: err.message,
      };
      saveResult(errResult);
      console.error(`  ERROR: ${err.message}`);
      log(`ERROR [${node.address}]: ${err.message}`);
    }

    // Always ensure WireGuard tunnel is cleaned up
    try { await disconnectWireGuard(); } catch {}

    // Delay between nodes
    if (i < nodesToTest.length - 1) await sleep(NODE_DELAY);
  }

  printSummary(allNodes.length, tested, passed15, withinBenchmark);
}

// ─── Test a single node ───────────────────────────────────────────────────────
async function testNode(client, account, privkey, node, opts) {
  const { testMb, gigabytes, denom, v2rayAvailable, onlyType } = opts;

  // A) Check node is online + get type/bandwidth
  let status;
  try {
    status = await Promise.race([
      nodeStatus(node.remoteUrl),
      sleep(15_000).then(() => { throw new Error('nodeStatus timeout'); }),
    ]);
  } catch (err) {
    console.log(`  Offline: ${err.message}`);
    log(`SKIP [${node.address}] offline: ${err.message}`);
    return null;
  }

  const typeName = status.type === NodeVPNType.WIREGUARD ? 'WireGuard' : 'V2Ray';

  // Filter by requested type
  if (onlyType) {
    if (onlyType === 'wireguard' && status.type !== NodeVPNType.WIREGUARD) return null;
    if (onlyType === 'v2ray'     && status.type !== NodeVPNType.V2RAY)     return null;
  }

  // Skip if required tool unavailable
  if (status.type === NodeVPNType.WIREGUARD && !WG_AVAILABLE) {
    console.log(`  Skipping WireGuard node (wg tools not found)`);
    return null;
  }
  if (status.type === NodeVPNType.V2RAY && !v2rayAvailable) {
    console.log(`  Skipping V2Ray node (v2ray not found)`);
    return null;
  }

  const reportedDownloadMbps = status.bandwidth.download * 8 / 1_000_000;
  console.log(`  Type: ${typeName} | Reported: ${reportedDownloadMbps.toFixed(1)} Mbps | Location: ${status.location.city}, ${status.location.country}`);

  // B) Subscribe to node (1 GB)
  console.log(`  Subscribing...`);
  let subscriptionId;
  try {
    const subTx = await client.nodeSubscribe({
      from: account.address,
      nodeAddress: node.address,
      gigabytes: Long.fromNumber(gigabytes, true),
      denom,
    });
    assertIsDeliverTxSuccess(subTx);

    const subEvent = searchEvent(NodeEventCreateSubscription.type, subTx.events);
    if (!subEvent || !isNodeEventCreateSubscription(subEvent)) {
      throw new Error('No NodeEventCreateSubscription event in tx');
    }
    subscriptionId = NodeEventCreateSubscription.parse(subEvent).value.id;
    console.log(`  Subscription ID: ${subscriptionId}`);
  } catch (err) {
    throw new Error(`Subscribe failed: ${err.message}`);
  }

  // C) Start session on-chain
  console.log(`  Starting session...`);
  let sessionId;
  try {
    const sessTx = await client.sessionStart({
      from: account.address,
      id: subscriptionId,
      address: node.address,
    });
    assertIsDeliverTxSuccess(sessTx);

    const sessEvent = searchEvent(SessionEventStart.type, sessTx.events);
    if (!sessEvent || !isSessionEventStart(sessEvent)) {
      throw new Error('No SessionEventStart event in tx');
    }
    sessionId = SessionEventStart.parse(sessEvent).value.id;
    console.log(`  Session ID: ${sessionId}`);
  } catch (err) {
    throw new Error(`Session start failed: ${err.message}`);
  }

  // D) Wait for chain sync
  console.log(`  Waiting for chain sync (15s)...`);
  await sleep(15_000);

  // E) Get VPN config from node REST API
  console.log(`  Getting VPN config from node...`);
  let vpn, vpnKey;

  if (status.type === NodeVPNType.WIREGUARD) {
    vpn = new Wireguard();
    vpnKey = vpn.publicKey;
  } else {
    vpn = new V2Ray();
    vpnKey = vpn.getKey();
  }

  const signature = signSessionId(privkey, sessionId);
  const sessionResp = await postSession(vpnKey, signature, account.address, sessionId, node.remoteUrl);

  if (!sessionResp.success) {
    throw new Error(`Node session API error: ${JSON.stringify(sessionResp.error)}`);
  }

  await vpn.parseConfig(sessionResp.result);

  // F) Connect + Speedtest
  console.log(`  Connecting...`);
  let actualMbps = null;

  try {
    if (status.type === NodeVPNType.WIREGUARD) {
      await connectWireGuard(vpn);
      await sleep(5_000); // wait for tunnel
      console.log(`  Running speedtest (${testMb} MB download)...`);
      const result = await speedtestDirect(testMb);
      actualMbps = result.mbps;
      console.log(`  Speed: ${actualMbps} Mbps (${result.seconds.toFixed(1)}s)`);
      await disconnectWireGuard();

    } else {
      // V2Ray — connect as SOCKS5 proxy on port 1080
      vpn.connect();
      await sleep(3_000); // wait for proxy
      console.log(`  Running speedtest via SOCKS5:1080 (${testMb} MB download)...`);
      const result = await speedtestViaSocks5(testMb, 1080);
      actualMbps = result.mbps;
      console.log(`  Speed: ${actualMbps} Mbps (${result.seconds.toFixed(1)}s)`);
      vpn.disconnect();
    }
  } catch (err) {
    // Always clean up even on speedtest failure
    try {
      if (status.type === NodeVPNType.WIREGUARD) await disconnectWireGuard();
      else vpn.disconnect();
    } catch {}
    throw new Error(`Speedtest failed: ${err.message}`);
  }

  // G) End session on-chain
  try {
    await client.sessionEnd({
      from: account.address,
      id: sessionId,
      rating: Long.fromNumber(0, true),
    });
  } catch (err) {
    // Non-fatal — session will expire naturally
    log(`WARN: sessionEnd failed for ${sessionId}: ${err.message}`);
  }

  // H) Return result
  const pass15mbps      = actualMbps >= 15;
  const withinBenchmark = actualMbps >= (reportedDownloadMbps * 0.70); // within 30%

  return {
    timestamp: new Date().toISOString(),
    address: node.address,
    type: typeName,
    moniker: status.moniker || '',
    country: status.location.country || '',
    city: status.location.city || '',
    reportedDownloadMbps: parseFloat(reportedDownloadMbps.toFixed(2)),
    actualMbps,
    pass15mbps,
    withinBenchmark,
    peers: status.peers,
    maxPeers: status.qos?.max_peers,
    gigabytePrices: status.gigabyte_prices || '',
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getAllNodes(client) {
  const nodes = [];
  let nextKey = undefined;

  do {
    const res = await client.sentinelQuery?.node.nodes(
      Status.STATUS_ACTIVE,
      PageRequest.fromPartial({ limit: 100, key: nextKey, countTotal: !nextKey })
    );
    if (res?.nodes) nodes.push(...res.nodes);
    nextKey = res?.pagination?.nextKey;
  } while (nextKey && nextKey.length > 0);

  return nodes;
}

async function checkV2Ray() {
  try {
    const { execSync } = await import('child_process');
    execSync('v2ray version', { stdio: 'pipe', encoding: 'utf8' });
    return true;
  } catch {}
  try {
    const { execSync } = await import('child_process');
    execSync('v2ray.exe version', { stdio: 'pipe', encoding: 'utf8' });
    return true;
  } catch {}
  return false;
}

// ─── Entry ───────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('Fatal error:', err);
  log(`FATAL: ${err.stack}`);
  process.exit(1);
});
