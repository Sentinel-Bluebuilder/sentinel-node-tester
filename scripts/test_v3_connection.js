import 'dotenv/config';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { SigningStargateClient, GasPrice } from '@cosmjs/stargate';
import {
    nodeStatusV3,
    generateWgKeyPair,
    initHandshakeV3,
    writeWgConfig,
    encodeMsgStartSession,
    extractSessionId,
} from './lib/v3protocol.js';
import { installWgTunnel, uninstallWgTunnel } from './lib/wireguard-win.js';
import { speedtestDirect, sleep } from './lib/speedtest.js';
import { Bip39, EnglishMnemonic, Slip10, Slip10Curve } from '@cosmjs/crypto';
import { makeCosmoshubPath } from '@cosmjs/amino';
import { Registry } from '@cosmjs/proto-signing';
import { defaultRegistryTypes, assertIsDeliverTxSuccess } from '@cosmjs/stargate';

// Configuration
const MNEMONIC = process.env.MNEMONIC;
const RPC = 'https://rpc.sentinel.co:443';
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

async function testV3Connection() {
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
        const lcdRes = await fetch("https://sentinel-api.polkachu.com/sentinel/node/v3/nodes?status=1&pagination.limit=10");
        const lcdData = await lcdRes.json();

        // Find a wireguard node with a price
        let node = null;
        let remoteUrl = '';

        for (const n of lcdData.nodes) {
            remoteUrl = n.remote_addrs[0].startsWith('http') ? n.remote_addrs[0] : `https://${n.remote_addrs[0]}`;
            try {
                const status = await nodeStatusV3(remoteUrl);
                if (status.type === 'wireguard' && (n.gigabyte_prices || []).find(p => p.denom === DENOM)) {
                    node = n;
                    break;
                }
            } catch (e) { }
        }

        if (!node) {
            console.log("No valid Wireguard node found in the first 10 results.");
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
        const { privateKey: wgPriv, publicKey: wgPub } = generateWgKeyPair();
        const hs = await initHandshakeV3(remoteUrl, sessionId, privkey, wgPub);
        console.log(`Handshake Successful! Assigned IPs: ${hs.assignedAddrs.join(', ')} -> Server: ${hs.serverEndpoint}`);

        console.log("Writing WireGuard Config...");
        const confPath = writeWgConfig(wgPriv, hs.assignedAddrs, hs.serverPubKey, hs.serverEndpoint);

        console.log("Installing WireGuard Tunnel...");
        try {
            await installWgTunnel(confPath);
            console.log("Tunnel Installed. Waiting 3 seconds...");
            await sleep(3000);

            console.log("Running Speedtest...");
            const result = await speedtestDirect(10); // test 10mb
            console.log(`Speedtest Result: ${result.mbps} Mbps`);
        } finally {
            console.log("Uninstalling WireGuard Tunnel...");
            await uninstallWgTunnel('wgsent0');
        }

        console.log("Test Completed Successfully!");

    } catch (error) {
        console.error("Error during test:", error);
    }
}

testV3Connection();
