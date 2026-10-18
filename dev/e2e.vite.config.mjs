// Dev server config for the end-to-end run (scripts/e2e.mjs) only; not used by the app build.
// A long headless run must not be interrupted by a full page reload, so this server neither
// watches files nor pushes HMR updates: restart it to pick up source changes.
// usage: VITE_CACHE_DIR=node_modules/.vite-integration npx vite --config dev/e2e.vite.config.mjs --port 5207 --strictPort
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  root,
  base: './',
  cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite-integration',
  server: { hmr: false, watch: { ignored: () => true } },
});
