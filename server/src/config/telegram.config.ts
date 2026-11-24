/**
 * Telegram Storage Configuration
 * Mapping of environment variables to typed config (see PLAN-TELEGRAM-BACKEND.md).
 */

export interface TelegramStorageConfig {
  enabled: boolean;
  apiId: number;
  apiHash: string;
  chatId: bigint;
  sessionPath: string;
  vaultKey: Buffer | null;
  /** Max plaintext bytes per uploaded part, before encryption overhead. Default 1.9 GiB. */
  maxPartBytes: number;
}

export const DEFAULT_TELEGRAM_CONFIG: Omit<TelegramStorageConfig, 'apiId' | 'apiHash' | 'chatId' | 'vaultKey'> = {
  enabled: false,
  sessionPath: '/config/telegram.session',
  maxPartBytes: 1_900_000_000,
};

export interface TelegramFileInfo {
  messageId: number;
  chatId: bigint;
  fileSize: number;
}

/**
 * Hard Telegram limit for a single file on a free account.
 * Telegram FAQ: files are limited to 2 GB each (4 GB with Premium).
 * There is no daily upload limit — the "per file" cap is the only hard bound.
 * A plaintext part must stay under this after the encryption overhead, hence
 * the configurable maxPartBytes default of 1.9 GiB.
 */
export const TELEGRAM_MAX_FILE_BYTES = 2_000_000_000;

/** Envelope magic/version for our own encryption format (NOT TDENC2-compatible). */
export const TG_ENC_CONSTANTS = {
  MAGIC: 'TGVAULT',
  VERSION: 1,
  CIPHER: 'aes-256-gcm' as const,
  KEY_SIZE: 32,
  IV_SIZE: 12,
  AUTH_TAG_SIZE: 16,
  CHUNK_SIZE: 1024 * 1024, // 1 MiB plaintext per chunk
} as const;