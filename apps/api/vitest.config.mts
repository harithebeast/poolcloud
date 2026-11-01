import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Core domain logic. The Drive client wrapper is a thin SDK adapter exercised manually (see
      // docs/google-setup.md); its retry/error/upload logic lives in tested modules.
      include: ['src/storage/**/*.ts'],
      exclude: [
        'src/storage/**/*.test.ts',
        'src/storage/testing/**',
        'src/storage/stores.ts',
        'src/storage/provider.ts',
        'src/storage/google-drive-provider.ts',
      ],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 75 },
    },
  },
});
