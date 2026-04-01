@echo off
echo ============================================
echo  Sentinel dVPN Network Audit Dashboard
echo ============================================
echo.

REM Auto-elevate to Administrator
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator privileges...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"

REM Kill any existing instance on port 3001
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3001 ^| findstr LISTENING 2^>nul') do (
  echo Killing existing process on port 3001 (PID %%a)
  taskkill /PID %%a /F >nul 2>&1
)

REM Install dependencies if node_modules missing
if not exist "node_modules" (
  echo Installing dependencies...
  npm install
  echo.
)

echo Starting server...
echo Dashboard: http://localhost:3001
echo.
start "" http://localhost:3001
node server.js
pause
