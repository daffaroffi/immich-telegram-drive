import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { TG_ENC_CONSTANTS } from 'src/config/telegram.config.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

/**
 * File encryption for Telegram storage.
 *
 * Format is our own (NOT TDENC2-compatible):
 *   header  = magic(7) | version(1) | salt(32) | chunkSize(4 LE) | ivPrefix(4) | plaintextLength(8 LE)
 *   payload = for each chunk i: AES-256-GCM(plaintext_chunk, iv = ivPrefix(4) | counter(8 BE))
 *             ciphertext is followed by a 16 byte auth tag.
 *
 * The per-file key is derived from the vault key with HKDF-SHA256 and a random
 * per-file salt, so a leaked file key cannot decrypt other files.
 */
@Injectable()
export class TelegramCryptoService {
  constructor(private logger: LoggingRepository) {
    this.logger.setContext(TelegramCryptoService.name);
  }

  /** Generate a fresh 32 byte vault key (hex encoded) for TELEGRAM_VAULT_KEY. */
  generateVaultKey(): string {
    return randomBytes(TG_ENC_CONSTANTS.KEY_SIZE).toString('hex');
  }

  parseVaultKey(value: string): Buffer {
    const key = Buffer.from(value, 'hex');
    if (key.length !== TG_ENC_CONSTANTS.KEY_SIZE) {
      throw new Error(
        `TELEGRAM_VAULT_KEY must be ${TG_ENC_CONSTANTS.KEY_SIZE} bytes hex (${TG_ENC_CONSTANTS.KEY_SIZE * 2} chars), got ${key.length} bytes`,
      );
    }
    return key;
  }

  private deriveFileKey(vaultKey: Buffer, salt: Buffer): Buffer {
    return Buffer.from(
      hkdfSync('sha256', vaultKey, salt, Buffer.from('immich-telegram:file-key:v1'), TG_ENC_CONSTANTS.KEY_SIZE),
    );
  }

  private chunkIv(ivPrefix: Buffer, index: number): Buffer {
    const iv = Buffer.alloc(TG_ENC_CONSTANTS.IV_SIZE);
    ivPrefix.copy(iv, 0);
    iv.writeBigUInt64BE(BigInt(index), 4);
    return iv;
  }

  private chunkAad(salt: Buffer, index: number, plaintextLength: number): Buffer {
    return Buffer.concat([
      Buffer.from(TG_ENC_CONSTANTS.MAGIC),
      Buffer.from([TG_ENC_CONSTANTS.VERSION]),
      salt,
      Buffer.from(`${index}:${plaintextLength}`),
    ]);
  }

  /** Encrypt a whole buffer. Header is prefixed, chunks follow with their tags. */
  encryptBuffer(plaintext: Buffer, vaultKey: Buffer): Buffer {
    const { MAGIC, VERSION, CHUNK_SIZE, IV_SIZE, AUTH_TAG_SIZE } = TG_ENC_CONSTANTS;
    const salt = randomBytes(32);
    const ivPrefix = randomBytes(IV_SIZE - 8);
    const fileKey = this.deriveFileKey(vaultKey, salt);

    const header = Buffer.alloc(MAGIC.length + 1 + 32 + 4 + ivPrefix.length + 8);
    let offset = 0;
    header.write(MAGIC, offset, 'ascii');
    offset += MAGIC.length;
    header.writeUInt8(VERSION, offset);
    offset += 1;
    salt.copy(header, offset);
    offset += 32;
    header.writeUInt32LE(CHUNK_SIZE, offset);
    offset += 4;
    ivPrefix.copy(header, offset);
    offset += ivPrefix.length;
    header.writeBigUInt64LE(BigInt(plaintext.length), offset);

    const parts: Buffer[] = [header];
    const chunkCount = Math.ceil(plaintext.length / CHUNK_SIZE);
    for (let i = 0; i < chunkCount; i++) {
      const start = i * CHUNK_SIZE;
      const chunk = plaintext.subarray(start, Math.min(start + CHUNK_SIZE, plaintext.length));
      const cipher = createCipheriv(TG_ENC_CONSTANTS.CIPHER, fileKey, this.chunkIv(ivPrefix, i), {
        authTagLength: AUTH_TAG_SIZE,
      });
      cipher.setAAD(this.chunkAad(salt, i, chunk.length));
      const encrypted = Buffer.concat([cipher.update(chunk), cipher.final()]);
      parts.push(Buffer.concat([encrypted, cipher.getAuthTag()]));
    }

    return Buffer.concat(parts);
  }

  /** Decrypt a payload produced by encryptBuffer. Throws on tampering or truncation. */
  decryptBuffer(envelope: Buffer, vaultKey: Buffer): Buffer {
    const { MAGIC, VERSION, IV_SIZE, AUTH_TAG_SIZE } = TG_ENC_CONSTANTS;
    const headerLength = MAGIC.length + 1 + 32 + 4 + (IV_SIZE - 8) + 8;
    if (envelope.length < headerLength) {
      throw new Error('Telegram envelope is truncated');
    }
    if (envelope.subarray(0, MAGIC.length).toString('ascii') !== MAGIC) {
      throw new Error('Telegram envelope has an invalid magic');
    }
    if (envelope.readUInt8(MAGIC.length) !== VERSION) {
      throw new Error('Unsupported telegram envelope version');
    }

    let offset = MAGIC.length + 1;
    const salt = Buffer.from(envelope.subarray(offset, offset + 32));
    offset += 32;
    const chunkSize = envelope.readUInt32LE(offset);
    offset += 4;
    const ivPrefix = Buffer.from(envelope.subarray(offset, offset + IV_SIZE - 8));
    offset = headerLength - 8;
    const plaintextLength = Number(envelope.readBigUInt64LE(offset));

    const fileKey = this.deriveFileKey(vaultKey, salt);
    const chunkCount = Math.ceil(plaintextLength / chunkSize);
    const parts: Buffer[] = [];
    let cursor = headerLength;

    for (let i = 0; i < chunkCount; i++) {
      const thisPlainLength = Math.min(chunkSize, plaintextLength - i * chunkSize);
      const recordLength = thisPlainLength + AUTH_TAG_SIZE;
      if (cursor + recordLength > envelope.length) {
        throw new Error(`Telegram envelope is truncated at chunk ${i}`);
      }
      const record = envelope.subarray(cursor, cursor + recordLength);
      cursor += recordLength;

      const tag = record.subarray(record.length - AUTH_TAG_SIZE);
      const body = record.subarray(0, record.length - AUTH_TAG_SIZE);
      const decipher = createDecipheriv(TG_ENC_CONSTANTS.CIPHER, fileKey, this.chunkIv(ivPrefix, i), {
        authTagLength: AUTH_TAG_SIZE,
      });
      decipher.setAAD(this.chunkAad(salt, i, thisPlainLength));
      decipher.setAuthTag(tag);
      parts.push(Buffer.concat([decipher.update(body), decipher.final()]));
    }

    if (cursor !== envelope.length) {
      throw new Error('Telegram envelope has trailing bytes');
    }

    const plaintext = Buffer.concat(parts);
    if (plaintext.length !== plaintextLength) {
      throw new Error('Telegram envelope length mismatch');
    }
    return plaintext;
  }

  /** Encrypt a file on disk to another path. Returns the encrypted byte count. */
  async encryptFile(sourcePath: string, targetPath: string, vaultKey: Buffer): Promise<number> {
    const { size } = await stat(sourcePath);
    const write = createWriteStream(targetPath);
    let written = 0;

    const read = createReadStream(sourcePath, { highWaterMark: TG_ENC_CONSTANTS.CHUNK_SIZE });
    const salt = randomBytes(32);
    const ivPrefix = randomBytes(TG_ENC_CONSTANTS.IV_SIZE - 8);
    const fileKey = this.deriveFileKey(vaultKey, salt);

    const header = Buffer.alloc(TG_ENC_CONSTANTS.MAGIC.length + 1 + 32 + 4 + ivPrefix.length + 8);
    let offset = 0;
    header.write(TG_ENC_CONSTANTS.MAGIC, offset, 'ascii');
    offset += TG_ENC_CONSTANTS.MAGIC.length;
    header.writeUInt8(TG_ENC_CONSTANTS.VERSION, offset);
    offset += 1;
    salt.copy(header, offset);
    offset += 32;
    header.writeUInt32LE(TG_ENC_CONSTANTS.CHUNK_SIZE, offset);
    offset += 4;
    ivPrefix.copy(header, offset);
    offset += ivPrefix.length;
    header.writeBigUInt64LE(BigInt(size), offset);

    write.write(header);
    written += header.length;

    let index = 0;
    for await (const chunk of read) {
      const plain = chunk as Buffer;
      const cipher = createCipheriv(TG_ENC_CONSTANTS.CIPHER, fileKey, this.chunkIv(ivPrefix, index), {
        authTagLength: TG_ENC_CONSTANTS.AUTH_TAG_SIZE,
      });
      cipher.setAAD(this.chunkAad(salt, index, plain.length));
      const record = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
      write.write(record);
      written += record.length;
      index++;
    }

    await new Promise<void>((resolve, reject) => {
      write.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });

    return written;
  }

  /**
   * Encrypt a plaintext byte range [start, start+length) of sourcePath into a
   * standalone envelope at targetPath. Used to split files larger than the
   * Telegram per-file limit into independent encrypted parts.
   */
  async encryptFilePart(sourcePath: string, targetPath: string, vaultKey: Buffer, start: number, length: number): Promise<number> {
    const write = createWriteStream(targetPath);
    let written = 0;

    const read = createReadStream(sourcePath, { start, end: start + length - 1, highWaterMark: TG_ENC_CONSTANTS.CHUNK_SIZE });
    const salt = randomBytes(32);
    const ivPrefix = randomBytes(TG_ENC_CONSTANTS.IV_SIZE - 8);
    const fileKey = this.deriveFileKey(vaultKey, salt);

    const header = Buffer.alloc(TG_ENC_CONSTANTS.MAGIC.length + 1 + 32 + 4 + ivPrefix.length + 8);
    let offset = 0;
    header.write(TG_ENC_CONSTANTS.MAGIC, offset, 'ascii');
    offset += TG_ENC_CONSTANTS.MAGIC.length;
    header.writeUInt8(TG_ENC_CONSTANTS.VERSION, offset);
    offset += 1;
    salt.copy(header, offset);
    offset += 32;
    header.writeUInt32LE(TG_ENC_CONSTANTS.CHUNK_SIZE, offset);
    offset += 4;
    ivPrefix.copy(header, offset);
    offset += ivPrefix.length;
    header.writeBigUInt64LE(BigInt(length), offset);

    write.write(header);
    written += header.length;

    let index = 0;
    for await (const chunk of read) {
      const plain = chunk as Buffer;
      const cipher = createCipheriv(TG_ENC_CONSTANTS.CIPHER, fileKey, this.chunkIv(ivPrefix, index), {
        authTagLength: TG_ENC_CONSTANTS.AUTH_TAG_SIZE,
      });
      cipher.setAAD(this.chunkAad(salt, index, plain.length));
      const record = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
      if (!write.write(record)) {
        await new Promise<void>((resolve) => write.once('drain', resolve));
      }
      written += record.length;
      index++;
    }

    await new Promise<void>((resolve, reject) => {
      write.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });

    return written;
  }

  /**
   * Encrypt a file into at most ceil(size / partSize) independent parts under
   * outDir. Returns each part's index, path and encrypted size. Files fitting
   * a single part still use the ordinary encryptFile path via partSize >= size.
   */
  async encryptFileToParts(sourcePath: string, partSize: number, vaultKey: Buffer, outDir: string): Promise<{ index: number; path: string; size: number }[]> {
    const { size } = await stat(sourcePath);
    const partCount = Math.max(1, Math.ceil(size / partSize));
    const parts: { index: number; path: string; size: number }[] = [];
    for (let i = 0; i < partCount; i++) {
      const start = i * partSize;
      const length = Math.min(partSize, size - start);
      const targetPath = join(outDir, `part-${i}.tg`);
      const encrypted = await this.encryptFilePart(sourcePath, targetPath, vaultKey, start, length);
      parts.push({ index: i, path: targetPath, size: encrypted });
    }
    return parts;
  }

  /** Decrypt a file on disk to another path. Streams chunk by chunk, so it works for very large parts. */
  async decryptFile(sourcePath: string, targetPath: string, vaultKey: Buffer): Promise<number> {
    const header = await this.readHeader(sourcePath);
    const fileKey = this.deriveFileKey(vaultKey, header.salt);
    const read = createReadStream(sourcePath, { start: header.headerLength, highWaterMark: header.chunkSize + TG_ENC_CONSTANTS.AUTH_TAG_SIZE });
    const write = createWriteStream(targetPath);
    let written = 0;
    let index = 0;
    let pending: Buffer = Buffer.alloc(0);

    for await (const raw of read) {
      pending = Buffer.concat([pending, raw as Buffer]);
      while (pending.length > 0) {
        const thisPlainLength = Math.min(header.chunkSize, header.plaintextLength - index * header.chunkSize);
        const recordLength = thisPlainLength + TG_ENC_CONSTANTS.AUTH_TAG_SIZE;
        if (pending.length < recordLength) {
          break;
        }
        const record = pending.subarray(0, recordLength);
        pending = pending.subarray(recordLength);

        const tag = record.subarray(record.length - TG_ENC_CONSTANTS.AUTH_TAG_SIZE);
        const body = record.subarray(0, record.length - TG_ENC_CONSTANTS.AUTH_TAG_SIZE);
        const decipher = createDecipheriv(TG_ENC_CONSTANTS.CIPHER, fileKey, this.chunkIv(header.ivPrefix, index), {
          authTagLength: TG_ENC_CONSTANTS.AUTH_TAG_SIZE,
        });
        decipher.setAAD(this.chunkAad(header.salt, index, thisPlainLength));
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(body), decipher.final()]);

        if (!write.write(plain)) {
          await new Promise<void>((resolve) => write.once('drain', resolve));
        }
        written += plain.length;
        index++;
      }
    }

    if (index * header.chunkSize < header.plaintextLength || pending.length > 0) {
      await new Promise<void>((resolve, reject) => {
        write.destroy();
        write.on('close', () => reject(new Error('Telegram envelope is truncated')));
      });
    }

    await new Promise<void>((resolve, reject) => {
      write.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });

    if (written !== header.plaintextLength) {
      throw new Error('Telegram envelope length mismatch');
    }
    return written;
  }

  /** Constant-time compare used by integrity checks. */
  equals(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Parse the fixed envelope header without loading the payload. */
  private async readHeader(sourcePath: string) {
    const { MAGIC, VERSION, IV_SIZE } = TG_ENC_CONSTANTS;
    const headerLength = MAGIC.length + 1 + 32 + 4 + (IV_SIZE - 8) + 8;
    const fd = await open(sourcePath, 'r');
    try {
      const buf = Buffer.alloc(headerLength);
      const { bytesRead } = await fd.read(buf, 0, headerLength, 0);
      if (bytesRead < headerLength) {
        throw new Error('Telegram envelope is truncated');
      }
      if (buf.subarray(0, MAGIC.length).toString('ascii') !== MAGIC) {
        throw new Error('Telegram envelope has an invalid magic');
      }
      if (buf.readUInt8(MAGIC.length) !== VERSION) {
        throw new Error('Unsupported telegram envelope version');
      }
      let offset = MAGIC.length + 1;
      const salt = Buffer.from(buf.subarray(offset, offset + 32));
      offset += 32;
      const chunkSize = buf.readUInt32LE(offset);
      offset += 4;
      const ivPrefix = Buffer.from(buf.subarray(offset, offset + IV_SIZE - 8));
      offset = headerLength - 8;
      const plaintextLength = Number(buf.readBigUInt64LE(offset));
      return { headerLength, salt, chunkSize, ivPrefix, plaintextLength };
    } finally {
      await fd.close();
    }
  }
}
