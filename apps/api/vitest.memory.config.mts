import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Opt-in heavy check (moves several GB): `pnpm test:memory`. Not part of the normal suite.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['scripts/**/*.check.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30 * 60_000,
    hookTimeout: 120_000,
    reporters: ['default'],
    disableConsoleIntercept: true,
  },
});
