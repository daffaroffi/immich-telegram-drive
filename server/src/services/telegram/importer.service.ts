import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AssetType, ChecksumAlgorithm, JobName, SystemMetadataKey } from 'src/enum.js';
import { TelegramRefRepository } from 'src/repositories/telegram-ref.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TelegramCryptoService } from 'src/services/telegram/crypto.service.js';
import { TelegramMtprotoService } from 'src/services/telegram/mtproto.service.js';

export interface TelegramImportFile {
  messageId: number;
  fileName: string;
  size: number;
  date: Date;
}

export interface TelegramImportResult {
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/**
 * One-time import of files that already live in the Telegram storage chat
 * (uploaded manually or via other Telegram-drive style tools before Immich
 * existed). Every document that does not have a telegram_ref row yet is
 * downloaded, decrypted when the vault key is configured, written into the
 * owner's upload tree and registered as a normal asset, so it shows up in the
 * Immich timeline. The telegram_ref row is created as well, so the regular
 * sync/restore machinery keeps treating the file as its own.
 */
@Injectable()
export class TelegramImporterService {
  constructor(
    private configRepository: ConfigRepository,
    private refRepository: TelegramRefRepository,
    private assetRepository: AssetRepository,
    private jobRepository: JobRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private crypto: TelegramCryptoService,
    private mtproto: TelegramMtprotoService,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(TelegramImporterService.name);
  }

  async importExisting(
    ownerId: string,
    options: {
      limit?: number;
      dryRun?: boolean;
      source?: 'chat' | 'self';
      /** only import files up to this size (bytes) — lets a small disk import in passes */
      maxBytes?: number;
      /** skip video files (big) and import photos/documents first */
      skipVideos?: boolean;
    } = {},
  ): Promise<TelegramImportResult> {
    const config = this.configRepository.getEnv().telegram;
    if (!config.enabled) {
      throw new Error('Telegram storage is not enabled');
    }

    const source = options.source ?? 'chat';
    const files = await this.listChatDocuments(options.limit ?? 500, source === 'self');
    const result: TelegramImportResult = { scanned: files.length, imported: 0, skipped: 0, failed: 0, errors: [] };
    const vaultKey = config.vaultKey;

    for (const file of files) {
      try {
        if (this.isImmichTestArtifact(file.fileName)) {
          result.skipped++;
          continue;
        }
        if (await this.refRepository.hasByMessageId(file.messageId)) {
          result.skipped++;
          continue;
        }
        if (options.skipVideos && /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(file.fileName)) {
          result.skipped++;
          continue;
        }
        if (options.maxBytes !== undefined && file.size > options.maxBytes) {
          result.skipped++;
          continue;
        }
        if (options.dryRun) {
          result.imported++;
          continue;
        }
        const imported = await this.importFile(ownerId, file, vaultKey, source);
        if (imported) {
          result.imported++;
        } else {
          result.skipped++;
        }
      } catch (error: unknown) {
        result.failed++;
        const detail = error instanceof Error ? error.message : String(error);
        result.errors.push(`message ${file.messageId} (${file.fileName}): ${detail}`);
        this.logger.error(`Telegram import failed for message ${file.messageId} (${file.fileName}): ${detail}`);
      }
    }

    this.logger.log(
      `Telegram import (${source}) finished: ${result.imported} imported, ${result.skipped} skipped, ${result.failed} failed`,
    );
    await this.updateStorageCache();
    return result;
  }

  /**
   * Cache how many bytes/files are still sitting in Telegram but not mapped
   * into the gallery yet, so the storage sidebar can report Telegram usage
   * without hammering the Telegram API on every request.
   */
  async updateStorageCache(): Promise<void> {
    try {
      const sources = await Promise.all([this.listChatDocuments(2000, true), this.listChatDocuments(2000, false)]);
      const mapped = new Set<string>();
      const rows = await this.refRepository.list(10000);
      for (const row of rows) {
        mapped.add(`${row.chatId}:${row.messageId}`);
      }
      let pendingBytes = 0;
      let pendingCount = 0;
      for (const files of sources) {
        for (const file of files) {
          if (this.isImmichTestArtifact(file.fileName)) {
            continue;
          }
          // chatId for storage-chat imports is the configured chat id; Saved Messages uses sentinel 0.
          const chatKey = files === sources[0] ? '0' : String(this.configRepository.getEnv().telegram.chatId);
          if (mapped.has(`${chatKey}:${file.messageId}`)) {
            continue;
          }
          pendingBytes += file.size;
          pendingCount++;
        }
      }
      await this.systemMetadataRepository.set(SystemMetadataKey.TelegramStorage, {
        pendingBytes,
        pendingCount,
        updatedAt: new Date().toISOString(),
      });
      this.logger.log(`Telegram storage cache updated: ${pendingCount} pending files, ${pendingBytes} bytes`);
    } catch (error: unknown) {
      this.logger.warn(`Failed to update telegram storage cache: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Documents in the storage chat (source='chat') or Saved Messages (source='self'), oldest first. */
  async listChatDocuments(limit: number, fromSelf = false): Promise<TelegramImportFile[]> {
    const messages = await this.mtproto.listChatMessages(limit, fromSelf);
    const files: TelegramImportFile[] = [];

    for (const message of messages) {
      const doc = (message as any)?.document;
      if (!doc) {
        continue;
      }
      const attributes: any[] = (doc.attributes ?? []) as any[];
      const name = attributes.map((a) => a.fileName).find(Boolean) ?? `telegram-${(message as any).id}.bin`;
      files.push({
        messageId: (message as any).id,
        fileName: name,
        size: Number(doc.size ?? 0),
        date: new Date((message as any).date * 1000),
      });
    }

    return files.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  /** Files Immich itself uploaded during tests; not user content. */
  private isImmichTestArtifact(fileName: string): boolean {
    return /^(e2e-|.*\.part\d+\.bin$|p\d+\.bin$)/.test(fileName);
  }

  private async importFile(
    ownerId: string,
    file: TelegramImportFile,
    vaultKey: Buffer | null,
    source: 'chat' | 'self' = 'chat',
  ): Promise<boolean> {
    const workDir = await mkdtemp(join(tmpdir(), 'tg-import-'));
    const downloadPath = join(workDir, 'part.bin');
    try {
      if (source === 'self') {
        await this.mtproto.downloadMessageMedia('me', file.messageId, downloadPath);
      } else {
        await this.mtproto.downloadFile(file.messageId, downloadPath);
      }

      let plainPath = downloadPath;
      let wasDecrypted = false;
      if (vaultKey) {
        const decryptedPath = join(workDir, 'plain.bin');
        try {
          await this.crypto.decryptFile(downloadPath, decryptedPath, vaultKey);
          plainPath = decryptedPath;
          wasDecrypted = true;
        } catch {
          // raw (unencrypted) document — keep the downloaded bytes as-is
          plainPath = downloadPath;
        }
      }

      const info = await stat(plainPath);
      if (info.size === 0) {
        return false;
      }

      await this.registerAsset(ownerId, file, plainPath, info.size, vaultKey !== null, wasDecrypted && source === 'self');
      return true;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async registerAsset(
    ownerId: string,
    file: TelegramImportFile,
    plainPath: string,
    size: number,
    encrypted: boolean,
    importedFromSelf = false,
  ): Promise<void> {
    const { StorageCore } = await import('src/cores/storage.core.js');
    const { mimeTypes } = await import('src/utils/mime-types.js');

    const assetId = randomUUID();
    const safeName = file.fileName.replace(/[^\w.\-]+/g, '_');
    const bytes = await readFile(plainPath);
    // Telegram-drive style uploads keep an opaque name (uuid.part0.bin), so the
    // real format has to come from the content, not the extension.
    const extension = sniffExtension(bytes) ?? extensionOf(safeName);
    const displayName = rewriteExtension(safeName, extension);
    const folder = StorageCore.getNestedFolder('upload' as never, ownerId, assetId);
    await mkdir(folder, { recursive: true });
    const targetPath = join(folder, assetId + extension);
    await copyFile(plainPath, targetPath);

    const checksum = createHash('sha1').update(bytes).digest();
    const fileDate = file.date;

    await this.assetRepository.create({
      id: assetId,
      ownerId,
      libraryId: null,
      type: mimeTypes.assetType(displayName),
      checksum,
      checksumAlgorithm: ChecksumAlgorithm.sha1File,
      originalPath: targetPath,
      fileCreatedAt: fileDate,
      fileModifiedAt: fileDate,
      localDateTime: fileDate,
      originalFileName: displayName,
      isFavorite: false,
      isOffline: false,
      isExternal: false,
      isEdited: false,
      duration: null,
      livePhotoVideoId: null,
      visibility: 'timeline' as never,
      status: 'active' as never,
    });

    await this.assetRepository.upsertExif({
      exif: { assetId, fileSizeInByte: size },
      lockedPropertiesBehavior: 'override',
    });

    await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: { id: assetId, source: 'upload' } });

    await this.refRepository.createPart({
      assetId,
      partIndex: 0,
      totalParts: 1,
      messageId: file.messageId,
      chatId: importedFromSelf ? 'me' : this.configRepository.getEnv().telegram.chatId,
      size,
      checksum: checksum.toString('hex'),
      encrypted,
    });

    this.logger.log(`Imported telegram message ${file.messageId} (${displayName}, ${size}B) as asset ${assetId}`);
  }
}

const MAGIC_EXTENSIONS: { magic: Buffer; extension: string }[] = [
  { magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]), extension: '.png' }, // PNG
  { magic: Buffer.from([0xff, 0xd8, 0xff]), extension: '.jpg' }, // JPEG
  { magic: Buffer.from('GIF8', 'ascii'), extension: '.gif' },
  { magic: Buffer.from('BM', 'ascii'), extension: '.bmp' },
  { magic: Buffer.from('RIFF', 'ascii'), extension: '.webp' }, // RIFF....WEBP
  { magic: Buffer.from('ftyp', 'ascii'), extension: '.mp4' }, // ISO-BMFF (mp4/mov)
  { magic: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), extension: '.webm' }, // Matroska
  { magic: Buffer.from('%PDF', 'ascii'), extension: '.pdf' },
  { magic: Buffer.from('PK', 'ascii'), extension: '.zip' },
  { magic: Buffer.from([0x1f, 0x8b]), extension: '.gz' },
];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '.bin';
}

function rewriteExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}${extension}`;
}

/** Guess the real file format from magic bytes; used for opaque telegram names. */
function sniffExtension(bytes: Buffer): string | null {
  for (const { magic, extension } of MAGIC_EXTENSIONS) {
    if (bytes.length >= magic.length && bytes.subarray(0, magic.length).equals(magic)) {
      if (extension === '.webp' && bytes.subarray(8, 12).toString('ascii') !== 'WEBP') {
        continue;
      }
      return extension;
    }
  }
  return null;
}
