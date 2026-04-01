import 'dotenv/config';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { SigningStargateClient, GasPrice } from '@cosmjs/stargate';
import {
    nodeStatusV3,
    initHandshakeV3V2Ray,
    buildV2RayClientConfig,
    encodeMsgStartSession,
    extractSessionId,
} from './lib/v3protocol.js';
import { speedtestViaSocks5, sleep } from './lib/speedtest.js';
import { Bip39, EnglishMnemonic, Slip10, Slip10Curve } from '@cosmjs/crypto';
import { makeCosmoshubPath } from '@cosmjs/amino';
import { Registry } from '@cosmjs/proto-signing';
import { defaultRegistryTypes, assertIsDeliverTxSuccess } from '@cosmjs/stargate';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { writeFileSync, existsSync } from 'fs';
import { spawn, execSync as execSyncV2 } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const MNEMONIC = process.env.MNEMONIC;
const RPC = 'https://sentinel-rpc.polkachu.com:443';
const DENOM = 'udvpn';
const GAS_PRICE = '0.2udvpn';
const V3_MSG_TYPE = '/sentinel.node.v3.MsgStartSessionRequest';

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

async function testV2RayConnection() {
    try {
        console.log("Setting up wallet...");
        const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'sent' });
        const [account] = await wallet.getAccounts();
        console.log(`Wallet Address: ${account.address}`);

        const privkey = await privKeyFromMnemonic(MNEMONIC);
        const registry = buildV3Registry();
        const client = await SigningStargateClient.connectWithSigner(RPC, wallet, {
            gasPrice: GasPrice.fromString(GAS_PRICE),
            registry,
        });

        const balance = await client.getBalance(account.address, DENOM);
        console.log(`Balance: ${balance.amount} ${balance.denom}`);

        console.log("Fetching a node from LCD...");
        const axios = (await import('axios')).default;
        const lcdRes = await axios.get("https://sentinel-api.polkachu.com/sentinel/node/v3/nodes?status=1&pagination.limit=100", { timeout: 10000 });
        const lcdData = lcdRes.data;

        let v2rayCount = 0;
        let node = null;
        let remoteUrl = '';

        for (const n of lcdData.nodes) {
            remoteUrl = n.remote_addrs[0].startsWith('http') ? n.remote_addrs[0] : `https://${n.remote_addrs[0]}`;
            try {
                const status = await nodeStatusV3(remoteUrl);
                if (status.type === 'v2ray' && (n.gigabyte_prices || []).find(p => p.denom === DENOM) && n.address !== 'sentnode1q8x7n9dkw9jd3f48jdetd4drvrw2pzky3xxejh') {
                    v2rayCount++;
                    if (v2rayCount >= 3) {
                        node = n;
                        break;
                    }
                }
            } catch (e) { }
        }

        if (!node) {
            console.log("No valid V2Ray node found.");
            return;
        }

        console.log(`Targeting Node: ${node.address} at ${remoteUrl}`);

        const priceEntry = (node.gigabyte_prices || []).find(p => p.denom === DENOM);

        console.log("Starting Session (v3)...");
        const fee = {
            amount: [{ denom: DENOM, amount: '200000' }],
            gas: '800000',
        };

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
        console.log(`Session Started! ID: ${sessionId}`);

        console.log("Waiting 15 seconds for chain sync...");
        await sleep(15000);

        console.log("Initiating v3 Handshake...");
        try { execSyncV2('taskkill /F /IM v2ray.exe 2>nul', { stdio: 'ignore' }); } catch { }
        await sleep(500);

        const uuid = randomUUID();
        console.log(`V2Ray UUID generated: ${uuid}`);

        const hs = await initHandshakeV3V2Ray(remoteUrl, sessionId, privkey, uuid);
        console.log(`Handshake Successful!`);

        const serverHost = new URL(remoteUrl).hostname;
        console.log("Returned Config:", hs.config);
        const v2rayConfig = buildV2RayClientConfig(serverHost, hs.config, uuid, 1080);

        const cfgPath = path.join(os.tmpdir(), 'sentinel-v2ray.json');
        writeFileSync(cfgPath, JSON.stringify(v2rayConfig, null, 2));

        const localV2RayExe = path.join(__dirname, 'bin', 'v2ray.exe');
        const v2rayExe = existsSync(localV2RayExe) ? localV2RayExe : 'v2ray.exe';
        console.log(`Starting V2Ray: ${v2rayExe} with config ${cfgPath}`);

        const proc = spawn(v2rayExe, ['run', '-config', cfgPath], { stdio: 'pipe' });
        proc.stdout?.on('data', d => console.log('V2RAY STDOUT:', d.toString().trim()));
        proc.stderr?.on('data', d => console.log('V2RAY STDERR:', d.toString().trim()));

        let v2rayStderr = '';

        try {
            console.log("Waiting for V2Ray to start proxy on port 1080...");
            await sleep(3000);
            if (proc.exitCode !== null) {
                throw new Error(`v2ray exited prematurely (code ${proc.exitCode})`);
            }

            console.log("Testing basic SOCKS5 HTTP resolving...");
            const { SocksProxyAgent } = await import('socks-proxy-agent');
            const axios = (await import('axios')).default;
            const simpleAgent = new SocksProxyAgent('socks5://127.0.0.1:1080');
            const res = await axios.get('http://ipv4.appspot.com', { httpAgent: simpleAgent, httpsAgent: simpleAgent, timeout: 5000 });
            console.log(`HTTP Proxy Test: ${res.status} - IP: ${res.data}`);

            console.log("Running Speedtest via SOCKS5...");
            const result = await speedtestViaSocks5(10, 1080); // test 10mb
            console.log(`Speedtest Result: ${result.mbps} Mbps`);
        } finally {
            console.log("Killing V2Ray process...");
            try { proc.kill(); } catch { }
        }

        console.log("Test Completed Successfully!");

    } catch (error) {
        console.error("Error during test:", error);
    }
}

testV2RayConnection();
