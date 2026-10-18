// Vitest config for the CHARACTER offline QA (not part of `npm test`):
//   npx vitest run --config dev/character.vitest.config.mjs
// SOAK=1 runs the long sweep (many seeds / grades / wall angles, rope + boulder).
import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['dev/character*.test.ts'],
    testTimeout: 1_200_000,
  },
});
