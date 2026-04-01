/**
 * Sentinel Node Tester — JSDoc Type Definitions
 * Shared types used across all modules.
 */

/**
 * @typedef {Object} ChainNode
 * @property {string} address - sentnode1... address
 * @property {string} remoteUrl - Node's HTTPS URL
 * @property {Array} gigabyte_prices - Price entries [{denom, base_value, quote_value}]
 * @property {string[]} planIds - Plan IDs this node belongs to
 */

/**
 * @typedef {Object} NodeStatus
 * @property {'wireguard'|'v2ray'} type - Node VPN type
 * @property {string} moniker - Node name
 * @property {number} peers - Current peer count
 * @property {{download: number, upload: number}} bandwidth - Reported bandwidth (bytes/s)
 * @property {{city: string, country: string, country_code: string, latitude: number, longitude: number}} location
 * @property {{max_peers: number|null}} qos
 * @property {number|null} clockDriftSec - Server clock drift in seconds
 * @property {Array} gigabyte_prices
 * @property {Object} _raw - Raw API response
 */

/**
 * @typedef {Object} TestResult
 * @property {string} timestamp - ISO timestamp
 * @property {string} address - Node sentnode1... address
 * @property {'WireGuard'|'V2Ray'} type - Protocol type
 * @property {string} moniker - Node name
 * @property {string} country - Country
 * @property {string} city - City
 * @property {number} reportedDownloadMbps - Node-reported speed
 * @property {number|null} actualMbps - Measured speed (null = failure)
 * @property {number|null} baselineAtTest - Baseline at time of test
 * @property {boolean} ispBottleneck - True if ISP limits the measurement
 * @property {boolean} baselineViable - True if baseline >= 30 Mbps
 * @property {number|null} dynamicThreshold - 50% of baseline
 * @property {boolean} slaApplicable - True if baseline >= 30 Mbps
 * @property {boolean} pass15mbps - True if actual >= 15 Mbps
 * @property {boolean} pass10mbps - True if actual >= 10 Mbps
 * @property {boolean} passBaseline - True if actual >= 50% baseline
 * @property {number|null} peers - Current peer count
 * @property {number|null} maxPeers - Max peers
 * @property {Array} gigabytePrices - Price entries
 * @property {boolean} inPlan - True if node is in a subscription plan
 * @property {string[]} planIds - Plan IDs
 * @property {string} [error] - Error message if failed
 * @property {boolean} [timedOut] - True if timed out
 * @property {Object} [diag] - Diagnostic data
 */

/**
 * @typedef {Object} AuditState
 * @property {'idle'|'running'|'paused'|'done'|'error'} status
 * @property {number} totalNodes
 * @property {number} testedNodes
 * @property {number} failedNodes - Was skippedNodes, now counts FAIL results
 * @property {number} retryCount - Total retries attempted
 * @property {number} passed15
 * @property {number} passed10
 * @property {number} passedBaseline
 * @property {number|null} baselineMbps
 * @property {Array} baselineHistory
 * @property {Array} nodeSpeedHistory
 * @property {string|null} currentNode
 * @property {string|null} currentType
 * @property {string|null} currentLocation
 * @property {string|null} walletAddress
 * @property {string|null} balance
 * @property {number} balanceUdvpn
 * @property {string|null} estimatedTotalCost
 * @property {number} spentUdvpn
 * @property {string|null} startedAt
 * @property {string|null} completedAt
 * @property {string|null} errorMessage
 * @property {boolean} stopRequested
 * @property {boolean} lowBalanceWarning
 * @property {boolean} economyMode
 * @property {string|null} pauseReason - Why audit is paused (VPN interference, etc.)
 */

export {};
