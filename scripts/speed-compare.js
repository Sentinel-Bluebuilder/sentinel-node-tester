/**
 * Speed Compare: Baseline vs Sentinel dVPN
 * Shows live download speed in Mbps — clean output only.
 * Must run as Administrator (WireGuard needs it).
 */
import 'dotenv/config';
import https from 'https';
import dns from 'dns';
import { Bip39, EnglishMnemonic, Slip10, Slip10Curve } from '@cosmjs/crypto';
import { makeCosmoshubPath } from '@cosmjs/amino';
import { DirectSecp256k1HdWallet, Registry } from '@cosmjs/proto-signing';
import { SigningStargateClient, GasPrice, defaultRegistryTypes, assertIsDeliverTxSuccess } from '@cosmjs/stargate';
import {
  nodeStatusV3, generateWgKeyPair, initHandshakeV3,
  writeWgConfig, encodeMsgStartSession, extractSessionId,
} from './lib/v3protocol.js';
import { WG_AVAILABLE, installWgTunnel, uninstallWgTunnel } from './lib/wireguard-win.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.PATH = path.join(__dirname, 'bin') + path.delimiter + (process.env.PATH || '');

const MNEMONIC  = process.env.MNEMONIC;
const RPC       = process.env.RPC || 'https://rpc.sentinel.co:443';
const DENOM     = 'udvpn';
const GAS_PRICE = '0.2udvpn';
const V3_MSG_TYPE = '/sentinel.node.v3.MsgStartSessionRequest';

// Target: fastest node from our test results
const TARGET_NODE = 'sentnode1dhjwse4f8z53fsf5jl6krjxj95dkv2ndynramx';

const LCD_ENDPOINTS = [
  'https://sentinel-api.polkachu.com',
  'https://api.sentinel.quokkastake.io',
  'https://sentinel-rest.publicnode.com',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Live speed download ────────────────────────────────────────────────────
const CF_HOST = 'speed.cloudflare.com';
let cfIp = null;

async function resolveCf() {
  if (cfIp) return cfIp;
  try {
    const addrs = await dns.promises.resolve4(CF_HOST);
    if (addrs.length) { cfIp = addrs[0]; return cfIp; }
  } catch {}
  try {
    const { address } = await dns.promises.lookup(CF_HOST);
    cfIp = address;
    return cfIp;
  } catch {}
  return null;
}

function liveDownload(sizeMb, label) {
  return new Promise((resolve, reject) => {
    const totalBytes = sizeMb * 1024 * 1024;
    const host = cfIp || CF_HOST;
    const url = `/__down?bytes=${totalBytes}`;
    let downloaded = 0;
    const start = Date.now();
    let lastPrint = 0;

    const options = {
      hostname: host,
      path: url,
      headers: {},
      rejectUnauthorized: false,
    };
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      options.headers['Host'] = CF_HOST;
      options.servername = CF_HOST;
    }

    const req = https.get(options, (res) => {
      if (res.statusCode !== 200) {
        req.destroy();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        const now = Date.now();
        const elapsed = (now - start) / 1000;
        if (now - lastPrint > 500 && elapsed > 0.2) {
          const mbps = (downloaded * 8) / elapsed / 1_000_000;
          const pct = Math.min(100, (downloaded / totalBytes * 100)).toFixed(0);
          process.stdout.write(`\r  ${label}: ${mbps.toFixed(2)} Mbps  [${pct}%]    `);
          lastPrint = now;
        }
      });
      res.on('end', () => {
        const elapsed = (Date.now() - start) / 1000;
        const mbps = elapsed > 0 ? (downloaded * 8) / elapsed / 1_000_000 : 0;
        process.stdout.write(`\r  ${label}: ${mbps.toFixed(2)} Mbps  [100%]    \n`);
        resolve({ mbps: parseFloat(mbps.toFixed(2)), seconds: elapsed });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── Wallet + chain helpers ─────────────────────────────────────────────────
async function privKeyFromMnemonic(mnemonic) {
  const seed = await Bip39.mnemonicToSeed(new EnglishMnemonic(mnemonic));
  const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, makeCosmoshubPath(0));
  return Buffer.from(privkey);
}

function buildV3Registry() {
  const MsgStartSessionV3 = {
    fromPartial: (value) => value,
    encode: (instance) => ({ finish: () => encodeMsgStartSession(instance) }),
    decode: () => ({}),
  };
  return new Registry([...defaultRegistryTypes, [V3_MSG_TYPE, MsgStartSessionV3]]);
}

async function findNodeOnLcd(nodeAddr) {
  for (const ep of LCD_ENDPOINTS) {
    try {
      const r = await fetch(`${ep}/sentinel/node/v3/nodes/${nodeAddr}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) continue;
      const data = await r.json();
      const n = data.node;
      if (!n) continue;
      const rawAddr = (n.remote_addrs || [])[0] || '';
      return {
        address: n.address,
        remoteUrl: rawAddr.startsWith('http') ? rawAddr : `https://${rawAddr}`,
        gigabyte_prices: n.gigabyte_prices || [],
      };
    } catch {}
  }
  return null;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n  SPEED COMPARE: Hotel WiFi vs Sentinel dVPN');
  console.log('  ' + '─'.repeat(45));

  await resolveCf();

  // ── Step 1: Baseline speed ──
  console.log('\n  [1/4] BASELINE (hotel WiFi, no VPN)');
  const baseline = await liveDownload(10, 'BASELINE');

  // ── Step 2: Connect to dVPN ──
  console.log('\n  [2/4] Connecting to Sentinel dVPN node...');

  if (!WG_AVAILABLE) {
    console.log('  ERROR: WireGuard not installed. Cannot connect.');
    process.exit(1);
  }

  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'sent' });
  const [account] = await wallet.getAccounts();
  const cosmosPrivKey = await privKeyFromMnemonic(MNEMONIC);

  const registry = buildV3Registry();
  const client = await SigningStargateClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString(GAS_PRICE),
    registry,
  });

  // Find node on LCD
  const node = await findNodeOnLcd(TARGET_NODE);
  if (!node) {
    console.log('  ERROR: Could not find target node on LCD');
    process.exit(1);
  }

  // Check node is online
  let status;
  try {
    status = await nodeStatusV3(node.remoteUrl);
  } catch (e) {
    console.log('  ERROR: Node offline — ' + e.message);
    process.exit(1);
  }

  const priceEntry = node.gigabyte_prices.find(p => p.denom === DENOM);
  if (!priceEntry) {
    console.log('  ERROR: No udvpn price on this node');
    process.exit(1);
  }

  console.log(`  Node: ${status.location.city}, ${status.location.country} (WireGuard)`);
  console.log(`  Cost: ${(parseFloat(priceEntry.quote_value) / 1e6).toFixed(2)} DVPN`);

  // Pay + start session
  console.log('  Paying & starting session...');
  const fee = { amount: [{ denom: DENOM, amount: '200000' }], gas: '800000' };

  const txResult = await client.signAndBroadcast(account.address, [{
    typeUrl: V3_MSG_TYPE,
    value: {
      from: account.address,
      node_address: node.address,
      gigabytes: 1,
      hours: 0,
      max_price: {
        denom: priceEntry.denom,
        base_value: priceEntry.base_value,
        quote_value: priceEntry.quote_value,
      },
    },
  }], fee);
  assertIsDeliverTxSuccess(txResult);

  const sessionId = extractSessionId(txResult);
  if (!sessionId) throw new Error('No session ID in tx');
  console.log(`  Session: ${sessionId}`);

  console.log('  Waiting 15s for chain sync...');
  await sleep(15000);

  // WireGuard handshake
  const { privateKey: wgPriv, publicKey: wgPub } = generateWgKeyPair();
  console.log('  Handshaking...');
  const hs = await initHandshakeV3(node.remoteUrl, sessionId, cosmosPrivKey, wgPub);
  const wgConfPath = writeWgConfig(wgPriv, hs.assignedAddrs, hs.serverPubKey, hs.serverEndpoint);

  console.log('  Installing WireGuard tunnel...');
  await installWgTunnel(wgConfPath);
  await sleep(5000);
  console.log('  Tunnel UP');

  // ── Step 3: VPN speed test ──
  console.log('\n  [3/4] dVPN SPEED (through WireGuard tunnel)');
  let vpnResult;
  try {
    vpnResult = await liveDownload(10, 'dVPN   ');
  } finally {
    // ── Step 4: Cleanup ──
    console.log('\n  [4/4] Disconnecting...');
    try { await uninstallWgTunnel(); } catch {}
    console.log('  Tunnel removed');
  }

  // ── Results ──
  console.log('\n  ' + '═'.repeat(45));
  console.log(`  BASELINE (hotel WiFi):  ${baseline.mbps.toFixed(2)} Mbps`);
  console.log(`  dVPN (WireGuard):       ${vpnResult.mbps.toFixed(2)} Mbps`);
  const diff = vpnResult.mbps - baseline.mbps;
  const pct = baseline.mbps > 0 ? ((diff / baseline.mbps) * 100).toFixed(0) : '∞';
  if (diff > 0) {
    console.log(`  RESULT: dVPN is ${pct}% FASTER (+${diff.toFixed(2)} Mbps)`);
  } else {
    console.log(`  RESULT: dVPN is ${Math.abs(parseInt(pct))}% slower (${diff.toFixed(2)} Mbps)`);
  }
  console.log('  ' + '═'.repeat(45));
}

main().catch(err => {
  console.error('\n  FATAL:', err.message);
  try { uninstallWgTunnel(); } catch {}
  process.exit(1);
});
