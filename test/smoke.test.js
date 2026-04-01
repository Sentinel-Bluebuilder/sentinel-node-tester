/**
 * Sentinel Node Tester — Smoke Tests
 * Validates all modules import, exports exist, error classes work,
 * constants are correct, and diagnostics classify properly.
 *
 * Run: node test/smoke.test.js
 */

const results = { pass: 0, fail: 0, errors: [] };

function assert(condition, name) {
  if (condition) { results.pass++; }
  else { results.fail++; results.errors.push(name); }
}

async function run() {
  console.log('Sentinel Node Tester — Smoke Tests\n');

  // ─── 1. Module Imports ──────────────────────────────────────────────────
  console.log('1. Module imports...');
  const modules = [
    'core/errors.js', 'core/constants.js', 'core/types.js', 'core/wallet.js',
    'core/chain.js', 'core/session.js', 'core/transport-cache.js', 'core/countries.js',
    'core/csharp-bridge.js',
    'protocol/v3protocol.js', 'protocol/speedtest.js', 'protocol/diagnostics.js',
    'platforms/windows/wireguard.js', 'platforms/windows/v2ray.js', 'platforms/windows/network.js',
    'audit/retry.js', 'audit/pipeline.js', 'audit/node-test.js',
    'index.js',
  ];
  for (const m of modules) {
    try { await import('../' + m); assert(true, m); }
    catch (e) { assert(false, `IMPORT ${m}: ${e.message.split('\n')[0]}`); }
  }
  console.log(`   ${modules.length} modules checked`);

  // ─── 2. Index Exports ──────────────────────────────────────────────────
  console.log('2. Index exports...');
  const idx = await import('../index.js');
  const required = [
    'testNode', 'testWithRetry', 'runAudit', 'runRetestSkips',
    'getAllNodes', 'findWorkingLcd', 'getActiveLcd', 'queryNodeStatusDirect',
    'signAndBroadcastRetry', 'assertIsDeliverTxSuccess',
    'getCredential', 'saveCredential', 'findExistingSession', 'buildSessionMap',
    'submitBatchPayment', 'extractAllSessionIds',
    'nodeStatusV3', 'generateWgKeyPair', 'initHandshakeV3', 'buildV2RayClientConfig',
    'writeWgConfig', 'extractSessionId', 'waitForPort',
    'speedtestDirect', 'speedtestViaSocks5', 'checkGoogleDirect', 'checkGoogleViaSocks5',
    'sleep', 'classifyFailure',
    'installWgTunnel', 'uninstallWgTunnel', 'WG_AVAILABLE', 'IS_ADMIN',
    'spawnV2Ray', 'cleanupV2Ray',
    'reorderOutbounds', 'recordTransportSuccess',
    'COUNTRY_MAP', 'countryNameToCode',
    'DENOM', 'PORT', 'DNS_PRESETS',
  ];
  for (const name of required) {
    assert(name in idx, `export: ${name}`);
  }
  console.log(`   ${required.length} exports checked`);

  // ─── 3. Error Classes ──────────────────────────────────────────────────
  console.log('3. Error classes...');
  const { AuditError, ChainError, ErrorCodes, ERROR_SEVERITY, isRetryable } = await import('../core/errors.js');

  const e = new AuditError('test error', 'TEST_CODE', { step: 'handshake' });
  assert(e.code === 'TEST_CODE', 'AuditError.code');
  assert(e.diag.step === 'handshake', 'AuditError.diag');
  assert(e instanceof Error, 'AuditError extends Error');
  assert(e.message === 'test error', 'AuditError.message');

  const ce = new ChainError('chain fail', { tx: '0x123' });
  assert(ce.code === 'CHAIN_ERROR', 'ChainError.code');
  assert(ce.diag.tx === '0x123', 'ChainError.diag');

  assert(typeof ErrorCodes === 'object', 'ErrorCodes is object');
  assert(Object.keys(ErrorCodes).length >= 20, 'ErrorCodes has 20+ codes');
  assert(ErrorCodes.NODE_OFFLINE !== undefined, 'ErrorCodes.NODE_OFFLINE');
  assert(ErrorCodes.SESSION_EXISTS !== undefined, 'ErrorCodes.SESSION_EXISTS');
  assert(ErrorCodes.CHAIN_LAG !== undefined, 'ErrorCodes.CHAIN_LAG');

  assert(typeof ERROR_SEVERITY === 'object', 'ERROR_SEVERITY is object');
  assert(typeof isRetryable === 'function', 'isRetryable is function');
  console.log(`   ${Object.keys(ErrorCodes).length} error codes verified`);

  // ─── 4. Constants ──────────────────────────────────────────────────────
  console.log('4. Constants...');
  const c = await import('../core/constants.js');
  assert(c.DENOM === 'udvpn', 'DENOM=udvpn');
  assert(c.GAS_PRICE === '0.2udvpn', 'GAS_PRICE');
  assert(Array.isArray(c.LCD_ENDPOINTS), 'LCD_ENDPOINTS is array');
  assert(c.LCD_ENDPOINTS.length >= 2, 'LCD_ENDPOINTS has 2+ entries');
  assert(c.V3_MSG_TYPE.includes('sentinel'), 'V3_MSG_TYPE includes sentinel');
  assert(c.DNS_PRESETS.google !== undefined, 'DNS_PRESETS.google');
  assert(c.DNS_PRESETS.hns !== undefined, 'DNS_PRESETS.hns');
  assert(c.DNS_PRESETS.cloudflare !== undefined, 'DNS_PRESETS.cloudflare');
  assert(typeof c.PORT === 'number', 'PORT is number');

  // ─── 5. Diagnostics ───────────────────────────────────────────────────
  console.log('5. Diagnostics...');
  const { classifyFailure } = await import('../protocol/diagnostics.js');
  assert(classifyFailure({ message: 'ETIMEDOUT' }) === 'network_timeout', 'classify: timeout');
  assert(classifyFailure({ message: 'already exists 409' }) === 'session_conflict', 'classify: 409');
  assert(classifyFailure({ message: 'clock drift AEAD' }) === 'node_error', 'classify: clock drift');
  assert(classifyFailure({ message: 'does not exist on blockchain' }) === 'chain_lag', 'classify: chain lag');
  assert(classifyFailure({ message: 'insufficient funds' }) === 'fatal', 'classify: insufficient');
  assert(classifyFailure({ code: 'VPN_INTERFERENCE' }) === 'vpn_interference', 'classify: vpn interference');

  // ─── 6. Countries ─────────────────────────────────────────────────────
  console.log('6. Countries...');
  const { COUNTRY_MAP, countryNameToCode, getFlagEmoji } = await import('../core/countries.js');
  assert(Object.keys(COUNTRY_MAP).length >= 50, 'COUNTRY_MAP has 50+ entries');
  assert(countryNameToCode('Germany') === 'DE', 'Germany=DE');
  assert(countryNameToCode('United States') === 'US', 'USA=US');
  assert(typeof getFlagEmoji === 'function', 'getFlagEmoji exists');

  // ─── 7. Transport Cache ───────────────────────────────────────────────
  console.log('7. Transport cache...');
  const tc = await import('../core/transport-cache.js');
  assert(typeof tc.loadTransportCache === 'function', 'loadTransportCache');
  assert(typeof tc.saveTransportCache === 'function', 'saveTransportCache');
  assert(typeof tc.recordTransportSuccess === 'function', 'recordTransportSuccess');
  assert(typeof tc.reorderOutbounds === 'function', 'reorderOutbounds');
  assert(typeof tc.getCacheStats === 'function', 'getCacheStats');

  // ─── 8. Pipeline State ────────────────────────────────────────────────
  console.log('8. Pipeline state...');
  const { createState } = await import('../audit/pipeline.js');
  const state = createState();
  assert(state.status === 'idle', 'initial status=idle');
  assert(state.totalNodes === 0, 'initial totalNodes=0');
  assert(state.testedNodes === 0, 'initial testedNodes=0');
  assert(state.failedNodes === 0, 'initial failedNodes=0');
  assert(state.stopRequested === false, 'initial stopRequested=false');
  assert(state.economyMode === false, 'initial economyMode=false');
  assert(state.baselineMbps === null, 'initial baselineMbps=null');

  // ─── 9. Sleep Utility ─────────────────────────────────────────────────
  console.log('9. Sleep utility...');
  const { sleep } = await import('../protocol/speedtest.js');
  const start = Date.now();
  await sleep(50);
  assert(Date.now() - start >= 45, 'sleep(50) takes ~50ms');

  // ─── 10. Session Functions ─────────────────────────────────────────────
  console.log('10. Session functions...');
  const session = await import('../core/session.js');
  // Credential CRUD
  session.saveCredential('sentnode1test', { type: 'wireguard', key: 'test123' });
  assert(session.getCredential('sentnode1test')?.key === 'test123', 'saveCredential + getCredential');
  session.clearCredential('sentnode1test');
  assert(session.getCredential('sentnode1test') === null, 'clearCredential');

  // Session poisoning
  session.markSessionPoisoned('sentnode1abc', '999');
  assert(session.isSessionPoisoned('sentnode1abc', '999') === true, 'markSessionPoisoned');
  assert(session.isSessionPoisoned('sentnode1abc', '888') === false, 'unpoisoned session');
  session.clearPoisonedSessions();
  assert(session.isSessionPoisoned('sentnode1abc', '999') === false, 'clearPoisonedSessions');

  // Duplicate payment guard
  session.markPaid('sentnode1xyz');
  assert(session.isPaid('sentnode1xyz') === true, 'markPaid');
  assert(session.isPaid('sentnode1zzz') === false, 'unpaid node');
  session.clearPaidNodes();
  assert(session.isPaid('sentnode1xyz') === false, 'clearPaidNodes');

  // Price parser
  assert(session.parseNodePriceUdvpn([{ denom: 'udvpn', quote_value: '40152030' }]) === 40152030, 'parseNodePriceUdvpn array');
  assert(session.parseNodePriceUdvpn(null) === 0, 'parseNodePriceUdvpn null');

  // Session cache control
  session.invalidateSessionCache();
  session.addToSessionMap('sentnode1map', 12345n);
  assert(true, 'addToSessionMap no throw');

  // ─── 11. Wallet Functions ──────────────────────────────────────────────
  console.log('11. Wallet functions...');
  const wallet = await import('../core/wallet.js');
  assert(typeof wallet.cachedWalletSetup === 'function', 'cachedWalletSetup exists');
  assert(typeof wallet.privKeyFromMnemonic === 'function', 'privKeyFromMnemonic exists');
  assert(typeof wallet.createFreshClient === 'function', 'createFreshClient exists');
  assert(typeof wallet.signAndBroadcastRetry === 'function', 'signAndBroadcastRetry exists');
  assert(typeof wallet.buildV3Registry === 'function', 'buildV3Registry exists');
  const registry = wallet.buildV3Registry();
  assert(registry !== null && typeof registry === 'object', 'buildV3Registry returns object');

  // ─── 12. Chain Functions ───────────────────────────────────────────────
  console.log('12. Chain functions...');
  const chain = await import('../core/chain.js');
  assert(typeof chain.findWorkingLcd === 'function', 'findWorkingLcd');
  assert(typeof chain.ensureLcd === 'function', 'ensureLcd');
  assert(typeof chain.getAllNodes === 'function', 'getAllNodes');
  assert(typeof chain.queryNodeStatusDirect === 'function', 'queryNodeStatusDirect');
  assert(typeof chain.fetchPlanMembership === 'function', 'fetchPlanMembership');
  assert(typeof chain.discoverPlans === 'function', 'discoverPlans');
  assert(typeof chain.querySubscriptions === 'function', 'querySubscriptions');
  assert(typeof chain.invalidateNodeCache === 'function', 'invalidateNodeCache');
  chain.setActiveLcd('https://lcd.sentinel.co');
  assert(chain.getActiveLcd() === 'https://lcd.sentinel.co', 'get/setActiveLcd');

  // ─── 13. Protocol Functions ────────────────────────────────────────────
  console.log('13. Protocol functions...');
  const proto = await import('../protocol/v3protocol.js');
  assert(typeof proto.nodeStatusV3 === 'function', 'nodeStatusV3');
  assert(typeof proto.generateWgKeyPair === 'function', 'generateWgKeyPair');
  assert(typeof proto.initHandshakeV3 === 'function', 'initHandshakeV3');
  assert(typeof proto.initHandshakeV3V2Ray === 'function', 'initHandshakeV3V2Ray');
  assert(typeof proto.buildV2RayClientConfig === 'function', 'buildV2RayClientConfig');
  assert(typeof proto.writeWgConfig === 'function', 'writeWgConfig');
  assert(typeof proto.extractSessionId === 'function', 'extractSessionId');
  assert(typeof proto.waitForPort === 'function', 'waitForPort');
  assert(typeof proto.validateCIDR === 'function', 'validateCIDR');

  // CIDR validation
  assert(proto.validateCIDR('10.8.0.2/32') === true, 'validateCIDR valid IPv4');
  assert(proto.validateCIDR('garbage') === false, 'validateCIDR invalid');

  // WireGuard key generation
  const keys = proto.generateWgKeyPair();
  assert(keys.privateKey.length === 32, 'WG private key 32 bytes');
  assert(keys.publicKey.length === 32, 'WG public key 32 bytes');

  // ─── 14. Subpath Imports ───────────────────────────────────────────────
  console.log('14. Subpath imports...');
  const subpaths = [
    'sentinel-node-tester/audit/pipeline',
    'sentinel-node-tester/core/errors',
    'sentinel-node-tester/core/constants',
    'sentinel-node-tester/protocol/v3protocol',
    'sentinel-node-tester/protocol/speedtest',
    'sentinel-node-tester/protocol/diagnostics',
    'sentinel-node-tester/core/wallet',
    'sentinel-node-tester/core/chain',
    'sentinel-node-tester/core/session',
  ];
  for (const sp of subpaths) {
    try { await import(sp); assert(true, 'subpath: ' + sp); }
    catch (e) { assert(false, `subpath ${sp}: ${e.message.split('\n')[0]}`); }
  }

  // ─── 15. Error Hierarchy ───────────────────────────────────────────────
  console.log('15. Error hierarchy...');
  const errors = await import('../core/errors.js');
  const errorClasses = ['AuditError', 'ChainError', 'HandshakeError', 'TunnelError',
    'PaymentError', 'VpnInterferenceError', 'NodeUnreachableError',
    'InsufficientBalanceError', 'SpeedTestError'];
  for (const cls of errorClasses) {
    assert(typeof errors[cls] === 'function', `error class: ${cls}`);
    // AuditError needs (msg, code, diag), subclasses need (msg, diag)
    const instance = cls === 'AuditError'
      ? new errors[cls]('test', 'TEST', {})
      : new errors[cls]('test');
    assert(instance instanceof Error, `${cls} extends Error`);
    assert(typeof instance.code === 'string', `${cls} has .code`);
    assert(typeof instance.diag === 'object', `${cls} has .diag`);
  }

  // ─── Results ──────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${results.pass} passed, ${results.fail} failed (${results.pass + results.fail} total)`);
  if (results.errors.length > 0) {
    console.log('\nFAILURES:');
    for (const e of results.errors) console.log(`  FAIL: ${e}`);
  }
  console.log(`${'='.repeat(50)}`);
  process.exit(results.fail > 0 ? 1 : 0);
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
