import { defineConfig } from 'vitest/config';

/**
 * Benchmark harness config. Run via: npm run bench
 * (optionally BENCH_GROUP=A or BENCH_GROUP=A,P to run a subset — partial
 * runs merge into the existing results/js-wasm.json).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['bench.test.ts'],
    disableConsoleIntercept: true,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
