using Sentinel.SDK.Core;

namespace SentinelBridge.Commands;

// ─── Speedtest Command ───

/// <summary>
/// Runs a direct (no-proxy) speed test using Cloudflare CDN.
/// Measures baseline internet speed for comparison with VPN throughput.
/// </summary>
internal static class SpeedtestCommand
{
    private const int SPEEDTEST_TIMEOUT_MS = 60_000;

    public static async Task DirectAsync(CancellationToken ct)
    {
        Output.Log("Running direct speed test (Cloudflare CDN)...");

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(SPEEDTEST_TIMEOUT_MS);

        var result = await SpeedTest.DirectAsync(timeoutCts.Token);

        Output.Success(new
        {
            mbps = result.Mbps,
            chunks = result.Chunks,
            adaptive = result.Adaptive,
            totalBytes = result.TotalBytes,
            seconds = result.Seconds,
        });
    }

    /// <summary>
    /// Run speed test through a SOCKS5 proxy (for VPN tunnel measurement).
    /// </summary>
    public static async Task ViaSocksAsync(int socksPort, string? user, string? pass, CancellationToken ct)
    {
        Output.Log($"Running SOCKS5 speed test on port {socksPort}...");

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(SPEEDTEST_TIMEOUT_MS);

        var result = await SpeedTest.ViaSocks5Async(socksPort, user, pass, timeoutCts.Token);

        Output.Success(new
        {
            mbps = result.Mbps,
            chunks = result.Chunks,
            adaptive = result.Adaptive,
            totalBytes = result.TotalBytes,
            seconds = result.Seconds,
            proxy = new { port = socksPort, authenticated = user != null },
        });
    }
}
