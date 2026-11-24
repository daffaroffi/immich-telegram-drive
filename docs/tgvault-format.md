# TGVAULT file format

Files stored in Telegram by this project are wrapped in a small
encryption envelope so that the storage chat does not contain plain
media. Version 1 format:

```
offset  size  field
0       7     magic  = "TGVAULT" (ASCII)
7       1     version = 1
8       32    salt (per file, random)
40      4     chunkSize (uint32 LE) — plaintext bytes per chunk
44      4     ivPrefix (4 random bytes)
48      8     plainLen (uint64 LE) — total plaintext length
56      ...   payload = concat(encrypted chunks)
```

## Chunk encryption

- Key derivation: PBKDF2-HMAC-SHA256, `salt` above, iterations per
  `TELEGRAM_VAULT_KEY` policy (see `crypto.service.ts`), output 32 bytes.
- Cipher: AES-256-CTR.
- IV per chunk index `i` (0-based):

```
iv(i) = ivPrefix(4) || 0x00000000 (4 zero bytes) || uint64BE(i)
```

- The final chunk is truncated to `plainLen - i*chunkSize` bytes; CTR mode
  needs no padding.

## Detection

`crypto.service.ts` treats any downloaded document whose first 7 bytes
equal `TGVAULT` as an envelope and decrypts it. Anything else is handled
as a **raw document** (e.g. files uploaded to Telegram by other apps) and
served as-is — restore never fails just because the source was plain.

## Why this design

- The 4-byte `ivPrefix` + deterministic low 64 bits keep the envelope tiny
  (56-byte header) while never reusing an IV across chunks of one file.
- Per-file salt means the same key does not produce the same keystream for
  identical files uploaded twice.
- `chunkSize` is stored in the header so it can be tuned (Telegram part
  limits) without a format bump.
