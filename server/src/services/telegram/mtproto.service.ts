import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { TelegramStorageConfig } from 'src/config/telegram.config.js';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */
type GramJsModule = any;

export interface TelegramUploadResult {
  messageId: number;
  chatId: bigint;
  size: number;
  fileId: string;
}

/**
 * Minimal MTProto client for Telegram storage.
 *
 * Uses gramjs (`telegram` package) with a persisted StringSession so the
 * server can run headless. Login is a one-off interactive CLI step:
 * `immich telegram:login` writes the session file used here.
 */
@Injectable()
export class TelegramMtprotoService implements OnModuleInit, OnModuleDestroy {
  private client: any = null;
  private gramjs: GramJsModule = null;
  private connecting: Promise<void> | null = null;

  constructor(
    private configRepository: ConfigRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(TelegramMtprotoService.name);
  }

  private get config(): TelegramStorageConfig {
    return this.configRepository.getEnv().telegram;
  }

  private async loadGramjs(): Promise<GramJsModule> {
    if (!this.gramjs) {
      // dynamic import keeps gramjs out of the hot startup path and out of
      // any worker that does not need it
      this.gramjs = await import('telegram');
    }
    return this.gramjs;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.debug('Telegram storage disabled');
      return;
    }
    try {
      await this.connect();
    } catch (error: unknown) {
      this.logger.error(`Telegram storage could not connect at startup: ${error}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  get isConnected(): boolean {
    return this.client !== null;
  }

  private assertConfigured(): TelegramStorageConfig {
    const config = this.config;
    if (!config.apiId || !config.apiHash) {
      throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set when telegram storage is enabled');
    }
    if (config.chatId === 0n) {
      throw new Error('TELEGRAM_CHAT_ID must be set when telegram storage is enabled');
    }
    return config;
  }

  private async readSession(): Promise<string> {
    const config = this.assertConfigured();
    const session = await readFile(config.sessionPath, 'utf8').catch(() => null);
    if (!session) {
      throw new Error(
        `Telegram session missing at ${config.sessionPath}. Run the interactive login once to create it.`,
      );
    }
    return session.trim();
  }

  async connect(): Promise<void> {
    if (this.client || this.connecting) {
      return this.connecting ?? undefined;
    }

    this.connecting = (async () => {
      const config = this.assertConfigured();
      const gramjs = await this.loadGramjs();
      const session = new gramjs.sessions.StringSession(await this.readSession());

      const client = new gramjs.TelegramClient(session, config.apiId, config.apiHash, {
        connectionRetries: 5,
        autoReconnect: true,
        useWSS: false,
      });

      client.setLogLevel('error');
      await client.connect();

      if (!(await client.checkAuthorization())) {
        throw new Error('Stored Telegram session is no longer authorized. Re-run the interactive login.');
      }

      this.client = client;
      this.logger.log(`Connected to Telegram (chat ${config.chatId})`);
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect().catch(() => {});
      this.client = null;
    }
  }

  private async ensureClient(): Promise<any> {
    if (!this.client) {
      await this.connect();
    }
    return this.client;
  }

  /**
   * Interactive login helper used by the `telegram:login` CLI command.
   * Not called during normal server operation.
   */
  async interactiveLogin(phone: () => Promise<string>, code: () => Promise<string>, password?: () => Promise<string>) {
    const config = this.assertConfigured();
    const gramjs = await this.loadGramjs();
    const session = new gramjs.sessions.StringSession();

    const client = new gramjs.TelegramClient(session, config.apiId, config.apiHash, { connectionRetries: 5 });
    client.setLogLevel('error');
    await client.start({
      phoneNumber: phone,
      password: password,
      phoneCode: code,
      onError: (error: Error) => this.logger.error(`Login error: ${error.message}`),
    });

    const sessionString = session.save();
    await mkdir(dirname(config.sessionPath), { recursive: true });
    await writeFile(config.sessionPath, sessionString, { mode: 0o600 });

    await client.disconnect();
    this.logger.log(`Telegram session saved to ${config.sessionPath}`);
    return config.sessionPath;
  }

  /** Upload a file from disk and return the Telegram message reference. */
  async uploadFile(filePath: string, fileName: string): Promise<TelegramUploadResult> {
    const config = this.assertConfigured();
    if (!existsSync(filePath)) {
      throw new Error(`Cannot upload missing file: ${filePath}`);
    }

    const client = await this.ensureClient();
    const gramjs = await this.loadGramjs();

    return this.withFloodWait('upload', async () => {
      const { size } = await stat(filePath);
      // gramjs expects a CustomFile (name/size/path) — a bare ReadStream is
      // rejected by fileToBuffer with "Could not create buffer from file".
      // CustomFile lives in telegram/client/uploads, not on the root export.
      const uploads = await import('telegram/client/uploads.js');
      const file = new uploads.CustomFile(fileName, size, filePath);

      const uploaded = await client.uploadFile({
        file,
        workers: 1,
      });

      const result = await client.sendMessage(config.chatId.toString(), {
        file: uploaded,
        forceDocument: true,
        attributes: [new gramjs.Api.DocumentAttributeFilename({ fileName })],
      });

      const messageId = Number(result.id);
      this.logger.log(`Uploaded ${fileName} to Telegram (message ${messageId})`);

      return {
        messageId,
        chatId: config.chatId,
        size: uploaded.size ?? 0,
        fileId: `tg:${config.chatId}:${messageId}`,
      };
    });
  }

  /**
   * Recent document/media messages from the storage chat, newest first.
   * Used by the importer to discover files that already live in Telegram.
   */
  async listChatMessages(limit: number, fromSelf = false): Promise<any[]> {
    const config = this.assertConfigured();
    const client = await this.ensureClient();
    if (!fromSelf) {
      return client.getMessages(config.chatId.toString(), { limit });
    }
    // 'me' resolves to the account's own Saved Messages chat
    const me = await client.getEntity('me');
    return client.getMessages(me, { limit });
  }

  /** Download a stored document from an arbitrary peer (chat id or 'me'). */
  async downloadMessageMedia(peer: string, messageId: number, targetPath: string): Promise<number> {
    const client = await this.ensureClient();
    return this.withFloodWait('download', async () => {
      const messages = await client.getMessages(peer, { ids: [messageId] });
      const message = messages?.[0];
      if (!message?.media) {
        throw new Error(`Telegram message ${messageId} has no media`);
      }
      await mkdir(dirname(targetPath), { recursive: true });
      const buffer = await client.downloadMedia(message);
      if (!Buffer.isBuffer(buffer)) {
        throw new Error(`Telegram download for message ${messageId} did not return a buffer`);
      }
      await writeFile(targetPath, buffer);
      return buffer.length;
    });
  }

  /** Download a previously uploaded file into a local path. */
  async downloadFile(messageId: number, targetPath: string): Promise<number> {
    try {
      return await this.downloadMessageMedia(this.assertConfigured().chatId.toString(), messageId, targetPath);
    } catch (error: unknown) {
      // Files imported from Saved Messages live in the 'me' peer, not the storage chat.
      this.logger.warn(`downloadFile(${messageId}) missed in chat, trying Saved Messages: ${error}`);
      return this.downloadMessageMedia('me', messageId, targetPath);
    }
  }

  /**
   * Retry a Telegram call when the server answers with FLOOD_WAIT_x.
   * Telegram rate limits are seconds-based and recoverable, so waiting is the
   * correct response; anything else propagates to the caller.
   */
  private async withFloodWait<T>(operation: string, run: () => Promise<T>): Promise<T> {
    const maxAttempts = 5;

    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (error: unknown) {
        const seconds = parseFloodWaitSeconds(error);
        if (seconds === null) {
          throw error;
        }
        if (attempt >= maxAttempts) {
          this.logger.error(`Telegram ${operation} still rate limited after ${maxAttempts} attempts`);
          throw error;
        }
        // cap a single wait so a pathological FLOOD_WAIT cannot hang the queue
        const delay = Math.min(seconds, 15 * 60);
        this.logger.warn(`Telegram ${operation} rate limited; waiting ${delay}s (attempt ${attempt}/${maxAttempts})`);
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      }
    }
  }

  /** Delete a stored file (used by restore/cleanup and verification). */
  async deleteMessage(messageId: number): Promise<void> {
    const config = this.assertConfigured();
    const client = await this.ensureClient();
    await client.deleteMessages(config.chatId.toString(), [messageId], { revoke: true });
  }

  /** Connection details for the admin status endpoint. */
  status() {
    const config = this.config;
    return {
      enabled: config.enabled,
      connected: this.isConnected,
      chatId: config.chatId.toString(),
      sessionPath: config.sessionPath,
      maxPartBytes: config.maxPartBytes,
    };
  }
}

/** Extract the wait duration from a gramjs FLOOD_WAIT error, or null when absent. */
function parseFloodWaitSeconds(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /FLOOD_WAIT_(\d+)/.exec(message);
  if (match) {
    return Number(match[1]);
  }
  // gramjs sometimes surfaces the code as a numeric property instead
  const seconds = (error as { seconds?: unknown } | null)?.seconds;
  if (typeof seconds === 'number' && Number.isFinite(seconds)) {
    return seconds;
  }
  return null;
}
