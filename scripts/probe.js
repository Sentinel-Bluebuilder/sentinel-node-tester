/**
 * Sentinel v3 Connection Probe — SDK-free
 * Uses only @cosmjs/* + our lib/v3protocol.js
 */

import 'dotenv/config';
import https from 'https';
import axios from 'axios';
import { Bip39, EnglishMnemonic, Slip10, Slip10Curve } from '@cosmjs/crypto';
import { makeCosmoshubPath } from '@cosmjs/amino';
import { DirectSecp256k1HdWallet, Registry } from '@cosmjs/proto-signing';
import { SigningStargateClient, GasPrice, defaultRegistryTypes, assertIsDeliverTxSuccess } from '@cosmjs/stargate';

import {
  nodeStatusV3,
  generateWgKeyPair,
  initHandshakeV3,
  initHandshakeV3V2Ray,
  buildV2RayClientConfig,
  writeWgConfig,
  encodeMsgStartSession,
  extractSessionId,
} from './lib/v3protocol.js';
import { WG_AVAILABLE, WG_EXE, IS_ADMIN, installWgTunnel, uninstallWgTunnel } from './lib/wireguard-win.js';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.PATH = path.join(__dirname, 'bin') + path.delimiter + (process.env.PATH || '');

const MNEMONIC  = process.env.MNEMONIC;
const RPC       = process.env.RPC       || 'https://rpc.sentinel.co:443';
const DENOM     = process.env.DENOM     || 'udvpn';
const GAS_PRICE = process.env.GAS_PRICE || '0.2udvpn';
const PROBE_LIMIT = 100;

const V3_MSG_TYPE = '/sentinel.node.v3.MsgStartSessionRequest';

const LCD_ENDPOINTS = [
  'https://sentinel-api.polkachu.com',
  'https://api.sentinel.quokkastake.io',
  'https://sentinel-rest.publicnode.com',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Derive raw secp256k1 private key from mnemonic (no SDK) */
async function privKeyFromMnemonic(mnemonic) {
  const seed = await Bip39.mnemonicToSeed(new EnglishMnemonic(mnemonic));
  const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, makeCosmoshubPath(0));
  return Buffer.from(privkey);
}

/** Build a Registry with the v3 MsgStartSession type registered */
function buildV3Registry() {
  // CosmJS needs a ts-proto-style GeneratedType:
  //   fromPartial(value) → instance
  //   encode(instance).finish() → Uint8Array
  const MsgStartSessionV3 = {
    fromPartial: (value) => value,
    encode: (instance) => ({
      finish: () => encodeMsgStartSession(instance),
    }),
    decode: () => ({}),
  };

  return new Registry([
    ...defaultRegistryTypes,
    [V3_MSG_TYPE, MsgStartSessionV3],
  ]);
}

async function fetchNodes(limit) {
  for (const ep of LCD_ENDPOINTS) {
    try {
      const r = await fetch(`${ep}/sentinel/node/v3/nodes?status=1&pagination.limit=${limit}`, {
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) continue;
      const data = await r.json();
      return (data.nodes || []).map(n => {
        const rawAddr = (n.remote_addrs || [])[0] || '';
        return {
          address: n.address,
          remoteUrl: rawAddr.startsWith('http') ? rawAddr : `https://${rawAddr}`,
          gigabyte_prices: n.gigabyte_prices || [],
        };
      });
    } catch (e) { console.log(`LCD ${ep} failed: ${e.message}`); }
  }
  throw new Error('No LCD endpoint reachable');
}

async function checkIP(label, proxyPort = null) {
  try {
    let ip;
    if (proxyPort) {
      const { SocksProxyAgent } = await import('socks-proxy-agent');
      const agent = new SocksProxyAgent(`socks5://127.0.0.1:${proxyPort}`);
      const r = await axios.get('https://api.ipify.org?format=json', { httpsAgent: agent, httpAgent: agent, timeout: 10000 });
      ip = r.data.ip;
    } else {
      const r = await axios.get('https://api.ipify.org?format=json', { timeout: 10000 });
      ip = r.data.ip;
    }
    console.log(`[${label}] Public IP: ${ip}`);
    return ip;
  } catch (e) {
    console.log(`[${label}] IP check failed: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log('\n====== Sentinel v3 Connection Probe (SDK-free) ======');
  console.log(`WireGuard: ${WG_AVAILABLE ? '✓ available' : '✗ not found'}`);

  const baseIp = await checkIP('BASELINE (no VPN)');

  // Wallet + private key
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'sent' });
  const [account] = await wallet.getAccounts();
  const cosmosPrivKey = await privKeyFromMnemonic(MNEMONIC);
  console.log(`\nWallet: ${account.address}`);

  // Create client with v3 registry
  const registry = buildV3Registry();
  const client = await SigningStargateClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString(GAS_PRICE),
    registry,
  });

  const balRes = await client.getBalance(account.address, DENOM);
  const bal = parseInt(balRes?.amount || '0');
  console.log(`Balance: ${(bal / 1e6).toFixed(4)} DVPN`);

  if (bal < 1_000_000) {
    console.error('ERROR: Balance too low (need at least 1 DVPN)');
    process.exit(1);
  }

  // Fetch nodes
  console.log(`\nFetching ${PROBE_LIMIT} nodes...`);
  const nodes = await fetchNodes(PROBE_LIMIT);
  console.log(`Got ${nodes.length} nodes\n`);

  // Find an online node with a udvpn price
  let targetNode = null, targetStatus = null;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    process.stdout.write(`[${i+1}/${nodes.length}] ${node.remoteUrl.padEnd(35)} `);
    try {
      const status = await Promise.race([
        nodeStatusV3(node.remoteUrl),
        sleep(8000).then(() => { throw new Error('timeout'); }),
      ]);
      const dl = (status.bandwidth.download * 8 / 1e6).toFixed(1);
      const typeLabel = status.type.padEnd(9);
      console.log(`ONLINE ✓  ${typeLabel} ${status.location.city}, ${status.location.country} | ${dl} Mbps`);

      // Need a node with a udvpn price
      const hasPrice = node.gigabyte_prices.find(p => p.denom === DENOM);
      if (hasPrice && (status.type === 'wireguard' || status.type === 'v2ray')) {
        targetNode = node;
        targetStatus = status;
        break;
      }
    } catch (e) {
      console.log(`offline (${e.message?.slice(0, 45)})`);
    }
  }

  if (!targetNode) { console.error('No suitable online nodes found.'); process.exit(1); }

  const typeName = targetStatus.type === 'wireguard' ? 'WireGuard' : 'V2Ray';
  const priceEntry = targetNode.gigabyte_prices.find(p => p.denom === DENOM);

  console.log(`\n====== Connecting: ${typeName} ======`);
  console.log(`Address:   ${targetNode.address}`);
  console.log(`URL:       ${targetNode.remoteUrl}`);
  console.log(`Location:  ${targetStatus.location.city}, ${targetStatus.location.country}`);
  console.log(`Speed:     ${(targetStatus.bandwidth.download * 8 / 1e6).toFixed(1)} Mbps reported`);
  console.log(`Price:     ${priceEntry.quote_value} udvpn/GB (${(parseFloat(priceEntry.quote_value)/1e6).toFixed(4)} DVPN/GB)`);

  // v3: single MsgStartSession tx
  console.log('\nSending MsgStartSession (v3)...');

  const fee = {
    amount: [{ denom: DENOM, amount: '200000' }],  // 0.2 DVPN
    gas: '800000',
  };

  let txResult;
  try {
    txResult = await client.signAndBroadcast(account.address, [{
      typeUrl: V3_MSG_TYPE,
      value: {
        from:         account.address,
        node_address: targetNode.address,
        gigabytes:    1,
        hours:        0,
        max_price:    {
          denom:       priceEntry.denom,
          base_value:  priceEntry.base_value,   // decToScaledInt applied inside encodePrice
          quote_value: priceEntry.quote_value,
        },
      },
    }], fee);
    assertIsDeliverTxSuccess(txResult);
  } catch (err) {
    console.error('\nMsgStartSession FAILED:', err.message);
    if (txResult) {
      console.error('Code:', txResult.code);
      console.error('RawLog:', txResult.rawLog?.slice(0, 500));
      console.error('Events:', JSON.stringify(txResult.events?.slice(0, 3), null, 2));
    }
    throw err;
  }

  console.log(`Tx hash:   ${txResult.transactionHash}`);
  console.log(`Gas used:  ${txResult.gasUsed}`);

  // Extract session ID
  const sessionId = extractSessionId(txResult);
  if (!sessionId) {
    console.log('All events:', JSON.stringify(txResult.events?.slice(0, 5), null, 2));
    console.log('RawLog:', txResult.rawLog?.slice(0, 500));
    throw new Error('Could not extract session ID from tx result');
  }
  console.log(`Session ID: ${sessionId}`);

  // Wait for chain sync
  console.log('Waiting 15s for chain sync...');
  await sleep(15000);

  // Handshake
  if (targetStatus.type === 'wireguard') {
    const { privateKey: wgPriv, publicKey: wgPub } = generateWgKeyPair();
    console.log(`\nWG client pubkey: ${wgPub.toString('base64')}`);
    console.log('Sending v3 WireGuard handshake...');

    const hs = await initHandshakeV3(targetNode.remoteUrl, sessionId, cosmosPrivKey, wgPub);
    console.log('Handshake ✓');
    console.log(`Assigned IPs:    ${hs.assignedAddrs.join(', ')}`);
    console.log(`Server pubkey:   ${hs.serverPubKey}`);
    console.log(`Server endpoint: ${hs.serverEndpoint}`);

    const wgConfPath = writeWgConfig(wgPriv, hs.assignedAddrs, hs.serverPubKey, hs.serverEndpoint);
    console.log(`Config written:  ${wgConfPath}`);

    if (WG_AVAILABLE && WG_EXE) {
      console.log(`\nInstalling WireGuard tunnel (${IS_ADMIN ? 'as admin' : 'via UAC elevation'})...`);
      try {
        await installWgTunnel(wgConfPath);
        console.log('Tunnel UP ✓');

        const vpnIp = await checkIP('THROUGH WireGuard VPN');
        if (vpnIp && vpnIp !== baseIp) {
          console.log(`\n✅ SUCCESS — IP changed: ${baseIp} → ${vpnIp}`);
        } else {
          console.log(`\n⚠ IP unchanged (${vpnIp}) — AllowedIPs routing may need checking`);
        }
      } catch (err) {
        console.error(`WireGuard error: ${err.message}`);
      } finally {
        try { await uninstallWgTunnel(); } catch {}
        console.log('Tunnel removed');
      }
    } else {
      console.log('\nWireGuard exe not found — handshake succeeded but tunnel not installed.');
      console.log(`Config ready at: ${wgConfPath}`);
    }

  } else {
    // V2Ray
    const { randomUUID } = await import('crypto');
    const uuid = randomUUID();
    console.log(`\nV2Ray UUID: ${uuid}`);
    console.log('Sending v3 V2Ray handshake...');

    const hs = await initHandshakeV3V2Ray(targetNode.remoteUrl, sessionId, cosmosPrivKey, uuid);
    console.log('V2Ray handshake ✓');
    console.log(`Server endpoints: ${hs.serverEndpoints.join(', ')}`);
    console.log('Waiting 5s for node to register UUID...');
    await sleep(5000);

    // Build proper V2Ray client config from node metadata
    const { writeFileSync } = await import('fs');
    const serverHost = new URL(targetNode.remoteUrl).hostname;
    const v2rayConfig = buildV2RayClientConfig(serverHost, hs.config, uuid, 1080);
    const meta0 = JSON.parse(hs.config).metadata?.[0] || {};
    console.log(`Config: proto=${meta0.proxy_protocol === 1 ? 'vless' : 'vmess'} transport=${meta0.transport_protocol} security=${meta0.transport_security}`);
    const configPath = path.join(os.tmpdir(), 'sentinel-v2ray-probe.json');
    writeFileSync(configPath, JSON.stringify(v2rayConfig, null, 2));
    console.log(`V2Ray config written: ${configPath}`);
    console.log('Starting v2ray...');

    const v2rayExe = path.join(__dirname, 'bin', 'v2ray.exe');
    const proc = (await import('child_process')).spawn(v2rayExe, ['run', '-config', configPath], {
      detached: false,
      stdio: 'pipe',
    });
    proc.stderr.on('data', d => console.log('[v2ray stderr]', d.toString().trim()));
    await sleep(3000);

    const vpnIp = await checkIP('THROUGH V2Ray SOCKS5', 1080);
    if (vpnIp && vpnIp !== baseIp) {
      console.log(`\n✅ SUCCESS — IP changed: ${baseIp} → ${vpnIp}`);
    } else {
      console.log(`\n⚠ IP unchanged (${vpnIp}) — V2Ray may need more time or config fixing`);
    }

    proc.kill();
  }

  console.log('\n====== PROBE COMPLETE ======');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
