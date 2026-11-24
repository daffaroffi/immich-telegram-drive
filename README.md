# immich-telegram-drive

[![AGPLv3](https://img.shields.io/badge/license-AGPLv3-blue.svg)](./LICENSE)

Use **Telegram as your photo/video backup drive** with an Immich-compatible UI.

This is a standalone, trimmed distribution of the Immich server with a
Telegram backend: every file you send to your own Telegram account
(Saved Messages or a dedicated storage chat) is continuously mapped into
the Immich gallery — the same experience as the classic
[Telegram-Drive](https://github.com/caamer20/Telegram-Drive) project, but
with the full Immich timeline, thumbnails, and mobile-app compatibility.

> Based on [Immich](https://github.com/immich-app/immich) (AGPLv3),
> modified by Daffa Roffi. See [LICENSE](./LICENSE) and
> [NOTICE.md](./NOTICE.md).

## How it works

```
Telegram (Saved Messages / storage chat)
        │  (cron every 15 min)
        ▼
importer ──▶ telegram_ref (DB) ──▶ Immich gallery (thumbnails, timeline)
        │
        └─ large files stay in Telegram; served on demand via
           restore-on-demand (transparent, byte-identical)
```

- **Continuous mapping** — a systemd timer calls the import API every 15
  minutes, so new Telegram files appear in the gallery automatically.
- **Telegram storage panel** — the sidebar storage meter shows Telegram
  usage (mapped bytes + pending bytes), not the VPS disk.
- **Restore-on-demand** — files bigger than the import cap are never
  copied to disk; requests stream them straight from Telegram.

## Repository layout

| Path | What it is |
|---|---|
| `server/` | Modified Immich NestJS server (telegram services live in `server/src/services/telegram/`) |
| `web/`, `i18n/` | Immich web app sources (built into the server image) |
| `packages/` | SDK / CLI / plugin tooling needed by the build |
| `docker/` | Compose stack, continuous-import cron script, env template |
| `.github/workflows/` | Docker image build workflow |
| `docs/` | Architecture, TGVAULT format, setup guide |

## Quick start

See **[docs/setup.md](docs/setup.md)** for the full guide. Short version:

```bash
git clone https://github.com/daffaroffi/immich-telegram-drive.git
cd immich-telegram-drive/docker
cp example.env .env          # then fill in your own values
nano .env
docker compose up -d
```

Then open `http://<server-ip>:2283`, create the first admin account
(sign-up closes automatically afterwards), and start sending files to
your Telegram Saved Messages.

## Documentation

- [Setup guide](docs/setup.md) — configuration, Telegram session, cron.
- [Architecture](docs/architecture.md) — how import, refs, and restore work.
- [TGVAULT format](docs/tgvault-format.md) — the encrypted file format.

## License

AGPLv3 — same as Immich. This project carries forward the original
license; modifications are documented in [NOTICE.md](./NOTICE.md).
