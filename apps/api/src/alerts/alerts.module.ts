import { Global, Module } from '@nestjs/common';
import { DB, type Db } from '../db/db.module.js';
import { PgAccountStore } from '../storage/pg-stores.js';
import { AccountHealth, AlertsService } from './alerts.service.js';
import { AlertsController } from './alerts.controller.js';

@Global()
@Module({
  controllers: [AlertsController],
  providers: [
    { provide: AlertsService, inject: [DB], useFactory: (db: Db) => new AlertsService(db) },
    {
      provide: AccountHealth,
      inject: [DB, AlertsService],
      useFactory: (db: Db, alerts: AlertsService) =>
        new AccountHealth({ accounts: new PgAccountStore(db), alerts }),
    },
  ],
  exports: [AlertsService, AccountHealth],
})
export class AlertsModule {}
