// Dev server config for the INPUT harness only (not used by the app build).
// Several agents edit this tree at once; watching only the input module's own files keeps the
// harness page from full-reloading every time another module changes.
// usage: [VITE_CACHE_DIR=node_modules/.vite-x] npx vite --config dev/input.vite.config.mjs --port 5204 --strictPort
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mine = (p) => {
  const rel = path.relative(root, p).split(path.sep).join('/');
  if (rel === '' || rel === 'src' || rel === 'dev') return true;
  return rel.startsWith('src/input') || rel.startsWith('src/ui') || rel.startsWith('dev/input');
};

export default defineConfig({
  root,
  base: './',
  cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite-input',
  server: { watch: { ignored: (p) => !mine(p) } },
});
