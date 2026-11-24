import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "telegram_ref" (
  "assetId" uuid NOT NULL,
  "partIndex" integer NOT NULL,
  "totalParts" integer NOT NULL,
  "messageId" integer NOT NULL,
  "chatId" bigint NOT NULL,
  "size" bigint NOT NULL,
  "checksum" character varying,
  "encrypted" boolean NOT NULL DEFAULT true,
  "uploadedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "telegram_ref_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "telegram_ref_pkey" PRIMARY KEY ("assetId", "partIndex")
);`.execute(db);
  await sql`CREATE INDEX "telegram_ref_assetId_idx" ON "telegram_ref" ("assetId");`.execute(db);
  await sql`CREATE INDEX "telegram_ref_uploadedAt_idx" ON "telegram_ref" ("uploadedAt");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "telegram_ref";`.execute(db);
}
