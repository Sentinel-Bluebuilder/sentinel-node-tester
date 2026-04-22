/**
 * functions — List every exported SDK function with its source module.
 *
 * Reads index.js, parses `export { ... } from './path'` lines using regex
 * (no AST parser), resolves each re-export path, and outputs a grouped list.
 */

import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { printJson, printError } from '../lib/output.js';

// ─── Metadata ────────────────────────────────────────────────────────────────

export const name = 'functions';
export const description = 'List every exported function/const from index.js grouped by source module.';
export const usage = 'sentinel-audit functions [--pretty]';
export const flags = [
  { flag: '--pretty', description: 'Human-readable grouped output' },
];

// ─── Regex patterns ──────────────────────────────────────────────────────────

// Matches: export { foo, bar, baz } from './some/path.js'
// Also handles multi-line via stripping newlines first.
const EXPORT_RE = /export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function run(args) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, '..', '..');
  const indexPath = path.join(rootDir, 'index.js');

  if (!existsSync(indexPath)) {
    printError(new Error('index.js not found at ' + indexPath), args.flags);
    return;
  }

  let source;
  try {
    source = readFileSync(indexPath, 'utf8');
  } catch (err) {
    printError(err, args.flags);
    return;
  }

  // Collapse line continuations so multi-line exports are captured
  const collapsed = source.replace(/\n/g, ' ');

  const groups = {};

  let match;
  EXPORT_RE.lastIndex = 0;
  while ((match = EXPORT_RE.exec(collapsed)) !== null) {
    const names = match[1]
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const fromPath = match[2];

    // Normalise the module path to be relative from root
    const resolved = path.normalize(fromPath.replace(/^\.\//, ''));
    const moduleKey = resolved.replace(/\\/g, '/');

    if (!groups[moduleKey]) groups[moduleKey] = [];
    groups[moduleKey].push(...names);
  }

  // Sort exports within each group
  for (const key of Object.keys(groups)) {
    groups[key].sort();
  }

  const totalCount = Object.values(groups).reduce((n, arr) => n + arr.length, 0);

  if (args.flags['--pretty']) {
    console.log(`\nExported symbols from index.js  (${totalCount} total)\n`);
    for (const [mod, names] of Object.entries(groups)) {
      console.log(`  ${mod}`);
      for (const n of names) {
        console.log(`    ${n}`);
      }
      console.log('');
    }
  } else {
    printJson({ total: totalCount, modules: groups }, args.flags);
  }
}
