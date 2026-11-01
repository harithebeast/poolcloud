import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AccountsService } from '../accounts/accounts.service.js';
import { KEY_RING } from '../accounts/accounts.module.js';
import { DomainErrorsFilter } from '../common/domain-errors.filter.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { DB, type Db } from '../db/db.module.js';
import { FsService } from '../fs/fs.service.js';
import { CleanupService } from '../storage/cleanup-service.js';
import type { KeyRing } from '../storage/crypto.js';
import { DownloadService } from '../storage/download-service.js';
import { PgAccountStore, PgCleanupOutbox } from '../storage/pg-stores.js';
import { QuotaSyncService } from '../storage/quota-sync.js';
import { UploadService, type StorageSettings } from '../storage/upload-service.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';

export function storageSettings(cfg: AppConfig): StorageSettings {
  return {
    chunkSize: cfg.CHUNK_SIZE_BYTES,
    headroom: { percent: cfg.HEADROOM_PERCENT, minBytes: cfg.HEADROOM_MIN_BYTES },
    reservationTtlMs: 15 * 60_000,
    cleanupGraceMs: 60 * 60_000,
  };
}

@Global()
@Module({
  controllers: [FilesController],
  providers: [
    { provide: APP_FILTER, useClass: DomainErrorsFilter },
    { provide: FsService, inject: [DB], useFactory: (db: Db) => new FsService(db) },
    { provide: PgAccountStore, inject: [DB], useFactory: (db: Db) => new PgAccountStore(db) },
    { provide: PgCleanupOutbox, inject: [DB], useFactory: (db: Db) => new PgCleanupOutbox(db) },
    {
      provide: UploadService,
      inject: [PgAccountStore, PgCleanupOutbox, AccountsService, KEY_RING, APP_CONFIG],
      useFactory: (
        accounts: PgAccountStore,
        outbox: PgCleanupOutbox,
        svc: AccountsService,
        keyRing: KeyRing,
        cfg: AppConfig,
      ) =>
        new UploadService({
          accounts,
          outbox,
          providers: svc.providers,
          keyRing,
          settings: storageSettings(cfg),
        }),
    },
    {
      provide: DownloadService,
      inject: [PgAccountStore, AccountsService, KEY_RING],
      useFactory: (accounts: PgAccountStore, svc: AccountsService, keyRing: KeyRing) =>
        new DownloadService({ accounts, providers: svc.providers, keyRing }),
    },
    {
      provide: CleanupService,
      inject: [PgCleanupOutbox, AccountsService],
      useFactory: (outbox: PgCleanupOutbox, svc: AccountsService) =>
        new CleanupService({ outbox, providers: svc.providers }),
    },
    {
      provide: QuotaSyncService,
      inject: [PgAccountStore, AccountsService],
      useFactory: (accounts: PgAccountStore, svc: AccountsService) =>
        new QuotaSyncService({ accounts, providers: svc.providers }),
    },
    {
      provide: FilesService,
      inject: [DB, FsService, UploadService, DownloadService],
      useFactory: (db: Db, fs: FsService, uploads: UploadService, downloads: DownloadService) =>
        new FilesService({ db, fs, uploads, downloads }),
    },
  ],
  exports: [FsService, FilesService, QuotaSyncService, CleanupService, PgAccountStore],
})
export class FilesModule {}
