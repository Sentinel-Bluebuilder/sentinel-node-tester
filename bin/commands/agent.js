/**
 * agent — End-to-end CLI server driver for Sentinel Node Tester.
 *
 * Lets an AI / automation drive every operator-facing function over HTTP
 * against a running `serve` instance. Every subcommand prints structured JSON
 * to stdout and exits non-zero on error so it composes cleanly in pipelines.
 *
 * Discovery:
 *   sentinel-audit agent map         # full machine-readable endpoint registry
 *   sentinel-audit agent --help      # short-form usage
 *
 * Auth:
 *   --token <t>                  prefer this
 *   $SENTINEL_AUDIT_TOKEN        else this
 *   $ADMIN_TOKEN                 else this
 *   (no token)                   single-user/local mode is allowed by server
 *
 * Target:
 *   --base-url http://host:port  prefer this
 *   $SENTINEL_AUDIT_URL          else this
 *   --port <n>                   else http://localhost:<port>
 *   (default)                    http://localhost:3001
 */

import { api, apiRequest, resolveBaseUrl, resolveToken } from '../lib/http.js';
import { printJson } from '../lib/output.js';

export const name = 'agent';
export const description = 'End-to-end agentic driver: hit every Sentinel Node Tester server function from the CLI.';
export const usage = 'sentinel-audit agent <subcommand> [...args] [--base-url URL] [--token T] [--pretty]';
export const flags = [
  { flag: '--base-url <url>',  description: 'Server URL (default http://localhost:3001 or $SENTINEL_AUDIT_URL)' },
  { flag: '--port <n>',        description: 'Shorthand to set localhost port (default 3001)' },
  { flag: '--token <t>',       description: 'Bearer admin token (default $SENTINEL_AUDIT_TOKEN or $ADMIN_TOKEN)' },
  { flag: '--pretty',          description: 'Pretty-print JSON output' },
  { flag: '--timeout <s>',     description: 'HTTP timeout in seconds (default 30)' },
  { flag: '--watch <s>',       description: 'For events/state subcommands: stream / poll for N seconds' },
  // Pass-through bodies
  { flag: '--plan-id <id>',    description: 'Plan ID (start, test-plan, sub-plans)' },
  { flag: '--sub-id <id>',     description: 'Subscription ID (start, test-sub-plan)' },
  { flag: '--sub-granter <a>', description: 'Subscription granter address (start)' },
  { flag: '--test-run',        description: 'Use TEST RUN mode for /api/start' },
  { flag: '--pricing-mode <m>',description: 'gigabytes | hours (default gigabytes)' },
  { flag: '--addr <a>',        description: 'Node address (sentnode1...) for node, retest, etc.' },
  { flag: '--remote-url <u>',  description: 'Node remote URL (https://host:port) for chain-status' },
  { flag: '--country <cc>',    description: 'Country filter (audit, retest)' },
  { flag: '--limit <n>',       description: 'Result limit (errors, results)' },
  { flag: '--num <n>',         description: 'Run number (runs/save, runs/load)' },
  { flag: '--sdk <s>',         description: 'SDK selection (js | tkd)' },
];

// ─── Endpoint registry ───────────────────────────────────────────────────────
//
// Single source of truth. `agent map` prints this verbatim so an AI calling
// the CLI can introspect every function the server exposes.

const ENDPOINTS = [
  // Discovery / health
  { sub: 'health',          method: 'GET',  path: '/health',                          auth: false, desc: 'Public health probe' },
  { sub: 'admin-health',    method: 'GET',  path: '/api/health',                      auth: true,  desc: 'Admin-side health (chain + balance)' },
  { sub: 'stats',           method: 'GET',  path: '/api/stats',                       auth: true,  desc: 'Admin run/network stats' },
  { sub: 'state',           method: 'GET',  path: '/api/state',                       auth: true,  desc: 'Full server runtime state' },
  { sub: 'sdk-versions',    method: 'GET',  path: '/api/sdk-versions',                auth: true,  desc: 'Installed SDK versions' },
  { sub: 'sdk-verify',      method: 'GET',  path: '/api/sdk-verify',                  auth: true,  desc: 'Byte-for-byte SDK verification' },
  { sub: 'sdk-verify-key',  method: 'GET',  path: '/api/sdk-verify/:key',             auth: true,  desc: 'SDK file content by verification key',  params: ['key'] },
  { sub: 'cross-sdk',       method: 'GET',  path: '/api/cross-sdk',                   auth: true,  desc: 'Cross-SDK comparison data' },
  { sub: 'failure-analysis',method: 'GET',  path: '/api/failure-analysis',            auth: true,  desc: 'Failure breakdown' },
  { sub: 'transport-cache', method: 'GET',  path: '/api/transport-cache',             auth: true,  desc: 'Inspect transport cache (wg/v2ray)' },

  // Public reads (no auth)
  { sub: 'pub-nodes',       method: 'GET',  path: '/api/public/nodes',                auth: false, desc: 'Public node list' },
  { sub: 'pub-node',        method: 'GET',  path: '/api/public/node/:addr',           auth: false, desc: 'Public single node detail',         params: ['addr'] },
  { sub: 'pub-node-errors', method: 'GET',  path: '/api/public/node/:addr/errors',    auth: false, desc: 'Public per-node error log',         params: ['addr'] },
  { sub: 'pub-bandwidth',   method: 'GET',  path: '/api/public/node/:addr/bandwidth', auth: false, desc: 'Public per-node bandwidth history', params: ['addr'] },
  { sub: 'pub-errors',      method: 'GET',  path: '/api/public/errors',               auth: false, desc: 'Recent failure log entries' },
  { sub: 'pub-countries',   method: 'GET',  path: '/api/public/countries',            auth: false, desc: 'Country breakdown' },
  { sub: 'pub-stats',       method: 'GET',  path: '/api/public/stats',                auth: false, desc: 'Public network stats' },
  { sub: 'pub-run-current', method: 'GET',  path: '/api/public/runs/current',         auth: false, desc: 'In-flight run snapshot (when broadcast on)' },
  { sub: 'pub-run-last',    method: 'GET',  path: '/api/public/runs/last',            auth: false, desc: 'Last completed run snapshot' },
  { sub: 'pub-runs',        method: 'GET',  path: '/api/public/runs',                 auth: false, desc: 'List historical runs' },
  { sub: 'pub-batches',     method: 'GET',  path: '/api/public/batches',              auth: false, desc: 'List broadcast batches' },
  { sub: 'pub-batch',       method: 'GET',  path: '/api/public/batch/:id',            auth: false, desc: 'Single batch detail',               params: ['id'] },
  { sub: 'pub-logs',        method: 'GET',  path: '/api/public/logs',                 auth: false, desc: 'Public broadcast log buffer' },
  { sub: 'pub-live-state',  method: 'GET',  path: '/api/public/live-state',           auth: false, desc: 'Cold-refresh hydration for /live' },
  { sub: 'pub-test-status', method: 'GET',  path: '/api/public/test/status',          auth: false, desc: 'Public test status probe' },
  { sub: 'pub-test-start',  method: 'POST', path: '/api/public/test/start',           auth: false, desc: 'Start gated public test (requires ALLOW_PUBLIC_TEST=true)',
    bodyFromFlags: (f) => ({ mode: f['--mode'] === 'subscription' ? 'subscription' : 'p2p' }) },
  { sub: 'pub-test-stop',   method: 'POST', path: '/api/public/test/stop',            auth: false, desc: 'Stop gated public test (requires ALLOW_PUBLIC_TEST=true)' },

  // Broadcast toggle
  { sub: 'broadcast',       method: 'GET',  path: '/api/broadcast',                   auth: false, desc: 'Read current broadcastLive value' },
  { sub: 'broadcast-toggle',method: 'POST', path: '/api/broadcast',                   auth: true,  desc: 'Flip broadcastLive (no body)' },

  // Audit lifecycle
  { sub: 'start',           method: 'POST', path: '/api/start',                       auth: true,  desc: 'Start audit run',
    bodyFromFlags: (f) => {
      const body = {};
      if (f['--plan-id'])    body.planId = f['--plan-id'];
      if (f['--sub-id'])     body.subscriptionId = f['--sub-id'];
      if (f['--sub-granter'])body.subscriptionGranter = f['--sub-granter'];
      if (f['--test-run'])   body.testRun = true;
      if (f['--pricing-mode']) body.pricingMode = f['--pricing-mode'];
      return body;
    } },
  { sub: 'resume',          method: 'POST', path: '/api/resume',                      auth: true,  desc: 'Resume the last audit run' },
  { sub: 'stop',            method: 'POST', path: '/api/stop',                        auth: true,  desc: 'Stop in-flight audit' },
  { sub: 'rescan',          method: 'POST', path: '/api/rescan',                      auth: true,  desc: 'Rescan chain node list' },
  { sub: 'retest-skips',    method: 'POST', path: '/api/retest-skips',                auth: true,  desc: 'Retest only skipped nodes' },
  { sub: 'retest-fails',    method: 'POST', path: '/api/retest-fails',                auth: true,  desc: 'Retest only failed nodes' },
  { sub: 'auto-retest',     method: 'POST', path: '/api/auto-retest',                 auth: true,  desc: 'Trigger background auto-retest sweep' },
  { sub: 'clear',           method: 'POST', path: '/api/clear',                       auth: true,  desc: 'Clear current results buffer' },

  // Plans & subscriptions
  { sub: 'plans',           method: 'GET',  path: '/api/plans',                       auth: true,  desc: 'List wallet plans' },
  { sub: 'subscriptions',   method: 'GET',  path: '/api/subscriptions',               auth: true,  desc: 'List wallet subscriptions' },
  { sub: 'sub-plans',       method: 'GET',  path: '/api/sub-plans',                   auth: true,  desc: 'List subscription-plan pairings' },
  { sub: 'admin-plans',     method: 'GET',  path: '/api/admin/plans',                 auth: true,  desc: 'Admin plan inspector' },
  { sub: 'test-plan',       method: 'POST', path: '/api/test-plan',                   auth: true,  desc: 'Run a plan-mode audit',
    bodyFromFlags: (f) => ({ planId: f['--plan-id'] }) },
  { sub: 'test-sub-plan',   method: 'POST', path: '/api/test-sub-plan',               auth: true,  desc: 'Run a subscription-plan-mode audit',
    bodyFromFlags: (f) => ({ subscriptionId: f['--sub-id'], planId: f['--plan-id'], granter: f['--sub-granter'] }) },

  // Chain queries
  { sub: 'chain-nodes',     method: 'GET',  path: '/api/chain/nodes',                 auth: true,  desc: 'Direct chain node fetch' },
  { sub: 'chain-status',    method: 'GET',  path: '/api/chain/node-status',           auth: true,  desc: 'Per-node status snapshot (requires --remote-url https://host:port)',
    queryFromFlags: (f) => {
      const url = f['--remote-url'] || f['--remoteUrl'];
      return url ? { remoteUrl: url } : {};
    } },

  // Run history
  { sub: 'runs',            method: 'GET',  path: '/api/runs',                        auth: true,  desc: 'List saved audit runs' },
  { sub: 'run-get',         method: 'GET',  path: '/api/runs/:num',                   auth: true,  desc: 'Read a specific saved run',         params: ['num'] },
  { sub: 'run-save',        method: 'POST', path: '/api/runs/save',                   auth: true,  desc: 'Save the current results buffer' },
  { sub: 'run-load',        method: 'POST', path: '/api/runs/load/:num',              auth: true,  desc: 'Load run #N back into the buffer',  params: ['num'] },

  // Results & errors
  { sub: 'results',         method: 'GET',  path: '/api/results',                     auth: true,  desc: 'Current results buffer' },

  // SDK + DNS knobs
  { sub: 'sdk-get',         method: 'GET',  path: '/api/sdk',                         auth: true,  desc: 'Read active SDK selection' },
  { sub: 'sdk-set',         method: 'POST', path: '/api/sdk',                         auth: true,  desc: 'Set active SDK',
    bodyFromFlags: (f) => ({ sdk: f['--sdk'] }) },
  { sub: 'dns-get',         method: 'GET',  path: '/api/dns',                         auth: true,  desc: 'Read DNS configuration' },
  { sub: 'dns-set',         method: 'POST', path: '/api/dns',                         auth: true,  desc: 'Update DNS configuration',
    bodyFromFlags: (f) => {
      const b = {};
      if (f['--dns'])      b.servers = String(f['--dns']).split(',').map(s => s.trim()).filter(Boolean);
      if (f['--enabled'] !== undefined) b.enabled = f['--enabled'] === 'true' || f['--enabled'] === true;
      return b;
    } },

  // Streaming
  { sub: 'events',          method: 'GET',  path: '/api/events',                      auth: true,  desc: 'Admin SSE event stream (use --watch <s>)' },
  { sub: 'pub-events',      method: 'GET',  path: '/api/public/events',               auth: false, desc: 'Public SSE event stream (use --watch <s>)' },
];

// ─── Resolution helpers ──────────────────────────────────────────────────────

function findEndpoint(sub) {
  return ENDPOINTS.find(e => e.sub === sub);
}

// Map :paramName → fallback flag name when positional is omitted
const PARAM_FLAG_FALLBACK = {
  addr: '--addr',
  num:  '--num',
};

function fillPath(rawPath, params, positional, flags) {
  if (!params || !params.length) return rawPath;
  let p = rawPath;
  for (let i = 0; i < params.length; i++) {
    let tok = positional[i];
    if (!tok && flags) {
      const fallbackFlag = PARAM_FLAG_FALLBACK[params[i]];
      if (fallbackFlag && typeof flags[fallbackFlag] === 'string') {
        tok = flags[fallbackFlag];
      }
    }
    if (!tok) {
      throw new Error(`Missing positional argument for :${params[i]} in ${rawPath}`);
    }
    p = p.replace(`:${params[i]}`, encodeURIComponent(tok));
  }
  return p;
}

// ─── Top-level help / map output ─────────────────────────────────────────────

function printAgentHelp() {
  console.log(`
  sentinel-audit agent — End-to-end CLI server driver

  Usage:
    sentinel-audit agent <subcommand> [args...] [flags]

  Discovery:
    agent map                       Machine-readable endpoint registry (JSON)
    agent --help                    This text

  Common subcommands:
    health                          Public health probe
    state                           Server runtime state (admin)
    plans / subscriptions           Wallet plans / subs
    start [--test-run] [--pricing-mode hours|gigabytes]
    stop / resume / rescan
    retest-skips / retest-fails
    broadcast / broadcast-toggle
    pub-nodes / pub-node <addr> / pub-node-errors <addr>
    runs / run-get <n> / run-save / run-load <n>
    events --watch 30               Stream admin SSE for 30s
    pub-events --watch 30           Stream public SSE for 30s

  Run "agent map --pretty" for the full registry with HTTP method / path / auth.
`);
}

// ─── SSE streaming ───────────────────────────────────────────────────────────

async function streamSse(path, flags) {
  const watchSecs = parseInt(flags['--watch'] || '30', 10);
  const res = await apiRequest('GET', path, { flags, raw: true, timeoutMs: (watchSecs + 5) * 1000 });
  if (!res.ok || !res.body) {
    throw new Error(`SSE ${path} → HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const start = Date.now();
  const events = [];

  while (Date.now() - start < watchSecs * 1000) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      let parsed = data;
      try { parsed = JSON.parse(data); } catch {}
      const rec = { t: Date.now() - start, event, data: parsed };
      events.push(rec);
      // Live tap to stderr so the user sees progress; stdout is reserved for
      // the final aggregate JSON.
      console.error(JSON.stringify(rec));
    }
  }

  try { await reader.cancel(); } catch {}
  return { source: path, watchSeconds: watchSecs, events };
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function run({ positional, flags: f }) {
  const sub = positional[0];

  if (!sub || sub === 'help') {
    printAgentHelp();
    return;
  }

  // Discovery: print the full endpoint registry as JSON
  if (sub === 'map' || sub === 'list') {
    const base = resolveBaseUrl(f);
    const tokenSource = f['--token'] ? '--token'
      : process.env.SENTINEL_AUDIT_TOKEN ? '$SENTINEL_AUDIT_TOKEN'
      : process.env.ADMIN_TOKEN ? '$ADMIN_TOKEN'
      : 'none';
    return {
      baseUrl: base,
      tokenSource,
      tokenPresent: Boolean(resolveToken(f)),
      total: ENDPOINTS.length,
      endpoints: ENDPOINTS.map(e => ({
        sub: e.sub,
        method: e.method,
        path: e.path,
        auth: e.auth,
        params: e.params || [],
        description: e.desc,
      })),
    };
  }

  // Streaming subcommands
  if (sub === 'events' || sub === 'pub-events') {
    const path = sub === 'events' ? '/api/events' : '/api/public/events';
    return await streamSse(path, f);
  }

  // Lookup
  const ep = findEndpoint(sub);
  if (!ep) {
    throw new Error(`unknown agent subcommand: "${sub}". Run "agent map --pretty" for the registry.`);
  }

  const tail = positional.slice(1);
  const path = fillPath(ep.path, ep.params, tail, f);

  // Build query / body
  const query = {};
  if (f['--limit']) query.limit = f['--limit'];
  if (f['--country']) query.country = f['--country'];
  if (ep.queryFromFlags) Object.assign(query, ep.queryFromFlags(f) || {});

  let body;
  if (ep.method !== 'GET' && ep.method !== 'HEAD') {
    body = ep.bodyFromFlags ? ep.bodyFromFlags(f) : {};
  }

  const timeoutMs = parseInt(f['--timeout'] || '30', 10) * 1000;

  return await apiRequest(ep.method, path, { flags: f, body, query, timeoutMs });
}
