import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { IncomingMessage } from 'node:http';
import { RedisModule } from './common/redis.module.js';
import { APP_CONFIG, ConfigModule, type AppConfig } from './config/config.module.js';
import { DbModule } from './db/db.module.js';
import { AccountsModule } from './accounts/accounts.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    RedisModule,
    AuthModule,
    AccountsModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({
        pinoHttp: {
          level: cfg.LOG_LEVEL,
          genReqId: (req: IncomingMessage & { id?: string | number }) => String(req.id ?? ''),
          autoLogging: {
            ignore: (req: IncomingMessage) => req.url?.startsWith('/health') ?? false,
          },
          // Secrets must never reach logs.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              '*.password',
              '*.refreshToken',
              '*.masterKey',
            ],
            censor: '[redacted]',
          },
        },
      }),
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
