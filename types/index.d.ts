/**
 * Sentinel Node Tester — TypeScript Definitions
 * Public API types for library consumers.
 */

// ─── Core Data Types ────────────────────────────────────────────────────────

/** Price entry from the chain (gigabyte or hourly). */
export interface PriceEntry {
  denom: string;
  base_value: string;
  quote_value: string;
}

/** Node data as returned by getAllNodes(). */
export interface ChainNode {
  address: string;
  remoteUrl: string;
  remoteAddrs: string[];
  gigabyte_prices: PriceEntry[];
  status: number;
  planIds: string[];
}

/** Node status from the /status endpoint (nodeStatusV3). */
export interface NodeStatus {
  type: 'wireguard' | 'v2ray';
  moniker: string;
  peers: number;
  bandwidth: { download: number; upload: number };
  location: {
    city: string;
    country: string;
    country_code: string;
    latitude: number;
    longitude: number;
  };
  qos: { max_peers: number | null };
  clockDriftSec: number | null;
  gigabyte_prices: PriceEntry[];
  _raw: Record<string, unknown>;
}

/** Diagnostic data attached to test results. */
export interface DiagnosticData {
  category?: string;
  phase?: string;
  retryable?: boolean;
  [key: string]: unknown;
}

/** Result of testing a single node. */
export interface TestResult {
  timestamp: string;
  address: string;
  type: 'WireGuard' | 'V2Ray' | 'UNKNOWN' | string;
  moniker: string;
  country: string;
  countryCode?: string;
  city: string;
  reportedDownloadMbps: number;
  actualMbps: number | null;
  baselineAtTest: number | null;
  ispBottleneck: boolean;
  baselineViable: boolean;
  dynamicThreshold: number | null;
  slaApplicable: boolean;
  pass15mbps: boolean;
  pass10mbps: boolean;
  passBaseline: boolean;
  peers: number | null;
  maxPeers: number | null;
  gigabytePrices: PriceEntry[];
  inPlan: boolean;
  planIds: string[];
  googleAccessible?: boolean | null;
  googleLatencyMs?: number | null;
  sdk?: string;
  os?: string;
  error?: string;
  timedOut?: boolean;
  diag?: DiagnosticData;
}

/** Audit pipeline state. */
export interface AuditState {
  status: 'idle' | 'running' | 'paused' | 'paused_internet' | 'done' | 'error';
  totalNodes: number;
  testedNodes: number;
  failedNodes: number;
  retryCount: number;
  passed15: number;
  passed10: number;
  passedBaseline: number;
  baselineMbps: number | null;
  baselineHistory: number[];
  nodeSpeedHistory: number[];
  currentNode: string | null;
  currentType: string | null;
  currentLocation: string | null;
  walletAddress: string | null;
  balance: string | null;
  balanceUdvpn: number;
  estimatedTotalCost: string | null;
  spentUdvpn: number;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  stopRequested: boolean;
  lowBalanceWarning: boolean;
  economyMode: boolean;
  pauseReason: string | null;
  /** Present during retest mode */
  retestMode?: boolean;
  retestTotal?: number;
  retestTested?: number;
  retestPassed?: number;
  retestFailed?: number;
  activeSDK?: string;
}

/** Session map entry for a node. */
export interface SessionEntry {
  sessionId: bigint;
  maxBytes: number;
  usedBytes: number;
}

/** Credential cache entry for a node. */
export interface CredentialEntry {
  savedAt: string;
  [key: string]: unknown;
}

/** Node status on chain (from queryNodeStatusDirect). */
export interface ChainNodeStatus {
  active: boolean;
  status: number | null;
}

/** Subscription info (from querySubscriptions). */
export interface SubscriptionInfo {
  id: string;
  plan_id: string;
  status: string;
  expiry: string;
}

/** Failure classification result. */
export interface FailureClassification {
  category: string;
  retryable: boolean;
  phase: string;
}

/** Options for testNode. */
export interface TestNodeOpts {
  testMb: number;
  gigabytes: number;
  denom: string;
  v2rayAvailable: boolean;
  baselineMbps: number | null;
  onlineTimeoutMs?: number;
  nodeStatus?: NodeStatus | null;
}

/** Broadcast function type (SSE). */
export type BroadcastFn = (event: string, data: Record<string, unknown>) => void;

/** DNS preset configuration. */
export interface DnsPreset {
  name: string;
  servers: string[];
}

/** DNS presets map. */
export interface DnsPresets {
  hns: DnsPreset;
  google: DnsPreset;
  cloudflare: DnsPreset;
  [key: string]: DnsPreset;
}

/** Transport cache entry. */
export interface TransportCacheEntry {
  protocol: string;
  network: string;
  security: string;
  successCount: number;
  failCount: number;
}

/** Speed test result from SDK. */
export interface SpeedTestResult {
  mbps: number;
  bytesDownloaded: number;
  elapsedMs: number;
}

/** Google connectivity check result. */
export interface GoogleCheckResult {
  accessible: boolean;
  latencyMs: number | null;
  error?: string;
}

/** V2Ray process handle. */
export interface V2RayProcess {
  proc: import('child_process').ChildProcess;
  cfgPath: string;
  getStdout: () => string;
  getStderr: () => string;
}

/** Country group from groupNodesByCountry. */
export interface CountryGroup {
  code: string;
  name: string;
  count: number;
  nodes: ChainNode[];
}

// ─── Error Classes ──────────────────────────────────────────────────────────

/** Base audit error with diagnostic data. */
export class AuditError extends Error {
  name: 'AuditError';
  code: string;
  diag: DiagnosticData;
  constructor(message: string, code: string, diag?: DiagnosticData);
}

export class ChainError extends AuditError {
  name: 'ChainError';
  constructor(message: string, diag?: DiagnosticData);
}

export class HandshakeError extends AuditError {
  name: 'HandshakeError';
  constructor(message: string, diag?: DiagnosticData);
}

export class TunnelError extends AuditError {
  name: 'TunnelError';
  constructor(message: string, diag?: DiagnosticData);
}

export class PaymentError extends AuditError {
  name: 'PaymentError';
  constructor(message: string, diag?: DiagnosticData);
}

export class VpnInterferenceError extends AuditError {
  name: 'VpnInterferenceError';
  constructor(message: string, diag?: DiagnosticData);
}

export class NodeUnreachableError extends AuditError {
  name: 'NodeUnreachableError';
  constructor(message: string, diag?: DiagnosticData);
}

export class InsufficientBalanceError extends AuditError {
  name: 'InsufficientBalanceError';
  constructor(message: string, diag?: DiagnosticData);
}

export class SpeedTestError extends AuditError {
  name: 'SpeedTestError';
  constructor(message: string, diag?: DiagnosticData);
}

// Re-exported from sentinel-dvpn-sdk
export { SentinelError, ValidationError, NodeError, SecurityError } from 'sentinel-dvpn-sdk';
export { ErrorCodes, ERROR_SEVERITY, isRetryable, userMessage } from 'sentinel-dvpn-sdk';

// ─── Audit Pipeline ─────────────────────────────────────────────────────────

/** Test a single node. Returns TestResult or null if fundamentally untestable. */
export function testNode(
  client: unknown,
  account: { address: string },
  privkey: Uint8Array,
  node: ChainNode,
  opts: TestNodeOpts,
  preSessionId: bigint | null,
  broadcast: BroadcastFn,
  state: AuditState,
): Promise<TestResult | null>;

/** Test a node with zero-skip retry logic. */
export function testWithRetry(
  testFn: () => Promise<TestResult | null>,
  broadcast: BroadcastFn,
  state: AuditState,
  nodeAddr: string,
): Promise<{ result: TestResult | null; retried: number }>;

/** Run a full audit of all active nodes. */
export function runAudit(
  resume: boolean,
  state: AuditState,
  broadcast: BroadcastFn,
): Promise<void>;

/** Retest previously-failed nodes. */
export function runRetestSkips(
  skipAddrs: string[],
  state: AuditState,
  broadcast: BroadcastFn,
): Promise<void>;

/** Get current results array. */
export function getResults(): TestResult[];

/** Create a fresh audit state. */
export function createState(): AuditState;

// ─── Chain & Wallet ─────────────────────────────────────────────────────────

/** Fetch all active nodes from the chain (RPC primary, LCD fallback). */
export function getAllNodes(broadcast?: BroadcastFn): Promise<ChainNode[]>;

/** Probe LCD endpoints and return the first working one. */
export function findWorkingLcd(): Promise<string | null>;

/** Get the currently active LCD endpoint. */
export function getActiveLcd(): string;

/** Check if a specific node is active on chain. */
export function queryNodeStatusDirect(nodeAddr: string): Promise<ChainNodeStatus>;

/** Invalidate the cached node list. */
export function invalidateNodeCache(): void;

/** Discover active subscription plans. */
export function discoverPlans(
  broadcast?: BroadcastFn,
  opts?: Record<string, unknown>,
): Promise<unknown[]>;

/** Query subscriptions for a wallet address. */
export function querySubscriptions(walletAddress: string): Promise<SubscriptionInfo[]>;

/** Check if a wallet has an active subscription to a plan. */
export function hasActiveSubscription(
  walletAddress: string,
  planId: string,
): Promise<{ has: boolean; subscriptionId?: string }>;

/** Disconnect and clear the cached RPC client. */
export function cleanupRpc(): void;

/** Sign and broadcast with retry + RPC reconnect. */
export function signAndBroadcastRetry(
  client: unknown,
  address: string,
  messages: unknown[],
  fee: { amount: Array<{ denom: string; amount: string }>; gas: string },
  broadcast?: BroadcastFn,
  maxRetries?: number,
): Promise<unknown>;

/** Assert a tx result is successful (throws on failure). */
export function assertIsDeliverTxSuccess(result: unknown): void;

// ─── Session Management ─────────────────────────────────────────────────────

/** Get cached credential for a node. */
export function getCredential(nodeAddr: string): CredentialEntry | null;

/** Save a credential entry for a node. */
export function saveCredential(nodeAddr: string, data: Record<string, unknown>): void;

/** Clear credential for a specific node. */
export function clearCredential(nodeAddr: string): void;

/** Clear all cached credentials. */
export function clearAllCredentials(): void;

/** Mark a session as poisoned (failed handshake). */
export function markSessionPoisoned(nodeAddr: string, sessionId: string): void;

/** Check if a node has been paid this run. */
export function isPaid(nodeAddr: string): boolean;

/** Mark a node as paid this run. */
export function markPaid(nodeAddr: string): void;

/** Clear the paid-nodes set. */
export function clearPaidNodes(): void;

/** Find an existing active session for a node. */
export function findExistingSession(
  nodeAddr: string,
  walletAddress: string,
  broadcast: BroadcastFn | null,
): Promise<bigint | null>;

/** Build a session map from all active sessions for a wallet. */
export function buildSessionMap(
  walletAddress: string,
  broadcast?: BroadcastFn,
): Promise<void>;

/** Submit batch payment for multiple nodes in one tx. */
export function submitBatchPayment(
  client: unknown,
  account: { address: string },
  denom: string,
  gigabytes: number,
  batch: Array<{ node: ChainNode }>,
  state: AuditState,
  broadcast: BroadcastFn,
): Promise<Map<string, bigint>>;

/** Wait for a session to become active on chain. */
export function waitForSessionActive(
  nodeAddr: string,
  walletAddr: string,
  maxWaitMs?: number,
  sessionId?: bigint | null,
): Promise<void>;

/** Extract all session IDs from a multi-message tx. */
export function extractAllSessionIds(txResult: unknown): bigint[];

/** Extract session-to-node mapping from a tx. */
export function extractSessionMap(
  txResult: unknown,
  nodeAddrs?: string[],
): Map<string, bigint> & { _orphanIds: bigint[]; _needsChainLookup: boolean };

/** Invalidate the cached session map. */
export function invalidateSessionCache(): void;

/** Parse gigabyte_prices and return price per GB in udvpn. */
export function parseNodePriceUdvpn(gigabytePrices: PriceEntry[] | string | null): number;

// ─── Protocol ───────────────────────────────────────────────────────────────

/** Query node status via the v3 /status endpoint. */
export function nodeStatusV3(remoteUrl: string): Promise<NodeStatus>;

/** Generate a WireGuard key pair. */
export function generateWgKeyPair(): { publicKey: string; privateKey: string };

/** Perform v3 WireGuard handshake. */
export function initHandshakeV3(
  remoteUrl: string,
  sessionId: bigint,
  privkey: Uint8Array,
  wgPublicKey: string,
): Promise<{ wgConfig: string; [key: string]: unknown }>;

/** Perform v3 V2Ray handshake. */
export function initHandshakeV3V2Ray(
  remoteUrl: string,
  sessionId: bigint,
  privkey: Uint8Array,
): Promise<{ uid: string; metadata: unknown[]; [key: string]: unknown }>;

/** Build a V2Ray client config from handshake result. */
export function buildV2RayClientConfig(
  handshakeResult: unknown,
  socksPort: number,
): unknown;

/** Write a WireGuard config file to disk. */
export function writeWgConfig(config: string, path: string): void;

/** Extract a session ID from a tx result. */
export function extractSessionId(txResult: unknown): bigint | null;

/** Wait for a port to become available. */
export function waitForPort(port: number, timeoutMs?: number): Promise<boolean>;

// ─── Speed Test ─────────────────────────────────────────────────────────────

/** Run a direct speed test (no proxy). */
export function speedtestDirect(sizeMb?: number): Promise<SpeedTestResult>;

/** Run a speed test through a SOCKS5 proxy. */
export function speedtestViaSocks5(
  socksPort: number,
  sizeMb?: number,
): Promise<SpeedTestResult>;

/** Check Google accessibility directly. */
export function checkGoogleDirect(timeoutMs?: number): Promise<GoogleCheckResult>;

/** Check Google accessibility through a SOCKS5 proxy. */
export function checkGoogleViaSocks5(
  proxyPort: number,
  timeoutMs?: number,
): Promise<GoogleCheckResult>;

/** Resolve speed test server IPs. */
export function resolveSpeedtestIPs(): Promise<string[]>;

/** Sleep for a given number of milliseconds. */
export function sleep(ms: number): Promise<void>;

// ─── Diagnostics ────────────────────────────────────────────────────────────

/** Classify a failure error into category, phase, retryable. */
export function classifyFailure(err: Error | string): FailureClassification;

// ─── Platform: Windows WireGuard ────────────────────────────────────────────

/** Install a WireGuard tunnel from a config file. */
export function installWgTunnel(confPath: string): Promise<void>;

/** Uninstall a WireGuard tunnel by name. */
export function uninstallWgTunnel(tunnelName: string): Promise<void>;

/** Whether WireGuard is available on this system. */
export const WG_AVAILABLE: boolean;

/** Whether the process is running as admin. */
export const IS_ADMIN: boolean;

/** Emergency cleanup of WireGuard tunnels (sync). */
export function emergencyCleanupSync(): void;

// ─── Platform: Windows V2Ray ────────────────────────────────────────────────

/** Spawn a V2Ray process with the given config. */
export function spawnV2Ray(
  v2rayConfig: unknown,
  outbound: string,
  socksPort: number,
): Promise<V2RayProcess>;

/** Clean up a V2Ray process. */
export function cleanupV2Ray(proc: V2RayProcess | null): void;

/** Kill all running V2Ray processes. */
export function killAllV2Ray(): void;

/** Kill a V2Ray process by PID. */
export function killV2RayByPid(pid: number | null): void;

/** Get next available SOCKS port. */
export function nextSocksPort(): Promise<number>;

// ─── C# Bridge ──────────────────────────────────────────────────────────────

/** Whether the C# bridge executable is available. */
export const BRIDGE_AVAILABLE: boolean;

/** Query node status via C# bridge. */
export function bridgeNodeStatus(remoteUrl: string): Promise<NodeStatus>;

/** Perform WireGuard handshake via C# bridge. */
export function bridgeHandshakeWG(
  remoteUrl: string,
  sessionId: bigint,
): Promise<unknown>;

/** Perform V2Ray handshake via C# bridge. */
export function bridgeHandshakeV2Ray(
  remoteUrl: string,
  sessionId: bigint,
): Promise<unknown>;

// ─── Transport Cache ────────────────────────────────────────────────────────

/** Reorder outbounds based on cached transport success rates. */
export function reorderOutbounds(
  nodeAddr: string,
  outbounds: unknown[],
): unknown[];

/** Record a successful transport for a node. */
export function recordTransportSuccess(nodeAddr: string, transport: string): void;

/** Record a failed transport globally. */
export function recordTransportFailure(transport: string): void;

/** Get the cached best transport for a node. */
export function getCachedTransport(nodeAddr: string): string | null;

/** Save transport cache to disk. */
export function saveTransportCache(): void;

// ─── Country/Flag Helpers ───────────────────────────────────────────────────

/** Map of lowercase country name/variant to ISO 3166-1 alpha-2 code. */
export const COUNTRY_MAP: Readonly<Record<string, string>>;

/** Convert a country name to ISO code. */
export function countryNameToCode(name: string | null): string | null;

/** Get a flag image URL from flagcdn.com. */
export function getFlagUrl(code: string, width?: number): string;

/** Get emoji flag for a country code. */
export function getFlagEmoji(code: string): string;

/** Group nodes by country. */
export function groupNodesByCountry(nodes: ChainNode[]): CountryGroup[];

// ─── Constants ──────────────────────────────────────────────────────────────

/** Wallet mnemonic from environment. */
export const MNEMONIC: string | undefined;

/** Default RPC endpoint. */
export const RPC: string;

/** Token denomination (udvpn). */
export const DENOM: string;

/** Gas price string. */
export const GAS_PRICE: string;

/** Gigabytes per node session. */
export const GIGS: number;

/** Download size for speed test in MB. */
export const TEST_MB: number;

/** Max nodes to test (0 = unlimited). */
export const MAX_NODES: number;

/** Delay between node tests in ms. */
export const NODE_DELAY: number;

/** Server port. */
export const PORT: number;

/** DNS preset configurations. */
export const DNS_PRESETS: DnsPresets;

/** Currently active DNS servers. */
export let ACTIVE_DNS: string[];

/** Set the active DNS servers. */
export function setActiveDns(servers: string[]): void;

/** v3 MsgStartSession type URL. */
export const V3_MSG_TYPE: string;

/** LCD endpoint URLs. */
export const LCD_ENDPOINTS: string[];

/** Project root directory. */
export const PROJECT_ROOT: string;
