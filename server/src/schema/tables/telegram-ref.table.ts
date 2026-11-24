import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  PrimaryColumn,
  Table,
  Timestamp,
  type Generated,
  type Int8,
} from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/**
 * Maps one encrypted telegram part back to its asset.
 *
 * A large asset is split into multiple parts (each below Telegram's 2 GB
 * per-file limit) and uploaded as separate messages. One row holds a single
 * part; the composite primary key is (assetId, partIndex).
 */
@Table('telegram_ref')
export class TelegramRefTable {
  @PrimaryColumn({ type: 'uuid' })
  assetId!: Generated<string>;

  @PrimaryColumn({ type: 'integer' })
  partIndex!: number;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  asset!: AssetTable;

  @Column({ type: 'integer' })
  totalParts!: number;

  @Column({ type: 'integer' })
  messageId!: number;

  @Column({ type: 'bigint' })
  chatId!: Int8;

  @Column({ type: 'bigint' })
  size!: Int8;

  @Column({ type: 'character varying', nullable: true })
  checksum!: string | null;

  @Column({ type: 'boolean', default: true })
  encrypted!: boolean;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  uploadedAt!: Generated<Timestamp>;
}