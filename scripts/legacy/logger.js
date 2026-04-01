// Save results to JSON and CSV

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, '..', 'results');

mkdirSync(RESULTS_DIR, { recursive: true });

const JSON_PATH = path.join(RESULTS_DIR, 'results.json');
const CSV_PATH  = path.join(RESULTS_DIR, 'results.csv');
const LOG_PATH  = path.join(RESULTS_DIR, 'tester.log');

const CSV_HEADER = [
  'timestamp', 'address', 'type', 'moniker', 'country', 'city',
  'reported_dl_mbps', 'actual_dl_mbps',
  'pass_15mbps', 'within_30pct_benchmark',
  'peers', 'max_peers', 'gigabyte_prices'
].join(',');

let results = [];

export function initLogger() {
  // Write CSV header if file doesn't exist
  if (!existsSync(CSV_PATH)) {
    writeFileSync(CSV_PATH, CSV_HEADER + '\n', 'utf8');
  }
  log('=== Sentinel Node Tester Started ===');
}

export function saveResult(result) {
  results.push(result);

  // Append to CSV
  const row = [
    result.timestamp,
    result.address,
    result.type,
    `"${(result.moniker || '').replace(/"/g, '')}"`,
    `"${(result.country || '').replace(/"/g, '')}"`,
    `"${(result.city || '').replace(/"/g, '')}"`,
    result.reportedDownloadMbps,
    result.actualMbps ?? 'N/A',
    result.pass15mbps ?? 'N/A',
    result.withinBenchmark ?? 'N/A',
    result.peers ?? '',
    result.maxPeers ?? '',
    `"${(result.gigabytePrices || '').replace(/"/g, '')}"`,
  ].join(',');

  writeFileSync(CSV_PATH, row + '\n', { flag: 'a', encoding: 'utf8' });

  // Overwrite full JSON
  writeFileSync(JSON_PATH, JSON.stringify(results, null, 2), 'utf8');
}

export function printResult(result) {
  const pass = result.pass15mbps ? '✅ PASS' : '❌ FAIL';
  const bench = result.withinBenchmark ? '✅ IN RANGE' : '⚠️  SLOW';
  const speed = result.actualMbps != null
    ? `${result.actualMbps.toFixed(1)} Mbps actual / ${result.reportedDownloadMbps.toFixed(1)} Mbps reported`
    : 'SKIPPED';

  const line = [
    `[${result.type}] ${result.address}`,
    `  Location: ${result.city}, ${result.country}`,
    `  Moniker:  ${result.moniker}`,
    `  Speed:    ${speed}`,
    `  15 Mbps:  ${pass}`,
    `  Benchmark:${bench}`,
  ].join('\n');

  console.log(line);
  log(line);
}

export function printSummary(total, tested, passed15, withinBenchmark) {
  const summary = [
    '\n=== SUMMARY ===',
    `Total nodes found:    ${total}`,
    `Nodes tested:         ${tested}`,
    `Passed 15 Mbps:       ${passed15} (${pct(passed15, tested)})`,
    `Within 30% benchmark: ${withinBenchmark} (${pct(withinBenchmark, tested)})`,
    `Results saved to:     ${RESULTS_DIR}`,
  ].join('\n');

  console.log(summary);
  log(summary);
}

export function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  writeFileSync(LOG_PATH, line + '\n', { flag: 'a', encoding: 'utf8' });
}

function pct(n, total) {
  if (!total) return '0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}
