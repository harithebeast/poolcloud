import type { FastifyInstance } from 'fastify';

/**
 * Hand uploads to the route as a raw stream. Without this Fastify would buffer the whole body in
 * memory and cap it at `bodyLimit`; with it, memory stays flat for any file size.
 */
export function registerStreamParsers(app: Pick<FastifyInstance, 'addContentTypeParser'>): void {
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
    done(null, payload),
  );
}
