import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { DB, type Db } from '../db/db.module.js';
import { FsService } from '../fs/fs.service.js';
import { PublicSharesController, SharesController } from './shares.controller.js';
import { SharesService } from './shares.service.js';

@Module({
  imports: [AuthModule],
  controllers: [SharesController, PublicSharesController],
  providers: [
    {
      provide: SharesService,
      inject: [DB, FsService, APP_CONFIG],
      useFactory: (db: Db, fs: FsService, cfg: AppConfig) =>
        new SharesService({ db, fs, secret: cfg.SESSION_SECRET }),
    },
  ],
})
export class SharesModule {}
