/**
 * test — End-to-end test a single node (consumes gas + session payment).
 */

import { MNEMONIC, DENOM, GIGS, TEST_MB } from '../../core/constants.js';
import { ensureLcd } from '../../core/chain.js';
import { cachedWalletSetup, createFreshClient } from '../../core/wallet.js';
import { getAllNodes } from '../../core/chain.js';
import { testNode } from '../../audit/node-test.js';
import { createState } from '../../audit/pipeline.js';

export const name = 'test';
export const description = 'End-to-end test a single node (consumes gas + session payment).';
export const usage = 'sentinel-audit test <sentnode1...> [--timeout 120] [--pretty]';
export const flags = [
  { name: '--timeout', desc: 'Seconds per phase', default: '120' },
  { name: '--verbose', desc: 'Log broadcast events to stderr', default: 'false' },
];

export async function run({ positional, flags: f }) {
  const nodeAddr = positional[0];
  if (!nodeAddr) throw new Error('Missing required argument: sentnode1... address');
  if (!nodeAddr.startsWith('sentnode1')) {
    throw new Error(`Invalid node address: expected sentnode1... prefix, got "${nodeAddr}"`);
  }
  if (!MNEMONIC || !MNEMONIC.trim()) {
    throw new Error('MNEMONIC not set in .env — cannot sign transactions');
  }

  const timeoutMs = (parseInt(f['--timeout'] || '120', 10)) * 1_000;
  const verbose = f['--verbose'] === 'true' || f['--verbose'] === true;

  // ─── LCD + wallet setup ──────────────────────────────────────────────────
  await ensureLcd();
  const { wallet, account, privkey } = await cachedWalletSetup(MNEMONIC);
  const client = await createFreshClient(wallet);

  // ─── Fetch node list and find target node ────────────────────────────────
  console.error(`[test] Fetching node list to locate ${nodeAddr}...`);
  const allNodes = await getAllNodes(null);
  const node = allNodes.find(n => n.address === nodeAddr);
  if (!node) {
    throw new Error(`Node not found on chain: ${nodeAddr}`);
  }
  console.error(`[test] Found node at ${node.remoteUrl}`);

  // ─── State scaffold ──────────────────────────────────────────────────────
  const state = createState();
  state.activeSDK = 'js';
  state.balanceUdvpn = 0;
  state.spentUdvpn = 0;

  // Fetch real balance so testNode's balance checks work correctly
  try {
    const balRes = await client.getBalance(account.address, DENOM);
    state.balanceUdvpn = parseInt(balRes?.amount || '0', 10);
    state.balance = `${(state.balanceUdvpn / 1_000_000).toFixed(4)} P2P`;
    console.error(`[test] Balance: ${state.balance}`);
  } catch (err) {
    console.error(`[test] Warning: could not fetch balance: ${err.message}`);
  }

  // ─── Broadcast (progress to stderr, not stdout) ──────────────────────────
  const broadcast = (event, data) => {
    if (verbose) {
      console.error(JSON.stringify({ event, data }));
    } else if (event === 'log' && data?.msg) {
      console.error(data.msg);
    }
  };

  // ─── v2ray availability (needed for testNode's skip logic) ──────────────
  let v2rayAvailable = false;
  try {
    if (process.platform === 'win32') {
      const { checkV2Ray } = await import('../../platforms/windows/v2ray.js');
      v2rayAvailable = await checkV2Ray();
    } else {
      const { execSync } = await import('child_process');
      try { execSync('which v2ray', { stdio: 'pipe' }); v2rayAvailable = true; } catch { }
    }
  } catch { }

  // ─── opts — matches what testNode destructures from opts ─────────────────
  const opts = {
    testMb: TEST_MB,
    gigabytes: GIGS,
    denom: DENOM,
    v2rayAvailable,
    baselineMbps: null,
    onlineTimeoutMs: Math.min(timeoutMs, 30_000),
    nodeStatus: null,
  };

  // ─── Run test ────────────────────────────────────────────────────────────
  console.error(`[test] Starting test for ${nodeAddr}...`);
  const result = await testNode(
    client,
    account,
    privkey,
    node,
    opts,
    null,       // preSessionId
    broadcast,
    state,
  );

  if (result === null) {
    return { skipped: true, reason: 'testNode returned null (WireGuard or V2Ray binary not available)' };
  }

  return result;
}
