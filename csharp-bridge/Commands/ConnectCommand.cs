using Sentinel.SDK.Core;
using Sentinel.SDK.Node;

namespace SentinelBridge.Commands;

// ─── Connect Command ───

/// <summary>
/// Handles the handshake and full connect flow:
///   handshake — perform V3 handshake only (session must already exist)
///   connect   — full flow: check balance, pay, create session, handshake
/// </summary>
internal static class ConnectCommand
{
    private const int HANDSHAKE_TIMEOUT_MS = 90_000;
    private const int CHAIN_PROPAGATION_DELAY_MS = 10_000;
    private const int SESSION_409_RETRY_DELAY_MS = 15_000;

    // ─── Handshake Only ───

    /// <summary>
    /// Perform a V3 handshake with a node using an existing on-chain session.
    /// </summary>
    public static async Task HandshakeAsync(
        string nodeUrl,
        ulong sessionId,
        string mnemonic,
        string tunnelType,
        CancellationToken ct)
    {
        Output.Log($"Handshake: node={nodeUrl} session={sessionId} type={tunnelType}");

        var type = ParseHandshakeType(tunnelType);

        using var wallet = SentinelWallet.FromMnemonic(mnemonic);
        Output.Log($"Wallet: {wallet.Address}");

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(HANDSHAKE_TIMEOUT_MS);

        var result = await Handshake.HandshakeAsync(wallet, nodeUrl, sessionId, type, ct: timeoutCts.Token);

        if (result is WireGuardHandshakeResult wg)
        {
            Output.Success(new
            {
                type = "wireguard",
                sessionId,
                serverPublicKey = wg.ServerPublicKey,
                assignedAddresses = wg.AssignedAddresses,
                serverEndpoint = wg.ServerEndpoint,
                clientPrivateKey = Convert.ToBase64String(wg.ClientPrivateKey),
            });
        }
        else if (result is V2RayHandshakeResult v2)
        {
            Output.Success(new
            {
                type = "v2ray",
                sessionId,
                uuid = v2.Uuid,
                proxyProtocol = v2.ProxyProtocol,
                transport = v2.Transport,
                tls = v2.Tls,
                port = v2.Port,
                allEntries = v2.AllEntries.Select(e => new
                {
                    proxy_protocol = e.ProxyProtocol,
                    transport_protocol = e.Transport,
                    transport_security = e.Tls,
                    port = e.Port,
                }).ToArray(),
            });
        }
        else
        {
            Output.Error("Unexpected handshake result type", "HANDSHAKE_UNKNOWN_TYPE");
        }
    }

    // ─── Full Connect Flow ───

    /// <summary>
    /// Full connect flow: balance check, subscribe, wait for chain, handshake.
    /// Does NOT start the tunnel — the Node.js caller manages tunnels.
    /// </summary>
    public static async Task FullConnectAsync(
        string nodeUrl,
        string mnemonic,
        int gigabytes,
        CancellationToken ct)
    {
        Output.Log($"Full connect: node={nodeUrl} gb={gigabytes}");

        if (gigabytes < 1 || gigabytes > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(gigabytes), "Must be 1-100");
        }

        var logger = new BridgeLogger();

        using var wallet = SentinelWallet.FromMnemonic(mnemonic);
        Output.Log($"Wallet: {wallet.Address}");

        var chainClient = new ChainClient(logger: logger);
        var txBuilder = new TransactionBuilder(wallet, chainClient);

        // ─── Step 1: Check balance ───
        Output.Log("Step 1/5: Checking balance...");
        var balance = await chainClient.GetBalanceAsync(wallet.Address, ct);
        Output.Log($"Balance: {balance.Display}");

        if (balance.Udvpn < 100_000)
        {
            throw new SentinelException(
                "INSUFFICIENT_BALANCE",
                $"Balance too low: {balance.Display}. Need at least 0.1 P2P for gas.");
        }

        // ─── Step 2: Query node on-chain ───
        Output.Log("Step 2/5: Querying node on chain...");
        var nodeStatus = await NodeClient.GetStatusAsync(nodeUrl, ct: ct);
        Output.Log($"Node type: {nodeStatus.Type}, peers: {nodeStatus.Peers}");

        // Check clock drift — VMess AEAD fails at >120s drift
        // If VLess available, we can still connect. If VMess-only, warn but try.
        if (nodeStatus.Type == "v2ray" && nodeStatus.ClockDriftSec.HasValue
            && Math.Abs(nodeStatus.ClockDriftSec.Value) > 120)
        {
            Output.Log($"WARNING: Clock drift {nodeStatus.ClockDriftSec}s exceeds VMess AEAD limit (120s). VLess preferred.");
        }

        // ─── Step 3: Look for node address on chain ───
        Output.Log("Step 3/5: Looking up node address...");

        // Extract IP from nodeUrl for chain lookup
        var nodeUri = new Uri(nodeUrl);
        var nodeIp = nodeUri.Host;

        // Find the node's sentnode address by matching remote URL
        var activeNodes = await chainClient.GetActiveNodesAsync(2000, ct);
        string? nodeAddress = null;

        foreach (var node in activeNodes)
        {
            if (node.RemoteUrl != null && node.RemoteUrl.Contains(nodeIp))
            {
                nodeAddress = node.Address;
                break;
            }

            foreach (var addr in node.RemoteAddrs)
            {
                if (addr.Contains(nodeIp))
                {
                    nodeAddress = node.Address;
                    break;
                }
            }

            if (nodeAddress != null) break;
        }

        if (nodeAddress == null)
        {
            throw new SentinelException(
                ErrorCodes.NodeNotFound,
                $"Could not find node with IP {nodeIp} on chain. Is the node registered and active?");
        }

        Output.Log($"Found node address: {nodeAddress}");

        // ─── Step 4: Check for existing session or create new one ───
        Output.Log("Step 4/5: Creating session...");
        var existingSession = await SessionManager.FindExistingSessionAsync(
            chainClient, wallet.Address, nodeAddress, ct);

        ulong sessionId;
        bool sessionReused;

        if (existingSession.HasValue)
        {
            sessionId = existingSession.Value;
            sessionReused = true;
            Output.Log($"Reusing existing session: {sessionId}");
        }
        else
        {
            // Create new GB-based session
            var startMsg = MessageBuilder.StartSession(
                from: wallet.Address,
                nodeAddress: nodeAddress,
                gigabytes: gigabytes);

            Output.Log($"Broadcasting StartSession TX ({gigabytes} GB)...");
            var txResult = await txBuilder.BroadcastAsync(startMsg);

            if (!txResult.Success)
            {
                // Code 105: node inactive on chain (LCD stale)
                // Verify across multiple LCDs before giving up, then retry with longer waits
                if (txResult.RawLog?.Contains("invalid status inactive") == true)
                {
                    Output.Log("Code 105 — checking node status across LCDs...");
                    var lcdEndpoints = new[]
                    {
                        "https://lcd.sentinel.co",
                        "https://api.sentinel.quokkastake.io",
                        "https://sentinel-api.polkachu.com",
                    };
                    bool confirmedActive = false;
                    foreach (var lcd in lcdEndpoints)
                    {
                        try
                        {
                            using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
                            var r = await httpClient.GetStringAsync($"{lcd}/sentinel/node/v3/nodes/{nodeAddress}", ct);
                            if (r.Contains("\"status\":1") || r.Contains("\"status\":\"active\""))
                            {
                                confirmedActive = true;
                                Output.Log($"LCD {lcd} confirms node is active — blockchain lag");
                                break;
                            }
                        }
                        catch { }
                    }

                    if (!confirmedActive)
                    {
                        throw new SentinelException(
                            ErrorCodes.TxFailed,
                            $"Node genuinely inactive on chain (confirmed across LCDs, peers={nodeStatus.Peers})");
                    }

                    // Active on LCD but chain rejected — retry with longer waits
                    Output.Log("Retrying payment in 20s (blockchain lag)...");
                    await Task.Delay(20_000, ct);
                    txResult = await txBuilder.BroadcastAsync(startMsg);

                    if (!txResult.Success && txResult.RawLog?.Contains("invalid status inactive") == true)
                    {
                        Output.Log("Still Code 105 — final attempt in 30s...");
                        await Task.Delay(30_000, ct);
                        txResult = await txBuilder.BroadcastAsync(startMsg);
                    }
                }

                if (!txResult.Success)
                {
                    throw new SentinelException(
                        ErrorCodes.TxFailed,
                        $"StartSession TX failed (code {txResult.Code}): {txResult.RawLog}");
                }
            }

            Output.Log($"TX succeeded: {txResult.TxHash}");

            // Wait for chain propagation
            Output.Log($"Waiting {CHAIN_PROPAGATION_DELAY_MS}ms for chain propagation...");
            await Task.Delay(CHAIN_PROPAGATION_DELAY_MS, ct);

            // Find the new session
            var newSession = await SessionManager.FindExistingSessionAsync(
                chainClient, wallet.Address, nodeAddress, ct);

            if (!newSession.HasValue)
            {
                throw new SentinelException(
                    "SESSION_NOT_FOUND",
                    "Session was created but not found on chain. Try again in a few seconds.");
            }

            sessionId = newSession.Value;
            sessionReused = false;
            Output.Log($"New session created: {sessionId}");
        }

        // ─── Step 5: V3 Handshake ───
        Output.Log("Step 5/5: Performing V3 handshake...");
        var handshakeType = nodeStatus.Type == "wireguard"
            ? HandshakeType.WireGuard
            : HandshakeType.V2Ray;

        using var handshakeCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        handshakeCts.CancelAfter(HANDSHAKE_TIMEOUT_MS);

        object? handshakeResult = null;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                handshakeResult = await Handshake.HandshakeAsync(
                    wallet, nodeUrl, sessionId, handshakeType, ct: handshakeCts.Token);
                break;
            }
            catch (SentinelException ex) when (ex.Message.Contains("already exists"))
            {
                var delay = attempt == 0 ? SESSION_409_RETRY_DELAY_MS : 20_000;
                Output.Log($"Session exists on node (attempt {attempt + 1}/3) — waiting {delay / 1000}s...");
                await Task.Delay(delay, ct);
            }
            catch (SentinelException ex) when (ex.Message.Contains("address mismatch"))
            {
                // Node config mismatch — retry once, may be transient
                if (attempt == 0)
                {
                    Output.Log("Address mismatch — retrying in 5s...");
                    await Task.Delay(5_000, ct);
                    continue;
                }
                throw new SentinelException("NODE_MISCONFIGURED", $"Node address mismatch (persistent): {ex.Message}");
            }
            catch (SentinelException ex) when (ex.Message.Contains("ABCI query failed") || ex.Message.Contains("context deadline exceeded"))
            {
                // Node RPC broken — retry once after delay
                if (attempt == 0)
                {
                    Output.Log("Node RPC timeout — retrying in 20s...");
                    await Task.Delay(20_000, ct);
                    continue;
                }
                throw new SentinelException("NODE_RPC_BROKEN", $"Node RPC broken after retry: {ex.Message}");
            }
            catch (SentinelException ex) when (ex.Message.Contains("no such table") || ex.Message.Contains("database is locked"))
            {
                // Node database corrupt — don't retry
                throw new SentinelException("NODE_DB_CORRUPT", $"Node database corrupt: {ex.Message}");
            }
        }

        // If all 3 attempts failed with 409 — pay for a FRESH session and retry once
        if (handshakeResult == null)
        {
            Output.Log("409 persisted after 3 attempts — paying for fresh session...");
            var freshMsg = MessageBuilder.StartSession(
                from: wallet.Address,
                nodeAddress: nodeAddress,
                gigabytes: gigabytes);
            var freshTx = await txBuilder.BroadcastAsync(freshMsg);
            if (!freshTx.Success)
            {
                throw new SentinelException("HANDSHAKE_409",
                    $"Node rejected session 3x and fresh payment failed: {freshTx.RawLog}");
            }

            Output.Log($"Fresh TX: {freshTx.TxHash} — waiting for chain propagation...");
            await Task.Delay(CHAIN_PROPAGATION_DELAY_MS, ct);

            var freshSession = await SessionManager.FindExistingSessionAsync(
                chainClient, wallet.Address, nodeAddress, ct);
            if (!freshSession.HasValue)
            {
                throw new SentinelException("HANDSHAKE_409",
                    "Fresh session created but not found on chain");
            }

            sessionId = freshSession.Value;
            sessionReused = false;
            Output.Log($"Fresh session {sessionId} — retrying handshake...");
            await Task.Delay(5_000, ct); // Wait for node to index

            try
            {
                using var freshCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                freshCts.CancelAfter(HANDSHAKE_TIMEOUT_MS);
                handshakeResult = await Handshake.HandshakeAsync(
                    wallet, nodeUrl, sessionId, handshakeType, ct: freshCts.Token);
            }
            catch (Exception ex)
            {
                throw new SentinelException("HANDSHAKE_409",
                    $"409 persistent even after fresh session: {ex.Message}");
            }
        }

        // ─── Output result ───
        if (handshakeResult is WireGuardHandshakeResult wg)
        {
            Output.Success(new
            {
                type = "wireguard",
                sessionId,
                sessionReused,
                nodeAddress,
                balance = new { udvpn = balance.Udvpn, p2p = balance.P2P, display = balance.Display },
                node = new
                {
                    moniker = nodeStatus.Moniker,
                    peers = nodeStatus.Peers,
                    clockDriftSec = nodeStatus.ClockDriftSec,
                    location = $"{nodeStatus.Location.City}, {nodeStatus.Location.Country}",
                },
                wireguard = new
                {
                    serverPublicKey = wg.ServerPublicKey,
                    assignedAddresses = wg.AssignedAddresses,
                    serverEndpoint = wg.ServerEndpoint,
                    clientPrivateKey = Convert.ToBase64String(wg.ClientPrivateKey),
                },
            });
        }
        else if (handshakeResult is V2RayHandshakeResult v2)
        {
            Output.Success(new
            {
                type = "v2ray",
                sessionId,
                sessionReused,
                nodeAddress,
                balance = new { udvpn = balance.Udvpn, p2p = balance.P2P, display = balance.Display },
                node = new
                {
                    moniker = nodeStatus.Moniker,
                    peers = nodeStatus.Peers,
                    clockDriftSec = nodeStatus.ClockDriftSec,
                    location = $"{nodeStatus.Location.City}, {nodeStatus.Location.Country}",
                },
                v2ray = new
                {
                    uuid = v2.Uuid,
                    proxyProtocol = v2.ProxyProtocol,
                    transport = v2.Transport,
                    tls = v2.Tls,
                    port = v2.Port,
                },
            });
        }
        else
        {
            Output.Error("Unexpected handshake result type", "HANDSHAKE_UNKNOWN_TYPE");
        }
    }

    // ─── Helpers ───

    private static HandshakeType ParseHandshakeType(string type)
    {
        return type.ToLowerInvariant() switch
        {
            "wireguard" or "wg" => HandshakeType.WireGuard,
            "v2ray" => HandshakeType.V2Ray,
            _ => throw new ArgumentException(
                $"Invalid tunnel type '{type}'. Use 'wireguard' or 'v2ray'."),
        };
    }
}
