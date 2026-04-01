// Audit all connection paths for bugs
const fs = require('fs');
const code = fs.readFileSync('server.js', 'utf8');

const issues = [];

// Check 1: Any place where sessionId could be undefined/null when used for handshake
if (code.includes('initHandshakeV3(') && !code.includes('if (!sessionId)')) {
  // Actually it does throw if sessionId is null from extractSessionId
}

// Check 2: WireGuard tunnel cleanup after every test
const wgInstalls = (code.match(/installWgTunnel/g) || []).length;
const wgUninstalls = (code.match(/uninstallWgTunnel/g) || []).length;
console.log(`WG install calls: ${wgInstalls}, uninstall calls: ${wgUninstalls}`);

// Check 3: V2Ray process cleanup
const v2raySpawns = (code.match(/spawn\(v2rayExe/g) || []).length;
const v2rayKills = (code.match(/proc\.kill\(\)/g) || []).length;
const taskkillV2ray = (code.match(/taskkill.*v2ray/g) || []).length;
console.log(`V2Ray spawns: ${v2raySpawns}, proc.kill: ${v2rayKills}, taskkill: ${taskkillV2ray}`);

// Check 4: Does the handshake use sessionId as BigInt properly?
const handshakeCalls = code.match(/initHandshakeV3.*sessionId/g) || [];
console.log(`Handshake calls using sessionId: ${handshakeCalls.length}`);

// Check 5: Are there any await calls without try/catch in testNode?
// Count bare awaits between "async function testNode" and the closing brace

// Check 6: Is node.remoteUrl always available?
const remoteUrlUses = (code.match(/node\.remoteUrl/g) || []).length;
console.log(`node.remoteUrl references: ${remoteUrlUses}`);

// Check 7: port 1080 conflicts - is v2ray killed before each test?
const port1080refs = (code.match(/1080/g) || []).length;
console.log(`Port 1080 references: ${port1080refs}`);

// Check 8: Does extractSessionId handle all tx result formats?
const extractCalls = (code.match(/extractSessionId/g) || []).length;
const extractAllCalls = (code.match(/extractAllSessionIds/g) || []).length;
console.log(`extractSessionId calls: ${extractCalls}, extractAllSessionIds: ${extractAllCalls}`);

// Check 9: Sleep after WG install - is it enough?
const wgSleeps = code.match(/installWgTunnel.*\n.*sleep\((\d+)/);
console.log(`Sleep after WG install: ${wgSleeps ? wgSleeps[1] + 'ms' : 'NOT FOUND'}`);

// Check 10: Sleep after V2Ray start
const v2raySleeps = code.match(/give v2ray time.*\n.*sleep\((\d+)/) || code.match(/await sleep\(6_000\)/);
console.log(`V2Ray startup sleep: ${v2raySleeps ? '6000ms' : 'NOT FOUND'}`);

console.log('\n--- Checking for potential null/undefined access ---');

// Does testNode always have node.remoteUrl?
if (code.includes('new URL(node.remoteUrl)')) {
  console.log('node.remoteUrl used in URL constructor - could throw if missing');
}

// Does writeWgConfig always get valid args?
if (code.includes('writeWgConfig(wgPriv, hs.assignedAddrs, hs.serverPubKey, hs.serverEndpoint)')) {
  console.log('writeWgConfig depends on handshake response fields - could fail if malformed');
}

// JSON.parse(hs.config) - could throw
if (code.includes('JSON.parse(hs.config)')) {
  console.log('JSON.parse(hs.config) - could throw if config is not valid JSON');
}

console.log('\nDone.');
