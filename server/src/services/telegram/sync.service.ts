import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OnEvent } from 'src/decorators.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TelegramRefRepository } from 'src/repositories/telegram-ref.repository.js';
import { TelegramCryptoService } from 'src/services/telegram/crypto.service.js';
import { TelegramMtprotoService } from 'src/services/telegram/mtproto.service.js';

interface QueueItem {
  assetId: string;
  originalPath: string;
  checksum: string | null;
}

/**
 * Core sync engine. Listens for `AssetCreate` and, when telegram storage is
 * enabled, uploads the original file (encrypted) to the configured channel and
 * records the mapping in `telegram_ref`.
 *
 * Telegram has a hard per-file cap (2 GB free / 4 GB premium) and no daily
 * limit, so large originals are split into independent encrypted parts and
 * uploaded as separate messages. Uploads are serialized.
 */
@Injectable()
export class TelegramSyncService {
  private queue: QueueItem[] = [];
  private processing = false;

  constructor(
    private configRepository: ConfigRepository,
    private refRepository: TelegramRefRepository,
    private crypto: TelegramCryptoService,
    private mtproto: TelegramMtprotoService,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(TelegramSyncService.name);
  }

  @OnEvent({ name: 'AssetCreate' })
  onAssetCreate({ asset, file }: ArgOf<'AssetCreate'>): void {
    if (!this.configRepository.getEnv().telegram.enabled) {
      return;
    }
    if (!file?.originalPath) {
      this.logger.warn(`Asset ${asset.id} has no originalPath, skipping telegram backup`);
      return;
    }
    this.enqueue({
      assetId: asset.id,
      originalPath: file.originalPath,
      checksum: toHexString(file.checksum),
    });
  }

  private enqueue(item: QueueItem): void {
    if (!item.originalPath) {
      this.logger.warn(`Asset ${item.assetId} has no originalPath, skipping telegram backup`);
      return;
    }
    this.queue.push(item);
    void this.drain();
  }

  /**
   * Backfill: queue every asset that has no telegram_ref row yet, resolving the
   * on-disk path from the asset table. Returns how many were queued.
   */
  async backfill(limit = 5000): Promise<number> {
    const pending = await this.refRepository.listPendingUpload(limit);
    for (const row of pending) {
      this.enqueue({ assetId: row.assetId, originalPath: row.originalPath, checksum: null });
    }
    return pending.length;
  }

  /**
   * Restore an asset's original file from Telegram to `targetPath`.
   * Downloads every stored part in order and concatenates the decrypted
   * plaintext. Returns true when the file was restored.
   */
  async restoreTo(assetId: string, targetPath: string): Promise<boolean> {
    const summary = await this.refRepository.getSummary(assetId);
    if (!summary) {
      return false;
    }

    const vaultKey = this.configRepository.getEnv().telegram.vaultKey;
    if (summary.encrypted && !vaultKey) {
      this.logger.error(`Asset ${assetId} is encrypted but TELEGRAM_VAULT_KEY is not set; cannot restore`);
      return false;
    }

    await this.mtproto.connect();

    const workDir = await mkdtemp(join(tmpdir(), 'tg-restore-'));
    try {
      for (const part of summary.parts) {
        const partPath = join(workDir, `part-${part.partIndex}.bin`);
        await this.mtproto.downloadFile(part.messageId, partPath);
        if (summary.encrypted) {
          const outPath = join(workDir, `plain-${part.partIndex}.bin`);
          await this.crypto.decryptFile(partPath, outPath, vaultKey!);
          await rm(partPath, { force: true });
          await this.appendFileTo(targetPath, outPath);
          await rm(outPath, { force: true });
        } else {
          await this.appendFileTo(targetPath, partPath);
          await rm(partPath, { force: true });
        }
      }
      this.logger.log(`Restored asset ${assetId} from ${summary.parts.length} telegram part(s)`);
      return true;
    } catch (error: unknown) {
      this.logger.error(`Failed to restore asset ${assetId} from telegram: ${error}`);
      return false;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async appendFileTo(targetPath: string, sourcePath: string): Promise<void> {
    const { createReadStream } = await import('node:fs');
    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    await pipeline(createReadStream(sourcePath), createWriteStream(targetPath, { flags: 'a' }));
  }

  private async drain(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          await this.uploadOne(item);
        } catch (error: unknown) {
          this.logger.error(`Telegram backup failed for asset ${item.assetId}: ${error}`);
          // keep it for a later attempt unless it is a hard, permanent error
          if (!isHardError(error)) {
            this.queue.unshift(item);
          }
          break;
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async uploadOne(item: QueueItem): Promise<void> {
    const { assetId, originalPath, checksum } = item;

    if (await this.refRepository.has(assetId)) {
      this.logger.debug(`Asset ${assetId} already backed up`);
      return;
    }

    if (!existsSync(originalPath)) {
      throw new Error(`Original file missing on disk: ${originalPath}`);
    }

    await this.mtproto.connect();

    const vaultKey = this.configRepository.getEnv().telegram.vaultKey;
    const maxPartBytes = this.configRepository.getEnv().telegram.maxPartBytes;
    const workDir = await mkdtemp(join(tmpdir(), 'tg-upload-'));

    try {
      const parts = vaultKey
        ? await this.crypto.encryptFileToParts(originalPath, maxPartBytes, vaultKey, workDir)
        : [{ index: 0, path: originalPath, size: (await stat(originalPath)).size }];

      const totalParts = parts.length;
      for (const part of parts) {
        const result = await this.mtproto.uploadFile(part.path, `${assetId}.part${part.index}.bin`);
        await this.refRepository.createPart({
          assetId,
          partIndex: part.index,
          totalParts,
          messageId: result.messageId,
          chatId: result.chatId,
          size: part.size,
          checksum,
          encrypted: vaultKey !== null,
        });
      }
      this.logger.log(`Backed up asset ${assetId} → ${totalParts} telegram message(s)`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  status() {
    return {
      queueDepth: this.queue.length,
      processing: this.processing,
      telegram: this.mtproto.status(),
    };
  }
}

function isHardError(error: unknown): boolean {
  return /session missing|cannot upload missing|must be set when telegram storage is enabled/i.test(String(error));
}

function toHexString(buffer: Buffer | undefined): string | null {
  if (!buffer) {
    return null;
  }
  return createHash('sha1').update(buffer).digest('hex');
}
