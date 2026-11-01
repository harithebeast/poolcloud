import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Everything except wiring (modules, main, composition roots) and the Drive SDK adapter, which
      // is exercised manually (see docs/google-setup.md); its retry/error/upload logic is tested.
      // The suite needs TEST_DATABASE_URL (CI provides Postgres); without it DB tests skip and the
      // gate below will fail, which is intended.
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/testing/**',
        'src/main.ts',
        'src/**/*.module.ts',
        'src/db/migrate.ts',
        'src/db/schema.ts',
        'src/jobs/context.ts',
        'src/accounts/provider-factory.ts',
        'src/storage/stores.ts',
        'src/storage/provider.ts',
        'src/storage/google-drive-provider.ts',
      ],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 75 },
    },
  },
});
