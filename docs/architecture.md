# Architecture

How **immich-telegram-drive** turns a Telegram account into an Immich
storage backend.

## Big picture

```
                ┌────────────────────────────────────────────┐
                │                Telegram                    │
                │  Saved Messages (me)  +  storage chat      │
                └───────┬────────────────────────┬───────────┘
                        │ MTProto (gramjs)       │
                        ▼                        ▼
        ┌───────────────────────────┐   ┌────────────────────────┐
        │  TelegramImporterService  │   │  TelegramRestoreService │
        │  cron every 15 min        │   │  on /asset/:id/original │
        └───────┬───────────────────┘   └───────────┬────────────┘
                │ downloads ≤ maxBytes               │ streams any size
                ▼                                    ▼
        ┌───────────────────┐              ┌────────────────────┐
        │  telegram_ref     │              │  decrypted bytes   │
        │  (Postgres)       │              │  → asset file      │
        └───────┬───────────┘              └────────────────────┘
                │
                ▼
        Immich gallery: timeline, thumbnails, albums, mobile apps
```

## Components (all under `server/src/`)

### 1. `services/telegram/mtproto.service.ts`
Thin wrapper around **gramjs**. Handles session loading, peer resolution
(`me` = Saved Messages, chat id = storage chat), message listing, media
download, and upload of new files as `CustomFile` attachments.

### 2. `services/telegram/crypto.service.ts`
Encrypts/decrypts file payloads with the **TGVAULT** envelope
(see [tgvault-format.md](tgvault-format.md)). Files the user uploaded to
Telegram by other means (plain documents) are detected and passed through
unmodified.

### 3. `services/telegram/importer.service.ts`
The mapping engine. `importExisting({ source, maxBytes, skipVideos, dryRun, limit })`:

1. lists Telegram documents from the selected source
   (`self` = Saved Messages, `chat` = storage chat),
2. skips files already mapped (`telegram_ref.hasByMessageId` — idempotent),
3. downloads files up to `maxBytes`, decrypts them, and registers them as
   normal Immich assets (checksum, thumbnail, timeline entry),
4. records every part in `telegram_ref` (`assetId`, `chatId`, `messageId`,
   `partIndex`, `size`),
5. refreshes the **storage cache** (`system_metadata.telegram-storage`)
   with how many bytes/files are still pending in Telegram.

### 4. `repositories/telegram-ref.repository.ts`
The mapping table. One row per (asset, part). `chatId = 0` is the sentinel
for *Saved Messages*. Uniqueness on `(chatId, messageId, partIndex)` makes
imports idempotent.

### 5. `services/telegram/restore.service.ts`
Large files (over the import cap) are **not** stored on the VPS. When an
asset's original file is requested, `AssetMediaService` first calls
`restore.ensureAvailable()`, which re-downloads the missing file from the
Telegram peer recorded in `telegram_ref`, decrypts it, and writes it to
the expected path. Verified byte-identical (sha1) against the original.

### 6. `services/server.service.ts` — storage panel
`getStorage()` reports **Telegram** usage instead of the VPS disk:

- `used` = `SUM(telegram_ref.size)` — bytes already mapped into the gallery
- `pending` = cached bytes still in Telegram but not mapped yet
- the sidebar meter therefore shows the *Telegram library*, not `statfs('/')`.

## Continuous mapping

`docker/tg-import-cron.sh` + a systemd timer (default every 15 minutes)
call `POST /api/admin/telegram/import` for both sources with
`maxBytes=60000000` and a disk-watermark guard (skip when < 1.5 GiB free).
Combined with `hasByMessageId` idempotency this gives the Telegram-Drive
experience: send a file in Telegram, see it in the gallery automatically.

## Storage trade-offs

The VPS disk only holds: database, thumbnails, and small/medium files that
fit the import cap. Everything else stays in Telegram and streams through
restore-on-demand, so a 96 GB VPS can back a library far larger than its
disk.
