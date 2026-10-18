// Turns the single-file build (dist-single/index.html) into the content-only page format the
// claude.ai Artifact publisher expects: no doctype/html/head/body wrappers (the publisher adds its
// own skeleton), <title> first, and an explicit dark look since the game commits to one theme.
//
// usage: npm run build:single && node scripts/artifact.mjs [out.html]
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../dist-single/index.html', import.meta.url), 'utf8');
const out = process.argv[2] ?? new URL('../dist-single/artifact.html', import.meta.url).pathname;

const head = src.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? '';
const body = src.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? '';
if (!head || !body) throw new Error('unexpected build output: no <head>/<body>');

const title = head.match(/<title>[\s\S]*?<\/title>/i)?.[0] ?? '<title>Just Go Up</title>';
const keep = head
  .replace(/<title>[\s\S]*?<\/title>/i, '')
  // the publisher supplies charset + viewport; drop ours to avoid duplicates
  .replace(/<meta\s+charset[^>]*>/i, '')
  .replace(/<meta\s+name="viewport"[^>]*>/i, '')
  // PWA bits are meaningless inside the viewer
  .replace(/<link\s+rel="manifest"[^>]*>/i, '')
  .replace(/<link\s+rel="apple-touch-icon"[^>]*>/i, '');

const theme = '<style>:root{color-scheme:dark;background:#0D0E10}body{background:#0D0E10;color:#E9E5DD}</style>';
const page = `${title}\n${theme}\n${keep.trim()}\n${body.trim()}\n`;
writeFileSync(out, page);
console.log(`wrote ${out} (${(page.length / 1024).toFixed(0)} KB)`);
