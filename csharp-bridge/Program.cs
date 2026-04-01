using System.Text.Json;
using System.Text.Json.Serialization;
using SentinelBridge.Commands;

namespace SentinelBridge;

// ─── JSON Output Helpers ───

/// <summary>
/// Standard JSON output envelope for all bridge commands.
/// All stdout output is valid JSON; diagnostic logs go to stderr.
/// </summary>
internal static class Output
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>Write a success result to stdout as JSON.</summary>
    public static void Success(object data)
    {
        var envelope = new { success = true, data };
        Console.WriteLine(JsonSerializer.Serialize(envelope, JsonOptions));
    }

    /// <summary>Write an error result to stdout as JSON.</summary>
    public static void Error(string message, string? code = null, object? details = null)
    {
        var envelope = new { success = false, error = message, code, details };
        Console.WriteLine(JsonSerializer.Serialize(envelope, JsonOptions));
    }

    /// <summary>Write a diagnostic message to stderr (not captured by Node.js).</summary>
    public static void Log(string message)
    {
        Console.Error.WriteLine($"[bridge] {message}");
    }
}

// ─── Bridge Logger ───

/// <summary>
/// SDK logger that routes all output to stderr so it does not pollute JSON stdout.
/// </summary>
internal class BridgeLogger : Sentinel.SDK.Core.ISdkLogger
{
    public void Debug(string message) { }
    public void Info(string message) => Console.Error.WriteLine($"[sdk] {message}");
    public void Warn(string message) => Console.Error.WriteLine($"[sdk:warn] {message}");
    public void Error(string message, Exception? ex = null) =>
        Console.Error.WriteLine($"[sdk:error] {message}{(ex != null ? $" - {ex.Message}" : "")}");
}

// ─── Entry Point ───

internal static class Program
{
    private const int GLOBAL_TIMEOUT_MS = 120_000; // 2 minute hard timeout for any command

    private static async Task<int> Main(string[] args)
    {
        if (args.Length == 0)
        {
            PrintUsage();
            return 1;
        }

        var command = args[0].ToLowerInvariant();

        using var cts = new CancellationTokenSource(GLOBAL_TIMEOUT_MS);

        try
        {
            switch (command)
            {
                case "status":
                    ValidateArgCount(args, 2, "status <nodeUrl>");
                    await StatusCommand.ExecuteAsync(args[1], cts.Token);
                    break;

                case "handshake":
                    ValidateArgCount(args, 5, "handshake <nodeUrl> <sessionId> <mnemonic> <type>");
                    await ConnectCommand.HandshakeAsync(
                        nodeUrl: args[1],
                        sessionId: ulong.Parse(args[2]),
                        mnemonic: args[3],
                        tunnelType: args[4],
                        cts.Token);
                    break;

                case "connect":
                    ValidateArgCount(args, 4, "connect <nodeUrl> <mnemonic> <gigabytes>");
                    await ConnectCommand.FullConnectAsync(
                        nodeUrl: args[1],
                        mnemonic: args[2],
                        gigabytes: int.Parse(args[3]),
                        cts.Token);
                    break;

                case "speedtest-direct":
                    await SpeedtestCommand.DirectAsync(cts.Token);
                    break;

                case "google-check":
                    await GoogleCheckCommand.ExecuteAsync(cts.Token);
                    break;

                case "balance":
                    ValidateArgCount(args, 2, "balance <mnemonic>");
                    await BalanceCommand.ExecuteAsync(args[1], cts.Token);
                    break;

                case "version":
                    Output.Success(new
                    {
                        bridge = "1.0.0",
                        runtime = Environment.Version.ToString(),
                        os = Environment.OSVersion.ToString(),
                    });
                    break;

                default:
                    Output.Error($"Unknown command: {command}");
                    PrintUsage();
                    return 1;
            }

            return 0;
        }
        catch (OperationCanceledException)
        {
            Output.Error("Command timed out", "TIMEOUT");
            return 2;
        }
        catch (Sentinel.SDK.Core.SentinelException ex)
        {
            Output.Error(ex.Message, ex.Code, ex.Details);
            return 1;
        }
        catch (Exception ex)
        {
            Output.Error($"Unexpected error: {ex.Message}", "INTERNAL_ERROR");
            Output.Log(ex.ToString());
            return 1;
        }
    }

    private static void ValidateArgCount(string[] args, int required, string usage)
    {
        if (args.Length < required)
        {
            throw new ArgumentException($"Not enough arguments. Usage: SentinelBridge {usage}");
        }
    }

    private static void PrintUsage()
    {
        Output.Error(
            "Usage: SentinelBridge <command> [args...]",
            "USAGE",
            new
            {
                commands = new[]
                {
                    "status <nodeUrl>                          - Query node status",
                    "handshake <nodeUrl> <sessionId> <mnemonic> <type> - V3 handshake (type: wireguard|v2ray)",
                    "connect <nodeUrl> <mnemonic> <gigabytes>  - Full connect flow",
                    "speedtest-direct                          - Baseline speed test",
                    "google-check                              - Check google.com reachability",
                    "balance <mnemonic>                        - Check wallet balance",
                    "version                                   - Show version info",
                },
            });
    }
}
