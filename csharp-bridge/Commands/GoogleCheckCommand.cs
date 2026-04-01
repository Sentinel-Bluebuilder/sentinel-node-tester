namespace SentinelBridge.Commands;

// ─── Google Check Command ───

/// <summary>
/// Checks google.com reachability — used to verify VPN tunnel is passing traffic.
/// Makes a direct HTTP request (follows system proxy / active tunnel).
/// </summary>
internal static class GoogleCheckCommand
{
    private const int CHECK_TIMEOUT_MS = 15_000;
    private const string CHECK_URL = "https://www.google.com";
    private const string IP_CHECK_URL = "https://api.ipify.org?format=json";

    private static readonly HttpClient SharedClient = new(
        new HttpClientHandler
        {
            // Allow self-signed certs in case proxy intercepts
            ServerCertificateCustomValidationCallback = (_, _, _, _) => true,
        })
    {
        Timeout = TimeSpan.FromMilliseconds(CHECK_TIMEOUT_MS),
    };

    public static async Task ExecuteAsync(CancellationToken ct)
    {
        Output.Log("Checking google.com reachability...");

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(CHECK_TIMEOUT_MS);

        var googleReachable = false;
        string? googleError = null;
        int? googleStatusCode = null;
        double googleLatencyMs = 0;

        try
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var response = await SharedClient.GetAsync(CHECK_URL, timeoutCts.Token);
            sw.Stop();

            googleStatusCode = (int)response.StatusCode;
            googleLatencyMs = sw.Elapsed.TotalMilliseconds;
            googleReachable = response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            googleError = ex.Message;
        }

        // Also try to get public IP for tunnel verification
        string? publicIp = null;
        try
        {
            var ipResponse = await SharedClient.GetStringAsync(IP_CHECK_URL, timeoutCts.Token);
            // Response is {"ip":"1.2.3.4"}
            var doc = System.Text.Json.JsonDocument.Parse(ipResponse);
            publicIp = doc.RootElement.GetProperty("ip").GetString();
        }
        catch
        {
            // Non-fatal — IP check is supplementary
        }

        Output.Success(new
        {
            googleReachable,
            googleStatusCode,
            googleLatencyMs = Math.Round(googleLatencyMs, 1),
            googleError,
            publicIp,
        });
    }
}
