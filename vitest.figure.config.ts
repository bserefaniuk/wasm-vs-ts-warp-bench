import { defineConfig } from 'vitest/config';

/**
 * Config for the article-figure generator (quality-figure.test.ts).
 * Kept separate so `npm run bench` never runs it.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['quality-figure.test.ts'],
    disableConsoleIntercept: true,
    testTimeout: 600_000,
  },
});
