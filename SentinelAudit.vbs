' SentinelAudit.vbs
' Double-click to launch Sentinel Audit Dashboard as Administrator.
' UAC prompt appears ONCE. After that, all WireGuard tunnels work without prompts.

Dim oShell, oFSO, sDir, sCmd
Set oShell  = CreateObject("Shell.Application")
Set oFSO    = CreateObject("Scripting.FileSystemObject")

sDir  = oFSO.GetParentFolderName(WScript.ScriptFullName)
sCmd  = "/k title Sentinel Audit && cd /d """ & sDir & """ && echo. && echo  Sentinel dVPN Network Audit Dashboard && echo  Starting server as Administrator... && echo. && node server.js"

' Launch cmd.exe elevated (triggers UAC once, then runs as full admin)
oShell.ShellExecute "cmd.exe", sCmd, sDir, "runas", 1

' Wait a moment then open browser
WScript.Sleep 4000
oShell.Open "http://localhost:3001"
