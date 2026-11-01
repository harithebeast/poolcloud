import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { registerStreamParsers } from './common/stream-parser.js';
import { MetricsService } from './metrics/metrics.service.js';
import { APP_CONFIG, type AppConfig } from './config/config.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      requestIdHeader: 'x-request-id',
      genReqId: () => randomUUID(),
      trustProxy: true,
    }),
    { bufferLogs: true },
  );
  const cfg = app.get<AppConfig>(APP_CONFIG);
  app.useLogger(app.get(Logger));

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
  });
  await app.register(fastifyCookie);
  registerStreamParsers(app.getHttpAdapter().getInstance());
  app.get(MetricsService).attach(app.getHttpAdapter().getInstance());
  await app.register(fastifyRateLimit, { max: 300, timeWindow: '1 minute' });
  app.enableCors({ origin: cfg.WEB_ORIGIN, credentials: true });
  app.setGlobalPrefix('api/v1', { exclude: ['health/(.*)', 'metrics'] });

  if (cfg.NODE_ENV !== 'production') {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('PoolDrive API').setVersion('0.1.0').build(),
    );
    SwaggerModule.setup('docs', app, doc);
  }

  app.enableShutdownHooks();
  await app.listen(cfg.API_PORT, '0.0.0.0');
}

bootstrap().catch((err: unknown) => {
  process.stderr.write(
    JSON.stringify({ level: 'fatal', msg: 'bootstrap failed', err: String(err) }) + '\n',
  );
  process.exit(1);
});
