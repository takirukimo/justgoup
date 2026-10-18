// Dev server config for the CHARACTER harnesses (not used by the app build).
// Several agents edit this tree at once: no HMR pushes (a page mid-screenshot never reloads), but files
// are still watched so the next page load picks up edits.
// usage: VITE_CACHE_DIR=node_modules/.vite-a-character npx vite --config dev/character.vite.config.mjs --port 5421 --strictPort
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  root,
  base: './',
  cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite-a-character',
  server: { hmr: false },
});
