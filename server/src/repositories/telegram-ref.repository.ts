import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema/index.js';
import { asUuid } from 'src/utils/database.js';

export interface TelegramRefPart {
  assetId: string;
  partIndex: number;
  totalParts: number;
  messageId: number;
  chatId: number;
  size: number;
  checksum: string | null;
  encrypted: boolean;
  uploadedAt: Date;
}

export interface TelegramRefPartCreate {
  assetId: string;
  partIndex: number;
  totalParts: number;
  messageId: number;
  chatId: bigint | string;
  size: number;
  checksum?: string | null;
  encrypted?: boolean;
}

/** Aggregate view across every part of one asset. */
export interface TelegramRefSummary {
  assetId: string;
  totalParts: number;
  encrypted: boolean;
  checksum: string | null;
  parts: { partIndex: number; messageId: number; chatId: bigint | string; size: number }[];
}

export class TelegramRefRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Insert (or replace) one part. Idempotent on (assetId, partIndex). */
  async createPart(part: TelegramRefPartCreate): Promise<void> {
    // chatId 'me' (Saved Messages) has no numeric id in our schema — store sentinel 0.
    const chatIdValue = part.chatId === 'me' ? 0 : Number(part.chatId);
    const values = {
      assetId: asUuid(part.assetId),
      partIndex: part.partIndex,
      totalParts: part.totalParts,
      messageId: part.messageId,
      chatId: chatIdValue,
      size: part.size,
      checksum: part.checksum ?? null,
      encrypted: part.encrypted ?? true,
    };
    await this.db
      .insertInto('telegram_ref')
      .values(values as never)
      .onConflict((oc) =>
        oc.columns(['assetId', 'partIndex']).doUpdateSet({
          totalParts: part.totalParts,
          messageId: part.messageId,
          chatId: chatIdValue,
          size: part.size,
          checksum: part.checksum ?? null,
          encrypted: part.encrypted ?? true,
        } as never),
      )
      .execute();
  }

  /** Every part of one asset, in part order, or undefined when not backed up. */
  async getSummary(assetId: string): Promise<TelegramRefSummary | undefined> {
    const rows = await this.db
      .selectFrom('telegram_ref')
      .selectAll()
      .where('assetId', '=', asUuid(assetId))
      .orderBy('partIndex', 'asc')
      .execute();
    if (rows.length === 0) {
      return undefined;
    }
    return {
      assetId,
      totalParts: rows[0].totalParts,
      encrypted: rows[0].encrypted,
      checksum: rows[0].checksum,
      parts: rows.map((row) => ({
        partIndex: row.partIndex,
        messageId: row.messageId,
        chatId: String(row.chatId) === '0' ? 'me' : BigInt(row.chatId),
        size: Number(row.size),
      })),
    };
  }

  async has(assetId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('telegram_ref')
      .select((eb) => eb.lit(1).as('x'))
      .where('assetId', '=', asUuid(assetId))
      .executeTakeFirst();
    return !!row;
  }

  async delete(assetId: string): Promise<void> {
    await this.db.deleteFrom('telegram_ref').where('assetId', '=', asUuid(assetId)).execute();
  }

  async count(): Promise<number> {
    const row = await this.db
      .selectFrom('telegram_ref')
      .select((eb) => eb.fn.countAll().as('n'))
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** Total bytes stored in Telegram across every mapped part. */
  async totalBytes(): Promise<number> {
    const row = await this.db
      .selectFrom('telegram_ref')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('size'), eb.lit(0)).as('bytes'))
      .executeTakeFirstOrThrow();
    return Number(row.bytes);
  }

  async countAssets(): Promise<number> {
    const rows = await this.db
      .selectFrom('telegram_ref')
      .select('assetId')
      .execute();
    return new Set(rows.map((row) => row.assetId)).size;
  }

  async list(limit = 100): Promise<TelegramRefPart[]> {
    return this.db.selectFrom('telegram_ref').selectAll().orderBy('uploadedAt', 'desc').limit(limit).execute();
  }

  /** True when a telegram part already points at this chat message. */
  async hasByMessageId(messageId: number): Promise<boolean> {
    const row = await this.db
      .selectFrom('telegram_ref')
      .select('assetId')
      .where('messageId', '=', messageId)
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  /** Assets that still need a telegram backup, with the path to upload from. */
  async listPendingUpload(limit: number): Promise<{ assetId: string; originalPath: string }[]> {
    return this.db
      .selectFrom('asset')
      .leftJoin('telegram_ref', 'telegram_ref.assetId', 'asset.id')
      .where('telegram_ref.assetId', 'is', null)
      .where('asset.originalPath', 'is not', null)
      .select(['asset.id as assetId', 'asset.originalPath as originalPath'])
      .limit(limit)
      .execute();
  }
}