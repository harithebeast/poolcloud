import { Controller, Get, Inject, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth.guard.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { availableBytes } from '../storage/placement.js';
import { PgAccountStore } from '../storage/pg-stores.js';
import { storageSettings } from './files.module.js';

/** The pooled picture every user sees. Which Google account holds what is admin-only (/accounts). */
@ApiTags('storage')
@Controller('storage')
export class StorageController {
  constructor(
    private readonly store: PgAccountStore,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Get('usage')
  async usage(@Req() req: AuthedRequest) {
    const { headroom } = storageSettings(this.cfg);
    const accounts = (await this.store.list(req.auth!.user.id)).filter(
      (a) => a.status !== 'DISCONNECTED',
    );
    const limit = accounts.reduce((s, a) => s + a.limit, 0);
    const used = accounts.reduce((s, a) => s + a.usage, 0);
    const healthy = accounts.filter((a) => a.status === 'HEALTHY');
    return {
      limit,
      used,
      free: Math.max(0, limit - used),
      /** What a new upload can actually use: free space minus the safety headroom, healthy accounts only. */
      uploadable: healthy.reduce((s, a) => s + availableBytes(a, headroom), 0),
      accounts: {
        total: accounts.length,
        healthy: healthy.length,
        degraded: accounts.filter((a) => a.status === 'DEGRADED').length,
      },
      /** Files split across accounts become unavailable if any account holding a piece is offline. */
      note: 'Large files may be split across accounts; a split file is unavailable while any account holding part of it is down.',
    };
  }
}
