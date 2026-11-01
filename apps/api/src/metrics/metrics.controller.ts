import { Controller, Get, Header, Headers, Inject, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../auth/auth.guard.js';
import { safeEqual } from '../auth/tokens.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { MetricsService } from './metrics.service.js';

@ApiExcludeController()
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Open unless METRICS_TOKEN is set. Keep it off the public internet either way. */
  @Get()
  @Header('cache-control', 'no-store')
  async scrape(@Headers('authorization') authorization?: string) {
    const expected = this.cfg.METRICS_TOKEN;
    if (expected && !(authorization && safeEqual(authorization, `Bearer ${expected}`))) {
      throw new UnauthorizedException();
    }
    return this.metrics.registry.metrics();
  }
}
