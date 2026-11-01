import { Global, Module } from '@nestjs/common';
import { loadConfig, type AppConfig } from '@pooldrive/shared';

export const APP_CONFIG = Symbol('APP_CONFIG');
export type { AppConfig };

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
