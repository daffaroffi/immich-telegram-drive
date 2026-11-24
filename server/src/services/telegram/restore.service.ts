import { Injectable } from '@nestjs/common';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TelegramRefRepository } from 'src/repositories/telegram-ref.repository.js';
import { TelegramCryptoService } from 'src/services/telegram/crypto.service.js';
import { TelegramMtprotoService } from 'src/services/telegram/mtproto.service.js';

/**
 * Restore path for telegram-backed assets.
 *
 * The on-disk copy is still the source of truth; this service only runs when
 * that copy has gone missing and a telegram_ref row exists. It downloads every
 * stored part in order, decrypts and reassembles the original.
 *
 * Deliberately independent of BaseService so it can be wired into the HTTP
 * layer without extending the already very long base constructor.
 */
@Injectable()
export class TelegramRestoreService {
  constructor(
    private configRepository: ConfigRepository,
    private refRepository: TelegramRefRepository,
    private crypto: TelegramCryptoService,
    private mtproto: TelegramMtprotoService,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(TelegramRestoreService.name);
  }

  private get enabled(): boolean {
    return this.configRepository.getEnv().telegram.enabled;
  }

  /**
   * Ensure `path` exists locally, restoring it from Telegram when it does not.
   * Returns true when the file is present after the call.
   */
  async ensureAvailable(assetId: string, path: string): Promise<boolean> {
    if (existsSync(path)) {
      return true;
    }
    if (!this.enabled) {
      return false;
    }

    const summary = await this.refRepository.getSummary(assetId);
    if (!summary) {
      return false;
    }

    const vaultKey = this.configRepository.getEnv().telegram.vaultKey;
    if (summary.encrypted && !vaultKey) {
      this.logger.error(`Asset ${assetId} is encrypted but TELEGRAM_VAULT_KEY is not set; cannot restore`);
      return false;
    }

    this.logger.warn(`Original file missing on disk, restoring ${assetId} from telegram`);

    const workDir = await mkdtemp(join(tmpdir(), 'tg-restore-'));
    try {
      for (const part of summary.parts) {
        const downloaded = join(workDir, `part-${part.partIndex}.bin`);
        // part.chatId is 'me' for files imported from Saved Messages, otherwise the storage chat id.
        if (part.chatId === 'me') {
          await this.mtproto.downloadMessageMedia('me', part.messageId, downloaded);
        } else {
          await this.mtproto.downloadFile(part.messageId, downloaded);
        }

        let plain = downloaded;
        if (summary.encrypted && vaultKey) {
          const decrypted = join(workDir, `plain-${part.partIndex}.bin`);
          try {
            await this.crypto.decryptFile(downloaded, decrypted, vaultKey);
            plain = decrypted;
          } catch {
            // ref flagged encrypted but the stored document is raw (e.g. files the user
            // uploaded straight to Telegram) — fall back to the downloaded bytes.
            plain = downloaded;
          }
        }

        await pipeline(createReadStream(plain), createWriteStream(path, { flags: 'a' }));
        await rm(downloaded, { force: true });
        if (plain !== downloaded) {
          await rm(plain, { force: true });
        }
      }
      this.logger.log(`Restored ${assetId} from ${summary.parts.length} telegram part(s)`);
      return true;
    } catch (error: unknown) {
      this.logger.error(`Failed to restore ${assetId} from telegram: ${error}`);
      // do not leave a partial file that would later masquerade as a full original
      await rm(path, { force: true }).catch(() => {});
      return false;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}