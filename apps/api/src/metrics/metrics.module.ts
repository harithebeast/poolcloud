import { Module } from '@nestjs/common';
import { DB, type Db } from '../db/db.module.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';

@Module({
  controllers: [MetricsController],
  providers: [
    { provide: MetricsService, inject: [DB], useFactory: (db: Db) => new MetricsService(db) },
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
