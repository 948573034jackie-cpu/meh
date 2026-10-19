import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@core': path.resolve(__dirname, 'vendor/core'), '@shared': path.resolve(__dirname, 'vendor/shared') } },
  test: { include: ['test/**/*.test.ts'], testTimeout: 20000 },
});
