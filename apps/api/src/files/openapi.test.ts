import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../testing/http-harness.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('OpenAPI document', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(url!);
  });
  afterAll(() => h.close());

  it('describes every public endpoint, grouped by tag', () => {
    const doc = SwaggerModule.createDocument(
      h.app,
      new DocumentBuilder().setTitle('PoolDrive API').setVersion('0.1.0').build(),
    );
    const ops = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.keys(item as object)
        .filter((m) => ['get', 'post', 'patch', 'delete', 'put'].includes(m))
        .map((m) => `${m.toUpperCase()} ${path}`),
    );
    for (const expected of [
      'POST /auth/login',
      'POST /auth/setup',
      'GET /auth/status',
      'POST /accounts/google/start',
      'GET /accounts/google/callback',
      'GET /files',
      'POST /files/upload',
      'GET /files/{id}/content',
      'POST /folders',
      'PATCH /files/{id}',
      'DELETE /files/{id}',
      'GET /files/search',
      'GET /trash',
      'POST /trash/{id}/restore',
      'POST /shares',
      'GET /public/shares/{token}/content',
      'POST /public/shares/{token}/unlock',
      'GET /storage/usage',
      'GET /alerts',
    ]) {
      expect(ops, expected).toContain(expected);
    }
    const tags = new Set(
      Object.values(doc.paths).flatMap((p) =>
        Object.values(p as object).flatMap((o: { tags?: string[] }) => o.tags ?? []),
      ),
    );
    expect([...tags].sort()).toEqual(
      ['accounts', 'alerts', 'auth', 'files', 'public', 'shares', 'storage'].sort(),
    );
  });
});
