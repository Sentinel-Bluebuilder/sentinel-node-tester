using Sentinel.SDK.Node;

namespace SentinelBridge.Commands;

// ─── Status Command ───

/// <summary>
/// Queries a Sentinel node for its current status including location,
/// bandwidth, peer count, clock drift, and QoS info.
/// </summary>
internal static class StatusCommand
{
    private const int STATUS_TIMEOUT_MS = 15_000;

    public static async Task ExecuteAsync(string nodeUrl, CancellationToken ct)
    {
        Output.Log($"Querying status for {nodeUrl}...");

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(STATUS_TIMEOUT_MS);

        var status = await NodeClient.GetStatusAsync(nodeUrl, ct: timeoutCts.Token);

        Output.Success(new
        {
            type = status.Type,
            moniker = status.Moniker,
            peers = status.Peers,
            maxPeers = status.MaxPeers,
            clockDriftSec = status.ClockDriftSec,
            location = new
            {
                city = status.Location.City,
                country = status.Location.Country,
                countryCode = status.Location.CountryCode,
                latitude = status.Location.Latitude,
                longitude = status.Location.Longitude,
            },
            bandwidth = new
            {
                upload = status.Bandwidth.Upload,
                download = status.Bandwidth.Download,
                uploadMbps = Math.Round(status.Bandwidth.Upload * 8.0 / 1_000_000, 2),
                downloadMbps = Math.Round(status.Bandwidth.Download * 8.0 / 1_000_000, 2),
            },
        });
    }
}
