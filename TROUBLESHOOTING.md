# Troubleshooting

## Quick Health Check

```bash
# After starting the server, check readiness:
curl http://localhost:3001/api/health
```

Returns `"status": "ready"` or lists specific issues to fix.

---

## Common Issues

### "MNEMONIC not set in .env"
1. Copy `.env.example` to `.env`: `cp .env.example .env`
2. Replace the placeholder with your 12 or 24 word Sentinel wallet mnemonic
3. Get a wallet at https://wallet.sentinel.co (prefix: `sent1`)
4. Fund it with P2P tokens via Osmosis DEX: https://app.osmosis.zone

### "V2Ray service dead" / "spawn UNKNOWN" / V2Ray not found
- **Windows:** Download V2Ray from https://github.com/v2fly/v2ray-core/releases — get `v2ray-windows-64.zip`, extract `v2ray.exe` to `bin/`
- **macOS:** `brew install v2ray`
- **Linux:** Download `v2ray-linux-64.zip` from same URL, extract to `bin/` or install to PATH
- **Version:** Use v5.47.0+ (older versions broken on Windows 11 build 26200+)

### "EACCES" / WireGuard tunnel fails / Permission denied
- WireGuard requires Administrator (Windows) or root (macOS/Linux)
- **Windows:** Launch via `SentinelAudit.vbs` (auto-elevates) — do NOT use `node server.js` directly
- **macOS/Linux:** `sudo node server.js`
- **Without admin:** V2Ray nodes (~70%) still work. Only WireGuard nodes require elevation.

### "WireGuard not installed"
- **Windows:** Download from https://www.wireguard.com/install/ or `winget install WireGuard.WireGuard`
- **macOS:** `brew install wireguard-tools`
- **Linux:** `apt install wireguard` or `dnf install wireguard-tools`

### "Insufficient funds" / Audit pauses
- Each node costs ~40 P2P for 1GB session + gas
- Full 1000-node audit ≈ 700-800 P2P
- The audit auto-pauses and polls every 5 minutes for balance top-up
- Top up wallet, audit resumes automatically

### "Request failed with status code 500" on handshake
- Node rejected the handshake — usually stale session or wrong signature format
- If using TKD JS SDK: ensure you're on @sentinel-official/sentinel-js-sdk v2.0.4+
- If using Blue JS SDK: sessions from previous runs may be poisoned — start a fresh test

### Dashboard shows stale data from previous run
- Click "New Test" to clear and start fresh
- Old results are saved to `results/runs/` before clearing

### All V2Ray nodes fail but WireGuard works
- Check V2Ray binary: `bin/v2ray.exe version` (Windows) or `v2ray version` (macOS/Linux)
- If "not compatible with Windows" → download latest v5.47.0+
- If "command not found" → V2Ray not installed or not in PATH

---

## Platform Support

| Platform | WireGuard | V2Ray | Admin Elevation |
|----------|-----------|-------|-----------------|
| **Windows** | Full (wireguard.exe service) | Full (bin/v2ray.exe) | `SentinelAudit.vbs` |
| **macOS** | Full via `wg-quick` (`brew install wireguard-tools`) | Full (bin/v2ray, falls back to PATH / brew) | `sudo -E node server.js` |
| **Linux** | Full via `wg-quick` (`apt install wireguard-tools`) | Full (bin/v2ray, falls back to PATH) | `sudo -E node server.js` |

All three platforms run the same audit pipeline. WireGuard nodes require root/Administrator on every platform. V2Ray nodes don't require elevation.

---

## SDK Toggle Issues

| SDK | What it tests | Requirements |
|-----|---------------|-------------|
| **Blue JS** | Our sentinel-dvpn-sdk | npm installed (automatic) |
| **Blue C#** | Our C# SDK via SentinelBridge.exe | .NET 8 + csharp-bridge built |
| **TKD JS** | @sentinel-official/sentinel-js-sdk by TKD Alex | npm installed (automatic) |

If TKD JS shows 500 errors: the handshake format may differ from Blue JS. This is expected — the comparison reveals SDK differences.
