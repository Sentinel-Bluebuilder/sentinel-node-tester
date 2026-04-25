# Sentinel Node Tester — Deployment Guide

## Required environment variables

Create a `.env` file in the project root (copy `.env.example`):

| Variable | Required | Description |
|----------|----------|-------------|
| `MNEMONIC` | Yes | BIP-39 mnemonic for the wallet that pays session fees |
| `ADMIN_TOKEN` | Yes | Secret token for the admin dashboard (use a long random string) |
| `ADMIN_PATH` | No | URL path for the admin UI (default: `/admin`) |
| `PORT` | No | HTTP port (default: `3001`) |

Do **not** commit `.env`. Real secrets belong there only.

---

## Docker deploy

### Prerequisites
- Docker 24+ and Docker Compose v2

### Commands

```bash
# From the project root
cd deploy
docker compose up -d
```

The image is built from the project root using `Dockerfile`. The `data/`
directory is bind-mounted so the SQLite database (`data/audit.db`) persists
across container restarts and upgrades.

### Upgrade

```bash
docker compose build --no-cache
docker compose up -d
```

### Verification

```bash
curl http://localhost:3001/health
# Expected: {"ok":true}
```

### Enabling public testing mode

Public testing mode is toggled from the admin dashboard only.
Navigate to `http://localhost:3001${ADMIN_PATH}` (e.g. `/admin`) and
authenticate with your `ADMIN_TOKEN`. The "Public Testing" toggle starts
the continuous loop and streams live events to `/live`.

The admin URL and token are never exposed on the public surface (`/` or `/live`).

---

## systemd deploy

### Prerequisites
- Node.js 20+ installed at `/usr/bin/node`
- A `sentinel` system user: `sudo useradd --system --no-create-home sentinel`
- App files copied to `/opt/sentinel-node-tester/`
- `.env` placed at `/opt/sentinel-node-tester/.env` (mode `600`, owner `sentinel`)

### Install

```bash
# Copy unit file
sudo cp deploy/sentinel-node-tester.service /etc/systemd/system/

# Reload and enable
sudo systemctl daemon-reload
sudo systemctl enable --now sentinel-node-tester
```

### Commands

```bash
sudo systemctl start   sentinel-node-tester
sudo systemctl stop    sentinel-node-tester
sudo systemctl restart sentinel-node-tester
sudo systemctl status  sentinel-node-tester
journalctl -u sentinel-node-tester -f   # live logs
```

### Verification

```bash
curl http://localhost:3001/health
# Expected: {"ok":true}
```

### Enabling public testing mode

Same as Docker: open the admin dashboard at `http://<host>:3001${ADMIN_PATH}`,
authenticate with `ADMIN_TOKEN`, and use the Public Testing toggle.
