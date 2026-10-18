import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * The single-file build must stand alone: no manifest or PNG touch icon next to it, and the SVG
 * favicon inlined as a data URI.
 */
function standaloneHead(): Plugin {
  return {
    name: 'jgu-standalone-head',
    transformIndexHtml(html) {
      const svg = readFileSync(new URL('./public/icons/icon.svg', import.meta.url), 'utf8').trim();
      const icon = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      return html
        .replace(/\s*<link rel="manifest"[^>]*>/, '')
        .replace(/\s*<link rel="apple-touch-icon"[^>]*>/, '')
        .replace(/href="\.\/icons\/icon\.svg"/, `href="${icon}"`);
    },
  };
}

// `vite build` produces a normal multi-file build (dist/) for hosting.
// `vite build --mode single` inlines everything into one index.html (dist-single/),
// which is what gets published as a claude.ai Artifact.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'single' ? [standaloneHead(), viteSingleFile()] : [],
  publicDir: mode === 'single' ? false : 'public',
  // Separate dep caches let several dev servers run side by side (VITE_CACHE_DIR=node_modules/.vite-x).
  cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
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
