import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AccountHealth } from '../alerts/alerts.service.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { KEY_RING } from '../accounts/accounts.module.js';
import { DomainErrorsFilter } from '../common/domain-errors.filter.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { DB, type Db } from '../db/db.module.js';
import { FsService } from '../fs/fs.service.js';
import { CleanupService } from '../storage/cleanup-service.js';
import type { KeyRing } from '../storage/crypto.js';
import { DownloadService } from '../storage/download-service.js';
import { PgAccountStore, PgChunkStore, PgCleanupOutbox } from '../storage/pg-stores.js';
import { DrainService } from '../storage/drain-service.js';
import { RemovalService } from '../accounts/removal.service.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { QuotaSyncService } from '../storage/quota-sync.js';
import { UploadService, type StorageSettings } from '../storage/upload-service.js';
import { FilesController } from './files.controller.js';
import { StorageController } from './storage.controller.js';
import { FilesService } from './files.service.js';

export function storageSettings(cfg: AppConfig): StorageSettings {
  return {
    chunkSize: cfg.CHUNK_SIZE_BYTES,
    encryptedChunkSize: cfg.ENCRYPTED_CHUNK_BYTES,
    headroom: { percent: cfg.HEADROOM_PERCENT, minBytes: cfg.HEADROOM_MIN_BYTES },
    reservationTtlMs: 15 * 60_000,
    cleanupGraceMs: 60 * 60_000,
  };
}

@Global()
@Module({
  controllers: [FilesController, StorageController],
  providers: [
    { provide: APP_FILTER, useClass: DomainErrorsFilter },
    { provide: FsService, inject: [DB], useFactory: (db: Db) => new FsService(db) },
    { provide: PgAccountStore, inject: [DB], useFactory: (db: Db) => new PgAccountStore(db) },
    { provide: PgChunkStore, inject: [DB], useFactory: (db: Db) => new PgChunkStore(db) },
    { provide: PgCleanupOutbox, inject: [DB], useFactory: (db: Db) => new PgCleanupOutbox(db) },
    {
      provide: UploadService,
      inject: [
        PgAccountStore,
        PgCleanupOutbox,
        AccountsService,
        KEY_RING,
        APP_CONFIG,
        AccountHealth,
      ],
      useFactory: (
        accounts: PgAccountStore,
        outbox: PgCleanupOutbox,
        svc: AccountsService,
        keyRing: KeyRing,
        cfg: AppConfig,
        health: AccountHealth,
      ) =>
        new UploadService({
          accounts,
          outbox,
          providers: svc.providers,
          keyRing,
          settings: storageSettings(cfg),
          onAuthFailure: (id, reason) => health.degrade(id, reason),
        }),
    },
    {
      provide: DownloadService,
      inject: [PgAccountStore, AccountsService, KEY_RING, AccountHealth],
      useFactory: (
        accounts: PgAccountStore,
        svc: AccountsService,
        keyRing: KeyRing,
        health: AccountHealth,
      ) =>
        new DownloadService({
          accounts,
          providers: svc.providers,
          keyRing,
          onAuthFailure: (id, reason) => health.degrade(id, reason),
        }),
    },
    {
      provide: CleanupService,
      inject: [PgCleanupOutbox, AccountsService],
      useFactory: (outbox: PgCleanupOutbox, svc: AccountsService) =>
        new CleanupService({ outbox, providers: svc.providers }),
    },
    {
      provide: QuotaSyncService,
      inject: [PgAccountStore, AccountsService, AccountHealth],
      useFactory: (accounts: PgAccountStore, svc: AccountsService, health: AccountHealth) =>
        new QuotaSyncService({
          accounts,
          providers: svc.providers,
          onDegraded: (id, reason) => health.degrade(id, reason),
        }),
    },
    {
      provide: DrainService,
      inject: [PgAccountStore, PgChunkStore, PgCleanupOutbox, AccountsService, APP_CONFIG],
      useFactory: (
        accounts: PgAccountStore,
        chunks: PgChunkStore,
        outbox: PgCleanupOutbox,
        svc: AccountsService,
        cfg: AppConfig,
      ) => {
        const { headroom, reservationTtlMs, cleanupGraceMs } = storageSettings(cfg);
        return new DrainService({
          accounts,
          chunks,
          outbox,
          providers: svc.providers,
          settings: { headroom, reservationTtlMs, cleanupGraceMs },
        });
      },
    },
    {
      provide: RemovalService,
      inject: [DB, PgAccountStore, PgChunkStore, DrainService, AlertsService, APP_CONFIG],
      useFactory: (
        db: Db,
        accounts: PgAccountStore,
        chunks: PgChunkStore,
        drain: DrainService,
        alerts: AlertsService,
        cfg: AppConfig,
      ) =>
        new RemovalService({
          db,
          accounts,
          chunks,
          drain,
          alerts,
          headroom: storageSettings(cfg).headroom,
          inlineDrain: cfg.STORAGE_PROVIDER === 'fake',
        }),
    },
    {
      provide: FilesService,
      inject: [DB, FsService, UploadService, DownloadService],
      useFactory: (db: Db, fs: FsService, uploads: UploadService, downloads: DownloadService) =>
        new FilesService({ db, fs, uploads, downloads }),
    },
  ],
  exports: [
    FsService,
    FilesService,
    QuotaSyncService,
    CleanupService,
    PgAccountStore,
    DrainService,
    RemovalService,
  ],
})
export class FilesModule {}
