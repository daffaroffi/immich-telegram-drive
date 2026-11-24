import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { TelegramRefRepository } from 'src/repositories/telegram-ref.repository.js';
import { TelegramImporterService } from 'src/services/telegram/importer.service.js';
import { TelegramMtprotoService } from 'src/services/telegram/mtproto.service.js';
import { TelegramSyncService } from 'src/services/telegram/sync.service.js';

class TelegramImportOptionsDto {
  limit?: number;
  dryRun?: boolean;
  source?: 'chat' | 'self';
  maxBytes?: number;
  skipVideos?: boolean;
}

@ApiTags(ApiTag.Maintenance)
@Controller('admin/telegram')
export class TelegramAdminController {
  constructor(
    private sync: TelegramSyncService,
    private refRepository: TelegramRefRepository,
    private mtproto: TelegramMtprotoService,
    private importer: TelegramImporterService,
  ) {}

  @Get('status')
  @Authenticated({ permission: Permission.SystemMetadataRead, admin: true })
  @Endpoint({
    summary: 'Telegram storage status',
    history: new HistoryBuilder().added('v3.4'),
  })
  async status(@Auth() _auth: AuthDto) {
    return {
      check: 'ok' as const,
      ...this.sync.status(),
      backedUpAssets: await this.refRepository.countAssets(),
      backedUpParts: await this.refRepository.count(),
    };
  }

  @Post('backfill')
  @Authenticated({ permission: Permission.SystemMetadataUpdate, admin: true })
  @Endpoint({
    summary: 'Queue all unbacked assets for telegram sync',
    history: new HistoryBuilder().added('v3.4'),
  })
  async backfill(@Auth() _auth: AuthDto) {
    const unbacked = await this.sync.backfill(5000);
    return { unbacked };
  }

  @Get('chat-files')
  @Authenticated({ permission: Permission.SystemMetadataRead, admin: true })
  @Endpoint({
    summary: 'List files already present in the telegram storage chat or Saved Messages',
    history: new HistoryBuilder().added('v3.4'),
  })
  async chatFiles(@Auth() _auth: AuthDto, @Query('limit') limit?: string, @Query('source') source?: string) {
    const files = await this.importer.listChatDocuments(Number(limit) || 500, source === 'self');
    return { count: files.length, files };
  }

  @Post('import')
  @Authenticated({ permission: Permission.SystemMetadataUpdate, admin: true })
  @Endpoint({
    summary: 'Import files already present in the telegram storage chat or Saved Messages into the timeline',
    history: new HistoryBuilder().added('v3.4'),
  })
  async import(@Auth() auth: AuthDto, @Body() dto: TelegramImportOptionsDto) {
    return this.importer.importExisting(auth.user.id, {
      limit: dto?.limit ?? 500,
      dryRun: dto?.dryRun ?? false,
      source: dto?.source === 'self' ? 'self' : 'chat',
      maxBytes: dto?.maxBytes,
      skipVideos: dto?.skipVideos ?? false,
    });
  }
}