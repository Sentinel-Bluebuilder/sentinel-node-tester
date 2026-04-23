/**
 * Smoke tests for the node-detail additions: getActiveRun,
 * getLastCompletedRun, getBandwidthHistory, and searchNodes({ runId }).
 *
 * Run: node test/node-detail.smoke.test.js
 */

import {
  getDb, useDb,
  insertRun, updateRunOnFinish, insertResult,
  getActiveRun, getLastCompletedRun, getBandwidthHistory,
  searchNodes,
} from '../core/db.js';

const db = getDb(':memory:');
useDb(db);

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; } else { fail++; console.error('  FAIL:', name); }
}

const NOW = Date.now();

// Run A: completed
const runA = insertRun({ started_at: NOW - 10 * 60_000, mode: 'p2p' });
insertResult(runA, {
  timestamp:            new Date(NOW - 9 * 60_000).toISOString(),
  address:              'sentnode1aaa',
  moniker:              'Alpha',
  country:              'Germany',
  city:                 'Berlin',
  type:                 'v2ray',
  reportedDownloadMbps: 100,
  actualMbps:           42.0,
  diag:                 { handshakeOk: true, latencyMs: 30 },
});
insertResult(runA, {
  timestamp:            new Date(NOW - 8 * 60_000).toISOString(),
  address:              'sentnode1bbb',
  moniker:              'Bravo',
  country:              'France',
  city:                 'Paris',
  type:                 'wireguard',
  reportedDownloadMbps: 100,
  actualMbps:           null,
  error:                'handshake timeout',
});
updateRunOnFinish(runA, { finished_at: NOW - 5 * 60_000, node_count: 2, pass_count: 1 });

// Run B: still running
const runB = insertRun({ started_at: NOW - 2 * 60_000, mode: 'p2p' });
insertResult(runB, {
  timestamp:            new Date(NOW - 1 * 60_000).toISOString(),
  address:              'sentnode1aaa',
  moniker:              'Alpha',
  country:              'Germany',
  city:                 'Berlin',
  type:                 'v2ray',
  reportedDownloadMbps: 100,
  actualMbps:           50.0,
  diag:                 { handshakeOk: true, latencyMs: 22 },
});

// ─── Assertions ────────────────────────────────────────────────────────────

const active = getActiveRun();
assert(active != null,                           'getActiveRun returns the in-progress run');
assert(active && active.id === runB,             'active run id matches runB');
assert(active && active.node_count_so_far === 1, 'active run reports 1 node tested so far');
assert(active && active.pass_count_so_far === 1, 'active run reports 1 pass so far');

const last = getLastCompletedRun();
assert(last != null,                     'getLastCompletedRun returns a run');
assert(last && last.id === runA,         'last completed run id matches runA');
assert(last && last.finished_at != null, 'last completed run has finished_at');

const bw = getBandwidthHistory('sentnode1aaa', { limit: 10 });
assert(bw.length === 2,                   'bandwidth history returns 2 rows for sentnode1aaa');
assert(bw[0].actual_mbps != null,         'bandwidth rows have actual_mbps set');
assert(bw.every(r => r.actual_mbps != null), 'bandwidth rows filter out null mbps');

const bwFail = getBandwidthHistory('sentnode1bbb', { limit: 10 });
assert(bwFail.length === 0, 'failed-only node has no bandwidth rows');

const allNodes = searchNodes({ limit: 10, window: 10 });
assert(allNodes.length === 2, 'searchNodes (all-time) returns 2 nodes');

const currentNodes = searchNodes({ limit: 10, window: 10, runId: runB });
assert(currentNodes.length === 1,                              'searchNodes({ runId: runB }) returns 1 node');
assert(currentNodes[0]?.node_addr === 'sentnode1aaa',          'runB-filtered result is sentnode1aaa');

const lastNodes = searchNodes({ limit: 10, window: 10, runId: runA });
assert(lastNodes.length === 2, 'searchNodes({ runId: runA }) returns 2 nodes');

console.log(`\nnode-detail.smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
