using Sentinel.SDK.Core;

namespace SentinelBridge.Commands;

// ─── Balance Command ───

/// <summary>
/// Checks wallet balance on the Sentinel chain.
/// Derives the wallet from a mnemonic and queries the LCD.
/// </summary>
internal static class BalanceCommand
{
    private const int BALANCE_TIMEOUT_MS = 15_000;

    public static async Task ExecuteAsync(string mnemonic, CancellationToken ct)
    {
        Output.Log("Checking wallet balance...");

        using var wallet = SentinelWallet.FromMnemonic(mnemonic);
        Output.Log($"Wallet: {wallet.Address}");

        var logger = new BridgeLogger();
        var chainClient = new ChainClient(logger: logger);

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(BALANCE_TIMEOUT_MS);

        var balance = await chainClient.GetBalanceAsync(wallet.Address, timeoutCts.Token);

        Output.Success(new
        {
            address = wallet.Address,
            udvpn = balance.Udvpn,
            p2p = balance.P2P,
            display = balance.Display,
        });
    }
}
