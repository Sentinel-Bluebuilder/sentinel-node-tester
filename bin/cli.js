#!/usr/bin/env node

/**
 * Sentinel Node Tester — CLI Entry Point
 *
 * Usage:
 *   npx sentinel-node-tester              # Start dashboard on default port
 *   npx sentinel-node-tester --port 3005  # Custom port
 *   npx sentinel-node-tester --help       # Show help
 */

import { fileURLToPath } from 'url';
import path from 'path';
import { existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Parse CLI args
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  Sentinel Node Tester — Network audit dashboard for Sentinel dVPN

  Usage:
    sentinel-audit [options]

  Options:
    --port <number>   Server port (default: 3001, or PORT env var)
    --help, -h        Show this help message
    --version, -v     Show version

  Setup:
    1. Create a .env file with your wallet mnemonic:
       MNEMONIC=your twelve word mnemonic phrase here

    2. Run as Administrator for WireGuard support (optional)

  Dashboard: http://localhost:<port>
  Docs:      https://github.com/Sentinel-Autonomybuilder/sentinel-node-tester
`);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  const pkg = JSON.parse((await import('fs')).readFileSync(path.join(root, 'package.json'), 'utf8'));
  console.log(`sentinel-node-tester v${pkg.version}`);
  process.exit(0);
}

// Set port from CLI arg
const portIdx = args.indexOf('--port');
if (portIdx !== -1 && args[portIdx + 1]) {
  process.env.PORT = args[portIdx + 1];
}

// Check for .env
if (!existsSync(path.join(root, '.env')) && !process.env.MNEMONIC) {
  console.log(`
  No .env file found and MNEMONIC not set.

  To get started:
    1. Copy .env.example to .env
    2. Add your Sentinel wallet mnemonic
    3. Run again

  The dashboard will start without a mnemonic but you won't be able to run audits.
`);
}

// Start server
await import(path.join(root, 'server.js'));
