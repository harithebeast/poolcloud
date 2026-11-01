import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Redis } from 'ioredis';
import { REDIS } from '../common/redis.module.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { DB, type Db } from '../db/db.module.js';
import { AuthController, SESSION_TTL_MS } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { LoginThrottle, RedisCounterStore } from './throttle.js';

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: AuthService,
      inject: [DB, APP_CONFIG],
      useFactory: (db: Db, cfg: AppConfig) =>
        new AuthService(db, { sessionSecret: cfg.SESSION_SECRET, sessionTtlMs: SESSION_TTL_MS }),
    },
    {
      provide: LoginThrottle,
      inject: [REDIS],
      useFactory: (redis: Redis) => new LoginThrottle(new RedisCounterStore(redis)),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
