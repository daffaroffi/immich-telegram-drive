# Setup Guide

Complete setup for **immich-telegram-drive** on a fresh server.
No credentials are stored in this repository — everything secret stays in
`docker/.env` (gitignored) and in the Telegram session file on the host.

## 1. Prerequisites

- Linux server with Docker + Docker Compose plugin
- ~2 GB free disk for images (the media itself lives in Telegram)
- A Telegram account and API credentials (free, from
  <https://my.telegram.org> → *API development tools* → `api_id` + `api_hash`)

## 2. Get the code

```bash
git clone https://github.com/daffaroffi/immich-telegram-drive.git
cd immich-telegram-drive/docker
```

## 3. Configure the environment

```bash
cp example.env .env
chmod 600 .env
nano .env
```

Fill in:

| Variable | Meaning |
|---|---|
| `UPLOAD_LOCATION` | Host directory for Immich data (e.g. `/srv/immich/library`) |
| `DB_DATA_LOCATION` | Host directory for Postgres data (e.g. `/srv/immich/postgres`) |
| `DB_PASSWORD` / `DB_USERNAME` / `DB_DATABASE_NAME` | Postgres credentials (choose your own) |
| `IMMICH_VERSION` | Image tag; use `main` to follow this repo's builds |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | From my.telegram.org |
| `TELEGRAM_CHAT_ID` | Optional storage chat id (leave empty to use only Saved Messages) |
| `TELEGRAM_VAULT_KEY` | Passphrase used to encrypt files in Telegram |
| `TELEGRAM_MAX_PART_BYTES` | Max bytes per Telegram part (default 2 GB) |

> **Never commit `.env`.** It is gitignored; keep it that way.

## 4. Create the Telegram session (one-time)

The server needs a logged-in Telegram session. Run the session helper once
on a machine you trust:

```bash
cd ../server
pnpm install
pnpx tsx src/services/telegram/session-cli.ts
```

Follow the login prompt (phone number → code). The session file
`telegram.session` is written to the path configured by
`TELEGRAM_SESSION_PATH` (default `/srv/immich/telegram.session`). The
compose file mounts it read-only into the container.

## 5. Start the stack

```bash
cd ../docker
docker compose up -d
```

Check health: `curl http://localhost:2283/api/server/ping` → `{"res":"pong"}`.

## 6. Create the admin account

Open `http://<server-ip>:2283` and create the first (admin) account.
Afterwards set `IMMICH_ALLOW_SETUP=false` in `.env` and
`docker compose up -d` again so no one else can register.

## 7. Enable the continuous import cron (optional but recommended)

The importer can run on a schedule so new Telegram files map themselves:

```bash
sudo cp tg-import-cron.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/tg-import-cron.sh
# create a systemd timer, e.g. every 15 minutes:
sudo tee /etc/systemd/system/immich-tg-import.service >/dev/null <<'UNIT'
[Unit]
Description=Immich Telegram continuous import

[Service]
Type=oneshot
ExecStart=/usr/local/bin/tg-import-cron.sh
UNIT
sudo tee /etc/systemd/system/immich-tg-import.timer >/dev/null <<'UNIT'
[Unit]
Description=Run immich telegram import every 15 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
Persistent=true

[Install]
WantedBy=timers.target
UNIT
sudo systemctl enable --now immich-tg-import.timer
```

The script reads the admin password from `docker/.import-password`
(create it with `umask 077; openssl rand -base64 15 > docker/.import-password`).

## 8. Verify

- Upload a small file to Telegram Saved Messages.
- Wait ≤ 15 minutes (or run `tg-import-cron.sh` manually).
- The file appears in the Immich timeline, and the sidebar **Storage**
  panel shows Telegram usage.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `FLOOD_WAIT` / rate limits in logs | increase the timer interval; Telegram rate-limits bulk downloads |
| File missing from gallery | check `GET /api/admin/telegram/status` with an admin token |
| Large file never appears | by design — files over `maxBytes` are served on demand from Telegram |
