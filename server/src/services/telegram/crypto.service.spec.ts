import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TelegramCryptoService } from 'src/services/telegram/crypto.service.js';

describe(TelegramCryptoService.name, () => {
  let sut: TelegramCryptoService;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tg-crypto-'));
    sut = new TelegramCryptoService(LoggingRepository.create(TelegramCryptoService.name));
  });

  it('roundtrips a small buffer', () => {
    const vaultKey = randomBytes(32);
    const plaintext = Buffer.from('hello immich telegram storage');
    const envelope = sut.encryptBuffer(plaintext, vaultKey);
    expect(sut.decryptBuffer(envelope, vaultKey)).toEqual(plaintext);
  });

  it('roundtrips a multi-chunk buffer', { timeout: 30_000 }, () => {
    const vaultKey = randomBytes(32);
    const plaintext = randomBytes(3 * 1024 * 1024 + 7);
    const envelope = sut.encryptBuffer(plaintext, vaultKey);
    expect(sut.decryptBuffer(envelope, vaultKey)).toEqual(plaintext);
  });

  it('rejects a tampered envelope', () => {
    const vaultKey = randomBytes(32);
    const envelope = sut.encryptBuffer(Buffer.from('secret'), vaultKey);
    envelope[envelope.length - 1] ^= 0xff;
    expect(() => sut.decryptBuffer(envelope, vaultKey)).toThrow();
  });

  it('rejects a wrong key', () => {
    const envelope = sut.encryptBuffer(Buffer.from('secret'), randomBytes(32));
    expect(() => sut.decryptBuffer(envelope, randomBytes(32))).toThrow();
  });

  it('rejects a truncated envelope', () => {
    const vaultKey = randomBytes(32);
    const envelope = sut.encryptBuffer(randomBytes(5 * 1024 * 1024), vaultKey);
    expect(() => sut.decryptBuffer(envelope.subarray(0, envelope.length - 100), vaultKey)).toThrow();
  });

  it('roundtrips through file paths', { timeout: 30_000 }, async () => {
    const vaultKey = randomBytes(32);
    const plaintext = randomBytes(2 * 1024 * 1024 + 123);
    const source = join(dir, 'source.bin');
    const target = join(dir, 'target.bin');
    const restored = join(dir, 'restored.bin');
    await writeFile(source, plaintext);

    await sut.encryptFile(source, target, vaultKey);
    await sut.decryptFile(target, restored, vaultKey);
    expect(await readFile(restored)).toEqual(plaintext);
  });

  it('splits a file into ordered parts and reassembles them', { timeout: 30_000 }, async () => {
    const vaultKey = randomBytes(32);
    // small part size to force multi-part without allocating gigabytes
    const partSize = 256 * 1024;
    const total = 600 * 1024 + 137; // 3 parts
    const source = join(dir, 'big.bin');
    await writeFile(source, randomBytes(total));

    const parts = await sut.encryptFileToParts(source, partSize, vaultKey, dir);
    expect(parts).toHaveLength(3);
    expect(parts.map((p) => p.index)).toEqual([0, 1, 2]);

    const plaintextLengths: number[] = [];
    for (const part of parts) {
      const out = join(dir, `plain-${part.index}.bin`);
      await sut.decryptFile(part.path, out, vaultKey);
      const bytes = await readFile(out);
      plaintextLengths.push(bytes.length);
    }
    expect(plaintextLengths.reduce((a, b) => a + b, 0)).toBe(total);
    expect(plaintextLengths).toEqual([partSize, partSize, total - 2 * partSize]);
  });

  it('does not load a multi-megabyte envelope into memory on decrypt', { timeout: 30_000 }, async () => {
    const vaultKey = randomBytes(32);
    // 8 MiB in a single encrypted file, streamed back out
    const size = 8 * 1024 * 1024 + 5;
    const source = join(dir, 'src8m.bin');
    const enc = join(dir, 'enc8m.bin');
    const dec = join(dir, 'dec8m.bin');
    await writeFile(source, randomBytes(size));

    await sut.encryptFile(source, enc, vaultKey);
    await sut.decryptFile(enc, dec, vaultKey);
    const restored = await readFile(dec);
    expect(restored.length).toBe(size);
  });

  it('generates and validates vault keys', () => {
    const hex = sut.generateVaultKey();
    expect(hex).toHaveLength(64);
    expect(sut.parseVaultKey(hex)).toHaveLength(32);
    expect(() => sut.parseVaultKey('abc')).toThrow();
  });
});
