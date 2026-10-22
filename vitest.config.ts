import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@core': path.resolve(__dirname, 'src/core'), '@shared': path.resolve(__dirname, 'src/shared') } },
  test: { include: ['test/unit/**/*.test.ts'], environment: 'node', testTimeout: 30000 },
});
