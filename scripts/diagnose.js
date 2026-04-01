/**
 * Diagnostic batch test — tests multiple WireGuard and V2Ray nodes sequentially.
 * Keeps going on failure — logs everything for analysis.
 * Run as Administrator for WireGuard.
 */
import 'dotenv/config';
import dns from 'dns';
import https from 'https';
import axios from 'axios';
import path from 'path';
import os from 'os';
import { existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import { randomUUID } from 'crypto';

import { Bip39, EnglishMnemonic, Slip10, Slip10Curve } from '@cosmjs/crypto';
import { makeCosmoshubPath } from '@cosmjs/amino';
import { DirectSecp256k1HdWallet, Registry } from '@cosmjs/proto-signing';
import { SigningStargateClient, GasPrice, defaultRegistryTypes, assertIsDeliverTxSuccess } from '@cosmjs/stargate';
import { SocksProxyAgent } from 'socks-proxy-agent';

import {
  nodeStatusV3, generateWgKeyPair, initHandshakeV3, initHandshakeV3V2Ray,
  buildV2RayClientConfig, writeWgConfig, encodeMsgStartSession, extractSessionId,
} from './lib/v3protocol.js';
import { installWgTunnel, uninstallWgTunnel, WG_AVAILABLE, IS_ADMIN } from './lib/wireguard-win.js';
import { speedtestDirect, speedtestViaSocks5, sleep, resolveCfHost } from './lib/speedtest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.PATH = path.join(__dirname, 'bin') + path.delimiter + (process.env.PATH || '');

const MNEMONIC = process.env.MNEMONIC;
const RPC = process.env.RPC || 'https://rpc.sentinel.co:443';
const DENOM = process.env.DENOM || 'udvpn';
const GAS_PRICE_STR = process.env.GAS_PRICE || '0.2udvpn';
const V3_MSG_TYPE = '/sentinel.node.v3.MsgStartSessionRequest';
const LCD = 'https://sentinel-api.polkachu.com';
const CF_HOST = 'speed.cloudflare.com';

// How many of each type to test
const WG_COUNT = 6;
const V2_COUNT = 6;

const BROKEN_NODES = new Set([
  'sentnode1qqktst6793vdxknvvkewfcmtv9edh7vvdvavrj',
  'sentnode1qx2p7kyep6m44ae47yh9zf3cfxrzrv5zt9vdnj',
]);

async function privKeyFromMnemonic(mnemonic) {
  const seed = await Bip39.mnemonicToSeed(new EnglishMnemonic(mnemonic));
  const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, makeCosmoshubPath(0));
  return Buffer.from(privkey);
}

function buildRegistry() {
  const M = { fromPartial: v => v, encode: i => ({ finish: () => encodeMsgStartSession(i) }), decode: () => ({}) };
  return new Registry([...defaultRegistryTypes, [V3_MSG_TYPE, M]]);
}

async function getSession(client, account, node, priceEntry) {
  try {
    const res = await fetch(`${LCD}/sentinel/session/v3/sessions?address=${account.address}&status=1&pagination.limit=200`,
      { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      for (const s of (data.sessions || [])) {
        if ((s.node_address || s.node) === node.address) {
          const alloc = parseInt(s.gigabytes || '0');
          const used = parseInt(s.download || '0') + parseInt(s.upload || '0');
          if (alloc === 0 || used < alloc) return BigInt(s.id);
        }
      }
    }
  } catch {}
  const fee = { amount: [{ denom: DENOM, amount: '200000' }], gas: '800000' };
  const txResult = await client.signAndBroadcast(account.address, [{
    typeUrl: V3_MSG_TYPE,
    value: {
      from: account.address, node_address: node.address, gigabytes: 1, hours: 0,
      max_price: { denom: priceEntry.denom, base_value: priceEntry.base_value, quote_value: priceEntry.quote_value },
    },
  }], fee);
  assertIsDeliverTxSuccess(txResult);
  const sid = extractSessionId(txResult);
  if (!sid) throw new Error('No session ID');
  console.log(`    Session ${sid} — waiting 12s...`);
  await sleep(12000);
  return sid;
}

// ─── WireGuard Test ─────────────────────────────────────────────────────────
async function testWG(client, account, privKey, node, status, idx) {
  const label = `[WG ${idx}]`;
  console.log(`\n${label} ${node.address.slice(0,20)}… | ${status.location.city}, ${status.location.country}`);
  const priceEntry = node.gigabyte_prices.find(p => p.denom === DENOM);
  if (!priceEntry) { console.log(`${label} SKIP: no udvpn price`); return { ok: false, error: 'no price' }; }

  try {
    const sessionId = await getSession(client, account, node, priceEntry);
    const { privateKey: wgPriv, publicKey: wgPub } = generateWgKeyPair();
    const hs = await initHandshakeV3(node.remoteUrl, sessionId, privKey, wgPub);
    console.log(`${label} Handshake OK → ${hs.assignedAddrs.join(', ')} → ${hs.serverEndpoint}`);
    const confPath = writeWgConfig(wgPriv, hs.assignedAddrs, hs.serverPubKey, hs.serverEndpoint);

    await installWgTunnel(confPath);
    await sleep(2000);
    console.log(`${label} Tunnel UP`);

    // DNS probe (quick)
    const dnsOk = await dns.promises.lookup(CF_HOST).then(() => true).catch(() => false);
    console.log(`${label} DNS (getaddrinfo): ${dnsOk ? 'OK' : 'FAILED'}`);

    // Speedtest using our fixed function
    try {
      const r = await speedtestDirect(10);
      console.log(`${label} SPEED: ${r.mbps} Mbps (${r.adaptive}, ${r.streams} stream${r.streams > 1 ? 's' : ''})`);
      await uninstallWgTunnel();
      return { ok: true, mbps: r.mbps, type: 'WG', loc: `${status.location.city}, ${status.location.country}` };
    } catch (err) {
      console.log(`${label} SPEEDTEST FAILED: ${err.message}`);
      // DNS diagnostic on failure
      const dnsAfter = await dns.promises.lookup(CF_HOST).then(r => r.address).catch(e => `FAIL:${e.code}`);
      console.log(`${label} DNS after failure: ${dnsAfter}`);
      await uninstallWgTunnel();
      return { ok: false, error: err.message, type: 'WG' };
    }
  } catch (err) {
    console.log(`${label} ERROR: ${err.message}`);
    try { await uninstallWgTunnel(); } catch {}
    return { ok: false, error: err.message, type: 'WG' };
  }
}

// ─── V2Ray Test ─────────────────────────────────────────────────────────────
async function testV2(client, account, privKey, node, status, idx) {
  const label = `[V2 ${idx}]`;
  console.log(`\n${label} ${node.address.slice(0,20)}… | ${status.location.city}, ${status.location.country}`);
  const priceEntry = node.gigabyte_prices.find(p => p.denom === DENOM);
  if (!priceEntry) { console.log(`${label} SKIP: no udvpn price`); return { ok: false, error: 'no price' }; }

  try {
    const sessionId = await getSession(client, account, node, priceEntry);

    try { execSync('taskkill /F /IM v2ray.exe 2>nul', { stdio: 'ignore' }); } catch {}
    await sleep(1500);

    const uuid = randomUUID();
    const hs = await initHandshakeV3V2Ray(node.remoteUrl, sessionId, privKey, uuid);
    const meta0 = JSON.parse(hs.config).metadata?.[0] || {};
    const proto = meta0.proxy_protocol === 1 ? 'vless' : 'vmess';
    console.log(`${label} Handshake OK — ${proto} transport=${meta0.transport_protocol} security=${meta0.transport_security}`);
    await sleep(5000);

    const serverHost = new URL(node.remoteUrl).hostname;
    const v2rayConfig = buildV2RayClientConfig(serverHost, hs.config, uuid, 1080);
    const cfgPath = path.join(os.tmpdir(), 'sentinel-v2ray-diag.json');
    writeFileSync(cfgPath, JSON.stringify(v2rayConfig, null, 2));

    const v2rayExe = path.join(__dirname, 'bin', 'v2ray.exe');
    const proc = spawn(v2rayExe, ['run', '-config', cfgPath], { stdio: 'pipe' });
    let stderr = '';
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => { stderr += `spawn: ${err.message}`; });

    await sleep(6000);
    if (proc.exitCode !== null) {
      console.log(`${label} v2ray EXITED (code ${proc.exitCode}): ${stderr.slice(0, 300)}`);
      return { ok: false, error: `v2ray exit ${proc.exitCode}`, type: 'V2' };
    }

    try {
      const r = await speedtestViaSocks5(10, 1080);
      console.log(`${label} SPEED: ${r.mbps} Mbps (${r.adaptive}, ${r.streams} stream${r.streams > 1 ? 's' : ''})`);
      proc.kill();
      await sleep(1000);
      return { ok: true, mbps: r.mbps, type: 'V2', loc: `${status.location.city}, ${status.location.country}` };
    } catch (err) {
      console.log(`${label} SPEEDTEST FAILED: ${err.message}`);
      if (stderr.trim()) console.log(`${label} v2ray stderr: ${stderr.trim().slice(0, 500)}`);
      proc.kill();
      await sleep(1000);

      // Retry: check if basic SOCKS5 even works
      console.log(`${label} Retrying basic IP check...`);
      try { execSync('taskkill /F /IM v2ray.exe 2>nul', { stdio: 'ignore' }); } catch {}
      return { ok: false, error: err.message, type: 'V2' };
    }
  } catch (err) {
    console.log(`${label} ERROR: ${err.message}`);
    try { execSync('taskkill /F /IM v2ray.exe 2>nul', { stdio: 'ignore' }); } catch {}
    return { ok: false, error: err.message, type: 'V2' };
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('========================================');
  console.log('  BATCH DIAGNOSTIC TEST');
  console.log(`  Testing ${WG_COUNT} WireGuard + ${V2_COUNT} V2Ray nodes`);
  console.log('========================================');
  console.log(`Admin: ${IS_ADMIN} | WireGuard: ${WG_AVAILABLE}`);

  // Pre-resolve CF
  const cfIp = await resolveCfHost();
  console.log(`Cloudflare IP: ${cfIp || 'FAILED'}`);

  // Baseline
  try {
    const r = await axios.get('https://api.ipify.org?format=json', { timeout: 10000 });
    console.log(`Baseline IP: ${r.data.ip}`);
  } catch (err) { console.log(`Baseline IP: FAILED (${err.message})`); }

  // Wallet
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'sent' });
  const [account] = await wallet.getAccounts();
  const privKey = await privKeyFromMnemonic(MNEMONIC);
  console.log(`Wallet: ${account.address}`);

  const registry = buildRegistry();
  const client = await SigningStargateClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString(GAS_PRICE_STR), registry,
  });
  const bal = await client.getBalance(account.address, DENOM);
  console.log(`Balance: ${(parseInt(bal?.amount || '0') / 1e6).toFixed(4)} DVPN\n`);

  // Fetch all nodes
  const allNodes = [];
  let nextKey = null;
  do {
    let url = `${LCD}/sentinel/node/v3/nodes?status=1&pagination.limit=200`;
    if (nextKey) url += `&pagination.key=${encodeURIComponent(nextKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    for (const n of (data.nodes || [])) {
      if (BROKEN_NODES.has(n.address)) continue;
      const rawAddr = (n.remote_addrs || [])[0] || '';
      allNodes.push({
        address: n.address,
        remoteUrl: rawAddr.startsWith('http') ? rawAddr : `https://${rawAddr}`,
        gigabyte_prices: n.gigabyte_prices || [],
      });
    }
    nextKey = data.pagination?.next_key || null;
  } while (nextKey);

  const priced = allNodes.filter(n => n.gigabyte_prices.find(p => p.denom === DENOM));
  console.log(`Nodes: ${allNodes.length} total, ${priced.length} with udvpn price`);

  // Parallel scan for candidates
  console.log('Scanning for online nodes (30 concurrent)...');
  const wgCandidates = [], v2Candidates = [];
  let idx = 0;

  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= priced.length) break;
      if (wgCandidates.length >= WG_COUNT * 2 && v2Candidates.length >= V2_COUNT * 2) break;
      const node = priced[i];
      try {
        const status = await Promise.race([
          nodeStatusV3(node.remoteUrl),
          sleep(6000).then(() => { throw new Error('timeout'); }),
        ]);
        if (status.type === 'wireguard' && wgCandidates.length < WG_COUNT * 2) {
          wgCandidates.push({ node, status });
        }
        if (status.type === 'v2ray' && v2Candidates.length < V2_COUNT * 2) {
          v2Candidates.push({ node, status });
        }
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: 30 }, worker));
  console.log(`Found ${wgCandidates.length} WG + ${v2Candidates.length} V2 candidates\n`);

  const results = [];

  // Test WireGuard nodes
  if (IS_ADMIN && WG_AVAILABLE) {
    for (let i = 0; i < Math.min(WG_COUNT, wgCandidates.length); i++) {
      const { node, status } = wgCandidates[i];
      const r = await testWG(client, account, privKey, node, status, i + 1);
      results.push(r);
      await sleep(2000);
    }
  } else {
    console.log('SKIPPING WireGuard (not admin or not available)');
  }

  // Test V2Ray nodes
  for (let i = 0; i < Math.min(V2_COUNT, v2Candidates.length); i++) {
    const { node, status } = v2Candidates[i];
    const r = await testV2(client, account, privKey, node, status, i + 1);
    results.push(r);
    await sleep(2000);
  }

  // Summary
  console.log('\n========================================');
  console.log('  RESULTS SUMMARY');
  console.log('========================================');
  const ok = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);
  console.log(`Total: ${results.length} | PASS: ${ok.length} | FAIL: ${fail.length}`);
  ok.forEach(r => console.log(`  PASS [${r.type}] ${r.loc || ''} — ${r.mbps} Mbps`));
  fail.forEach(r => console.log(`  FAIL [${r.type}] ${r.error?.slice(0, 80)}`));
  console.log(`Success rate: ${results.length > 0 ? (ok.length / results.length * 100).toFixed(0) : 0}%`);
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
