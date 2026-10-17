import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `vite build` produces a normal multi-file build (dist/) for hosting.
// `vite build --mode single` inlines everything into one index.html (dist-single/),
// which is what gets published as a claude.ai Artifact.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'single' ? [viteSingleFile()] : [],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: mode === 'single' ? 100_000_000 : 4096,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}));
