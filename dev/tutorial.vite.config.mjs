// Dev server config for the TUTORIAL harness only (not used by the app build).
// Several agents edit this tree at once; watching only the tutorial's own files keeps the harness
// from full-reloading mid-run whenever another module changes (restart the server to pick those up).
// usage: npx vite --config dev/tutorial.vite.config.mjs --port 5206 --strictPort
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mine = (p) => {
  const rel = path.relative(root, p).split(path.sep).join('/');
  if (rel === '' || rel === 'src' || rel === 'dev') return true;
  return rel.startsWith('src/tutorial') || rel.startsWith('dev/tutorial');
};

export default defineConfig({
  root,
  base: './',
  cacheDir: 'node_modules/.vite-tutorial',
  server: { watch: { ignored: (p) => !mine(p) } },
});
