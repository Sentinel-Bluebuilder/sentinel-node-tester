/**
 * Live V2Ray connection test — finds a V2Ray node, pays, handshakes, tests IP.
 */
import 'dotenv/config';
import https from 'https';
import axios from 'axios';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

import { Bip39, EnglishMnemonic, Slip10, Slip10Curve } from '@cosmjs/crypto';
import { makeCosmoshubPath } from '@cosmjs/amino';
import { DirectSecp256k1HdWallet, Registry } from '@cosmjs/proto-signing';
import { SigningStargateClient, GasPrice, defaultRegistryTypes, assertIsDeliverTxSuccess } from '@cosmjs/stargate';

import {
  nodeStatusV3,
  initHandshakeV3V2Ray,
  buildV2RayClientConfig,
  encodeMsgStartSession,
  extractSessionId,
} from './lib/v3protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.PATH = path.join(__dirname, 'bin') + path.delimiter + (process.env.PATH || '');

const MNEMONIC  = process.env.MNEMONIC;
const RPC       = process.env.RPC       || 'https://rpc.sentinel.co:443';
const DENOM     = process.env.DENOM     || 'udvpn';
const GAS_PRICE = process.env.GAS_PRICE || '0.2udvpn';
const V3_MSG_TYPE = '/sentinel.node.v3.MsgStartSessionRequest';
const LCD_ENDPOINTS = [
  'https://sentinel-api.polkachu.com',
  'https://api.sentinel.quokkastake.io',
  'https://sentinel-rest.publicnode.com',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function privKeyFromMnemonic(mnemonic) {
  const seed = await Bip39.mnemonicToSeed(new EnglishMnemonic(mnemonic));
  const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, makeCosmoshubPath(0));
  return Buffer.from(privkey);
}

function buildRegistry() {
  const MsgStartSessionV3 = {
    fromPartial: (v) => v,
    encode: (i) => ({ finish: () => encodeMsgStartSession(i) }),
    decode: () => ({}),
  };
  return new Registry([...defaultRegistryTypes, [V3_MSG_TYPE, MsgStartSessionV3]]);
}

async function checkIP(label, proxyPort = null) {
  try {
    let ip;
    if (proxyPort) {
      const { SocksProxyAgent } = await import('socks-proxy-agent');
      const agent = new SocksProxyAgent(`socks5://127.0.0.1:${proxyPort}`);
      const r = await axios.get('https://api.ipify.org?format=json', { httpsAgent: agent, httpAgent: agent, timeout: 15000 });
      ip = r.data.ip;
    } else {
      const r = await axios.get('https://api.ipify.org?format=json', { timeout: 10000 });
      ip = r.data.ip;
    }
    console.log(`  [${label}] IP: ${ip}`);
    return ip;
  } catch (e) {
    console.log(`  [${label}] IP check FAILED: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log('\n====== Sentinel V2Ray Live Test ======\n');

  // Check v2ray binary
  const localV2Ray = path.join(__dirname, 'bin', 'v2ray.exe');
  const v2rayExe = existsSync(localV2Ray) ? localV2Ray : 'v2ray.exe';
  console.log(`v2ray.exe: ${existsSync(localV2Ray) ? localV2Ray + ' ✓' : 'not in bin/ — trying PATH'}`);

  const baseIp = await checkIP('BASELINE (no VPN)');
  console.log();

  // Wallet
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'sent' });
  const [account] = await wallet.getAccounts();
  const privKey = await privKeyFromMnemonic(MNEMONIC);
  console.log(`Wallet:  ${account.address}`);

  const registry = buildRegistry();
  const client = await SigningStargateClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString(GAS_PRICE), registry,
  });
  const balRes = await client.getBalance(account.address, DENOM);
  console.log(`Balance: ${(parseInt(balRes?.amount || '0') / 1e6).toFixed(4)} DVPN\n`);

  // Fetch nodes
  let lcd = null;
  for (const ep of LCD_ENDPOINTS) {
    try {
      const r = await fetch(`${ep}/sentinel/node/v3/nodes?status=1&pagination.limit=1`, { signal: AbortSignal.timeout(6000) });
      if (r.ok) { lcd = ep; break; }
    } catch {}
  }
  if (!lcd) throw new Error('No LCD endpoint reachable');

  // Known permanently broken V2Ray nodes (nil-UUID VMess/VLESS state or persistent proxy failure)
  const BROKEN_NODES = new Set([
    'sentnode1qqktst6793vdxknvvkewfcmtv9edh7vvdvavrj',
    'sentnode1qx2p7kyep6m44ae47yh9zf3cfxrzrv5zt9vdnj',  // us04.quinz.top — handshake OK but proxy always fails
  ]);

  // Collect ALL nodes — paginate fully
  console.log('Fetching all nodes (full paginate)...');
  const v2rayNodes = [];
  let nextKey = null;
  do {
    let url = `${lcd}/sentinel/node/v3/nodes?status=1&pagination.limit=100`;
    if (nextKey) url += `&pagination.key=${encodeURIComponent(nextKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    for (const n of (data.nodes || [])) {
      if (BROKEN_NODES.has(n.address)) continue;
      const rawAddr = (n.remote_addrs || [])[0] || '';
      v2rayNodes.push({
        address: n.address,
        remoteUrl: rawAddr.startsWith('http') ? rawAddr : `https://${rawAddr}`,
        gigabyte_prices: n.gigabyte_prices || [],
      });
    }
    nextKey = data.pagination?.next_key || null;
  } while (nextKey);

  console.log(`Total candidates fetched: ${v2rayNodes.length}\n`);
  console.log('Scanning for online V2Ray nodes in parallel (30 concurrent)...\n');

  // Parallel scan — 30 concurrent workers
  const candidateNodes = [];
  let scannedCount = 0;
  let idx = 0;
  const CONCURRENCY = 30;
  const MAX_CANDIDATES = 5;

  const pricedNodes = v2rayNodes.filter(n => n.gigabyte_prices.find(p => p.denom === DENOM));
  console.log(`Nodes with udvpn price: ${pricedNodes.length}`);

  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= pricedNodes.length || candidateNodes.length >= MAX_CANDIDATES) break;
      const node = pricedNodes[i];
      try {
        const status = await Promise.race([
          nodeStatusV3(node.remoteUrl),
          sleep(6000).then(() => { throw new Error('timeout'); }),
        ]);
        if (status.type === 'v2ray' && !BROKEN_NODES.has(node.address) && candidateNodes.length < MAX_CANDIDATES) {
          candidateNodes.push({ node, status });
          console.log(`  ✓ V2RAY [${candidateNodes.length}/${MAX_CANDIDATES}] ${node.remoteUrl.slice(0, 45)} — ${status.location.city}, ${status.location.country}`);
        }
      } catch { }
      scannedCount++;
      if (scannedCount % 50 === 0) process.stdout.write(`  (scanned ${scannedCount}/${pricedNodes.length})\n`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pricedNodes.length) }, worker));

  console.log(`\nScanned ${scannedCount} nodes. Found ${candidateNodes.length} V2Ray candidates.\n`);

  if (candidateNodes.length === 0) {
    console.error('No online V2Ray nodes found.');
    process.exit(1);
  }

  console.log(`\nTotal V2Ray candidates: ${candidateNodes.length}\n`);
  const fee = { amount: [{ denom: DENOM, amount: '200000' }], gas: '800000' };
  const { randomUUID } = await import('crypto');
  let usedUUID = null;
  let connectedNode = null, hs = null;

  for (const { node, status } of candidateNodes) {
    const priceEntry = node.gigabyte_prices.find(p => p.denom === DENOM);
    console.log(`\n──────────────────────────────────`);
    console.log(`Trying: ${node.address}`);
    console.log(`URL:    ${node.remoteUrl}`);
    console.log(`Loc:    ${status.location.city}, ${status.location.country}`);
    console.log(`Price:  ${priceEntry.quote_value} udvpn/GB`);

    // Check for existing active session first (avoid double payment)
    let sessionId = null;
    try {
      const sessRes = await fetch(`${lcd}/sentinel/session/v3/sessions?address=${account.address}&status=1&pagination.limit=100`, { signal: AbortSignal.timeout(8000) });
      if (sessRes.ok) {
        const sessData = await sessRes.json();
        for (const s of (sessData.sessions || [])) {
          const sNode = s.node_address || s.node;
          if (sNode === node.address) {
            const allocated = parseInt(s.gigabytes || '0');
            const consumed  = parseInt(s.download  || '0') + parseInt(s.upload || '0');
            if (allocated === 0 || consumed < allocated) {
              sessionId = BigInt(s.id);
              console.log(`♻ Reusing existing session ${sessionId}`);
              break;
            }
          }
        }
      }
    } catch {}

    if (!sessionId) {
      console.log('Sending MsgStartSession...');
      try {
        const txResult = await client.signAndBroadcast(account.address, [{
          typeUrl: V3_MSG_TYPE,
          value: {
            from: account.address, node_address: node.address,
            gigabytes: 1, hours: 0,
            max_price: { denom: priceEntry.denom, base_value: priceEntry.base_value, quote_value: priceEntry.quote_value },
          },
        }], fee);
        assertIsDeliverTxSuccess(txResult);
        console.log(`Tx: ${txResult.transactionHash}`);
        sessionId = extractSessionId(txResult);
        if (!sessionId) throw new Error('No session ID in tx');
        console.log(`Session: ${sessionId}`);
        console.log('Waiting 12s for chain sync...');
        await sleep(12000);
      } catch (err) {
        console.error(`MsgStartSession FAILED: ${err.message}`);
        continue;
      }
    }

    usedUUID = randomUUID();
    console.log(`UUID: ${usedUUID}`);
    console.log('V2Ray handshake...');
    try {
      hs = await initHandshakeV3V2Ray(node.remoteUrl, sessionId, privKey, usedUUID);
      console.log('Handshake ✓');
      console.log(`Endpoints: ${hs.serverEndpoints.join(', ')}`);
      console.log(`Metadata: ${hs.config.slice(0, 300)}`);
      console.log('Waiting 5s for node V2Ray API to register UUID...');
      await sleep(5000);
      connectedNode = node;
      break;
    } catch (err) {
      const isNodeBug = /already exists/i.test(err.message);
      console.error(`Handshake FAILED${isNodeBug ? ' (node bug — nil UUID)' : ''}: ${err.message.slice(0, 200)}`);
      if (isNodeBug) BROKEN_NODES.add(node.address);
      continue;
    }
  }

  if (!connectedNode || !hs) {
    console.error('\nAll V2Ray candidates failed handshake. V2Ray nodes appear to be broken network-wide.');
    process.exit(1);
  }

  // Write config + start v2ray
  const { writeFileSync } = await import('fs');
  const { spawn, execSync } = await import('child_process');

  // Kill any stale v2ray
  try { execSync('taskkill /F /IM v2ray.exe 2>nul', { stdio: 'ignore' }); } catch {}
  await sleep(500);

  // Build proper V2Ray client config from the metadata returned by the node.
  // The node returns metadata (port, proxy type, transport type), NOT a ready v2ray config.
  const serverHost = new URL(connectedNode.remoteUrl).hostname;
  const meta0 = JSON.parse(hs.config).metadata?.[0] || {};
  console.log(`\nBuilding config: host=${serverHost} proto=${meta0.proxy_protocol === 1 ? 'vless' : 'vmess'} transport=${meta0.transport_protocol} security=${meta0.transport_security} port=${meta0.port}`);

  const v2rayConfig = buildV2RayClientConfig(serverHost, hs.config, usedUUID, 1080);
  console.log('Full V2Ray config:\n' + JSON.stringify(v2rayConfig, null, 2) + '\n');
  const cfgPath = path.join(os.tmpdir(), 'sentinel-v2ray-test.json');
  writeFileSync(cfgPath, JSON.stringify(v2rayConfig, null, 2));
  console.log(`Config written: ${cfgPath}`);

  console.log(`Starting: ${v2rayExe}`);
  const proc = spawn(v2rayExe, ['run', '-config', cfgPath], { stdio: 'pipe' });
  let stderr = '';
  proc.stderr?.on('data', d => { stderr += d.toString(); process.stdout.write('[v2ray] ' + d.toString()); });
  proc.stdout?.on('data', d => process.stdout.write('[v2ray] ' + d.toString()));
  proc.on('error', err => console.error('v2ray spawn error:', err.message));

  console.log('Waiting 6s for v2ray to start...');
  await sleep(6000);

  if (proc.exitCode !== null) {
    console.error(`\nv2ray exited early (code ${proc.exitCode}):`);
    console.error(stderr.slice(0, 1000));
    process.exit(1);
  }

  console.log('v2ray running ✓\n');
  const vpnIp = await checkIP('THROUGH V2Ray SOCKS5 (port 1080)', 1080);

  // Wait a bit more to capture any deferred V2Ray error output
  await sleep(2000);
  if (stderr.includes('failed') || stderr.includes('error') || stderr.includes('Error')) {
    console.log('\n[v2ray errors captured]:\n' + stderr.slice(-2000));
  }

  try { proc.kill(); } catch {}

  console.log();
  if (vpnIp && vpnIp !== baseIp) {
    console.log(`✅ SUCCESS — IP changed: ${baseIp} → ${vpnIp}`);
  } else if (vpnIp === baseIp) {
    console.log(`⚠ FAIL — IP did NOT change (still ${vpnIp}) — traffic not routing through V2Ray`);
  } else {
    console.log(`⚠ FAIL — Could not reach IP check through SOCKS5`);
  }

  console.log('\n====== TEST COMPLETE ======');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
