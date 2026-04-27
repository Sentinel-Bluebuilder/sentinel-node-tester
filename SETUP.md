# Setup Guide -- New Machine

Step-by-step instructions to get the Sentinel Node Auditor running on a fresh Windows 11 machine.

---

## 1. Install Node.js 20+

```powershell
winget install OpenJS.NodeJS.LTS
```

Or download from [nodejs.org](https://nodejs.org/). Verify:

```bash
node --version   # v20.x or higher
npm --version    # v10.x or higher
```

---

## 2. Install WireGuard

```powershell
winget install WireGuard.WireGuard
```

Or download from [wireguard.com/install](https://www.wireguard.com/install/).

Verify the binary exists at `C:\Program Files\WireGuard\wireguard.exe`. The auditor requires Administrator privileges to manage WireGuard tunnel services.

---

## 3. Install .NET 8 SDK (for C# bridge)

```powershell
winget install Microsoft.DotNet.SDK.8
```

Or download from [dotnet.microsoft.com](https://dotnet.microsoft.com/download/dotnet/8.0). Verify:

```bash
dotnet --version   # 8.x
```

Skip this step if you only plan to use the JavaScript SDK for testing.

---

## 4. Get the Project

Clone or copy `sentinel-node-tester/` to your machine. The expected location is `Desktop\sentinel-node-tester\`.

---

## 5. Install Dependencies

```bash
cd sentinel-node-tester
npm install
```

---

## 6. Create `.env`

Create a `.env` file in the project root with your Sentinel wallet mnemonic:

```env
MNEMONIC=word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12
RPC=https://rpc.sentinel.co:443
DENOM=udvpn
GAS_PRICE=0.2udvpn
GIGABYTES_PER_NODE=1
TEST_MB=10
MAX_NODES=0
NODE_DELAY_MS=5000
```

| Variable | Required | Notes |
|----------|----------|-------|
| `MNEMONIC` | Yes | Your Sentinel wallet mnemonic. Wallet must have P2P tokens. |
| `RPC` | No | Defaults to `https://rpc.sentinel.co:443`. |
| `DENOM` | No | Always `udvpn`. Do not change. |
| `GAS_PRICE` | No | `0.2udvpn` is the standard gas price. |
| `GIGABYTES_PER_NODE` | No | 1 GB per session is sufficient for speed testing. |
| `TEST_MB` | No | 10 MB download per test. Higher = more accurate, slower. |
| `MAX_NODES` | No | 0 tests all nodes. Set to e.g. 10 for a quick validation run. |
| `NODE_DELAY_MS` | No | 5000 ms between tests. Lower = faster audit, more load. |

**Funding:** Each node test costs ~0.04 P2P. A full audit of ~950 nodes costs ~50 P2P. Gas per batch transaction: 0.2 P2P. Get P2P tokens via [Osmosis DEX](https://app.osmosis.zone/).

---

## 7. Build C# Bridge (optional)

```bash
cd csharp-bridge
dotnet build
```

This builds the `SentinelBridge` console app that wraps the Sentinel C# SDK. It references SDK projects at `..\..\Sentinel SDK\csharp-sdk\src\` -- make sure that directory exists.

If you only need JavaScript SDK testing, skip this step. The server defaults to `activeSDK = 'js'`.

---

## 8. Launch

```bash
cscript //nologo SentinelAudit.vbs
```

This will:
1. Trigger a UAC prompt for Administrator elevation (required for WireGuard)
2. Start the Node.js server on port 3001
3. Open http://localhost:3001 in your default browser after 4 seconds

### Alternative launchers

| Method | Command | Notes |
|--------|---------|-------|
| VBS (recommended) | `cscript //nologo SentinelAudit.vbs` | Handles admin elevation + browser open |
| Batch file | `start.bat` | Auto-elevates, kills existing port 3001 process |
| Scheduled task | `SentinelAudit.exe` | No UAC popup (run `Setup (Run Once As Admin).bat` first) |
| Direct | `node server.js` | Must already be in an admin terminal |

---

## 9. Verify

1. Open http://localhost:3001 -- you should see the dashboard with your wallet address and P2P balance
2. Click **Start Audit** -- the live log should show node discovery, then batch payments, then individual node tests
3. Check `results/results.json` after a few nodes complete -- should contain test result objects

### Health check

```bash
curl http://localhost:3001/health
```

Expected: `{ "status": "ok", "uptime": ... }`

---

## Checklist

| Step | Done |
|------|------|
| Node.js 20+ installed | |
| WireGuard installed at default path | |
| .NET 8 SDK installed (if using C# bridge) | |
| `npm install` completed | |
| `.env` created with valid mnemonic | |
| Wallet funded with P2P tokens | |
| C# bridge built (if using C# SDK) | |
| `cscript //nologo SentinelAudit.vbs` launches successfully | |
| Dashboard loads at http://localhost:3001 | |
| Audit starts and tests nodes | |
