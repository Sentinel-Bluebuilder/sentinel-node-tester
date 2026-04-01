@echo off
setlocal

:: Check admin
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: This setup must be run as Administrator.
    echo Right-click this file and choose "Run as administrator".
    pause
    exit /b 1
)

set "TASK_NAME=SentinelAudit"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
set "SERVER_JS=%~dp0server.js"
set "WORK_DIR=%~dp0"

echo ============================================
echo  Sentinel Audit — One-Time Setup
echo ============================================
echo.
echo Registering scheduled task with admin privileges...
echo Task:    %TASK_NAME%
echo Node:    %NODE_EXE%
echo Server:  %SERVER_JS%
echo.

:: Delete existing task if any
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

:: Create task via PowerShell (more reliable than schtasks XML)
powershell -NoProfile -Command ^
  "$a = New-ScheduledTaskAction -Execute '%NODE_EXE%' -Argument '\"%SERVER_JS%\"' -WorkingDirectory '%WORK_DIR%';" ^
  "$p = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -RunLevel Highest -LogonType Interactive;" ^
  "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -MultipleInstances IgnoreNew;" ^
  "Register-ScheduledTask -TaskName '%TASK_NAME%' -Action $a -Principal $p -Settings $s -Force | Out-Null;" ^
  "Write-Host 'Task registered.'"

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Failed to register task.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Setup complete!
echo.
echo  You can now double-click SentinelAudit.exe
echo  on your Desktop - NO admin prompt, ever.
echo ============================================
echo.
pause
