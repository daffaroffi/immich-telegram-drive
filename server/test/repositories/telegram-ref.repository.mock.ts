import { Mocked, vitest } from 'vitest';
import { TelegramRefRepository } from 'src/repositories/telegram-ref.repository.js';
import type { RepositoryInterface } from 'src/types.js';

export const newTelegramRefRepositoryMock = (): Mocked<RepositoryInterface<TelegramRefRepository>> => {
  return {
    createPart: vitest.fn(),
    getSummary: vitest.fn(),
    has: vitest.fn(),
    delete: vitest.fn(),
    count: vitest.fn(),
    countAssets: vitest.fn(),
    list: vitest.fn(),
    hasByMessageId: vitest.fn(),
    listPendingUpload: vitest.fn(),
    totalBytes: vitest.fn(),
  } as unknown as Mocked<RepositoryInterface<TelegramRefRepository>>;
};
