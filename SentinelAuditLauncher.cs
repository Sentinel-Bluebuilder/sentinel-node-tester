using System;
using System.Diagnostics;
using System.Threading;

class SentinelAuditLauncher
{
    const string TASK_NAME = "SentinelAudit";

    static void Main()
    {
        // Kill any existing process on port 3001
        KillPort3001();

        // Start the server via the pre-registered scheduled task (no UAC needed)
        int exitCode = RunTask();

        if (exitCode != 0)
        {
            Console.WriteLine("ERROR: Scheduled task not found.");
            Console.WriteLine("Please run 'Setup (Run Once As Admin).bat' first.");
            Console.WriteLine("Right-click it and choose 'Run as administrator'.");
            Console.WriteLine();
            Console.WriteLine("Press Enter to exit.");
            Console.ReadLine();
            return;
        }

        Console.WriteLine("Server starting...");
        Thread.Sleep(5000);

        // Open browser
        Process.Start(new ProcessStartInfo
        {
            FileName = "http://localhost:3001",
            UseShellExecute = true
        });

        Console.WriteLine("Dashboard open: http://localhost:3001");
        Console.WriteLine("Press Enter to close this window (server keeps running).");
        Console.ReadLine();
    }

    static int RunTask()
    {
        var p = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "schtasks.exe",
                Arguments = "/run /tn \"" + TASK_NAME + "\"",
                UseShellExecute = false,
                CreateNoWindow = true
            }
        };
        p.Start();
        p.WaitForExit();
        return p.ExitCode;
    }

    static void KillPort3001()
    {
        try
        {
            var p = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -Command \"Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }\"",
                    UseShellExecute = false,
                    CreateNoWindow = true
                }
            };
            p.Start();
            p.WaitForExit(5000);
        }
        catch { }
    }
}
