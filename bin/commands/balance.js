/**
 * balance — Query P2P token balance for a wallet address.
 *
 * RPC-first via queryBalance() (ABCI /cosmos.bank.v1beta1.Query/Balance),
 * falls back to LCD REST if RPC endpoints are unreachable.
 */

import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { queryBalance } from '../../core/chain.js';

// ─── Metadata ────────────────────────────────────────────────────────────────

export const name = 'balance';
export const description = 'Query P2P token balance (RPC first, LCD fallback).';
export const usage = 'sentinel-audit balance [sent1...] [--pretty]';
export const flags = [
  { flag: '--pretty', description: 'Human-readable output' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function addrFromMnemonic(mnemonic) {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: 'sent' });
  const [account] = await wallet.getAccounts();
  return account.address;
}

function formatP2P(udvpn) {
  const n = parseInt(udvpn, 10) || 0;
  return `${(n / 1_000_000).toFixed(6)} P2P`;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function run({ positional = [], flags: _f } = {}) {
  let address = positional[0] || null;

  if (!address) {
    const mnem = process.env.MNEMONIC;
    if (!mnem) {
      throw new Error('No address provided and MNEMONIC env var is not set');
    }
    address = await addrFromMnemonic(mnem.trim());
  }

  const coin = await queryBalance(address, 'udvpn');

  return {
    address,
    udvpn: coin.amount,
    p2p: formatP2P(coin.amount),
  };
}
